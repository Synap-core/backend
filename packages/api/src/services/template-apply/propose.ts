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
  getRequestGrant,
  preflightWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import { grantDeniedKey } from "../../utils/grant-write-check.js";
import { resolveWorkspaceTemplate } from "../capabilities/resolve-workspace-template.js";
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
 * The named permission an app asks for to install a package into the
 * person's pod (L7 "Add to my pod", focus plan b5e5cbfc; research 1993e7ed
 * section 5): `package.install`, requested in the app's `synap_requests` and
 * ticked by the person on the consent screen. It permits THIS act at rung 0
 * (the key's grant) in place of the broader `workspace.create` /
 * `workspace.update`, and only for a package the CATALOG fixes, never for
 * content the app wrote (`routeNamedInstall`). Every later rung runs as for
 * any write, by how an app's token acts (`podAppActsAs`,
 * routers/oauth/config.ts): a Synap app acts as the PERSON, whose own click
 * applies a catalog package directly; every other app acts as its own AGENT,
 * whose install is floored to a proposal (governance rung 2.09). The space
 * pin holds for an update of a space; a fresh install makes a new space,
 * which no pin names (`namedPermissionPermits`).
 */
export const PACKAGE_INSTALL_PERMISSION = "package.install" as const;

/** The named permission as the gate reads it, for the space the apply lands in. */
function packageInstallPermission(workspaceId: string | null) {
  return { subject: "package", action: "install", workspaceId };
}

/**
 * What an apply body may carry beside a catalog reference: which package
 * (`_meta.slug`, `_meta.version`) and where it goes. Anything else is package
 * CONTENT the caller wrote.
 */
const CATALOG_REFERENCE_PLACEMENT_KEYS = [
  "targetWorkspaceId",
  "projectId",
  "projectName",
  "agentUserId",
] as const;
const CATALOG_REFERENCE_KEYS: ReadonlySet<string> = new Set([
  "_meta",
  ...CATALOG_REFERENCE_PLACEMENT_KEYS,
]);
const CATALOG_REFERENCE_META_KEYS: ReadonlySet<string> = new Set([
  "slug",
  "version",
]);

/**
 * How an install a key reaches ONLY through `package.install` goes (the key's
 * grant does not hold `workspace.create` / `workspace.update` itself):
 *  - `unchanged`: no grant, or the grant reaches the install without the
 *    named permission: nothing here changes it.
 *  - `catalog`: the request is a CATALOG REFERENCE (a slug, an optional
 *    version, where it goes; no content) to a package the official catalog
 *    holds at that version: the door installs the catalog's own definition
 *    (`definition`), so what applies is fixed by the catalog, never by the
 *    request.
 *  - `review`: anything else (content the app wrote, a slug no catalog holds,
 *    another version): ONE proposal the person approves, whoever holds the
 *    token (`proposeTemplateApply` without `catalogFixed`), and no data
 *    change runs.
 * The person's consent at sign-in is to installing packages, never a blank
 * cheque for whatever an app sends (review finding 6, 2026-11-05).
 */
export type NamedInstallRoute =
  | { kind: "unchanged" }
  | {
      kind: "catalog";
      definition: Record<string, unknown>;
      version: string | null;
    }
  | { kind: "review" };

/**
 * Does the calling key reach this install ONLY through `package.install`
 * (its grant holds neither `workspace.create` / `workspace.update` for it, and
 * the named permission does)? Pure: it records no denial.
 */
async function installRidesNamedPermissionOnly(
  body: PackageApplyBody,
  existingSpace: { id: string } | null
): Promise<boolean> {
  const grant = getRequestGrant();
  if (!grant) return false;
  const write = {
    subjectType: "workspace",
    action: body.targetWorkspaceId || existingSpace ? "update" : "create",
    workspaceId: body.targetWorkspaceId ?? null,
  };
  if (!(await grantDeniedKey(write, grant))) return false;
  const named = packageInstallPermission(
    body.targetWorkspaceId ?? existingSpace?.id ?? null
  );
  return !(await grantDeniedKey({ ...write, namedPermission: named }, grant));
}

