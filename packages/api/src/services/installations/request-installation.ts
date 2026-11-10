/**
 * The ask for a capability on one of the person's computers: ONE rule, two
 * doors (Hub REST `POST /installations/request` and MCP
 * `synap_request_installation`). Reconciliation f75fbb48 §3.4, founder
 * 2026-11-07 and 2026-11-08 ("an AI can ask to add a capability from the
 * marketplace and choose which computer to install it on, and the person
 * accepts, closing the loop").
 *
 *   requestInstallation   install, update, verify or remove one capability on
 *                         one computer. A person's ask applies; an agent's
 *                         install, update or removal is ONE proposal
 *                         (`installation/request`). With `fromCatalog`, a
 *                         capability the pod does not have yet is checked
 *                         against Synap's catalog definition, and the same
 *                         proposal adds it on approval: one card, "add X and
 *                         install it on Mac".
 *   requestPodInstall     the pod itself as the target: a capability that
 *                         runs on the pod is added from the catalog through
 *                         the one marketplace door (`runMarketInstall`: an
 *                         agent proposes `capability.install`).
 *   loadCatalogCapability where a catalog capability runs (pod, computer,
 *                         which systems) and its licence, from its definition.
 *   computerChoices       each of the person's computers, and whether this
 *                         capability can go on it (and why not).
 *
 * A refusal is an answer with a code and a reason the caller can act on, never
 * a throw: a computer whose system it does not support, a computer without
 * "Installs from the pod", a pod capability sent to a computer, or the
 * reverse.
 */

import { TRPCError } from "@trpc/server";
import { db, eq } from "@synap/database";
import { capabilities } from "@synap/database/schema";
import {
  CapabilityComputerSpecSchema,
  installKind,
  pickComputerSpec,
} from "@synap-core/types/capability-manifest";
import { platformLabel } from "@synap-core/types/computers";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import { listMachines } from "../machine-roster.js";
import {
  applyInstallationRequest,
  computerRefOf,
  InstallationRequestError,
  installRefusal,
  loadInstallableCapability,
  loadLiveInstallation,
  reconcileInstallation,
  repairKindFor,
  requestNeedsApproval,
  type ComputerRef,
  type InstallableCapability,
  type InstallationRequestAction,
} from "./installations.js";

// ── Where a capability runs ─────────────────────────────────────────────────

/** A capability in Synap's catalog, as far as where it runs is concerned. */
export interface CatalogCapability {
  capabilityKey: string;
  name: string;
  version: string | null;
  /** Where it runs: `["pod"]` when it declares no placement. */
  runsOn: Array<"pod" | "computer">;
  /** The systems it installs on (`process.platform` values), when it runs on a computer. */
  platforms: string[];
  licence: string | null;
  /** Its computer blocks and kind, when it can be installed on a computer. */
  installable: {
    manifest: Record<string, unknown>;
    kind: "service" | "tool";
  } | null;
}

function runsOnOf(
  spec: Record<string, unknown> | null
): Array<"pod" | "computer"> {
  const runsOn = (spec?.placement as { runsOn?: unknown } | undefined)?.runsOn;
  if (!Array.isArray(runsOn)) return ["pod"];
  const out = runsOn.filter(
    (r): r is "pod" | "computer" => r === "pod" || r === "computer"
  );
  return out.length > 0 ? out : ["pod"];
}

function platformsOf(spec: Record<string, unknown> | null): string[] {
  const platforms = (spec?.placement as { platforms?: unknown } | undefined)
    ?.platforms;
  if (!Array.isArray(platforms)) return [];
  return [
    ...new Set(
      platforms
        .map((p) => (p as { os?: unknown })?.os)
        .filter((os): os is string => typeof os === "string")
    ),
  ];
}

/**
 * Where a capability DEFINITION runs, and what it would install on a
 * computer. Pure; the catalog read and the search projection share it.
 */
export function describePlacement(
  capabilityKey: string,
  definition: Record<string, unknown>,
  version: string | null
): CatalogCapability {
  const spec = pickComputerSpec(definition);
  let installable: CatalogCapability["installable"] = null;
  if (spec) {
    const parsed = CapabilityComputerSpecSchema.safeParse(spec);
    const kind = parsed.success ? installKind(parsed.data) : null;
    if (kind) installable = { manifest: spec, kind };
  }
  return {
    capabilityKey,
    name: typeof definition.name === "string" ? definition.name : capabilityKey,
    version:
      version ??
      (typeof definition.version === "string" ? definition.version : null),
    runsOn: runsOnOf(spec),
    platforms: platformsOf(spec),
    licence: typeof spec?.licence === "string" ? spec.licence : null,
    installable,
  };
}

