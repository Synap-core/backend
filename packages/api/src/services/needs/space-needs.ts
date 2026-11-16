/**
 * A SPACE'S NEEDS — each filled once, by one provider, shared by the space's
 * members (founder decisions D2 and D3, 16 Nov 2026; migration 0426).
 *
 * The vocabulary is `@synap-core/types/needs` (mirror of the `needs` rows).
 * The binding is an `installation_bindings` row with NO installation:
 * `workspace_id` = the space, `need_key` = the need slug,
 * `provider_capability_id` = the provider, `state` live (or revoked). One live
 * row per (space, need), enforced by `uq_installation_bindings_space_need`.
 * There is no second "chosen provider" store: the per-person
 * `intent_defaults` (0409, never wired) was dropped by the same migration.
 *
 * THE ONE RESOLVER of a need ref (`need:<need>[/<intent>]`) to verbs is
 * {@link resolveNeedRefVerbs}: the run's tool profile, the pre-run tools
 * check, a criterion's `check.capability`, an automation `capability` node
 * and `requires` all read a need through here. A need the space has not
 * filled resolves to a REASON (`unfilled`, `provider_gone`, `no_verb`,
 * `unknown_need`), never to a silent empty list.
 *
 * WRITES go through {@link applySpaceNeedBinding}, called only by the governed
 * door (`checkPermissionOrPropose`, action `bind_need` on the workspace) and
 * its proposal executor, and by the template-install reconcile
 * (`space-need-coverage.ts`) for the one case it may decide alone: exactly one
 * installed provider fills an empty need.
 */
import { createLogger } from "@synap-core/core";
import {
  canonicalNeedSlug,
  needOf,
  needRefIntents,
  parseNeedRef,
  type NeedDefinition,
} from "@synap-core/types/needs";

const logger = createLogger({ module: "space-needs" });

/** One live binding of a space's need. */
export interface SpaceNeedBinding {
  bindingId: string;
  need: string;
  /** Null once the provider capability was deleted (FK SET NULL): the need reads empty. */
  providerCapabilityId: string | null;
  providerName: string | null;
  setBy: string;
  updatedAt: Date;
}

/** need slug → its live binding. A need with no row is absent. */
export type SpaceNeedBindings = ReadonlyMap<string, SpaceNeedBinding>;

/**
 * The live bindings of one space. Service read: the caller has already fixed
 * the space (a run's lens, a door that checked membership). Throws on a failed
 * read: "no binding" and "could not read" are different facts.
 */
export async function readSpaceNeedBindings(
  workspaceId: string
): Promise<Map<string, SpaceNeedBinding>> {
  const { db, installationBindings, capabilities, and, eq, isNull, ne } =
    await import("@synap/database");
  const rows = await db
    .select({
      bindingId: installationBindings.id,
      need: installationBindings.needKey,
      providerCapabilityId: installationBindings.providerCapabilityId,
      providerName: capabilities.name,
      setBy: installationBindings.userId,
      updatedAt: installationBindings.updatedAt,
    })
    .from(installationBindings)
    .leftJoin(
      capabilities,
      eq(capabilities.id, installationBindings.providerCapabilityId)
    )
    .where(
      and(
        isNull(installationBindings.installationId),
        eq(installationBindings.workspaceId, workspaceId),
        ne(installationBindings.state, "revoked")
      )
    );
  const out = new Map<string, SpaceNeedBinding>();
  for (const r of rows) {
    out.set(r.need, {
      bindingId: r.bindingId,
      need: r.need,
      providerCapabilityId: r.providerCapabilityId,
      providerName: r.providerName ?? null,
      setBy: r.setBy,
      updatedAt: r.updatedAt,
    });
  }
  return out;
}

/** What the registry says about one capability row, as far as a need reads it. */
export interface NeedProviderRow {
  id: string;
  name: string;
  /** The container this brick belongs to (`capabilities.id`), when it is in one. */
  containerId?: string | null;
  verbs?: ReadonlyArray<{
    id: string;
    kind?: string;
    intent?: string | null;
  }>;
}

/** How a need ref resolved. Exactly one arm. */
export type NeedRefResolution =
  | {
      status: "ok";
      need: string;
      providerCapabilityId: string;
      providerName: string;
      /** The provider's verbs serving the ref's intents, each once. */
      verbs: string[];
    }
  | { status: "unknown_need"; need: string }
  | { status: "unfilled"; need: string }
  | { status: "provider_gone"; need: string }
  | {
      status: "no_verb";
      need: string;
      providerName: string;
      intents: string[];
    };

