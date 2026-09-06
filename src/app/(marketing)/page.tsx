import Link from "next/link";
import {
  ArrowRight, Bot, Building2, CalendarDays, CheckSquare, FolderKanban,
  Landmark, Layers, Search, Sparkles, Target, Users, Workflow, Zap,
} from "lucide-react";

import { MarketingNav } from "@/components/marketing/nav";
import { ProductPreview } from "@/components/marketing/product-preview";
import { AiCallout, Pricing } from "@/components/marketing/pricing";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/brand/logo";
import { getIdentity } from "@/lib/auth/context";

export const metadata = {
  title: "Tiny CRM — Your whole business. Organized.",
  description:
    "A simple AI-powered CRM for contacts, deals, projects, tasks, and everything that happens between them.",
};

const OBJECTS = [
  { icon: FolderKanban, label: "Projects", copy: "Every initiative gets a dashboard, a deadline and a next action." },
  { icon: Users, label: "Contacts", copy: "People, with the history and the relationship score that goes with them." },
  { icon: Building2, label: "Companies", copy: "Accounts that pull together every contact, deal and project." },
  { icon: Target, label: "Deals", copy: "A drag-and-drop pipeline that tells you which deals are stalling." },
  { icon: Landmark, label: "Opportunities", copy: "RFPs and grants with deadlines, requirements and a go / no-go call." },
  { icon: CheckSquare, label: "Tasks", copy: "The next action on anything, in one list you can actually finish." },
  { icon: CalendarDays, label: "Calendar", copy: "Meetings attached to the work they belong to." },
  { icon: Workflow, label: "Automations", copy: "When a deal hits Proposal, the follow-up task creates itself." },
];

const QUESTIONS = [
  "What do I need to do today?",
  "Which deals need attention?",
  "Who haven't I talked to in 30 days?",
  "What projects are at risk?",
  "Show me every opportunity worth more than $100k.",
  "Summarize everything happening with BBOP.",
];

const FAQ = [
  {
    q: "How is this different from HubSpot?",
    a: "HubSpot is built for sales teams with an admin. Tiny CRM is built for one person running several businesses. Where HubSpot gives you a settings page, Tiny CRM picks a sensible default. You will understand the whole product in about five minutes.",
  },
  {
    q: "Can I run more than one business in it?",
    a: "That is the point. Each business gets its own workspace with its own pipelines, statuses and tags, and the All Businesses view aggregates across every one of them. Switching context is one click and never loses the bigger picture.",
  },
  {
    q: "What does Tiny AI actually do?",
    a: "It reads your CRM and answers questions about it, writes a morning brief, summarises any record, spots duplicates and stale deals, and turns a pasted note into proposed contacts, companies and tasks. It never changes anything without you approving it first.",
  },
  {
    q: "Do I need an AI API key?",
    a: "No. Relationship scores, deal momentum, project health, duplicate detection and the hygiene checks are all computed by the app itself and work with no key. Add a Claude or OpenAI key and Tiny AI can also answer open-ended questions in its own words.",
  },
  {
    q: "What happens when I hit the free limits?",
    a: "Nothing breaks and nothing is deleted. You are told which limit you have reached and can upgrade when it is worth it. Free is a real plan, not a countdown.",
  },
  {
    q: "Is the lifetime plan really forever?",
    a: "Yes — one payment of $250 for the full product and all future updates, with no renewal. It works out to roughly 18 months of Pro.",
  },
];

