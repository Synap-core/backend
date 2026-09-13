/**
 * Guidelines Router
 *
 * CRUD over `config_settings` rows with `key='guideline'` (Wave 3a) — the
 * "teach the AI a rule in plain language" door. A guideline is natural-language
 * intent the interpret pass fetches while structuring a message ("messages
 * saying 'ready for review' → set this client's playbook to 'ready for review'";
 * "for this channel, use Proton not Google Drive"). It attaches at any
 * granularity (default | channelType | bridge | channel | shape) and is injected
 * into `message.interpret`'s prompt by `resolveGuidelines`.
 *
 * The `workKind` rung scopes a guideline to a KIND OF WORK instead of a
 * transport; its `scopeRef` is a `BLOCKED_REASONS` token and this router is the
 * gate that keeps that vocabulary closed (see `CreateInputSchema`'s last
 * refine, and `SCOPE_ORDER` in `utils/config-settings.ts` for why the rung
 * ranks where it does).
 *
 * MIRRORS the governance-rules router (access floors + owner-floor + validation),
 * with ONE deliberate difference: a pod-wide (NULL-workspace) guideline is
 * OWNER-FLOORED on read (`resolveGuidelines` only applies a pod-wide row to its
 * own `created_by`), so — unlike a pod-wide GOVERNANCE rule, which is global and
 * needs pod-admin — a pod-wide guideline affects only its author and needs no
 * admin. Workspace-scoped guidelines still require editor membership (they'd bias
 * every member's interpret in that workspace).
 *
 * For v1 the `posture` field is STORED but NOT an executor: interpret's writes
 * stay proposal-gated. posture becomes load-bearing in the later
 * crystallization/patterns wave.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { assertPodAdmin } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  and,
  createGuideline,
  listGuidelines,
  listGuidelineHistory,
  revokeGuideline,
  supersedeGuideline,
  GuidelineSupersedeConflictError,
  GUIDELINE_SOURCE_KINDS,
  GUIDELINE_TEXT_MAX,
  IMPORT_SOURCE_KIND_PREFIX,
} from "@synap/database";
import {
  configSettings,
  profiles,
  proposals,
  workspaceMembers,
  CONFIG_SCOPE_KINDS,
} from "@synap/database/schema";
import type { ConfigSetting } from "@synap/database/schema";
import { BLOCKED_REASONS } from "@synap/playbooks";
import { IMPORT_SOURCE_VALUES } from "@synap-core/types";
// The `sourceKind` vocabulary gate — shared with the Hub read door and the
// correction paths, so it lives in services and every door imports it downward.
import { isGuidelineSourceKind } from "../services/guidelines/source-kind.js";
import {
  assertCanApproveStructureGuideline,
  proposeCorrectionAsGuideline,
  recordCorrectionAsGuideline,
} from "../services/guidelines/guideline-versions.js";
import { assertProposalVisibleTo } from "../utils/proposal-visibility.js";

/** A profile slug's shape; existence is checked against `profiles` on create. */
const ENTITY_KIND_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const EDITOR_ROLES = ["editor", "admin", "owner"];

async function isPodAdmin(userId: string): Promise<boolean> {
  try {
    await assertPodAdmin(userId);
    return true;
  } catch {
    return false;
  }
}

async function assertWorkspaceEditor(
  userId: string,
  workspaceId: string
): Promise<void> {
  if (await isPodAdmin(userId)) return;
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { role: true },
  });
  if (!membership || !EDITOR_ROLES.includes(membership.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Editor role or higher required for this workspace",
    });
  }
}

async function assertWorkspaceMember(
  userId: string,
  workspaceId: string
): Promise<void> {
  if (await isPodAdmin(userId)) return;
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { userId: true },
  });
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have access to this workspace",
    });
  }
}

/** Reused shape predicate validator (mirrors the MessageShapePredicate type). */
const ShapePredicateSchema = z.object({
  op: z.enum([
    "contains",
    "regex",
    "has_attachment",
    "has_url",
    "from_participant",
  ]),
  value: z.string().max(200).optional(),
});

/**
 * The scope kinds whose `scopeRef` is REQUIRED — DERIVED from the ladder rather
 * than listed by hand: every rung except `default` (which has no ref) and
 * `shape` (whose predicate lives in `shape`) is keyed on one. A rung added to
 * the enum joins this set by EXISTING, which is why `workKind` needed no edit
 * here beyond its own vocabulary gate below.
 */
const SCOPE_KINDS_NEEDING_REF = CONFIG_SCOPE_KINDS.filter(
  (k) => k !== "default" && k !== "shape"
);