/**
 * Resolve a need ref against a space's bindings and the registry rows under
 * the run's lens. PURE.
 *
 * The provider's verbs are every verb of a registry row that IS the provider
 * (`id`) or belongs to it (`containerId`) whose declared intent is one the
 * ref asks for. A verb with no intent is never guessed into a need (the same
 * rule as `foldVerbsByIntent`). `readsOnly` keeps read verbs only (a trial).
 */
export function resolveNeedRefVerbs(
  entry: string,
  bindings: SpaceNeedBindings,
  capabilities: readonly NeedProviderRow[],
  readsOnly = false
): NeedRefResolution {
  const ref = parseNeedRef(entry);
  const slug = ref ? canonicalNeedSlug(ref.need) : null;
  if (!ref || !slug)
    return { status: "unknown_need", need: ref?.need ?? entry };
  const binding = bindings.get(slug);
  if (!binding) return { status: "unfilled", need: slug };
  const providerId = binding.providerCapabilityId;
  if (!providerId) return { status: "provider_gone", need: slug };
  const intents = new Set(needRefIntents(ref));
  const verbs: string[] = [];
  let providerName = binding.providerName;
  for (const cap of capabilities) {
    if (cap.id !== providerId && cap.containerId !== providerId) continue;
    if (cap.id === providerId) providerName = cap.name;
    for (const v of cap.verbs ?? []) {
      if (!v.intent || !intents.has(v.intent)) continue;
      if (readsOnly && v.kind !== "read") continue;
      if (!verbs.includes(v.id)) verbs.push(v.id);
    }
  }
  const name = providerName ?? "its provider";
  if (verbs.length === 0) {
    return {
      status: "no_verb",
      need: slug,
      providerName: name,
      intents: [...intents],
    };
  }
  return {
    status: "ok",
    need: slug,
    providerCapabilityId: providerId,
    providerName: name,
    verbs,
  };
}

/**
 * The ONE verb a single-verb reference (a criterion's `check.capability`, an
 * automation `capability` node) runs for a need ref. PURE. Several verbs
 * serve the ref: `ambiguous`, and the author narrows it with `/<intent>`.
 */
export type NeedVerbChoice =
  | { status: "ok"; verbId: string; need: string; providerName: string }
  | Exclude<NeedRefResolution, { status: "ok" }>
  | {
      status: "ambiguous";
      need: string;
      providerName: string;
      verbs: string[];
    };

export function chooseNeedVerb(resolution: NeedRefResolution): NeedVerbChoice {
  if (resolution.status !== "ok") return resolution;
  if (resolution.verbs.length > 1) {
    return {
      status: "ambiguous",
      need: resolution.need,
      providerName: resolution.providerName,
      verbs: resolution.verbs,
    };
  }
  return {
    status: "ok",
    verbId: resolution.verbs[0]!,
    need: resolution.need,
    providerName: resolution.providerName,
  };
}

/** The sentence a reason reads as, for a run, a refusal or a step error. PURE. */
export function needResolutionReason(
  r: Exclude<NeedVerbChoice, { status: "ok" }>
): string {
  const label = needOf(r.need)?.label ?? r.need;
  switch (r.status) {
    case "unknown_need":
      return `"${r.need}" is not a need.`;
    case "unfilled":
      return `The need "${label}" is not filled in this space: choose a provider for it.`;
    case "provider_gone":
      return `The provider chosen for the need "${label}" was removed: choose another.`;
    case "no_verb":
      return `${r.providerName}, chosen for the need "${label}", offers no tool for ${r.intents.join(", ")}.`;
    case "ambiguous":
      return `${r.providerName}, chosen for the need "${label}", offers several tools for it (${r.verbs.join(", ")}): name one intent, e.g. need:${r.need}/<intent>.`;
  }
}

/**
 * The capability key a `requires` need ref names: the bound provider's
 * template key. `null` = not filled (the ref is then kept as written, so the
 * runner's computer check reports it missing, never a silent drop).
 */
export function needRequiresKey(
  entry: string,
  bindings: SpaceNeedBindings,
  providerKeys: ReadonlyMap<string, string>
): string | null {
  const ref = parseNeedRef(entry);
  const slug = ref ? canonicalNeedSlug(ref.need) : null;
  if (!slug) return null;
  const providerId = bindings.get(slug)?.providerCapabilityId;
  return providerId ? (providerKeys.get(providerId) ?? null) : null;
}

