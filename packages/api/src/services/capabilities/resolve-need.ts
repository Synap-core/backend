/**
 * RESOLVE ONE NEED BY INTENT (plan U5, addendum 000e75ff §5).
 *
 * A capability needs `expose_http` for its studio. Which installed capability
 * serves it, on what terms, and if none does, which catalog pack could?
 *
 *   1. INSTALLED providers: containers under the caller's lens whose
 *      `metadata.offers[intent]` meets the need (`offerMisfit`), and whose
 *      executable verbs cover the contract's required ops (`opsMisfit`). A
 *      COMPOSITE (`metadata.compose[intent]`) fits only when each of its own
 *      needs resolves the same way, recursively (depth ≤ 3, cycles refused).
 *      A provider that does not fit is kept as a MISFIT, with the reason, so a
 *      person sees why it is greyed out.
 *   2. Decide: one fit → `one`; several → `several`, with the remembered
 *      default (`intent_defaults`) when one matches; none → `none`, with the
 *      catalog packs that declare the intent AND fit (the same rule,
 *      `selectIntentProviders`).
 *   3. A READ never files anything. Only a write door passes `propose`, and
 *      only then does `none` call `resolveIntentGap`, which files one
 *      `capability.install` proposal (`gapOffer`).
 *
 * A read that FAILED is `failed`, never `none`: "nothing provides this" and
 * "we could not look" are different facts.
 *
 * Routing, never authorization: a fit names a provider; running its verbs
 * still goes through the grant gate.
 *
 * The decision is the PURE core (`resolveNeedCore`) over a `ResolveWorld`;
 * `resolveNeed` loads that world for one caller.
 */
import { createHash } from "node:crypto";
import { db, and, eq, inArray, isNull, or, drizzleSql } from "@synap/database";
import { capabilities, intentDefaults, skills } from "@synap/database/schema";
import {
  isIntentOp,
  type IntentContract,
  type IntentOp,
} from "@synap-core/types/capability-intents";
import type {
  ComposeEntry,
  ManifestNeed,
  ManifestOffer,
} from "@synap-core/types/capability-manifest";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import {
  listCapabilities,
  type CapabilityRegistryContext,
} from "./capability-registry.js";
import { canonicalJson } from "./capability-drift.js";
import { loadIntentContracts } from "./intent-registry.js";
import { offerMisfit, opsMisfit } from "./offer-match.js";
import {
  resolveIntentGap,
  selectIntentProviders,
  type IntentInstallOffer,
  type IntentProviderCandidate,
} from "./propose-intent-gap-install.js";

/** A composite may nest composites this deep, no further. */
export const MAX_COMPOSE_DEPTH = 3;

/** What a need asks for: an intent and its constraints. */
export type NeedAsk = Pick<ManifestNeed, "intent" | "constraints"> & {
  key?: string;
};

/** One installed capability, as the resolver reads it. */
export interface InstalledProvider {
  capabilityId: string;
  name: string;
  offers?: Record<string, ManifestOffer>;
  needs?: ManifestNeed[];
  compose?: Record<string, ComposeEntry>;
  /** Per intent, the contract ops its EXECUTABLE verbs implement. */
  ops: Record<string, IntentOp[]>;
}

export interface NeedFit {
  capabilityId: string;
  name: string;
  /** `verbs`: its own verbs serve the intent; `composite`: its needs do. */
  via: "verbs" | "composite";
  offer: ManifestOffer;
  /** For a composite: how each of its needs resolved. */
  subNeeds?: Record<string, NeedResolution>;
}

export interface NeedMisfit {
  capabilityId: string;
  name: string;
  reason: string;
}

export interface CatalogNeedCandidates {
  candidates: IntentProviderCandidate[];
  misfits: Array<{ slug: string; name: string; reason: string }>;
  /** Packs whose declaration could not be read: the search was not total. */
  unreadable: string[];
}

