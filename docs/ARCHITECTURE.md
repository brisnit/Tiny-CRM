# Architecture

The brief asked, after the first build, to *"review the architecture and identify anything
that would prevent Tiny CRM from eventually supporting thousands of contacts, hundreds of
projects, multiple workspaces, email/calendar integrations, and AI agents."*

This document is that review. It is written against measurements, not intentions —
`scripts/loadtest.ts` builds a workspace of the stated size and times the queries that
actually back each screen.

---

## 1. Measured behaviour at scale

Query timings on a workspace holding **25,000 contacts, 3,000 companies, 1,200 projects,
12,000 deals, 25,000 tasks and 100,000 activities** (SQLite, warm, average of 3 runs —
reproduce with `npm run db:loadtest`):

| Query | Time |
|---|---|
| Dashboard (home page) | 30 ms |
| Contacts list + relationship scores | 16 ms |
| Contacts search | 34 ms |
| Pipeline board | 11 ms |
| Analytics, 1-year range | 36 ms |
| Global search | 17 ms |
| AI context snapshot | 8 ms |
| AI cleanup scan | 31 ms |

Nothing is above 40 ms. That is roughly 5× the stated target with headroom.

### What the load test actually caught

The first version of the CRM hygiene scanner ran at **873 ms** and grew linearly, because
it loaded every contact, company and open deal into Node to do duplicate detection. Every
other query was already bounded; this one was not, and no amount of reading the code made
that obvious — running it did.

It was rewritten so the database does the grouping (`GROUP BY … HAVING COUNT(*) > 1`) and
every detector takes a capped slice ordered by how much it matters. **873 ms → 31 ms**, and
the cost is now a function of how many *problems* a workspace has rather than how many
records. See the SCALE NOTE at the top of `src/lib/ai/recommendations.ts`.

---

## 2. The decisions that make the numbers hold

### Everything is bounded

No screen issues an unbounded `findMany`. Lists paginate in SQL (50/page). Board columns
cap at 400 cards while the column header still shows the true total. The AI context builder
caps at 14,000 characters and truncates field by field, so prompt size is constant no
matter how large the workspace grows.

### Aggregates are grouped, not looped

Relationship strength needs 90 days of interaction counts per contact. The naive shape is
two queries per row; instead `attachScores` issues **two grouped queries for the whole
page** (`src/lib/data/contacts.ts`). The same pattern gives companies their open-pipeline
totals and the dashboard its per-stage rollups.

### Recency is denormalised, deliberately

`Company.lastActivityAt`, `Deal.lastActivityAt`, `Project.lastActivityAt`,
`Contact.lastContactedAt` and `Deal.stageEnteredAt` are maintained on write by
`logActivity` (`src/lib/actions/base.ts`). "Deals that have gone quiet" is then an indexed
range scan rather than an aggregate over a 100,000-row activity table. Every one of those
columns is indexed alongside `workspaceId`.

### Indexes match the access patterns

`prisma/schema.prisma` declares composite indexes shaped like the queries in
`src/lib/data/*` — `[workspaceId, archivedAt, lastContactedAt]`, `[workspaceId, status, dueAt]`,
`[pipelineId, stageId]`, `[entityType, entityId]` for the polymorphic tag and custom-field
links, and so on.

### Scores are computed, never stored

Relationship strength, deal momentum, win probability and project health live in
`src/lib/scoring.ts` as pure functions. Nothing is cached in a column that could drift from
the data it describes, and every score returns the factors that produced it — which is what
lets the UI explain itself when you click a badge.

The one thing that *is* cached is model output: `AiInsight` rows carry a SHA-256
fingerprint of the context that produced them, so a summary is regenerated when the record
actually changes rather than on every page view. That is what makes an AI summary on every
record affordable.

---

## 3. Multi-workspace tenancy

Scope resolution happens in exactly one place, `resolveScope` in `src/lib/auth/session.ts`,
which turns a scope preference into the list of workspace ids the user is a member of.
Every query then filters on `workspaceId: { in: [...] }`.

The consequences are deliberate:

- **"All Businesses" is not a special case.** It is the same query with more ids, which is
  why aggregate views cost the same as scoped ones.
- **The scope cookie is a preference, never a permission.** A tampered cookie naming a
  workspace the user does not belong to silently falls back rather than leaking anything.
- **Role checks run on writes, not just in the UI.** `requireWorkspace(userId, workspaceId, minimum)`
  is called inside the server actions, so a hand-crafted request is refused the same way a
  hidden button would be.

---

## 4. Database portability