const CreateInputSchema = z
  .object({
    text: z.string().min(1).max(GUIDELINE_TEXT_MAX),
    posture: z.enum(["auto", "propose"]).optional(),
    // DERIVED from the enum — see SCOPE_KINDS_NEEDING_REF.
    scopeKind: z.enum(CONFIG_SCOPE_KINDS),
    scopeRef: z.string().min(1).optional(),
    shape: ShapePredicateSchema.optional(),
    capabilityId: z.string().uuid().optional(),
    workspaceId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      !(SCOPE_KINDS_NEEDING_REF as readonly string[]).includes(v.scopeKind) ||
      !!v.scopeRef,
    {
      message: `scopeRef is required for scopeKind ${SCOPE_KINDS_NEEDING_REF.map(
        (k) => `'${k}'`
      ).join(" | ")}`,
      path: ["scopeRef"],
    }
  )
  .refine((v) => v.scopeKind !== "shape" || !!v.shape, {
    message: "shape is required when scopeKind is 'shape'",
    path: ["shape"],
  })
  /**
   * THE `workKind` VOCABULARY GATE.
   *
   * This router is the ONLY producer of `workKind` rows, and the resolver
   * matches `scopeRef` by string equality — so this refine is the whole reason
   * the rung's `scopeRef` is a CLOSED set rather than the free-text tag the
   * dead `guideline.appliesTo` was. Widening it means teaching the resolver a
   * discriminator first (see `SCOPE_ORDER` in `utils/config-settings.ts`).
   */
  .refine(
    (v) =>
      v.scopeKind !== "workKind" ||
      (BLOCKED_REASONS as readonly string[]).includes(v.scopeRef ?? ""),
    {
      message: `scopeRef must be one of ${BLOCKED_REASONS.join(
        " | "
      )} when scopeKind is 'workKind'`,
      path: ["scopeRef"],
    }
  )
  // The DATA-TYPE rungs (0258): closed input vocabulary; profile-slug output.
  .refine(
    (v) => v.scopeKind !== "sourceKind" || isGuidelineSourceKind(v.scopeRef),
    {
      message: `scopeRef must be one of ${GUIDELINE_SOURCE_KINDS.join(
        " | "
      )} or ${IMPORT_SOURCE_KIND_PREFIX}<${IMPORT_SOURCE_VALUES.join(
        " | "
      )}> when scopeKind is 'sourceKind'`,
      path: ["scopeRef"],
    }
  )
  .refine(
    (v) =>
      v.scopeKind !== "entityKind" || ENTITY_KIND_REF.test(v.scopeRef ?? ""),
    {
      message: "scopeRef must be a profile slug when scopeKind is 'entityKind'",
      path: ["scopeRef"],
    }
  );

/**
 * May `userId` READ this guideline row? Mirrors the list lens: a pod-wide row
 * only by its owner (owner floor), a workspace row by any member. Answers
 * NOT_FOUND for a pod-wide row the caller does not own, so its existence does
 * not leak.
 */
async function assertCanReadGuideline(
  userId: string,
  row: ConfigSetting
): Promise<void> {
  if (row.workspaceId) {
    await assertWorkspaceMember(userId, row.workspaceId);
  } else if (row.createdBy !== userId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Guideline not found" });
  }
}

/**
 * May `userId` CHANGE this guideline (revoke / supersede)? The author always;
 * a workspace row also any editor of that workspace (or pod admin). Gated on
 * the LOADED row, never on request input.
 */
async function assertCanChangeGuideline(
  userId: string,
  row: ConfigSetting
): Promise<void> {
  if (row.createdBy === userId) return;
  if (row.workspaceId) {
    await assertWorkspaceEditor(userId, row.workspaceId);
    return;
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "You can only change your own pod-wide guidelines",
  });
}

async function loadGuideline(id: string): Promise<ConfigSetting> {
  const existing = await db.query.configSettings.findFirst({
    where: eq(configSettings.id, id),
  });
  if (!existing || existing.key !== "guideline") {
    throw new TRPCError({ code: "NOT_FOUND", message: "Guideline not found" });
  }
  return existing;
}