/** The template key of each provider a space's bindings name. */
export async function readProviderKeys(
  bindings: SpaceNeedBindings
): Promise<Map<string, string>> {
  const ids = [...bindings.values()]
    .map((b) => b.providerCapabilityId)
    .filter((id): id is string => !!id);
  if (ids.length === 0) return new Map();
  const { db, capabilities, inArray } = await import("@synap/database");
  const rows = await db
    .select({ id: capabilities.id, key: capabilities.templateKey })
    .from(capabilities)
    .where(inArray(capabilities.id, ids));
  return new Map(
    rows.filter((r) => !!r.key).map((r) => [r.id, r.key as string])
  );
}

/** Does this capability row's metadata declare it fills the need? PURE. */
export function declaresFill(metadata: unknown, need: string): boolean {
  const fills = (metadata as { fills?: unknown } | null)?.fills;
  return Array.isArray(fills) && fills.includes(need);
}

/** What a binding write did. */
export type SpaceNeedBindResult =
  | {
      status: "bound";
      need: string;
      providerCapabilityId: string;
      providerName: string;
      bindingId: string;
      /** The binding it replaced, revoked in the same transaction. */
      replaced: string | null;
    }
  | { status: "cleared"; need: string; replaced: string | null }
  | { status: "unchanged"; need: string; providerCapabilityId: string | null };

/** A binding write that cannot apply. `code` is the machine reason. */
export class SpaceNeedBindError extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_NEED"
      | "NO_SUCH_PROVIDER"
      | "PROVIDER_OUTSIDE_SPACE"
      | "PROVIDER_CANNOT_FILL",
    message: string
  ) {
    super(message);
    this.name = "SpaceNeedBindError";
  }
}

/**
 * Bind (or clear, `providerCapabilityId: null`) a space's need. The APPLY
 * function: callers are the governed door after a grant, its proposal
 * executor, and the install reconcile; never an ungoverned agent path.
 *
 * Refused when the need is not in the vocabulary, the provider does not
 * exist, is outside the space (neither its own nor pod-wide), or can fill
 * nothing of the need: it neither declares `fills` for it nor serves any of
 * its intents (`servesIntent`, the registry fold, passed in by the caller so
 * this stays one transaction of plain reads and writes).
 *
 * Rebind: the live row is revoked and a new one written, in one transaction
 * (the partial unique index allows one live row per space and need).
 */
export async function applySpaceNeedBinding(input: {
  workspaceId: string;
  need: string;
  providerCapabilityId: string | null;
  /** The person the write is attributed to (the approver, on a proposal). */
  userId: string;
  /** Does the provider serve one of the need's intents (registry fold)? */
  servesIntent?: (
    providerCapabilityId: string,
    need: NeedDefinition
  ) => Promise<boolean>;
}): Promise<SpaceNeedBindResult> {
  const need = needOf(input.need);
  if (!need) {
    throw new SpaceNeedBindError(
      "UNKNOWN_NEED",
      `"${input.need}" is not a need.`
    );
  }
  const { db, installationBindings, capabilities, and, eq, isNull, ne } =
    await import("@synap/database");

  let provider: { id: string; name: string } | null = null;
  if (input.providerCapabilityId) {
    const [row] = await db
      .select({
        id: capabilities.id,
        name: capabilities.name,
        workspaceId: capabilities.workspaceId,
        metadata: capabilities.metadata,
      })
      .from(capabilities)
      .where(eq(capabilities.id, input.providerCapabilityId))
      .limit(1);
    if (!row) {
      throw new SpaceNeedBindError(
        "NO_SUCH_PROVIDER",
        `No capability ${input.providerCapabilityId} on this pod.`
      );
    }
    if (row.workspaceId !== null && row.workspaceId !== input.workspaceId) {
      throw new SpaceNeedBindError(
        "PROVIDER_OUTSIDE_SPACE",
        `${row.name} is installed in another space: install it in this one, or choose a pod-wide provider.`
      );
    }
    const fills =
      declaresFill(row.metadata, need.slug) ||
      (input.servesIntent ? await input.servesIntent(row.id, need) : false);
    if (!fills) {
      throw new SpaceNeedBindError(
        "PROVIDER_CANNOT_FILL",
        `${row.name} cannot fill the need "${need.label}": it neither declares it nor offers a tool for ${need.intents.join(", ")}.`
      );
    }
    provider = { id: row.id, name: row.name };
  }

  return db.transaction(async (tx) => {
    const live = and(
      isNull(installationBindings.installationId),
      eq(installationBindings.workspaceId, input.workspaceId),
      eq(installationBindings.needKey, need.slug),
      ne(installationBindings.state, "revoked")
    );
    const [current] = await tx
      .select({
        id: installationBindings.id,
        providerCapabilityId: installationBindings.providerCapabilityId,
      })
      .from(installationBindings)
      .where(live)
      .limit(1);
    if ((current?.providerCapabilityId ?? null) === (provider?.id ?? null)) {
      return {
        status: "unchanged" as const,
        need: need.slug,
        providerCapabilityId: provider?.id ?? null,
      };
    }
    const now = new Date();
    if (current) {
      await tx
        .update(installationBindings)
        .set({ state: "revoked", revokedAt: now, updatedAt: now })
        .where(eq(installationBindings.id, current.id));
    }
    if (!provider) {
      logger.info(
        { workspaceId: input.workspaceId, need: need.slug },
        "space need cleared"
      );
      return {
        status: "cleared" as const,
        need: need.slug,
        replaced: current?.id ?? null,
      };
    }
    const [row] = await tx
      .insert(installationBindings)
      .values({
        userId: input.userId,
        workspaceId: input.workspaceId,
        needKey: need.slug,
        providerCapabilityId: provider.id,
        state: "live",
        checkedAt: now,
      })
      .returning({ id: installationBindings.id });
    logger.info(
      {
        workspaceId: input.workspaceId,
        need: need.slug,
        provider: provider.id,
      },
      "space need bound"
    );
    return {
      status: "bound" as const,
      need: need.slug,
      providerCapabilityId: provider.id,
      providerName: provider.name,
      bindingId: row!.id,
      replaced: current?.id ?? null,
    };
  });
}

