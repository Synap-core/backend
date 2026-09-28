/**
 * `workspace/update_brief` — the NARROW edit door for a space's brief
 * (`settings.onboarding`). Founder decision 4 (2026-09-28): not the generic
 * `workspace/update` settings replacement, which rewrites all of settings at
 * once and can lose a concurrent edit.
 *
 *   - Patches ONLY `settings.onboarding`, and inside it only the fields the
 *     patch names (a value replaces the field, `null` removes it). Untouched
 *     fields are written back BYTE-FOR-BYTE — never re-normalized — so the
 *     template reconcile's three-way stamp still reads them as untouched.
 *   - Governed through `checkPermissionOrPropose` under the `workspace/update`
 *     gate key with `operation: "update_brief"` — the precedent is
 *     `setPrimarySurface`. `workspace.update` is ADMIN-floored, so an agent
 *     ALWAYS proposes; the owner applies directly.
 *   - The proposal carries `brief.before` / `brief.after` / `changes` so the
 *     review card renders a readable per-field diff (`routers/proposals/
 *     changes.ts`), and the approval replay (`executors/workspace.ts`)
 *     re-applies the PATCH to the brief as it is then — never the stale
 *     `after` snapshot.
 *   - Writes through `WorkspaceRepository.replaceSpaceBrief`, a
 *     compare-and-set on the brief the change was computed from.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  db,
  eq,
  getDb,
  eventRepository,
  workspaces,
  WorkspaceRepository,
  type WorkspaceSpaceBrief,
  type WorkspaceSpaceTemplateRule,
} from "@synap/database";
import {
  SPACE_BRIEF_TEMPLATE_FIELDS,
  applySpaceBriefPatch,
  diffSpaceBrief,
  normalizeSpaceBrief,
  type SpaceBrief,
  type SpaceBriefFieldChange,
  type SpaceBriefPatch,
  type SpaceTemplateRule,
} from "@synap-core/types/space-brief";
import { checkPermissionOrPropose } from "../utils/permission-check.js";

// ── COMPILE FLOOR: the database mirror IS the canonical type ───────────────
// `@synap/database` cannot import `@synap-core/types` (build cycle), so it
// declares the brief once as `WorkspaceSpaceBrief`. Mutual assignability here
// — in a package that sees both — makes a field added on one side and not the
// other stop the api build. BOTH floors are needed: mutual assignability
// alone misses an added OPTIONAL key (it is assignable both ways), which the
// keyof floor catches; the keyof floor misses a changed field TYPE, which the
// assignability floor catches (each negative-controlled, 2026-09-28).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _briefMirror: Same<SpaceBrief, WorkspaceSpaceBrief> = true;
const _briefKeys: Same<keyof SpaceBrief, keyof WorkspaceSpaceBrief> = true;
const _ruleMirror: Same<SpaceTemplateRule, WorkspaceSpaceTemplateRule> = true;
void _briefMirror;
void _briefKeys;
void _ruleMirror;

const text = z.string().trim().min(1).max(2000);
const texts = z.array(text).max(20);

/** The wire shape of a brief patch — mirrors `SpaceBriefPatch`. */
export const spaceBriefPatchSchema = z
  .object({
    purpose: text.nullable(),
    goal: text.nullable(),
    framing: text.nullable(),
    expertise: z
      .object({ starters: texts, blindSpots: texts, bar: text })
      .partial()
      .nullable(),
    collect: z
      .array(
        z.object({
          profileSlug: z.string().min(1).max(100),
          what: text,
          cardinality: z.enum(["one", "few", "several"]).optional(),
          keyFields: z.array(z.string().min(1)).max(30).optional(),
          min: z.number().int().positive().optional(),
        })
      )
      .max(30)
      .nullable(),
    openingQuestions: texts.nullable(),
    doneWhen: text.nullable(),
    anchors: z
      .array(
        z.object({
          profileSlug: z.string().min(1).max(100),
          role: z.enum(["root", "context"]),
          seedRef: z.string().min(1).optional(),
          entityId: z.string().uuid().optional(),
          limit: z.number().int().positive().max(50).optional(),
        })
      )
      .max(20)
      .nullable(),
    fetch: z
      .array(
        z
          .object({
            profileSlug: z.string().min(1).max(100).optional(),
            query: text.optional(),
            note: text.optional(),
          })
          .refine((f) => f.profileSlug || f.query, {
            message: "a fetch hint needs a profileSlug or a query",
          })
      )
      .max(20)
      .nullable(),
  })
  .partial()
  .strict();

