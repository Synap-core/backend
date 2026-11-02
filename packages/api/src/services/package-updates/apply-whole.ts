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
 * A person's act: an agent is refused with where to go (an agent cannot agree
 * to data changes, and a capability reconcile is an operator pass, like
 * `POST /capabilities/reconcile`). An agent asks for a space update through
 * `POST /packages/apply`, which files it for review.
 */

import { TRPCError } from "@trpc/server";
import {
  sql,
  dataChangeConsent,
  runConsentedDataChanges,
  getActingAgentUserId,
} from "@synap/database";
import type {
  ApplyPackageUpdateInput,
  PackageUpdateApplyResult,
} from "@synap-core/types/package-updates";

import { reconcileCapabilitiesToTemplates } from "../capabilities/reconcile-capabilities-to-templates.js";
import type { Context } from "../../types/context.js";
import type { InstalledPackage } from "./standing.js";
import { pendingSpaceDataChanges } from "./plan.js";

export const AGENT_WHOLE_PACKAGE_REFUSAL =
  "An agent cannot apply a space or capability update here: it may change existing records, which only a person agrees to. Ask a person to apply it on pod admin (Marketplace, Updates), or request it with POST /packages/apply, which files it for review.";

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

export async function applyWholePackageUpdate(
  ctx: Context,
  pkg: InstalledPackage,
  input: Pick<ApplyPackageUpdateInput, "expectedVersion" | "acceptDataChanges">
): Promise<PackageUpdateApplyResult> {
  if (
    getActingAgentUserId() ??
    (ctx as { agentUserId?: string | null }).agentUserId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: AGENT_WHOLE_PACKAGE_REFUSAL,
    });
  }
  if (pkg.hasUpdate !== true) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No update waits for "${pkg.slug}".`,
    });
  }
  if (pkg.latestVersion !== input.expectedVersion) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `The catalog moved to ${pkg.latestVersion ?? "an unknown version"} since this update was shown (${input.expectedVersion}). Review it again.`,
    });
  }
  const userId = ctx.userId as string;
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
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${pkg.slug}" is a ${pkg.kind}: it is updated field by field.`,
    });
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