export async function routeNamedInstall(input: {
  userId: string;
  raw: Record<string, unknown>;
  body: PackageApplyBody;
}): Promise<NamedInstallRoute> {
  if (!getRequestGrant()) return { kind: "unchanged" };
  const { raw, body } = input;
  const packageSlug = body._meta?.slug?.trim() || undefined;
  const existingSpace =
    !body.targetWorkspaceId && packageSlug
      ? await installedTemplateSpace(packageSlug, input.userId)
      : null;
  // The grant reaches the install by itself, or the named permission does
  // not reach it either (rung 0 decides as before): not this path.
  if (!(await installRidesNamedPermissionOnly(body, existingSpace)))
    return { kind: "unchanged" };

  const meta = raw._meta;
  const isReference =
    !!packageSlug &&
    Object.keys(raw).every((k) => CATALOG_REFERENCE_KEYS.has(k)) &&
    (meta === undefined ||
      (typeof meta === "object" &&
        meta !== null &&
        Object.keys(meta).every((k) => CATALOG_REFERENCE_META_KEYS.has(k))));
  if (!isReference) return { kind: "review" };
  const resolved = await resolveWorkspaceTemplate(packageSlug);
  if (!resolved) return { kind: "review" };
  const asked = body._meta?.version;
  if (asked !== undefined && asked !== resolved.version)
    return { kind: "review" };
  return {
    kind: "catalog",
    definition: resolved.packageDefinition as unknown as Record<
      string,
      unknown
    >,
    version: resolved.version ?? null,
  };
}

/**
 * The apply body a `catalog` route installs: the catalog's own definition,
 * with only where it goes taken from the request (`targetWorkspaceId`,
 * `projectId`, `projectName`, `agentUserId`) and the slug it was asked by.
 * The caller parses it (`PackageApplySchema`) as any apply body.
 */
export function expandCatalogReference(
  raw: Record<string, unknown>,
  route: Extract<NamedInstallRoute, { kind: "catalog" }>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...route.definition };
  for (const k of CATALOG_REFERENCE_PLACEMENT_KEYS)
    if (raw[k] !== undefined) out[k] = raw[k];
  const defMeta =
    typeof route.definition._meta === "object" && route.definition._meta
      ? (route.definition._meta as Record<string, unknown>)
      : {};
  const askedMeta = raw._meta as { slug?: unknown } | undefined;
  out._meta = {
    ...defMeta,
    slug: askedMeta?.slug,
    ...(route.version ? { version: route.version } : {}),
  };
  return out;
}

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
 * An update stays a proposal even when the agent's key grant leaves out
 * `workspace.update` (`proposeBeyondGrant`); a create beyond the grant is
 * denied. A key holding `package.install` (PACKAGE_INSTALL_PERMISSION) is
 * permitted the install at rung 0, then governed like any write.
 */
export async function proposeTemplateApply(input: {
  userId: string;
  agentUserId?: string;
  body: PackageApplyBody;
  /** The door that filed it, when it is not the Hub `/packages/apply`. */
  via?: string;
  /**
   * The body IS the official catalog's definition (`routeNamedInstall` said
   * `catalog`, or a door that installs from the catalog). Without it, an
   * install the key reaches only through `package.install` is content the
   * caller wrote: filed as ONE proposal even on a person's token (the gate's
   * untrusted-issuer rung), never applied directly. Safe by default.
   */
  catalogFixed?: boolean;
}): Promise<ProposeTemplateApplyResult> {
  const { userId, agentUserId, body } = input;
  const packageSlug = body._meta?.slug?.trim() || undefined;
  const existingSpace =
    !body.targetWorkspaceId && packageSlug
      ? await installedTemplateSpace(packageSlug, userId)
      : null;
  const isUpdate = !!(body.targetWorkspaceId || existingSpace);
  const review =
    !input.catalogFixed &&
    (await installRidesNamedPermissionOnly(body, existingSpace));
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId: body.targetWorkspaceId ?? null,
    subjectType: "workspace",
    action: isUpdate ? "update" : "create",
    // An agent's key whose grant leaves out `workspace.update` (the AI
    // preset: "Space administration") ASKS for a template update instead of
    // being refused (founder, 2026-11-02): a pending proposal the person
    // approves; the key itself still cannot apply it. A fresh install
    // (`workspace.create`) stays refused.
    proposeBeyondGrant: isUpdate,
    // `package.install` permits this act at rung 0 (see above).
    grantNamedPermission: packageInstallPermission(
      body.targetWorkspaceId ?? existingSpace?.id ?? null
    ),
    // App-written content reaching the install only through the named
    // permission: always reviewed, even on a person's token (`catalogFixed`).
    ...(review ? { issuer: { kind: "connector", trusted: false } } : {}),
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
export async function resolvePackageContents(
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