export default async function MarketingPage() {
  const user = await getIdentity();
  const signedIn = Boolean(user);

  return (
    <div className="min-h-dvh bg-canvas">
      <MarketingNav signedIn={signedIn} />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 grid-lines opacity-[0.55] [mask-image:radial-gradient(ellipse_at_top,black,transparent_72%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[900px] -translate-x-1/2 rounded-full bg-brand-400/10 blur-3xl"
        />
        <div className="relative mx-auto max-w-6xl px-4 pb-14 pt-16 sm:px-6 sm:pt-24">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-panel px-3 py-1 text-[12px] font-medium text-muted">
              <Sparkles className="size-3.5 text-brand-500" />
              A simple AI-powered CRM
            </span>

            <h1 className="mt-5 text-pretty text-[38px] font-semibold leading-[1.08] tracking-[-0.035em] text-body sm:text-[54px]">
              Your whole business.
              <br />
              <span className="text-brand-500">Organized.</span>
            </h1>

            <p className="mx-auto mt-5 max-w-xl text-pretty text-[15px] leading-relaxed text-muted sm:text-base">
              Contacts, deals, projects, tasks — and everything that happens between them. Built for the person
              running several businesses at once, not for a sales department.
            </p>

            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button asChild variant="brand" size="xl" className="w-full sm:w-auto">
                <Link href={signedIn ? "/home" : "/signup"}>
                  {signedIn ? "Open Tiny CRM" : "Start free"}
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="xl" className="w-full sm:w-auto">
                <a href="#pricing">See pricing</a>
              </Button>
            </div>

            <p className="mt-4 text-[12px] text-faint">
              Free forever for your first few clients · $14/month · or $250 once, for good
            </p>
          </div>

          <div className="mx-auto mt-12 max-w-5xl">
            <ProductPreview />
          </div>
        </div>
      </section>

      {/* Philosophy */}
      <section className="border-y border-hairline bg-panel">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-pretty text-2xl font-semibold tracking-[-0.025em] text-body sm:text-[30px]">
              Four questions, answered on every screen
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-muted">
              Most CRMs are a filing cabinet you have to maintain. Tiny CRM is built around the only questions that
              matter when you are running the business yourself.
            </p>
          </div>

          <div className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
            {[
              { q: "What is happening?", a: "A live timeline on every record — calls, meetings, emails, notes, stage changes.", icon: Layers },
              { q: "Who is involved?", a: "Everything is relational. A person, their company, their deals, their projects — one click apart.", icon: Users },
              { q: "What needs my attention?", a: "Overdue work, stalling deals, slipping projects and quiet relationships, surfaced without asking.", icon: Zap },
              { q: "What should I do next?", a: "Every record carries a next action. Tiny AI suggests one when you have not.", icon: ArrowRight },
            ].map((item) => (
              <div key={item.q} className="bg-panel p-6">
                <item.icon className="size-4 text-brand-500" />
                <h3 className="mt-3 text-[14px] font-semibold tracking-[-0.01em] text-body">{item.q}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Objects */}
      <section id="how" className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="max-w-2xl">
          <h2 className="text-pretty text-2xl font-semibold tracking-[-0.025em] text-body sm:text-[30px]">
            Everything important has a home, a relationship, and a next action
          </h2>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            A contact belongs to a company. A deal belongs to a company and a project. A note can attach to any of
            them. Nothing floats loose, so nothing gets lost.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {OBJECTS.map((object) => (
            <div key={object.label} className="rounded-xl border border-hairline bg-panel p-5">
              <object.icon className="size-4 text-brand-500" />
              <h3 className="mt-3 text-[13.5px] font-semibold text-body">{object.label}</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{object.copy}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Multi-business */}
      <section className="border-y border-hairline bg-panel">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-2 lg:items-center">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-500">
              Built for several businesses
            </span>
            <h2 className="mt-3 text-pretty text-2xl font-semibold tracking-[-0.025em] text-body sm:text-[30px]">
              Switch context without losing the whole picture
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-muted">
              Give each business its own workspace, with its own pipelines, project statuses and tags. Then flip to
              All Businesses to see the combined pipeline, the tasks due today across everything, and every project
              that is slipping — in one view.
            </p>
            <p className="mt-3 text-[14px] leading-relaxed text-muted">
              Focus on a single project and the whole app narrows to it: its contacts, deals, tasks, files and
              activity. Switch back when you are done.
            </p>
          </div>

          <div className="rounded-2xl border border-hairline bg-canvas p-5">
            <div className="space-y-1.5">
              {[
                { name: "All Businesses", meta: "4 workspaces · $1.4M pipeline", active: true, color: "#1b1b1b" },
                { name: "Artifact Intelligence", meta: "6 projects · 11 contacts", color: "#068C28" },
                { name: "Artifact Digital", meta: "5 projects · 8 contacts", color: "#2563EB" },
                { name: "DropQ", meta: "2 projects · 5 contacts", color: "#7C3AED" },
                { name: "Personal Business Development", meta: "2 projects · 6 contacts", color: "#EA580C" },
              ].map((row) => (
                <div
                  key={row.name}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 ${
                    row.active ? "bg-panel ring-1 ring-brand-300 dark:ring-brand-800" : "hover:bg-panel"
                  }`}
                >
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: row.color }} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-body">{row.name}</span>
                    <span className="block truncate text-[11px] text-faint">{row.meta}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Tiny AI */}
      <section id="ai" className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-start">
          <div>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-500">
              <Sparkles className="size-3.5" />
              Tiny AI
            </span>
            <h2 className="mt-3 text-pretty text-2xl font-semibold tracking-[-0.025em] text-body sm:text-[30px]">
              An assistant that has actually read your CRM
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-muted">
              Hit <kbd className="rounded border border-hairline bg-panel px-1.5 py-0.5 font-mono text-[11px]">⌘K</kbd>{" "}
              and ask. Tiny AI reads your contacts, deals, projects, tasks and activity — scoped to what you can
              see — and answers with the actual records, not generic advice.
            </p>

            <ul className="mt-6 space-y-2.5">
              {[
                "A morning brief that names the one thing to start with",
                "An AI summary on every contact, company, deal and project",
                "Paste a note — it proposes the contacts, companies and tasks inside it",
                "Finds duplicates, stale deals and follow-ups you have let slide",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-[13.5px] leading-snug text-body">
                  <Bot className="mt-0.5 size-4 shrink-0 text-brand-500" />
                  {line}
                </li>
              ))}
            </ul>

            <p className="mt-6 rounded-xl border border-hairline bg-panel p-4 text-[13px] leading-relaxed text-muted">
              <strong className="font-semibold text-body">It never edits your CRM behind your back.</strong>{" "}
              Tiny AI proposes changes and you approve them. That is a rule of the product, not a setting.
            </p>
          </div>

          <div className="rounded-2xl border border-hairline bg-panel p-5">
            <div className="flex items-center gap-2 border-b border-hairline pb-3">
              <Search className="size-3.5 text-faint" />
              <span className="text-[13px] text-faint">Ask Tiny AI anything…</span>
              <kbd className="ml-auto rounded border border-hairline px-1.5 py-0.5 font-mono text-[10px] text-faint">
                ⌘K
              </kbd>
            </div>
            <ul className="mt-3 space-y-1">
              {QUESTIONS.map((question) => (
                <li
                  key={question}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-body hover:bg-sunken"
                >
                  <Sparkles className="size-3.5 shrink-0 text-brand-500" />
                  {question}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-y border-hairline bg-panel">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-pretty text-2xl font-semibold tracking-[-0.025em] text-body sm:text-[30px]">
              Priced like a tool, not a platform
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-muted">
              Start free. Pay $14 a month when it earns it. Or pay once and never think about it again.
            </p>
          </div>

          <div className="mt-10">
            <Pricing signedIn={signedIn} />
          </div>

          <div className="mt-6">
            <AiCallout />
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
        <h2 className="text-pretty text-2xl font-semibold tracking-[-0.025em] text-body sm:text-[30px]">
          Questions
        </h2>
        <dl className="mt-8 divide-y divide-hairline border-t border-hairline">
          {FAQ.map((item) => (
            <div key={item.q} className="py-5">
              <dt className="text-[14px] font-semibold tracking-[-0.01em] text-body">{item.q}</dt>
              <dd className="mt-2 text-[13.5px] leading-relaxed text-muted">{item.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* CTA */}
      <section className="border-t border-hairline bg-panel">
        <div className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-20">
          <LogoMark className="mx-auto size-10" />
          <h2 className="mt-5 text-pretty text-2xl font-semibold tracking-[-0.025em] text-body sm:text-[30px]">
            Everything gets easier when work has a home
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-[14px] leading-relaxed text-muted">
            Replace the spreadsheet, the Notion workspace and the CRM you stopped updating. It takes about five
            minutes to understand.
          </p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild variant="brand" size="xl" className="w-full sm:w-auto">
              <Link href={signedIn ? "/home" : "/signup"}>
                {signedIn ? "Open Tiny CRM" : "Start free"}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            {!signedIn ? (
              <Button asChild variant="outline" size="xl" className="w-full sm:w-auto">
                <Link href="/login">Sign in</Link>
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2">
            <LogoMark className="size-5" />
            <span className="text-[12px] text-faint">
              Tiny CRM — Your whole business. Organized.
            </span>
          </div>
          <div className="flex items-center gap-4 text-[12px] text-faint">
            <a href="#pricing" className="transition-colors hover:text-muted">Pricing</a>
            <a href="#faq" className="transition-colors hover:text-muted">FAQ</a>
            <Link href="/login" className="transition-colors hover:text-muted">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
