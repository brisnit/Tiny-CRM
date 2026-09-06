"use server";

import bcrypt from "bcryptjs";
import { z } from "zod";

import { db } from "@/lib/db";
import { slugify } from "@/lib/utils";
import {
  DEFAULT_DEAL_STAGES, DEFAULT_OPPORTUNITY_STAGES, DEFAULT_PROJECT_STATUSES,
} from "@/lib/enums";

const signUpSchema = z.object({
  name: z.string().trim().min(1, "What should we call you?"),
  email: z.string().trim().toLowerCase().email("That email doesn't look right"),
  password: z.string().min(8, "Use at least 8 characters"),
});

export type SignUpResult = { ok: true } | { ok: false; error: string; field?: string };

export async function signUp(input: z.input<typeof signUpSchema>): Promise<SignUpResult> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Check the form", field: issue?.path.join(".") };
  }

  const { name, email, password } = parsed.data;

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return { ok: false, error: "An account with that email already exists.", field: "email" };
  }

  await db.user.create({
    data: {
      email,
      name,
      passwordHash: await bcrypt.hash(password, 10),
      plan: "free",
    },
  });

  // The workspace is created during onboarding, not here, so the first screen
  // after sign-up can ask what the user actually runs.
  return { ok: true };
}

const workspaceSchema = z.object({
  name: z.string().trim().min(1, "Give the workspace a name"),
  description: z.string().trim().optional(),
  color: z.string().default("#068C28"),
});

/**
 * Creates a workspace with everything it needs to be usable immediately:
 * project statuses, a deal pipeline and an opportunity pipeline. "Better
 * defaults over more settings" — a new workspace is never an empty shell.
 */
export async function createWorkspaceWithDefaults(
  userId: string,
  input: z.input<typeof workspaceSchema>,
) {
  const data = workspaceSchema.parse(input);

  // Slugs are unique per owner; disambiguate rather than reject.
  const base = slugify(data.name) || "workspace";
  let slug = base;
  for (let i = 2; await db.workspace.findFirst({ where: { ownerId: userId, slug } }); i++) {
    slug = `${base}-${i}`;
  }

  const workspace = await db.workspace.create({
    data: {
      name: data.name,
      slug,
      description: data.description,
      color: data.color,
      ownerId: userId,
      members: { create: { userId, role: "owner" } },
      projectStatuses: {
        create: DEFAULT_PROJECT_STATUSES.map((s, i) => ({
          key: s.key,
          name: s.name,
          color: s.color,
          order: i,
          isTerminal: s.isTerminal,
          isDefault: "isDefault" in s ? Boolean(s.isDefault) : false,
        })),
      },
    },
  });

  await db.pipeline.create({
    data: {
      workspaceId: workspace.id,
      name: "Sales",
      kind: "deal",
      isDefault: true,
      order: 0,
      description: "The default pipeline for new business.",
      stages: {
        create: DEFAULT_DEAL_STAGES.map((s, i) => ({
          name: s.name, order: i, probability: s.probability, color: s.color, kind: s.kind,
        })),
      },
    },
  });

  await db.pipeline.create({
    data: {
      workspaceId: workspace.id,
      name: "Opportunities",
      kind: "opportunity",
      isDefault: true,
      order: 1,
      description: "Formal solicitations, grants and partnership openings.",
      stages: {
        create: DEFAULT_OPPORTUNITY_STAGES.map((s, i) => ({
          name: s.name, order: i, probability: s.probability, color: s.color, kind: s.kind,
        })),
      },
    },
  });

  return workspace;
}