/**
 * A capability of Synap's own catalog by key, read from its definition (the
 * cached row, else the Control Plane by key, signature-checked: the same
 * resolution an install applies). Null when the catalog has no such
 * capability.
 */
export async function loadCatalogCapability(
  capabilityKey: string
): Promise<CatalogCapability | null> {
  const { lookupCatalogEntry, resolveCatalogDefinition } =
    await import("../capabilities/marketplace-install.js");
  const { capabilityElementOf } =
    await import("../capabilities/package-element.js");
  const entry = await lookupCatalogEntry("capability", capabilityKey, null);
  const definition = await resolveCatalogDefinition(
    "capability",
    capabilityKey,
    entry
  );
  if (!definition) return null;
  return describePlacement(
    capabilityKey,
    capabilityElementOf(definition) as Record<string, unknown>,
    entry?.version ?? null
  );
}

/**
 * Does the pod's copy of the marketplace list a capability by this key? Read
 * from the cached catalog only (no Control Plane call): it words a refusal,
 * it decides nothing. A retired entry is not offered, so it does not count.
 */
async function inCatalogCache(capabilityKey: string): Promise<boolean> {
  const { lookupCatalogEntry } =
    await import("../capabilities/marketplace-install.js");
  try {
    return !!(await lookupCatalogEntry("capability", capabilityKey, null));
  } catch (err) {
    if (err instanceof TRPCError && err.code === "PRECONDITION_FAILED")
      return false;
    throw err;
  }
}

/** Is a capability with this catalog key on the pod (whatever it runs on)? */
async function capabilityOnPod(capabilityKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(eq(capabilities.templateKey, capabilityKey))
    .limit(1);
  return !!row;
}

// ── The person's computers ──────────────────────────────────────────────────

/**
 * The person's computers, by name, read through the ONE roster
 * (`machine-roster.ts` `listMachines`, what pod admin and `machines.list`
 * show), as the doors name a computer.
 */
export async function listPersonsComputers(
  personId: string
): Promise<ComputerRef[]> {
  return (await listMachines(personId))
    .map((m) => computerRefOf(personId, m))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What a computer is called in words a person says: any case, no `.local`. */
function plainName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.local$/, "");
}