export const guidelinesRouter = router({
  /**
   * List active guidelines visible in the caller's lens: pod-wide rows the caller
   * OWNS (owner-floored, matching how they resolve) plus this workspace's rows.
   * Newest first.
   */
  list: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? undefined;
      if (workspaceId) {
        await assertWorkspaceMember(ctx.userId, workspaceId);
      }
      const rows = await listGuidelines({
        db,
        userId: ctx.userId,
        workspaceId,
      });
      return { guidelines: rows };
    }),

  /** Create one guideline. See file header for the granularity → input mapping. */
  create: protectedProcedure
    .input(CreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      // Workspace-scoped guideline biases every member's interpret in that
      // workspace → editor gate. Pod-wide is owner-floored on read (affects only
      // its author), so any authenticated user may create one for themselves.
      if (input.workspaceId) {
        await assertWorkspaceEditor(ctx.userId, input.workspaceId);
      }
      // An entityKind guideline for a kind that does not exist could never
      // match — refuse it rather than store an inert row that reads as active.
      if (input.scopeKind === "entityKind") {
        const profile = await db.query.profiles.findFirst({
          where: eq(profiles.slug, input.scopeRef!),
          columns: { id: true },
        });
        if (!profile) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `No kind "${input.scopeRef}" exists in this pod`,
          });
        }
      }
      const guideline = await createGuideline({
        db,
        text: input.text,
        posture: input.posture,
        scopeKind: input.scopeKind,
        scopeRef: input.scopeRef,
        shape: input.shape,
        capabilityId: input.capabilityId,
        workspaceId: input.workspaceId,
        source: "user",
        createdBy: ctx.userId,
      });
      return { guideline };
    }),

  /**
   * Revoke a guideline (soft — sets revokedAt). The author may always revoke
   * their own; a workspace-scoped guideline may also be revoked by any editor of
   * that workspace (or pod admin).
   */
  revoke: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await loadGuideline(input.id);
      if (existing.revokedAt) {
        return { guideline: existing };
      }
      await assertCanChangeGuideline(ctx.userId, existing);
      const guideline = await revokeGuideline({ db, id: input.id });
      return { guideline };
    }),

  /**
   * Edit a guideline = SUPERSEDE it (0258): the current version is revoked and
   * version + 1 is inserted with the same scope and `supersedesId` lineage, in
   * one transaction. Only the CURRENT version can be edited — editing an older
   * one answers CONFLICT so a stale editor never forks the history. Scope is
   * not editable (a different scope is a different guideline).
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        text: z.string().min(1).max(GUIDELINE_TEXT_MAX),
        posture: z.enum(["auto", "propose"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await loadGuideline(input.id);
      await assertCanChangeGuideline(ctx.userId, existing);
      try {
        const { previous, guideline } = await supersedeGuideline({
          db,
          id: input.id,
          text: input.text,
          posture: input.posture,
          source: "user",
          createdBy: ctx.userId,
        });
        return { guideline, previous };
      } catch (err) {
        if (err instanceof GuidelineSupersedeConflictError) {
          throw new TRPCError({
            code: err.reason === "not_found" ? "NOT_FOUND" : "CONFLICT",
            message: err.message,
          });
        }
        throw err;
      }
    }),

  /**
   * Every version of the guideline `id` belongs to, newest first (revoked
   * versions included — that is the history). Readable by whoever can read
   * the row it was asked about.
   */
  history: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const existing = await loadGuideline(input.id);
      await assertCanReadGuideline(ctx.userId, existing);
      const versions = await listGuidelineHistory({ db, id: input.id });
      return { versions };
    }),

  /**
   * "Make it a rule" — a correction made on ONE proposal becomes guideline
   * text, so the next run applies it (founder D11).
   *
   * Access floor (the service leaves access to its caller):
   *   - the caller can SEE the proposal (`assertProposalVisibleTo`). A proposal
   *     that does not exist and one the caller may not see answer the SAME
   *     NOT_FOUND, so a guessed id learns nothing;
   *   - scope authority is D1's: `personal` (pod-wide, owner-floored) is the
   *     caller's own; `workspace` biases every member, so it needs a workspace
   *     editor/admin (or pod admin).
   *
   * An AGENT caller never writes: it files a `governance.structure_guideline`
   * proposal for the human it acts for, approved under the same D1/D2 rules.
   *
   * The scope rung is `default` — the whole of the caller's (or workspace's)
   * structuring. A narrower rung (source kind / entity kind) is not offered
   * from the room yet.
   */
  recordCorrection: protectedProcedure
    .input(
      z.object({
        proposalId: z.string().uuid(),
        text: z.string().trim().min(1).max(GUIDELINE_TEXT_MAX),
        scope: z.enum(["personal", "workspace"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await assertProposalVisibleTo(input.proposalId, ctx.userId);
      } catch (err) {
        if (err instanceof TRPCError && err.code === "FORBIDDEN") {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Proposal not found",
          });
        }
        throw err;
      }
      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
        columns: { workspaceId: true },
      });
      if (!proposal) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }
      if (input.scope === "workspace" && !proposal.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This proposal is not in a workspace — make it a rule just for you instead.",
        });
      }
      const scope = {
        scopeKind: "default" as const,
        scopeRef: null,
        workspaceId: input.scope === "workspace" ? proposal.workspaceId : null,
      };

      // BOTH paths: a proposal the owner floor would refuse on approve must not
      // be filed at all — a viewer's agent gets the same FORBIDDEN the viewer
      // gets, instead of a pending row nobody it acts for can ever approve.
      await assertCanApproveStructureGuideline({
        userId: ctx.userId,
        subjectUserId: ctx.userId,
        workspaceId: scope.workspaceId,
      });

      if (ctx.agentUserId) {
        const { proposalId, alreadyProposed } =
          await proposeCorrectionAsGuideline({
            userId: ctx.userId,
            agentUserId: ctx.agentUserId,
            scope,
            text: input.text,
            sourceProposalId: input.proposalId,
          });
        return { status: "proposed" as const, proposalId, alreadyProposed };
      }
      const { guideline, supersededId } = await recordCorrectionAsGuideline({
        userId: ctx.userId,
        scope,
        text: input.text,
        sourceProposalId: input.proposalId,
      });
      return { status: "saved" as const, guideline, supersededId };
    }),
});