The schema runs unchanged on SQLite and PostgreSQL because it avoids every
provider-specific feature:

| Instead of | It uses | Why it matters |
|---|---|---|
| Native `enum` | `String` + `src/lib/enums.ts` + Zod | SQLite has no enums; validation stays in one typed place |
| Scalar lists | Real join tables | Queryable, indexable, and portable |
| `Json` columns | `String` holding JSON + typed helpers | Same shape on both engines |
| `Decimal` | `Int` minor units (cents) | No float arithmetic on money, no Decimal support needed |

`src/lib/db.ts` picks the Prisma 7 driver adapter from the shape of `DATABASE_URL`, so
`npm run db:use-postgres` plus a connection string is the entire migration.

**Where Postgres becomes necessary:** search. `searchEverything` uses indexed `contains`
queries, which is genuinely fast to the tens of thousands but is a substring scan, not a
ranked text index. The ranking (prefix beats substring, name beats body) is applied in
application code. Past roughly 100k records per workspace the swap is Postgres full-text
(`tsvector` + GIN) or an external index — and only `src/lib/data/search.ts` changes,
because every caller depends on the `SearchHit` shape rather than on how it was produced.

---

## 5. Email and calendar

The data model is already the production one, not a placeholder. `EmailMessage` and
`CalendarEvent` carry a unique `(provider, externalId)` constraint so a sync worker can
upsert incrementally and re-run safely; `Integration` holds a per-workspace sync cursor and
an encrypted credentials column. Both tables are linked to contacts, companies, deals and
projects, and they already drive real behaviour — unanswered-thread detection, the meetings
panels, and the AI context.

The seeded records use `provider: "mock"`. Connecting Gmail or Google Calendar means adding
the OAuth handshake and a polling worker that writes to these same tables. **No schema
change, and no change to any screen.**

---

## 6. AI architecture

```
src/lib/ai/
  provider.ts         the abstraction: Anthropic | OpenAI | offline engine
  offline.ts          deterministic reasoning, used when no key is configured
  context.ts          scoped, budgeted CRM retrieval — the only path data takes to a model
  prompts.ts          every system prompt, in one editable place
  summaries.ts        fingerprint-cached record summaries and the daily brief
  classification.ts   text → proposed records (proposals only; never writes)
  recommendations.ts  deterministic hygiene detection, in SQL
  crm-agent.ts        the conversational agent behind ⌘K
```

Three properties are structural rather than conventional:

**No vendor coupling.** Nothing above `provider.ts` knows which model answered. Adding a
provider means implementing one interface.

**Retrieval precedes generation.** `context.ts` assembles context from workspace ids the
caller was *already* authorised for. The model never chooses what it sees, so a
prompt-injected note cannot widen its own access.

**The model explains; it does not calculate.** Scores arrive in the context pre-computed.
This is why the offline and model-backed modes agree on every number — they read the same
facts, and only the prose differs.

---

## 7. Known limits, stated plainly

These are real boundaries of the current build, not oversights:

- **Search** is substring-based (§4). Fine to tens of thousands; needs a text index beyond that.
- **Time-based automations** (deadline approaching, deal gone quiet) run inline on writes.
  The engine takes the shape a scheduled worker would call, but no scheduler is wired up.
- **Billing** records plan changes directly. There is no payment processor; the seam is one
  function (`changePlan`) that a webhook would call.
- **File storage** addresses files by a storage key rather than a URL, so S3/R2 is a change
  to one module — but only metadata is seeded; there is no upload endpoint yet.
- **Team collaboration**: the membership and role model exists and is enforced on writes,
  but there is no invitation flow.
- **The notes editor** uses `document.execCommand`, which is deprecated. It is isolated in
  one component so TipTap or Lexical could replace it without touching anything else.
- **Prisma CLI advisories**: `npm audit` reports issues in `mysql2` and `deepmerge-ts`,
  both transitive dev-only dependencies of the Prisma CLI. Nothing ships to production.

---

## 8. Verification

| What | How |
|---|---|
| Types | `npm run typecheck` — clean |
| Lint | `npm run lint` — clean, 0 problems |
| Build | `npm run build` — 40 routes |
| Behaviour | `node e2e-verify.mjs` — 15 browser checks, 0 console errors |
| Scale | `npm run db:loadtest` — timings in §1 |
| Plan limits | Enforced in `assertWithinLimit`, verified against the free-tier account |
| Chart colour | `dataviz` validator: brand green + blue, worst CVD ΔE 25.4 light / 26.3 dark against an ≥8 target, contrast ≥3:1 in both themes |