/**
 * Does a provider serve one of a need's intents under the space's lens? The
 * registry fold `applySpaceNeedBinding` asks when the provider declares no
 * `fills` (a hand-made or older capability).
 */
export async function providerServesNeedIntent(
  lens: { workspaceId: string; userId: string },
  providerCapabilityId: string,
  need: NeedDefinition
): Promise<boolean> {
  const { listCapabilities } =
    await import("../capabilities/capability-registry.js");
  const rows = await listCapabilities(lens, { limit: null });
  const intents = new Set(need.intents);
  return rows.some(
    (r) =>
      (r.id === providerCapabilityId ||
        r.containerId === providerCapabilityId) &&
      (r.verbs ?? []).some((v) => !!v.intent && intents.has(v.intent))
  );
}

/**
 * A `requires` list with each NEED ref replaced by the capability key of the
 * provider the space bound to it (0426). A ref the space has not filled, or
 * any ref when there is no space, stays AS WRITTEN: the runner's computer
 * check then reports `need:<need>` missing, never a silent drop. A failed
 * binding read keeps every ref as written (logged), for the same reason.
 */
export async function resolveRequiresNeeds(
  keys: readonly string[],
  workspaceId: string | null | undefined
): Promise<string[]> {
  if (!keys.some((k) => parseNeedRef(k)) || !workspaceId) return [...keys];
  try {
    const bindings = await readSpaceNeedBindings(workspaceId);
    const providerKeys = await readProviderKeys(bindings);
    const out: string[] = [];
    for (const k of keys) {
      const key = parseNeedRef(k)
        ? (needRequiresKey(k, bindings, providerKeys) ?? k)
        : k;
      if (!out.includes(key)) out.push(key);
    }
    return out;
  } catch (err) {
    logger.error(
      { err, workspaceId },
      "resolveRequiresNeeds: the space's needs could not be read — need refs stay unresolved"
    );
    return [...keys];
  }
}

/**
 * The ONE verb a single-verb need ref runs in a space (a criterion's
 * `check.capability`, an automation `capability` node's `need`): the space's
 * binding, the registry under the space's lens, {@link chooseNeedVerb}.
 * Answers the verb, or the reason in one sentence; throws only when a read
 * fails (never folded into "not filled").
 */
export async function resolveNeedVerb(input: {
  need: string;
  workspaceId: string | null;
  userId: string;
}): Promise<{ verbId: string } | { reason: string }> {
  const entry = input.need.startsWith("need:")
    ? input.need
    : `need:${input.need}`;
  if (!input.workspaceId) {
    return {
      reason: `"${entry}" names a need, and needs are filled per space: this runs in no space.`,
    };
  }
  const [{ listCapabilities }, bindings] = await Promise.all([
    import("../capabilities/capability-registry.js"),
    readSpaceNeedBindings(input.workspaceId),
  ]);
  const rows = await listCapabilities(
    { workspaceId: input.workspaceId, userId: input.userId },
    { limit: null }
  );
  const choice = chooseNeedVerb(resolveNeedRefVerbs(entry, bindings, rows));
  return choice.status === "ok"
    ? { verbId: choice.verbId }
    : { reason: needResolutionReason(choice) };
}
