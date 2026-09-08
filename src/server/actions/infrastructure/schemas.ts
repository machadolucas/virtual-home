import "server-only";
import { z } from "zod";
import { PROJECT_KINDS, PROJECT_LINK_ENTITY_KINDS, PROJECT_STATUSES } from "@/db/schema";
import { PROJECT_ATTACHMENT_ROLES } from "@/features/projects/labels";

/**
 * Input shapes for the project actions. A separate module because a `"use server"` file may only
 * export async functions.
 *
 * Money is in **cents** everywhere (CLAUDE.md rule 5); the form parses "1 234,50 €" into 123450
 * on the client and this schema never sees a float.
 */

export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

export const projectFields = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(PROJECT_KINDS),
  status: z.enum(PROJECT_STATUSES).default("idea"),
  startedOn: localDate.nullable().optional(),
  endedOn: localDate.nullable().optional(),
  budgetCents: z.number().int().nonnegative().max(1_000_000_00).nullable().optional(),
  actualCostCents: z.number().int().nonnegative().max(1_000_000_00).nullable().optional(),
  currency: z.string().trim().length(3).nullable().optional(),
  summary: optionalText(1000),
  notes: optionalText(8000),
});

export const createProjectInput = projectFields.extend({
  idempotencyKey: z.string().min(8).max(64).optional(),
});

export const updateProjectInput = projectFields.extend({
  id: z.string().min(1).max(64),
});

export const deleteProjectInput = z.object({ id: z.string().min(1).max(64) });

export const addProjectLinkInput = z.object({
  projectId: z.string().min(1).max(64),
  entityKind: z.enum(PROJECT_LINK_ENTITY_KINDS),
  entityId: z.string().min(1).max(64),
  role: optionalText(60),
});

export const removeProjectLinkInput = z.object({ linkId: z.string().min(1).max(64) });

// Declared in `@/features/projects/labels` so a client component can import it as a value; this
// module is `server-only`.

export const addProjectAttachmentInput = z.object({
  projectId: z.string().min(1).max(64),
  attachmentId: z.string().min(1).max(64),
  role: z.enum(PROJECT_ATTACHMENT_ROLES),
});

export const removeProjectAttachmentInput = z.object({
  projectId: z.string().min(1).max(64),
  attachmentId: z.string().min(1).max(64),
  role: z.enum(PROJECT_ATTACHMENT_ROLES),
});
