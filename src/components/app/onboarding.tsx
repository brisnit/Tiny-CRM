"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Check, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { LogoLockup } from "@/components/brand/logo";
import { createWorkspace } from "@/lib/actions/settings";
import { createContact } from "@/lib/actions/contacts";
import { createCompany } from "@/lib/actions/companies";
import { createProject } from "@/lib/actions/projects";
import { completeOnboarding } from "@/lib/actions/onboarding";
import { cn } from "@/lib/utils";

const COLORS = ["#068C28", "#2563EB", "#7C3AED", "#EA580C", "#0891B2", "#DB2777"];

type Step = 0 | 1 | 2 | 3 | 4;

/**
 * Onboarding.
 *
 * Five short steps, each answering one question, and every one skippable. The
 * goal is a workspace that already has something in it — an empty CRM is the
 * reason most people abandon one on day two.
 */
export function OnboardingFlow({
  firstName,
  hasWorkspace,
  selectedPlan,
}: {
  firstName: string;
  hasWorkspace: boolean;
  selectedPlan: string | null;
}) {
  const router = useRouter();
  const [step, setStep] = React.useState<Step>(hasWorkspace ? 2 : 0);
  const [pending, startTransition] = React.useTransition();

  const [businesses, setBusinesses] = React.useState("");
  const [workspaceName, setWorkspaceName] = React.useState("");
  const [workspaceColor, setWorkspaceColor] = React.useState(COLORS[0]!);
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const [projectName, setProjectName] = React.useState("");
  const [projectDescription, setProjectDescription] = React.useState("");
  const [contactFirst, setContactFirst] = React.useState("");
  const [contactLast, setContactLast] = React.useState("");
  const [contactEmail, setContactEmail] = React.useState("");
  const [companyName, setCompanyName] = React.useState("");

  function finish() {
    startTransition(async () => {
      await completeOnboarding();
      // A full navigation, not push + refresh: completing onboarding changes
      // what the layout will do with this account, and the two racing left a
      // blank screen that never settled. See auth-forms.tsx.
      window.location.assign(selectedPlan && selectedPlan !== "free" ? "/settings/billing" : "/home");
    });
  }

  function createTheWorkspace() {
    startTransition(async () => {
      const result = await createWorkspace({ name: workspaceName, color: workspaceColor });
      if (result.ok) {
        setWorkspaceId(result.data.id);
        setStep(2);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function createTheProject() {
    if (!projectName.trim()) {
      setStep(3);
      return;
    }
    startTransition(async () => {
      const result = await createProject({
        workspaceId: workspaceId!,
        name: projectName,
        description: projectDescription,
      });
      if (result.ok) setStep(3);
      else toast.error(result.error);
    });
  }

  function createTheContact() {
    if (!contactFirst.trim() && !companyName.trim()) {
      setStep(4);
      return;
    }
    startTransition(async () => {
      let companyId: string | undefined;
      if (companyName.trim()) {
        const company = await createCompany({ workspaceId: workspaceId!, name: companyName });
        if (company.ok) companyId = company.data.id;
      }
      if (contactFirst.trim()) {
        await createContact({
          workspaceId: workspaceId!,
          firstName: contactFirst,
          lastName: contactLast,
          email: contactEmail,
          companyId,
        });
      }
      setStep(4);
    });
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4 py-12">
      <div className="mb-8 flex justify-center">
        <LogoLockup />
      </div>

      <div className="mb-6 flex items-center justify-center gap-1.5">
        {[0, 1, 2, 3, 4].map((index) => (
          <span
            key={index}
            className={cn(
              "h-1 rounded-full transition-all duration-300",
              index === step ? "w-6 bg-brand-500" : index < step ? "w-3 bg-brand-300" : "w-3 bg-hairline",
            )}
          />
        ))}
      </div>

      <div className="rounded-2xl border border-hairline bg-panel p-6 shadow-panel">
        {step === 0 ? (
          <StepShell
            title={`Welcome, ${firstName}`}
            description="What do you actually run? A line or two is enough — it just helps you name things."
            onNext={() => {
              // Seed the workspace name from the first business they mention.
              const first = businesses.split(/[,\n]/)[0]?.trim();
              if (first && !workspaceName) setWorkspaceName(first);
              setStep(1);
            }}
            nextLabel="Continue"
            pending={pending}
          >
            <Textarea
              autoFocus
              rows={4}
              value={businesses}
              onChange={(e) => setBusinesses(e.target.value)}
              placeholder={"A consulting practice, a small agency, and a software product I'm launching."}
            />
          </StepShell>
        ) : null}

        {step === 1 ? (
          <StepShell
            title="Name your first workspace"
            description="One workspace per business. You can add more later, and switch between them in one click."
            onBack={() => setStep(0)}
            onNext={createTheWorkspace}
            nextLabel="Create workspace"
            nextDisabled={!workspaceName.trim()}
            pending={pending}
          >
            <Field label="Workspace name" required>
              <Input
                autoFocus
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="Artifact Intelligence"
              />
            </Field>
            <Field label="Colour" className="mt-3.5">
              <div className="flex gap-1.5">
                {COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setWorkspaceColor(color)}
                    className="size-8 rounded-lg transition-transform hover:scale-105"
                    style={{
                      background: color,
                      boxShadow:
                        workspaceColor === color
                          ? `0 0 0 2px var(--surface-panel), 0 0 0 4px ${color}`
                          : undefined,
                    }}
                    aria-label={`Colour ${color}`}
                  />
                ))}
              </div>
            </Field>
            <p className="mt-3 text-[12px] leading-relaxed text-faint">
              It arrives with project statuses and two pipelines already configured — better defaults over more
              setup.
            </p>
          </StepShell>
        ) : null}

        {step === 2 ? (
          <StepShell
            title="What are you working on?"
            description="Add one project. Everything else — contacts, deals, tasks, files — hangs off it."
            onBack={() => setStep(1)}
            onNext={createTheProject}
            nextLabel={projectName.trim() ? "Add project" : "Skip"}
            pending={pending}
          >
            <Field label="Project name">
              <Input
                autoFocus
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="BBOP Website Redesign"
              />
            </Field>
            <Field label="What is it?" className="mt-3.5">
              <Textarea
                rows={3}
                value={projectDescription}
                onChange={(e) => setProjectDescription(e.target.value)}
                placeholder="Full rebuild of their site, plus a donor portal."
              />
            </Field>
          </StepShell>
        ) : null}

        {step === 3 ? (
          <StepShell
            title="Who is involved?"
            description="Add one contact and their company. This is where the relationship history starts."
            onBack={() => setStep(2)}
            onNext={createTheContact}
            nextLabel={contactFirst.trim() || companyName.trim() ? "Add them" : "Skip"}
            pending={pending}
          >
            <Field label="Company">
              <Input
                autoFocus
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="BBOP Center"
              />
            </Field>
            <div className="mt-3.5 grid gap-3 sm:grid-cols-2">
              <Field label="First name">
                <Input value={contactFirst} onChange={(e) => setContactFirst(e.target.value)} placeholder="James" />
              </Field>
              <Field label="Last name">
                <Input value={contactLast} onChange={(e) => setContactLast(e.target.value)} placeholder="Okafor" />
              </Field>
            </div>
            <Field label="Email" className="mt-3.5">
              <Input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="james@bbopcenter.org"
              />
            </Field>
          </StepShell>
        ) : null}

        {step === 4 ? (
          <div className="text-center">
            <span className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400">
              <Sparkles className="size-5" />
            </span>
            <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-body">You&apos;re set up</h2>
            <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-muted">
              Tiny AI is already scoring your relationships, watching for deals going quiet and writing your
              morning brief. Press{" "}
              <kbd className="rounded border border-hairline bg-sunken px-1.5 py-0.5 font-mono text-[11px]">⌘K</kbd>{" "}
              any time to search or ask it something.
            </p>

            <ul className="mx-auto mt-5 max-w-sm space-y-2 text-left">
              {[
                "Everything important has a home and a next action",
                "Switch between businesses without losing the whole picture",
                "Tiny AI proposes changes — you approve them",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2 text-[12.5px] text-muted">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-brand-500" />
                  {line}
                </li>
              ))}
            </ul>

            <Button variant="brand" size="lg" className="mt-6 w-full" onClick={finish} loading={pending}>
              Open Tiny CRM
              <ArrowRight className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>

      {step < 4 ? (
        <button
          onClick={finish}
          disabled={pending}
          className="mx-auto mt-5 text-[12.5px] text-faint transition-colors hover:text-muted disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : "Skip setup"}
        </button>
      ) : null}
    </div>
  );
}

function StepShell({
  title,
  description,
  children,
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
  pending,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onBack?: () => void;
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  pending: boolean;
}) {
  return (
    <div>
      <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-body">{title}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{description}</p>
      <div className="mt-5">{children}</div>
      <div className="mt-6 flex items-center gap-2">
        {onBack ? (
          <Button variant="ghost" onClick={onBack} disabled={pending}>
            Back
          </Button>
        ) : null}
        <Button
          variant="brand"
          className="ml-auto"
          onClick={onNext}
          loading={pending}
          disabled={nextDisabled}
        >
          {nextLabel}
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