/** The words of a name: "MacBook-Pro-de-Antoine" → macbook, pro, de, antoine. */
function wordsOf(name: string): string[] {
  return plainName(name)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A system as a person names it ("my Mac") → `process.platform`. */
const SYSTEM_ALIASES: Record<string, string> = {
  mac: "darwin",
  macos: "darwin",
  linux: "linux",
  windows: "win32",
};

export type ComputerMatch =
  | { status: "found"; computer: ComputerRef }
  | { status: "ambiguous"; candidates: ComputerRef[] }
  | { status: "not_found" };

/**
 * Which of these computers a caller means by `ref`, the way a person names
 * one ("install it on my Mac"). The first rung that matches decides:
 *
 *   1. its id;
 *   2. its exact name;
 *   3. its name in any case, a trailing `.local` ignored on both sides (the
 *      Mac calls itself `MacBook-Pro.local`, the CLI `MacBook-Pro`);
 *   4. a prefix of its name, or each word of `ref` starting a word of its
 *      name ("macbook", "pro");
 *   5. a system: "mac" / "macos", "linux", "windows" → the person's only
 *      computer on it.
 *
 * Two computers on the deciding rung answer `ambiguous` with both: it never
 * guesses between them. Pure.
 */
export function matchComputer(
  computers: readonly ComputerRef[],
  ref: string
): ComputerMatch {
  const raw = ref.trim();
  const wanted = plainName(raw);
  const words = wordsOf(raw);
  const rungs: Array<(c: ComputerRef) => boolean> = [
    (c) => c.id === raw,
    (c) => c.name === raw,
    (c) => plainName(c.name) === wanted,
    (c) => {
      const own = wordsOf(c.name);
      return (
        plainName(c.name).startsWith(wanted) ||
        (words.length > 0 &&
          words.every((w) => own.some((o) => o.startsWith(w))))
      );
    },
    (c) => !!SYSTEM_ALIASES[wanted] && c.os === SYSTEM_ALIASES[wanted],
  ];
  if (!wanted) return { status: "not_found" };
  for (const rung of rungs) {
    const hits = computers.filter(rung);
    if (hits.length === 1) return { status: "found", computer: hits[0]! };
    if (hits.length > 1) return { status: "ambiguous", candidates: hits };
  }
  return { status: "not_found" };
}

/**
 * One of the person's computers as a caller names it (`matchComputer`), with
 * all of them for a refusal to choose again from.
 */
export async function findPersonsComputer(
  personId: string,
  ref: string
): Promise<ComputerMatch & { computers: ComputerRef[] }> {
  const computers = await listPersonsComputers(personId);
  return { ...matchComputer(computers, ref), computers };
}

/** A computer as an agent chooses among them. */
export interface ComputerChoice {
  id: string;
  name: string;
  system: string | null;
  arch: string | null;
  installsFromPod: boolean;
  /** Can this capability go on it? Absent when no capability is in question. */
  canInstall?: boolean;
  /** Why not, in words. */
  why?: string;
}

/** Why this capability cannot go on this computer, with a code; null when it can. */
export function computerRefusal(
  manifest: Record<string, unknown>,
  computer: ComputerRef
): { reason: CannotInstallReason; error: string } | null {
  const error = installRefusal({ manifest }, computer);
  if (!error) return null;
  if (!computer.installsFromPod)
    return { reason: "INSTALLS_FROM_POD_OFF", error };
  if (!runsOnOf(manifest).includes("computer"))
    return { reason: "RUNS_ON_POD", error };
  return { reason: "UNSUPPORTED_COMPUTER", error };
}

/**
 * The computer has not reported its processor, and this capability runs only
 * on some processors of its system: allowed (the computer's runner checks
 * it before any step runs), with the why saying so.
 */
function archUnknownMatters(
  manifest: Record<string, unknown>,
  computer: ComputerRef
): boolean {
  if (computer.arch || !computer.os) return false;
  const platforms = (manifest.placement as { platforms?: unknown } | undefined)
    ?.platforms;
  if (!Array.isArray(platforms)) return false;
  return platforms.some(
    (p: { os?: unknown; arch?: unknown }) =>
      p?.os === computer.os && Array.isArray(p.arch) && p.arch.length > 0
  );
}

/** The person's computers, each with whether this capability fits it. */
export function computerChoices(
  computers: ComputerRef[],
  manifest?: Record<string, unknown> | null
): ComputerChoice[] {
  return computers.map((c) => {
    const base: ComputerChoice = {
      id: c.id,
      name: c.name,
      system: platformLabel(c.os),
      arch: c.arch,
      installsFromPod: c.installsFromPod,
    };
    if (manifest === undefined) return base;
    const refusal = manifest ? computerRefusal(manifest, c) : null;
    return manifest && !refusal
      ? {
          ...base,
          canInstall: true,
          ...(archUnknownMatters(manifest, c)
            ? {
                why: "Its processor is not known yet: it runs only on some processors, and the computer checks that before it installs.",
              }
            : {}),
        }
      : {
          ...base,
          canInstall: false,
          why: refusal?.error ?? "It runs on the pod, not on a computer.",
        };
  });
}

/** Where a catalog capability runs, as both catalog reads show it. */
export interface CatalogPlacement {
  /** Absent for an entry that is not a capability, or carries no definition. */
  runsOn?: Array<"pod" | "computer">;
  systems?: string[];
  licence?: string | null;
  computers?: ComputerChoice[];
}

/**
 * The ONE placement projection of a catalog capability for one person: what
 * `market.search` and `synap_find`'s marketplace arm add to each capability
 * entry, so the two reads can never disagree. A capability that runs on a
 * computer adds its systems, its licence and the person's computers, each
 * with `canInstall` or `why` not (`computerChoices`). The person's computers
 * are read once per reader, only when an entry runs on a computer.
 */
export function catalogPlacementReader(
  personId: string
): (entry: {
  kind: string;
  slug: string;
  version: string | null;
  definition: Record<string, unknown> | null;
}) => Promise<CatalogPlacement> {
  let computers: Promise<ComputerRef[]> | null = null;
  return async (entry) => {
    if (entry.kind !== "capability" || !entry.definition) return {};
    const { capabilityElementOf } =
      await import("../capabilities/package-element.js");
    const p = describePlacement(
      entry.slug,
      capabilityElementOf(entry.definition) as Record<string, unknown>,
      entry.version
    );
    if (!p.runsOn.includes("computer")) return { runsOn: p.runsOn };
    computers ??= listPersonsComputers(personId);
    return {
      runsOn: p.runsOn,
      systems: p.platforms,
      licence: p.licence,
      computers: computerChoices(
        await computers,
        p.installable?.manifest ?? null
      ),
    };
  };
}

// ── The ask ─────────────────────────────────────────────────────────────────

export type CannotInstallReason =
  | "INSTALLS_FROM_POD_OFF"
  | "UNSUPPORTED_COMPUTER"
  | "RUNS_ON_POD"
  | "RUNS_ON_COMPUTER";

export type InstallationAsk =
  | {
      status: "approved";
      installationId: string;
      jobId: string | null;
    }
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl?: string;
      message: string;
    }
  | {
      status: "refused";
      code:
        | "NOT_INSTALLABLE"
        | "NOT_IN_CATALOG"
        | "NOT_INSTALLED"
        | "CANNOT_INSTALL"
        | "DENIED";
      /** For CANNOT_INSTALL: which check refused it. */
      reason?: CannotInstallReason;
      error: string;
      httpStatus: 403 | 404 | 409;
      /** The computer blocks it was checked against, for `computerChoices`. */
      manifest?: Record<string, unknown>;
    };

