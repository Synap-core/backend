/**
 * The ONE door that turns a template install into a governed request: the
 * checks a template apply must pass before anything is filed
 * (`admitTemplateApply`), then the filing itself (`proposeTemplateApply`).
 *
 * Extracted from Hub `POST /packages/apply` (onboarding A6) so the Hub door,
 * the IS `propose_workspace_template` seam and the onboarding setup
 * (`services/onboarding/setup.ts`) file the SAME proposal: one payload, read
 * by one approve executor (`workspace/create`, or `workspace/update` for a
 * slug already installed), which runs the one template apply as the approver.
 * Only the filing is shared; what a granted (direct) install does next stays
 * with its door.
 *
 * The payload keeps `source: "packages.apply"` whatever door filed it: the
 * approve executors key on it (layer 2 always runs; a template update routes
 * through the create body). The filing door is named by `via`, as
 * `workspaces.ensureTemplate` already does.
 */
import {
  preflightWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import type { z } from "zod";
import type { PackageApplySchema } from "../../routers/hub-protocol/rest/packages.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { installedTemplateSpace } from "../installed-template-space.js";
import {
  packageCapabilityKey,
  summarizePackageContents,
  type PackageContentsContext,
  type PackageContentsSummary,
} from "../package-contents-summary.js";
import { resolvePreflightComposeTarget } from "../preflight-compose-target.js";
import { checkOneSpacePerDomain } from "../workspace-creation-service.js";

export type PackageApplyBody = z.infer<typeof PackageApplySchema>;

type OneSpaceRefusal = Extract<
  Awaited<ReturnType<typeof checkOneSpacePerDomain>>,
  { action: "refuse" }
>;
type Preflight = Awaited<ReturnType<typeof preflightWorkspaceFromDefinition>>;

export type TemplateApplyAdmission =
  | { ok: true }
  /** A second space of a domain: typed `exists`, never filed. */
  | {
      ok: false;
      refusal: "one-space-per-domain";
      reply: OneSpaceRefusal["reply"];
    }
  /** A structural conflict with the live pod catalog (`force` never bypasses). */
  | { ok: false; refusal: "preflight"; preflight: Preflight };

/**
 * What every caller is refused BEFORE governance, so nothing is proposed that
 * could not apply: one space per domain (a fresh create only — installing
 * onto `targetWorkspaceId` mints nothing), then the write-free preflight
 * against the LIVE pod catalog (a compose apply resolves against the base it
 * would reconcile onto).
 */
export async function admitTemplateApply(input: {
  userId: string;
  body: PackageApplyBody;
}): Promise<TemplateApplyAdmission> {
  const { userId, body } = input;
  if (!body.targetWorkspaceId) {
    const packageSlug = body._meta?.slug?.trim() || undefined;
    const verdict = await checkOneSpacePerDomain({
      userId,
      packageSlug,
      idempotencyKey: packageSlug,
      workspaceName: body.workspaceName,
    });
    if (verdict.action === "refuse")
      return {
        ok: false,
        refusal: "one-space-per-domain",
        reply: verdict.reply,
      };
  }
  const preflight = await preflightWorkspaceFromDefinition({
    definition: body as unknown as WorkspaceDefinitionInput,
    userId,
    composeTarget: await resolvePreflightComposeTarget({
      definition: body,
      userId,
      targetWorkspaceId: body.targetWorkspaceId,
    }),
  });
  return preflight.ok
    ? { ok: true }
    : { ok: false, refusal: "preflight", preflight };
}

export type ProposeTemplateApplyResult =
  | { kind: "denied"; reason: string }
  | { kind: "proposed"; proposalId: string }
  /** The gate let the caller write directly: its door applies the template. */
  | { kind: "granted" };

/**
 * File the template apply through `checkPermissionOrPropose`. The FULL body
 * is stored as `definition`, so the approve executor re-runs the apply from
 * it. A slug some space already holds is a template UPDATE of that space
 * (`operation: "template_update"`, the space as target, under its real name);
 * installing onto `targetWorkspaceId` is an update of THAT space, so RBAC
 * checks the caller's role on it.
 *
 * An agent (`agentUserId`) always proposes: `workspace/create` is floored for
 * agents (governance rung 2.09) and `workspace/update` is an ADMIN action.
 */
export async function proposeTemplateApply(input: {
  userId: string;
  agentUserId?: string;
  body: PackageApplyBody;
  /** The door that filed it, when it is not the Hub `/packages/apply`. */
  via?: string;
}): Promise<ProposeTemplateApplyResult> {
  const { userId, agentUserId, body } = input;
  const packageSlug = body._meta?.slug?.trim() || undefined;
  const existingSpace =
    !body.targetWorkspaceId && packageSlug
      ? await installedTemplateSpace(packageSlug, userId)
      : null;
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId: body.targetWorkspaceId ?? null,
    subjectType: "workspace",
    action: body.targetWorkspaceId || existingSpace ? "update" : "create",
    data: {
      name:
        existingSpace?.name ??
        body.workspaceName ??
        body._meta?.slug ??
        "untitled",
      ...(existingSpace
        ? { id: existingSpace.id, operation: "template_update" }
        : {}),
      definition: body,
      // What approving brings — spaces, kinds, views, what waits on a
      // connection, and layer 2 — so the approval card shows it.
      contents: await resolvePackageContents(body),
      workspaceName: body.workspaceName,
      templateId: body._meta?.slug,
      packageSlug: body._meta?.slug,
      packageVersion: body._meta?.version,
      workspaceType: body.workspaceType,
      proposalId: packageSlug,
      createdBy: "provisioning",
      source: "packages.apply",
      ...(input.via ? { via: input.via } : {}),
      ...(body.targetWorkspaceId
        ? { targetWorkspaceId: body.targetWorkspaceId }
        : {}),
    },
  });
  if ("denied" in perm && perm.denied)
    return { kind: "denied", reason: perm.reason };
  if (
    "proposalId" in perm &&
    perm.proposalId &&
    !("granted" in perm && perm.granted)
  )
    return { kind: "proposed", proposalId: perm.proposalId };
  return { kind: "granted" };
}