// Every patchable field has a schema key, and nothing else does.
const _patchKeys: Same<
  keyof z.infer<typeof spaceBriefPatchSchema>,
  keyof SpaceBriefPatch
> = true;
void _patchKeys;

/**
 * Apply a patch to the RAW stored brief: only the named fields change, each
 * written as its normalized value; every other field keeps its stored bytes.
 */
export function patchStoredBrief(
  raw: unknown,
  patch: SpaceBriefPatch
): WorkspaceSpaceBrief {
  const stored =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const normalized = applySpaceBriefPatch(normalizeSpaceBrief(stored), patch);
  const next: Record<string, unknown> = { ...stored };
  for (const field of SPACE_BRIEF_TEMPLATE_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = normalized[field];
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  return next as WorkspaceSpaceBrief;
}

export type UpdateSpaceBriefResult =
  | {
      status: "updated";
      workspaceId: string;
      changes: SpaceBriefFieldChange[];
    }
  | { status: "unchanged"; workspaceId: string }
  | {
      status: "proposed";
      proposalId: string;
      changes: SpaceBriefFieldChange[];
    };

async function readRawBrief(workspaceId: string): Promise<unknown> {
  const [ws] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Space not found" });
  }
  return (ws.settings as Record<string, unknown> | null)?.onboarding;
}

/**
 * Write a patch to the CURRENT brief (compare-and-set). Shared by the direct
 * path and the approval replay, so both land byte-identical results.
 */
export async function applySpaceBriefPatchNow(
  workspaceId: string,
  patch: SpaceBriefPatch,
  userId: string
): Promise<{ changes: SpaceBriefFieldChange[] }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await readRawBrief(workspaceId);
    const next = patchStoredBrief(raw, patch);
    const changes = diffSpaceBrief(
      normalizeSpaceBrief(raw),
      normalizeSpaceBrief(next)
    );
    if (changes.length === 0) return { changes };
    const repo = new WorkspaceRepository(await getDb(), eventRepository);
    if (
      await repo.replaceSpaceBrief(
        workspaceId,
        { expected: raw, brief: next },
        userId
      )
    ) {
      return { changes };
    }
  }
  throw new TRPCError({
    code: "CONFLICT",
    message:
      "The space brief kept changing while this edit was being saved. Read it again and retry.",
  });
}

/** THE door. Agents propose (ADMIN floor on `workspace.update`); the owner applies. */
export async function updateSpaceBriefGoverned(input: {
  userId: string;
  agentUserId?: string | null;
  workspaceId: string;
  patch: unknown;
  reasoning?: string;
}): Promise<UpdateSpaceBriefResult> {
  const parsed = spaceBriefPatchSchema.safeParse(input.patch);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid brief change: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "patch"}: ${i.message}`)
        .join("; ")}`,
    });
  }
  const patch = parsed.data as SpaceBriefPatch;
  if (Object.keys(patch).length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Name at least one brief field to change.",
    });
  }

  const raw = await readRawBrief(input.workspaceId);
  const before = normalizeSpaceBrief(raw);
  const after = normalizeSpaceBrief(patchStoredBrief(raw, patch));
  const changes = diffSpaceBrief(before, after);
  if (changes.length === 0) {
    return { status: "unchanged", workspaceId: input.workspaceId };
  }

  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    workspaceId: input.workspaceId,
    subjectType: "workspace",
    action: "update",
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    data: {
      id: input.workspaceId,
      operation: "update_brief",
      // Replay input: the PATCH, re-applied to the brief as it is on approval.
      patch,
      // Review input: what the reviewer sees change, field by field.
      brief: { before: before ?? {}, after: after ?? {} },
      changes,
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm && perm.proposalId) {
    return { status: "proposed", proposalId: perm.proposalId, changes };
  }

  const applied = await applySpaceBriefPatchNow(
    input.workspaceId,
    patch,
    input.userId
  );
  return {
    status: "updated",
    workspaceId: input.workspaceId,
    changes: applied.changes,
  };
}