type Refused = Extract<InstallationAsk, { status: "refused" }>;

function refused(
  httpStatus: 403 | 404 | 409,
  code: Refused["code"],
  error: string,
  reason?: CannotInstallReason,
  manifest?: Record<string, unknown>
): Refused {
  return {
    status: "refused",
    code,
    error,
    httpStatus,
    ...(reason ? { reason } : {}),
    ...(manifest ? { manifest } : {}),
  };
}

export interface InstallationAskInput {
  userId: string;
  agentUserId: string | null;
  computer: ComputerRef;
  capabilityKey: string;
  action: InstallationRequestAction;
  version?: string | null;
  sessionId?: string;
  /**
   * The pod does not have the capability yet: check it against Synap's
   * catalog definition, and add it from the catalog when the install is
   * approved (one proposal). Off for the computer's own REST ask.
   */
  fromCatalog?: boolean;
  /**
   * The POD files this ask on its own (self-heal: "try again" once its
   * retries stopped, or a prerequisite nobody approved): always ONE proposal
   * for the person, one tap, even for a repair that would otherwise ask
   * nobody; authored by `author`, with this sentence on the card.
   */
  filedByPod?: { author: `system:${string}`; reasoning: string };
}

/** What the proposal carries to add a catalog capability on approval. */
export interface CatalogAddition {
  slug: string;
  name: string;
  version: string | null;
  licence: string | null;
}

/**
 * A version a person can read. A catalog capability's version is the Control
 * Plane's content hash (`h-<12 hex>`): it pins what the approval installs
 * (`catalog.version`, checked again on approval) but means nothing to a
 * person, so the sentence leaves it out.
 */
function readableVersion(version: string | null): string | null {
  return version && !version.startsWith("h-") ? version : null;
}

/** The sentence the approval card shows. */
function reasoningFor(
  input: InstallationAskInput,
  live: boolean,
  addition: CatalogAddition | null
): string {
  const { capabilityKey: key, computer } = input;
  if (input.action === "remove")
    return `Remove ${key} from ${computer.name}: its removal steps run on that computer.`;
  if (addition) {
    const what = [
      readableVersion(addition.version) ? `version ${addition.version}` : null,
      addition.licence ? `licence ${addition.licence}` : null,
    ].filter(Boolean);
    return `Add "${addition.name}" (${key}${what.length ? `, ${what.join(", ")}` : ""}) from the marketplace to the pod, then install it on ${computer.name}: its install steps run on that computer, then it is checked.`;
  }
  return live
    ? `Change ${key} on ${computer.name} to version ${input.version ?? "latest"}: its install steps run again on that computer.`
    : `Install ${key} on ${computer.name}: its install steps run on that computer, then it is checked.`;
}