/**
 * `summarizePackageContents` with what the body cannot say by itself: what
 * each capability needs connected (its definition: inline, else the pod's
 * catalog cache — a local read, never the network) and the names of the
 * spaces it requires (the template resolver, which works offline). A read
 * that fails leaves its keys unread, never "needs nothing".
 */
async function resolvePackageContents(
  body: PackageApplyBody
): Promise<PackageContentsSummary> {
  const connections = new Map<
    string,
    { kind: "provider" | "vault"; provider?: string; name?: string } | null
  >();
  const definitions = new Map<string, Record<string, unknown>>();
  const templateKeys: string[] = [];
  for (const entry of body.capabilities ?? []) {
    const key = packageCapabilityKey(entry);
    if (!key) continue;
    const inline = (entry as { definition?: unknown }).definition;
    if (inline && typeof inline === "object")
      definitions.set(key, inline as Record<string, unknown>);
    else templateKeys.push(key);
  }
  if (templateKeys.length > 0) {
    try {
      const { queryCatalogCache } =
        await import("../capabilities/catalog-cache-query.js");
      for (const row of await queryCatalogCache({ kind: "capability" }))
        if (row.definition && templateKeys.includes(row.slug))
          definitions.set(row.slug, row.definition);
    } catch {
      // Unread: those keys stay out of `connections` (→ `waitsOnUnread`).
    }
  }
  if (definitions.size > 0) {
    const { deriveConnection } =
      await import("../capabilities/capability-catalog.js");
    // No live connection state: what the capability REQUIRES, not whether
    // this person already connected it.
    const none = {
      providerConn: new Map<string, string>(),
      providerAvailable: null,
      vaultExists: new Set<string>(),
      vaultMeta: new Map<string, { name: string; service?: string }>(),
      reauthConnIds: new Set<string>(),
    };
    for (const [key, def] of definitions) {
      const tools = Array.isArray(def.tools)
        ? (def.tools as Array<{ credentialRef?: string | null }>)
        : [];
      const need = deriveConnection(
        tools.map((t) => t?.credentialRef ?? null),
        Array.isArray(def.vault) && def.vault.length > 0,
        none
      );
      const name = typeof def.name === "string" ? def.name : undefined;
      connections.set(
        key,
        need.required && need.kind
          ? {
              kind: need.kind,
              ...(need.kind === "provider" && need.provider
                ? { provider: need.provider }
                : {}),
              ...(name ? { name } : {}),
            }
          : null
      );
    }
  }

  const spaceNames = new Map<string, string>();
  const required = (body.dependencies ?? []).filter(
    (d) =>
      (d.kind ?? "workspace") === "workspace" &&
      (d.relation ?? "require") === "require"
  );
  if (required.length > 0) {
    const { resolveWorkspaceTemplate } =
      await import("../capabilities/resolve-workspace-template.js");
    for (const dep of required) {
      try {
        const name = (await resolveWorkspaceTemplate(dep.slug))
          ?.packageDefinition.workspaceName;
        if (name) spaceNames.set(dep.slug, name);
      } catch {
        // A name is a label: the space is still listed, by its slug.
      }
    }
  }
  const context: PackageContentsContext = { connections, spaceNames };
  return summarizePackageContents(body, context);
}