export interface NeedResolution {
  intent: string;
  needKey?: string;
  status: "one" | "several" | "none" | "failed";
  fits: NeedFit[];
  misfits: NeedMisfit[];
  /** The remembered provider (a capability id), when one of the fits is it. */
  default?: string;
  /** On `none`: the catalog packs that declare the intent and fit. */
  catalog?: CatalogNeedCandidates | { error: string };
  /** On `none`, from a write door only: the install proposal filed. */
  gapOffer?: IntentInstallOffer;
  /** On `failed`: what could not be read. */
  error?: string;
}

/** What the pure core reads. */
export interface ResolveWorld {
  /** The intent's contract; `null` = none; `undefined` = not a known intent. */
  contractFor(intent: string): IntentContract | null | undefined;
  /** Installed containers that offer or compose the intent, or carry its verbs. */
  providersFor(intent: string): InstalledProvider[];
  /** The remembered provider for this intent and constraints, if any. */
  defaultFor(intent: string, constraintsHash: string): string | undefined;
}

/**
 * The key a remembered choice is filed under (`intent_defaults.
 * constraints_hash`): '' for no constraints, else a sha256 of the
 * key-sorted constraints, so one choice answers exactly the needs it was
 * made for.
 */
export function constraintsHash(
  constraints: Record<string, unknown> | undefined
): string {
  if (!constraints || Object.keys(constraints).length === 0) return "";
  return createHash("sha256").update(canonicalJson(constraints)).digest("hex");
}