/**
 * Add a catalog capability to the pod as the person who approved an agent's
 * ask (the `installation/request` executor, which declares
 * `widensCredential`), through the one marketplace applier, and read it back
 * with its computer blocks.
 */
export async function addCatalogCapability(
  addition: CatalogAddition,
  approverId: string
): Promise<InstallableCapability | null> {
  const { applyMarketInstall } =
    await import("../capabilities/marketplace-install.js");
  await applyMarketInstall({
    kind: "capability",
    slug: addition.slug,
    version: addition.version,
    params: {},
    userId: approverId,
    workspaceId: null,
  });
  return loadInstallableCapability(addition.slug);
}

/**
 * Ask for a capability on one of the person's computers. Approval is once
 * per (capability, computer): a verify, or an install of the version already
 * approved (a repair), asks nobody. The computer must have "Installs from
 * the pod" on and the capability's placement must allow it.
 */
export async function requestInstallation(
  input: InstallationAskInput
): Promise<InstallationAsk> {
  const { computer, capabilityKey: key } = input;
  const capability = await loadInstallableCapability(key);
  let addition: CatalogAddition | null = null;
  let manifest: Record<string, unknown>;
  let kind: "service" | "tool";

  if (capability) {
    manifest = capability.manifest;
    kind = capability.kind;
  } else {
    if (!input.fromCatalog)
      return refused(
        404,
        "NOT_INSTALLABLE",
        (await inCatalogCache(key))
          ? `${key} is in the marketplace but not on this pod yet: add it with \`synap market install ${key}\`, or ask an agent to install it on this computer.`
          : `${key} is not a capability this pod can install on a computer.`
      );
    if (await capabilityOnPod(key))
      return refused(
        409,
        "CANNOT_INSTALL",
        `${key} runs on the pod, not on a computer, and it is already on the pod.`,
        "RUNS_ON_POD"
      );
    const catalog = await loadCatalogCapability(key);
    if (!catalog)
      return refused(
        404,
        "NOT_IN_CATALOG",
        `${key} is not in Synap's marketplace. Search it with market.search (synap_run_capability) and use the slug it returns.`
      );
    if (!catalog.installable)
      return refused(
        409,
        "CANNOT_INSTALL",
        `${key} runs on the pod, not on a computer: ask again with computer "pod".`,
        "RUNS_ON_POD"
      );
    if (input.action !== "install")
      return refused(
        409,
        "NOT_INSTALLED",
        `${key} is not on the pod yet, so nothing is installed to ${input.action}: ask to install it.`
      );
    manifest = catalog.installable.manifest;
    kind = catalog.installable.kind;
    addition = {
      slug: key,
      name: catalog.name,
      version: catalog.version,
      licence: catalog.licence,
    };
  }

  const live = capability ? await loadLiveInstallation(computer.id, key) : null;

  if (input.action === "verify") {
    if (!live || live.status !== "installed")
      return refused(
        409,
        "NOT_INSTALLED",
        `${key} is not installed on ${computer.name}.`
      );
    const jobId = await reconcileInstallation(live, { kind: "verify" });
    return { status: "approved", installationId: live.id, jobId };
  }
  if (input.action === "remove" && !live)
    return refused(
      409,
      "NOT_INSTALLED",
      `${key} is not installed on ${computer.name}.`
    );
  if (input.action !== "remove") {
    const refusal = computerRefusal(manifest, computer);
    if (refusal)
      return refused(
        409,
        "CANNOT_INSTALL",
        refusal.error,
        refusal.reason,
        manifest
      );
  }

  // Approved once for this pair at this version: a repair asks nobody.
  if (live && !input.filedByPod && !requestNeedsApproval(live, input)) {
    const jobId = await reconcileInstallation(live, {
      kind: repairKindFor(live),
    });
    return { status: "approved", installationId: live.id, jobId };
  }

  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    agentUserId: input.agentUserId ?? undefined,
    workspaceId: null,
    subjectType: "installation",
    action: "request",
    // Filed for the person even when the agent's key grant does not name
    // it: approval is the person's, and an agent always proposes
    // (reconciliation f75fbb48 §3.4.1, founder 2026-11-07; decision 168f34db
    // §2). The AI preset excludes installation.request, so without this an
    // agent's ask would be refused, never filed.
    proposeBeyondGrant: true,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.filedByPod
      ? { forcePropose: true, machineAuthor: input.filedByPod.author }
      : {}),
    // The pod's own sentence; a marketplace addition still says so.
    reasoning: input.filedByPod
      ? addition
        ? `${input.filedByPod.reasoning} ${reasoningFor(input, !!live, addition)}`
        : input.filedByPod.reasoning
      : reasoningFor(input, !!live, addition),
    data: {
      id: computer.id,
      computerId: computer.id,
      computerName: computer.name,
      capabilityKey: key,
      kind,
      action: input.action,
      ...(input.version ? { version: input.version } : {}),
      // Approving adds it from the catalog first (the executor re-reads the
      // catalog definition and checks the computer again).
      ...(addition ? { catalog: addition } : {}),
    },
  });
  if ("denied" in perm && perm.denied)
    return refused(403, "DENIED", perm.reason ?? "Not permitted");
  if ("proposalId" in perm && perm.proposalId)
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      ...(perm.reviewUrl ? { reviewUrl: perm.reviewUrl } : {}),
      message: proposedMessageFor(
        perm.proposalType,
        addition
          ? "Proposed: once the person approves it, the pod adds it from the marketplace and the computer installs it."
          : "Proposed: the computer acts on it once the person approves it."
      ),
    };

  // The person's own ask, applied. Adding from the catalog is done only by
  // approving an agent's proposal (the executor declares
  // `widensCredential`: an install may grant a secret or enrol an agent): a
  // person adds it from the Marketplace, which asks for that sign-in.
  if (!capability)
    return refused(
      409,
      "NOT_INSTALLABLE",
      `${key} is not on the pod yet: add it from the Marketplace first, then ask again.`
    );
  try {
    const out = await applyInstallationRequest({
      computer,
      capability,
      action: input.action,
      version: input.version ?? null,
      approverId: input.userId,
    });
    return {
      status: "approved",
      installationId: out.installation.id,
      jobId: out.jobId,
    };
  } catch (err) {
    if (err instanceof InstallationRequestError)
      return refused(409, err.code, "Nothing is installed to remove.");
    throw err;
  }
}

