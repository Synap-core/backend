/**
 * THE approved-kind writer: a kind (or role) a person approved, created as
 * that person, with the fields that rode its approval.
 *
 * ONE body for both places a kind is approved:
 *   - the `profile/create` executor (an agent's `synap_define_kind`, approved);
 *   - a capture plan's `define_kind` step (`utils/plan-callers.ts`), applied
 *     before the plan's entities so a kind and its records land together
 *     (pathway plan 368179d7, P10).
 *
 * It replays THE profile door (`profilesRouter.create`) as the approver, with
 * the provenance the proposal gives (agent-authored or not, owned by the
 * proposal for retire-on-revert lineage), then writes each carried field
 * through `createAndLinkPropertyDef` — the field writer that gives a kind its
 * own def, with a receipt (`globalField`), when its slug collides with a
 * pod-wide field (backend#1252). Each field is checked AGAIN here
 * (`ProposedKindFieldSchema`): a stored payload is data.
 *
 * What it does NOT decide: what a refused field means. The executor keeps the
 * kind and reports the field; a plan step fails the plan (all-or-none).
 */

import { TRPCError } from "@trpc/server";
import { db } from "@synap/database";
import type { Context } from "../../context.js";
import {
  createAndLinkPropertyDef,
  type CreateAndLinkPropertyDefInput,
  type CreateAndLinkPropertyDefResult,
} from "./create-and-link-property-def.js";
import { ProposedKindFieldSchema } from "./proposed-kind-field.js";

export interface ApprovedKindInput {
  /** The approving person: the profile door and every field write run as them. */
  userId: string;
  workspaceId: string;
  workspaceRole: string;
  /** The proposal that owns the row (retire-on-revert lineage). */
  proposalId: string;
  /** The proposal was filed by an agent (provenance `origin: "agent"`). */
  agentAuthored: boolean;
  /** The reviewer was shown the existing kinds: approving is their "keep both". */
  duplicateReviewed: boolean;
  slug: string;
  displayName: string;
  parentProfileId?: string;
  uiHints?: Record<string, unknown>;
  defaultValues?: Record<string, unknown>;
  scope?: "system" | "shared" | "workspace" | "user";
  entityScope?: "pod" | "workspace";
  profileKind?: "kind" | "role";
  applicableKinds?: string[];
  roleCategory?: string;
  /** The fields that rode the approval, as stored (re-parsed here). */
  kindFields: unknown[];
}

export interface ApprovedKindFieldOutcome {
  slug: string | null;
  outcome: "created" | "refused";
  reason?: string;
  /** The slug matched a pod-wide field: reused, or the kind got its own. */
  globalField?: CreateAndLinkPropertyDefResult["globalField"];
}

export interface ApprovedKindResult {
  /** The kind this approval CREATED; null when it landed on an existing one. */
  profileId: string | null;
  /** A kind of that slug already existed: nothing was created. */
  existing: boolean;
  fieldOutcomes: ApprovedKindFieldOutcome[];
}

function rawSlugOf(raw: unknown): string | null {
  return raw &&
    typeof raw === "object" &&
    typeof (raw as { slug?: unknown }).slug === "string"
    ? (raw as { slug: string }).slug
    : null;
}

export async function applyApprovedKind(
  input: ApprovedKindInput
): Promise<ApprovedKindResult> {
  // Lazy: the router imports back into proposals.
  const { profilesRouter } = await import("../../routers/profiles.js");
  const { userId, workspaceId } = input;
  const profileCaller = profilesRouter.createCaller({
    db,
    authenticated: true as const,
    userId,
    workspaceId,
    workspaceRole: input.workspaceRole,
    // Provenance (0263): server-only ctx, never tRPC input. The kind is the
    // PROPOSAL's — agent-authored when an agent filed it — and the proposal
    // owns the row (retire-on-revert lineage).
    profileProvenance: {
      origin: input.agentAuthored ? "agent" : "authored",
      ownerKind: "proposal",
      ownerId: input.proposalId,
    },
    // Server-only ctx, never input: see `profile/create`.
    duplicateReviewed: input.duplicateReviewed,
  } as unknown as Context);
  const result = await profileCaller.create({
    slug: input.slug,
    displayName: input.displayName,
    parentProfileId: input.parentProfileId,
    uiHints: input.uiHints,
    defaultValues: input.defaultValues,
    scope: input.scope,
    entityScope: input.entityScope,
    profileKind: input.profileKind,
    applicableKinds: input.applicableKinds,
    roleCategory: input.roleCategory,
  });
  // The approver IS the authority — the re-entrant gate should auto-grant. A
  // nested proposal means the approver lacks profile.create rights; surface it
  // rather than report a kind that was never built.
  if (
    result &&
    typeof result === "object" &&
    "status" in result &&
    result.status === "proposed"
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Profile approval unexpectedly re-proposed",
    });
  }

  // Only a kind THIS approval created takes the carried fields: on the
  // slug-idempotent hit (`existing: true`, a kind of that slug appeared since
  // filing) the reviewer was told a kind was being CREATED, so its fields are
  // refused and reported, never attached to someone's kind.
  const replayed = result as {
    profile?: { id?: string } | null;
    existing?: boolean;
  } | null;
  const existing = replayed?.existing === true;
  const profileId = existing ? null : (replayed?.profile?.id ?? null);
  const fieldOutcomes: ApprovedKindFieldOutcome[] = [];
  if (existing) {
    for (const raw of input.kindFields) {
      fieldOutcomes.push({
        slug: rawSlugOf(raw),
        outcome: "refused",
        reason:
          "the kind already exists, so the approval created nothing to attach it to; add it with define_kind",
      });
    }
  }
  if (profileId) {
    for (const raw of input.kindFields) {
      const parsed = ProposedKindFieldSchema.safeParse(raw);
      if (!parsed.success) {
        fieldOutcomes.push({
          slug: rawSlugOf(raw),
          outcome: "refused",
          reason: parsed.error.issues
            .map((i) => `${i.path.join(".") || "field"}: ${i.message}`)
            .join("; "),
        });
        continue;
      }
      const field = parsed.data;
      try {
        const written = await createAndLinkPropertyDef({
          userId,
          workspaceId,
          profileId,
          slug: field.slug,
          valueType:
            field.valueType as CreateAndLinkPropertyDefInput["valueType"],
          constraints: field.constraints,
          uiHints: field.uiHints,
          overlay: field.overlay === true,
          required: field.required,
          defaultValue: field.defaultValue,
          displayOrder: field.displayOrder,
        });
        fieldOutcomes.push({
          slug: field.slug,
          outcome: "created",
          ...(written?.globalField ? { globalField: written.globalField } : {}),
        });
      } catch (err) {
        // One field never undoes the kind or its siblings (the caller decides
        // what a refusal means).
        fieldOutcomes.push({
          slug: field.slug,
          outcome: "refused",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { profileId, existing, fieldOutcomes };
}