/** The pure decision for one need. */
export function resolveNeedCore(
  need: NeedAsk,
  world: ResolveWorld,
  trail: { depth: number; visiting: ReadonlySet<string> } = {
    depth: 0,
    visiting: new Set(),
  }
): NeedResolution {
  const base = {
    intent: need.intent,
    ...(need.key ? { needKey: need.key } : {}),
  };
  const contract = world.contractFor(need.intent);
  if (contract === undefined) {
    return {
      ...base,
      status: "failed",
      fits: [],
      misfits: [],
      error: `"${need.intent}" is not a known intent.`,
    };
  }
  const fits: NeedFit[] = [];
  const misfits: NeedMisfit[] = [];
  for (const p of world.providersFor(need.intent)) {
    const misfit = (reason: string) =>
      misfits.push({ capabilityId: p.capabilityId, name: p.name, reason });
    if (trail.visiting.has(p.capabilityId)) {
      misfit("it needs itself through its own needs (a cycle)");
      continue;
    }
    const offer = p.offers?.[need.intent];
    const offered = offerMisfit(need, offer);
    if (offered || !offer) {
      misfit(offered ?? `it declares no offer for ${need.intent}`);
      continue;
    }
    const compose = p.compose?.[need.intent];
    if (!compose) {
      const ops = opsMisfit(contract, p.ops[need.intent] ?? []);
      if (ops) {
        misfit(ops);
        continue;
      }
      fits.push({
        capabilityId: p.capabilityId,
        name: p.name,
        via: "verbs",
        offer,
      });
      continue;
    }
    // A composite: every need its plan uses must resolve.
    if (trail.depth + 1 > MAX_COMPOSE_DEPTH) {
      misfit(`it composes more than ${MAX_COMPOSE_DEPTH} levels deep`);
      continue;
    }
    const used = new Set(
      [compose.create, compose.status, compose.renew, compose.revoke].flatMap(
        (steps) => (Array.isArray(steps) ? steps.map((s) => s.need) : [])
      )
    );
    const subNeeds: Record<string, NeedResolution> = {};
    let gap: string | null = null;
    const visiting = new Set([...trail.visiting, p.capabilityId]);
    for (const sub of p.needs ?? []) {
      if (!used.has(sub.key)) continue;
      const r = resolveNeedCore(sub, world, {
        depth: trail.depth + 1,
        visiting,
      });
      subNeeds[sub.key] = r;
      if (!gap && (r.status === "none" || r.status === "failed")) {
        gap =
          r.status === "failed"
            ? `its need "${sub.key}" (${sub.intent}) could not be resolved`
            : `its need "${sub.key}" (${sub.intent}) has no provider`;
      }
    }
    if (gap) {
      misfit(gap);
      continue;
    }
    fits.push({
      capabilityId: p.capabilityId,
      name: p.name,
      via: "composite",
      offer,
      subNeeds,
    });
  }
  const remembered = world.defaultFor(
    need.intent,
    constraintsHash(need.constraints)
  );
  const status =
    fits.length === 0 ? "none" : fits.length === 1 ? "one" : "several";
  return {
    ...base,
    status,
    fits,
    misfits,
    ...(status === "several" &&
    remembered &&
    fits.some((f) => f.capabilityId === remembered)
      ? { default: remembered }
      : {}),
  };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

export interface ResolveNeedOptions {
  /** The computer the need is for (recorded; provider placement is U6's). */
  computer?: string | null;
  /**
   * Given only by a WRITE door (an install, `synap_propose_install`): on
   * `none`, file the provider install proposal. A read never passes it.
   */
  propose?: {
    userId: string;
    workspaceId: string | null;
    agentUserId?: string | null;
    sessionId?: string | null;
  };
}

type Loaded = {
  world: ResolveWorld;
  contracts: Map<string, IntentContract | null>;
};

/** The intents a need reaches, composites included (depth-bounded). */
async function loadWorld(
  ctx: CapabilityRegistryContext,
  root: string
): Promise<Loaded> {
  const contracts = new Map<string, IntentContract | null>();
  const providers = new Map<string, InstalledProvider[]>();
  const defaults = new Map<string, string>();
  const registry = await listCapabilities(ctx, { limit: null });

  let frontier = [root];
  for (let depth = 0; depth <= MAX_COMPOSE_DEPTH && frontier.length; depth++) {
    const wanted = frontier.filter((i) => !providers.has(i));
    frontier = [];
    if (wanted.length === 0) break;
    for (const [slug, c] of await loadIntentContracts(wanted)) {
      contracts.set(slug, c);
    }
    for (const intent of wanted) {
      const list = await loadProviders(ctx, intent, registry);
      providers.set(intent, list);
      for (const p of list) {
        if (!p.compose?.[intent]) continue;
        for (const n of p.needs ?? []) frontier.push(n.intent);
      }
    }
  }
  const intents = [...providers.keys()];
  if (intents.length > 0) {
    const rows = await db
      .select({
        intent: intentDefaults.intent,
        hash: intentDefaults.constraintsHash,
        workspaceId: intentDefaults.workspaceId,
        providerCapabilityId: intentDefaults.providerCapabilityId,
      })
      .from(intentDefaults)
      .where(
        and(
          eq(intentDefaults.userId, ctx.userId),
          inArray(intentDefaults.intent, intents),
          ctx.workspaceId
            ? or(
                isNull(intentDefaults.workspaceId),
                eq(intentDefaults.workspaceId, ctx.workspaceId)
              )
            : isNull(intentDefaults.workspaceId)
        )
      );
    // A space's own choice wins over the person's pod-wide one.
    for (const r of rows.sort((a, b) =>
      a.workspaceId === b.workspaceId ? 0 : a.workspaceId ? 1 : -1
    )) {
      defaults.set(`${r.intent}\u0000${r.hash}`, r.providerCapabilityId);
    }
  }
  return {
    contracts,
    world: {
      contractFor: (intent) =>
        contracts.has(intent) ? contracts.get(intent)! : undefined,
      providersFor: (intent) => providers.get(intent) ?? [],
      defaultFor: (intent, hash) => defaults.get(`${intent}\u0000${hash}`),
    },
  };
}

/**
 * The containers under the caller's lens (the container list's own lens) that
 * offer or compose `intent`, plus the containers of its visible verbs, each
 * with the contract ops its EXECUTABLE, connected verbs implement.
 */
async function loadProviders(
  ctx: CapabilityRegistryContext,
  intent: string,
  registry: Awaited<ReturnType<typeof listCapabilities>>
): Promise<InstalledProvider[]> {
  const verbNamesByContainer = new Map<string, Set<string>>();
  for (const row of registry) {
    if (!row.containerId) continue;
    for (const v of row.verbs ?? []) {
      if (v.intent !== intent) continue;
      if (v.backingSkillExecutable !== true) continue;
      if (row.connection && row.connection.connected !== true) continue;
      const set = verbNamesByContainer.get(row.containerId) ?? new Set();
      set.add(v.id);
      verbNamesByContainer.set(row.containerId, set);
    }
  }
  const lens = ctx.workspaceId
    ? or(
        isNull(capabilities.workspaceId),
        eq(capabilities.workspaceId, ctx.workspaceId)
      )
    : undefined;
  const declaresIt = drizzleSql`(${capabilities.metadata} -> 'offers') ? ${intent} OR (${capabilities.metadata} -> 'compose') ? ${intent}`;
  const withVerbs = [...verbNamesByContainer.keys()];
  const rows = await db
    .select({
      id: capabilities.id,
      name: capabilities.name,
      metadata: capabilities.metadata,
    })
    .from(capabilities)
    .where(
      and(
        lens,
        userVisibleWhere(capabilities.workspaceId, ctx.userId),
        withVerbs.length > 0
          ? or(declaresIt, inArray(capabilities.id, withVerbs))
          : declaresIt
      )
    );
  const verbNames = [
    ...new Set(withVerbs.flatMap((id) => [...verbNamesByContainer.get(id)!])),
  ];
  const opByName = new Map<string, IntentOp>();
  if (verbNames.length > 0) {
    const opRows = await db
      .select({ name: skills.name, intentOp: skills.intentOp })
      .from(skills)
      .where(and(eq(skills.intent, intent), inArray(skills.name, verbNames)));
    for (const r of opRows) {
      if (isIntentOp(r.intentOp)) opByName.set(r.name, r.intentOp);
    }
  }
  return rows.map((row) => {
    const md = (row.metadata ?? {}) as Record<string, unknown>;
    const ops = [...(verbNamesByContainer.get(row.id) ?? [])]
      .map((name) => opByName.get(name))
      .filter((op): op is IntentOp => op !== undefined);
    return {
      capabilityId: row.id,
      name: row.name,
      ...(md.offers
        ? { offers: md.offers as Record<string, ManifestOffer> }
        : {}),
      ...(Array.isArray(md.needs) ? { needs: md.needs as ManifestNeed[] } : {}),
      ...(md.compose
        ? { compose: md.compose as Record<string, ComposeEntry> }
        : {}),
      ops: { [intent]: [...new Set(ops)] },
    };
  });
}

/**
 * Resolve one need for one caller. A read (no `propose`) returns the
 * candidates and files nothing; a write door's `propose` files the provider
 * install on `none`.
 */
export async function resolveNeed(
  ctx: CapabilityRegistryContext,
  need: NeedAsk,
  options: ResolveNeedOptions = {}
): Promise<NeedResolution> {
  let loaded: Loaded;
  try {
    loaded = await loadWorld(ctx, need.intent);
  } catch (err) {
    return {
      intent: need.intent,
      ...(need.key ? { needKey: need.key } : {}),
      status: "failed",
      fits: [],
      misfits: [],
      error: `The installed providers could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = resolveNeedCore(need, loaded.world);
  if (result.status !== "none") return result;
  const contract = loaded.contracts.get(need.intent) ?? null;
  result.catalog = await readCatalogCandidates(need, contract);
  if ("error" in result.catalog) {
    // Nothing installed fits AND the catalog could not be read: whether a
    // provider exists is unknown, which is `failed`, never `none`.
    return {
      ...result,
      status: "failed",
      error: `No installed provider fits, and the catalog could not be read: ${result.catalog.error}`,
    };
  }
  if (options.propose) {
    result.gapOffer = await resolveIntentGap({
      intent: need.intent,
      userId: options.propose.userId,
      workspaceId: options.propose.workspaceId,
      agentUserId: options.propose.agentUserId ?? null,
      sessionId: options.propose.sessionId ?? null,
      constraints: need.constraints ?? {},
      contract,
    });
  }
  return result;
}

/** The catalog packs that declare the intent and fit (read-only, official). */
export async function readCatalogCandidates(
  need: NeedAsk,
  contract: IntentContract | null
): Promise<CatalogNeedCandidates | { error: string }> {
  try {
    const { queryCatalogCache } = await import("./catalog-cache-query.js");
    const entries = await queryCatalogCache({ kind: "capability" });
    return selectIntentProviders({
      entries,
      intent: need.intent,
      constraints: need.constraints ?? {},
      contract,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
