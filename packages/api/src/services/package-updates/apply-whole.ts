/**
 * Apply a WHOLE-package update (`comparedBy: "package"`): a space's template
 * (its own, or an overlay pack composed onto it) or a capability. No field is
 * chosen here: each kind goes through the door that already applies it, which
 * adds what the new version brings and keeps the pod's edits. No second
 * engine.
 *
 *   workspace  — the changes to existing records the person agreed to, through
 *                the conversion engine (`runConsentedDataChanges`, the same
 *                consent rule as `POST /packages/apply`), then the ONE template
 *                apply through `installTemplateFromCatalog` (the person door:
 *                the catalog's own definition, layer 1 additive, playbooks and
 *                rules 3-way merged so an owner's edit is never overwritten,
 *                the version stamped only on convergence).
 *   capability — `reconcileCapabilitiesToTemplates` narrowed to the package's
 *                containers, with the person's consent to a `notify` policy:
 *                the engine of `capabilities.applyUpdates`.
 *
 * ONE rule for every caller (founder, 2026-11-02: "the CLI should be able to
 * do everything"): a person applies; an agent's apply is FILED for the
 * person's approval, and the approval runs the same apply as that person.
 *
 *   workspace  — `proposeTemplateApply` per space (the filing door of
 *                `POST /packages/apply`, backend#661), with the catalog body
 *                the server resolves itself; approved by `workspace/update`.
 *   capability — a `capability/capability.update` proposal; approved by its
 *                executor (`routers/proposals/executors/package-update.ts`), which
 *                runs `applyWholeUpdateAsPerson` as the approver.
 *
 * An agent never agrees to changes to existing records (Contract C): a space
 * update that has some is a `NEEDS_PERSON` refusal naming the review page,
 * never a proposal that would apply the template and leave the data behind.
 */

import { TRPCError } from "@trpc/server";
import {
  sql,
  dataChangeConsent,
  runConsentedDataChanges,
  getActingAgentUserId,
} from "@synap/database";
import {
  packageUpdateReviewPath,
  type ApplyPackageUpdateInput,
  type PackageUpdateApplyResult,
} from "@synap-core/types/package-updates";

import { reconcileCapabilitiesToTemplates } from "../capabilities/reconcile-capabilities-to-templates.js";
import { createPendingProposal } from "../../utils/permission-check.js";
import type { Context } from "../../types/context.js";
import type { InstalledPackage } from "./standing.js";
import { pendingSpaceDataChanges } from "./plan.js";
import { packageUpdateRefusal } from "./refusals.js";

type WholeInput = Pick<
  ApplyPackageUpdateInput,
  "expectedVersion" | "acceptDataChanges"
>;

/** The door name an agent's space update is filed under (`data.via`). */
export const PACKAGE_UPDATES_VIA = "package-updates.apply";

/** The data changes a space update runs first, with the person's consent. */
async function runAgreedDataChanges(
  slug: string,
  accept: string[] | undefined
): Promise<void> {
  const pending = await pendingSpaceDataChanges(slug);
  if (pending.length === 0) return;
  const consent = dataChangeConsent(pending, accept);
  if (!consent.ok) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `This update changes existing records. Agree to each change first (${consent.missing
        .map((c) => c.opKey)
        .join(", ")}). Nothing was written.`,
    });
  }
  if (consent.toRun.length === 0) return;
  const summary = await runConsentedDataChanges(
    sql,
    consent.toRun.map((c) => c.opKey)
  );
  if (summary.hadError) {
    const failed = summary.results.find((r) => r.status === "error");
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `A change to existing records failed (${failed?.opKey ?? "unknown"}: ${failed?.error ?? "no detail"}), so the template was not applied. The changes that ran are done and will not run again.`,
    });
  }
}