// ── The pod as the target ──────────────────────────────────────────────────

export type PodInstallAsk =
  | { status: "already_on_pod"; capabilityKey: string }
  | { status: "installed"; result: Record<string, unknown> }
  | { status: "proposed"; proposalId: string; reviewUrl: string }
  | Refused;

/**
 * Add a capability that runs on the pod, from Synap's catalog, through the
 * one marketplace door (an agent proposes `capability.install`). A
 * capability that runs only on a computer is refused with the computers
 * that can take it named by the caller.
 */
export async function requestPodInstall(input: {
  userId: string;
  agentUserId: string | null;
  capabilityKey: string;
}): Promise<PodInstallAsk> {
  const key = input.capabilityKey;
  const onPod = await loadInstallableCapability(key);
  if (onPod && !runsOnOf(onPod.manifest).includes("pod"))
    return refused(
      409,
      "CANNOT_INSTALL",
      `${key} runs on a computer, not on the pod: name one of the person's computers.`,
      "RUNS_ON_COMPUTER",
      onPod.manifest
    );
  if (await capabilityOnPod(key))
    return { status: "already_on_pod", capabilityKey: key };
  const catalog = await loadCatalogCapability(key);
  if (!catalog)
    return refused(
      404,
      "NOT_IN_CATALOG",
      `${key} is not in Synap's marketplace. Search it with market.search (synap_run_capability) and use the slug it returns.`
    );
  if (!catalog.runsOn.includes("pod"))
    return refused(
      409,
      "CANNOT_INSTALL",
      `${key} runs on a computer, not on the pod: name one of the person's computers.`,
      "RUNS_ON_COMPUTER",
      catalog.installable?.manifest
    );
  const { runMarketInstall } =
    await import("../capabilities/marketplace-install.js");
  return runMarketInstall({
    slug: key,
    kind: "capability",
    userId: input.userId,
    workspaceId: null,
    agentUserId: input.agentUserId,
  });
}
