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
  revokeGuideline,
} from "@synap/database";
import {
  configSettings,
  workspaceMembers,
  CONFIG_SCOPE_KINDS,
} from "@synap/database/schema";
import { BLOCKED_REASONS } from "@synap/playbooks";

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
    text: z.string().min(1).max(2000),
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
  );

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
      const existing = await db.query.configSettings.findFirst({
        where: eq(configSettings.id, input.id),
      });
      if (!existing || existing.key !== "guideline") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Guideline not found",
        });
      }
      if (existing.revokedAt) {
        return { guideline: existing };
      }
      if (existing.createdBy !== ctx.userId) {
        if (existing.workspaceId) {
          await assertWorkspaceEditor(ctx.userId, existing.workspaceId);
        } else {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You can only revoke your own pod-wide guidelines",
          });
        }
      }
      const guideline = await revokeGuideline({ db, id: input.id });
      return { guideline };
    }),
});