/** The update the caller saw still waits, at the version it saw. */
export function assertUpdateStillWaits(
  pkg: InstalledPackage,
  expectedVersion: string
): void {
  if (pkg.hasUpdate !== true) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No update waits for "${pkg.slug}".`,
    });
  }
  if (pkg.latestVersion !== expectedVersion) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `The catalog moved to ${pkg.latestVersion ?? "an unknown version"} since this update was shown (${expectedVersion}). Review it again.`,
    });
  }
}

function refuseFieldKind(pkg: InstalledPackage): never {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `"${pkg.slug}" is a ${pkg.kind}: it is updated field by field.`,
  });
}

export async function applyWholePackageUpdate(
  ctx: Context,
  pkg: InstalledPackage,
  input: WholeInput
): Promise<PackageUpdateApplyResult> {
  assertUpdateStillWaits(pkg, input.expectedVersion);
  const userId = ctx.userId as string;
  const agentUserId =
    getActingAgentUserId() ??
    ((ctx as { agentUserId?: string | null }).agentUserId || undefined);
  if (agentUserId) {
    return fileWholePackageUpdate(userId, agentUserId, pkg, input);
  }
  return applyWholeUpdateAsPerson(userId, pkg, input);
}

/**
 * The person's apply: what a person does on pod admin, and what approving an
 * agent's capability update runs (as the approver). The caller checked that
 * the update still waits (`assertUpdateStillWaits`).
 */
export async function applyWholeUpdateAsPerson(
  userId: string,
  pkg: InstalledPackage,
  input: WholeInput
): Promise<PackageUpdateApplyResult> {
  const warnings: string[] = [];

  if (pkg.kind === "workspace") {
    await runAgreedDataChanges(pkg.slug, input.acceptDataChanges);
    // Dynamic import: the workspaces router pulls a large graph, and it
    // imports services that import this module's neighbours.
    const { installTemplateFromCatalog } =
      await import("../../routers/workspaces.js");
    for (const workspaceId of pkg.workspaceIds) {
      const reply = await installTemplateFromCatalog(
        { userId, agentUserId: null },
        { slug: pkg.slug, workspaceId }
      );
      if (reply.warning) warnings.push(reply.warning);
    }
  } else if (pkg.kind === "capability") {
    const report = await reconcileCapabilitiesToTemplates({
      dryRun: false,
      containerIds: pkg.containerIds,
      // The person applying IS the consent a `notify` policy waits for.
      applyNotifyPolicy: true,
    });
    for (const c of [...report.conflicts, ...report.updatesAvailable]) {
      warnings.push(`${c.name}: ${c.reason}`);
    }
  } else {
    refuseFieldKind(pkg);
  }

  // No receipt: a receipt records field changes to undo, and a whole-package
  // update changed none (additive, the pod's edits kept). The space records
  // its own apply (`settings.template`), the capability its stamp.
  return {
    status: "applied",
    receipt: null,
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

/** An agent's whole-package update, filed for the person's approval. */
async function fileWholePackageUpdate(
  userId: string,
  agentUserId: string,
  pkg: InstalledPackage,
  input: WholeInput
): Promise<PackageUpdateApplyResult> {
  if (pkg.kind === "workspace") {
    return fileSpaceUpdate(userId, agentUserId, pkg);
  }
  if (pkg.kind === "capability") {
    const from = pkg.installedVersion ?? "an unstamped version";
    const proposal = await createPendingProposal({
      userId,
      workspaceId: null,
      targetType: "capability",
      targetId: `update:${pkg.slug}`,
      proposalType: "capability.update",
      agentUserId,
      data: {
        slug: pkg.slug,
        kind: "capability",
        name: pkg.name,
        fromVersion: pkg.installedVersion,
        // The version the agent saw: approving applies THIS one, or is
        // refused when the catalog moved since (asked again).
        toVersion: input.expectedVersion,
        containerIds: pkg.containerIds,
      },
      notificationDescription: `Update the capability "${pkg.name}" from ${from} to ${input.expectedVersion}`,
    });
    return { status: "proposed", proposalIds: [proposal.id] };
  }
  return refuseFieldKind(pkg);
}

/**
 * A space update asked by an agent: each space's template apply filed through
 * the ONE filing door (`proposeTemplateApply`), after the same admission
 * `POST /packages/apply` runs, with the body the catalog holds (never one the
 * caller sent). A slug the space holds as its own template is a
 * `template_update` of it; an overlay pack is filed onto its base space.
 */
async function fileSpaceUpdate(
  userId: string,
  agentUserId: string,
  pkg: InstalledPackage
): Promise<PackageUpdateApplyResult> {
  const pending = await pendingSpaceDataChanges(pkg.slug);
  if (pending.length > 0) {
    throw packageUpdateRefusal(
      "FORBIDDEN",
      "NEEDS_PERSON",
      `This update of "${pkg.slug}" changes existing records (${pending
        .map((c) => c.opKey)
        .join(
          ", "
        )}), which only a person agrees to. A person applies it on pod admin: ${packageUpdateReviewPath(pkg.slug)}. Nothing was filed.`,
      { reviewUrl: packageUpdateReviewPath(pkg.slug) }
    );
  }
  const [{ resolveCatalogTemplateBody, installTemplateFromCatalog }, door] =
    await Promise.all([
      import("../../routers/workspaces.js"),
      import("../../routers/workspaces/template-door.js"),
    ]);
  const { admitTemplateApply, proposeTemplateApply } =
    await import("../template-apply/propose.js");
  const { body } = await resolveCatalogTemplateBody(userId, pkg.slug);

  const proposalIds: string[] = [];
  const warnings: string[] = [];
  for (const workspaceId of pkg.workspaceIds) {
    const targetWorkspaceId = await door.installTarget(workspaceId, pkg.slug);
    const spaceBody = {
      ...body,
      ...(targetWorkspaceId ? { targetWorkspaceId } : {}),
    };
    const admission = await admitTemplateApply({ userId, body: spaceBody });
    if (!admission.ok) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          admission.refusal === "preflight"
            ? `The catalog's "${pkg.slug}" would not apply cleanly to this pod (${
                admission.preflight.validationErrors.join("; ") ||
                "a kind it declares conflicts with the pod's"
              }). Nothing was filed.`
            : admission.reply.guidance,
      });
    }
    const filed = await proposeTemplateApply({
      userId,
      agentUserId,
      body: spaceBody,
      via: PACKAGE_UPDATES_VIA,
    });
    if (filed.kind === "denied") {
      throw new TRPCError({ code: "FORBIDDEN", message: filed.reason });
    }
    if (filed.kind === "proposed") {
      proposalIds.push(filed.proposalId);
      continue;
    }
    // The gate let this agent write directly: the same apply a person runs,
    // attributed to the agent.
    const reply = await installTemplateFromCatalog(
      { userId, agentUserId },
      { slug: pkg.slug, workspaceId }
    );
    if (reply.warning) warnings.push(reply.warning);
  }
  if (proposalIds.length > 0) return { status: "proposed", proposalIds };
  return {
    status: "applied",
    receipt: null,
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}
