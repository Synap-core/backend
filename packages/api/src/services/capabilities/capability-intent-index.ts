/**
 * Intent → capability REVERSE INDEX — the routing side of the capability
 * registry.
 *
 * `tools.capabilities[].id` is vendor-keyed (`gmail_send`,
 * `unipile_send_message`), so an agent asking to "send a message" must already
 * know which vendor is installed. `ToolVerbCatalogEntry.intent` adds a CLOSED
 * abstract axis over the same rows (see `ABSTRACT_VERBS` in
 * @synap/database `schema/tools.ts`); this module answers the reverse question —
 * given an intent, which installed capabilities declare it.
 *
 * SCOPING: there is deliberately NO query here. It folds the rows
 * `listCapabilities` already returned, so the caller's visibility floor is the
 * registry's own — a second predicate would be a second door to keep in sync,
 * which is exactly the drift this codebase keeps paying for.
 *
 * ROUTING, NEVER AUTHORIZATION. This resolves an intent to a CONCRETE verb id;
 * everything downstream (`executeCapability`, the grant gate, `decideAgentPolicy`)
 * then decides on that concrete verb exactly as it did before. An intent must
 * never widen what a caller may run.
 */

import {
  listCapabilities,
  type CapabilityRegistryContext,
  type RegistryCapability,
} from "./capability-registry.js";

/** One verb that declares an intent, carried with the capability it lives on. */
export interface IntentVerbMatch {
  intent: string;
  /** The CONCRETE verb id to pass to `synap_run_capability` / executeCapability. */
  verbId: string;
  verbLabel: string;
  /** read = pull · write/action = push. */
  verbKind: "read" | "write" | "action";
  /** Grant state, straight off the registry row — never re-derived here. */
  granted: boolean;
  effectiveExecMode: string;
  /** False when no visible active+approved backing skill can execute the verb. */
  backingSkillExecutable: boolean;
  capabilityId: string;
  capabilityName: string;
  /** Whether the provider tool is connected, when the registry knows. */
  connected?: boolean;
}

/**
 * Fold registry rows into intent → verbs. PURE, so the scoping (which belongs to
 * `listCapabilities`) and the folding are independently testable.
 *
 * A verb with no `intent` is simply absent from the index — legacy catalog
 * entries predate the axis and must never be guessed into a bucket. Rows are
 * deduped by `intent:verbId`, preferring a GRANTED copy, mirroring
 * `sectionCapabilities`' union rule for an integration installed twice.
 */
export function foldVerbsByIntent(
  caps: RegistryCapability[]
): Map<string, IntentVerbMatch[]> {
  const byIntent = new Map<string, IntentVerbMatch[]>();
  const seen = new Map<string, IntentVerbMatch>();
  for (const c of caps) {
    for (const v of c.verbs ?? []) {
      const intent = v.intent;
      if (!intent) continue;
      const match: IntentVerbMatch = {
        intent,
        verbId: v.id,
        verbLabel: v.label,
        verbKind: v.kind,
        granted: v.granted === true,
        effectiveExecMode: v.effectiveExecMode,
        backingSkillExecutable: v.backingSkillExecutable === true,
        capabilityId: c.id,
        capabilityName: c.name,
        ...(c.connection ? { connected: c.connection.connected === true } : {}),
      };
      const key = `${intent}:${v.id}`;
      const prior = seen.get(key);
      if (prior) {
        // Same verb from a duplicate row — keep the granted copy.
        if (match.granted && !prior.granted) Object.assign(prior, match);
        continue;
      }
      seen.set(key, match);
      const list = byIntent.get(intent);
      if (list) list.push(match);
      else byIntent.set(intent, [match]);
    }
  }
  return byIntent;
}

/**
 * Which capabilities visible to THIS caller declare `intent`.
 *
 * Returns `[]` for an intent nothing declares — a real answer (the pod cannot do
 * it through a declared verb), never a placeholder. Pass no `intent` to get the
 * whole index.
 */
export async function capabilitiesByIntent(
  ctx: CapabilityRegistryContext,
  intent: string
): Promise<IntentVerbMatch[]> {
  // `limit: null` — never slice before folding: a genuine match could be pushed
  // out of the window by duplicate rows of something else. Same reason the MCP
  // door passes `null` before `sectionCapabilities`.
  const caps = await listCapabilities(ctx, { limit: null });
  return foldVerbsByIntent(caps).get(intent) ?? [];
}

/** The full intent → verbs index under the caller's lens. */
export async function intentIndex(
  ctx: CapabilityRegistryContext
): Promise<Map<string, IntentVerbMatch[]>> {
  return foldVerbsByIntent(await listCapabilities(ctx, { limit: null }));
}

// ── Phase 3: DECLARED requirements vs. what is actually PROVIDABLE ────────────
//
// A workspace template declares `taskIntents` — WHAT THE SPACE NEEDS TO
// FUNCTION (`WorkspaceYaml.taskIntents`, Phase 1). The installed capabilities
// declare the mirror half — WHAT THEY ACTUALLY PROVIDE (Phase 2's hoisted
// `provides`). Neither side answers "can this space do the thing it was built
// for" alone, so this section joins them.
//
// ── WHY BOTH SIDES COME FROM THE ONE EXISTING AXIS ────────────────────────────
// `provides` is NEVER stored on the pod. It is a CP-side authoring aggregate
// DERIVED from `skills[].intent`, and `deriveToolVerbs`
// (create-from-definition.ts) rebuilds that per-verb axis into
// `tools.capabilities[].intent`, validated against the `capability_intents`
// table. So the INSTALLED side is exactly `foldVerbsByIntent` — the same fold
// the file above already exposes — and the two sides cannot disagree because
// they are the same declared values read from two ends. This is why the module
// needs no second index, no denormalised column, and no migration: adding a
// `providedIntents` column would be a THIRD copy of a value the registry already
// holds, free to drift from the verbs it claims to summarise.
//
// ── A DECLARATION IS NOT A SNAPSHOT ──────────────────────────────────────────
// `taskIntents` says what the space NEEDS, not what it currently has. The
// founder's reference declaration for Content Studio is 4 intents against 1
// installed pack, and that gap is the field doing its job: it is what a later
// install is checked against (Phase 4 proposes one). A gap is therefore a FACT
// to report, never an error and never something to reconcile away.

/** One declared intent, resolved against what this workspace can actually do. */
export interface IntentCoverage {
  intent: string;
  /**
   * Whether anything visible under this lens declares the intent. `false` is the
   * GAP — a real, reportable fact (this is what Phase 4 acts on), NOT an error
   * and NOT an absent row.
   */
  satisfied: boolean;
  /** The verbs that provide it. `[]` exactly when `satisfied` is false. */
  providedBy: IntentVerbMatch[];
}

/**
 * How much was actually searched — the answer to "is this a gap, or did the read
 * fail / come back narrow?". Never omitted on a successful read, so a caller
 * cannot mistake an unsearched axis for an empty one.
 */
export interface IntentCoverageMeta {
  /** Registry rows read under this lens (the registry's OWN visibility floor). */
  capabilityRows: number;
  /** Verb catalog entries seen across those rows. */
  verbs: number;
  /** How many of `verbs` declare an intent at all. */
  verbsDeclaringIntent: number;
  /** How many intents the workspace declares. */
  declared: number;
}

export interface IntentCoverageResult {
  lens: { workspaceId: string | null };
  /**
   * Per declared intent, in DECLARATION order. An empty array means the
   * workspace declares nothing — a real answer ("this space has no external
   * capability requirements"), NOT the same as a failed read.
   */
  intents: IntentCoverage[];
  /** Just the unsatisfied slugs, in declaration order — the Phase-4 input. */
  gaps: string[];
  meta: IntentCoverageMeta;
}

/**
 * Read a workspace's DECLARED `taskIntents`.
 *
 * ⚠️ WHY THE READ CAN FAIL LOUDLY. This is the difference that the codebase's
 * "never `catch { return [] }`" rule exists for: a workspace with no declaration
 * and a workspace whose declaration could not be read are DIFFERENT facts, and
 * collapsing them makes a broken lookup render as a calm, confident "this space
 * needs nothing". So this throws rather than defaulting — the caller decides.
 */
export async function readWorkspaceTaskIntents(input: {
  workspaceId: string;
}): Promise<string[]> {
  const { db, workspaces, eq } = await import("@synap/database");
  const row = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, input.workspaceId),
    columns: { settings: true },
  });
  if (!row) {
    throw new Error(
      `readWorkspaceTaskIntents: no workspace ${input.workspaceId} — cannot say whether it declares task requirements`
    );
  }
  const declared = (row.settings as { taskIntents?: unknown } | null)
    ?.taskIntents;
  // Absent = declares nothing. Not an error: a workspace that needs no external
  // capability legitimately omits the key.
  if (declared === undefined || declared === null) return [];
  if (!Array.isArray(declared)) {
    throw new Error(
      `readWorkspaceTaskIntents: settings.taskIntents on ${input.workspaceId} is ${typeof declared}, not an array`
    );
  }
  return declared.filter((v): v is string => typeof v === "string");
}

/**
 * Join a workspace's DECLARED intents against what its installed capabilities
 * PROVIDE, under ONE lens. Pure and I/O-free at its core (see
 * `foldIntentCoverage`) so the join is testable without a database; this wrapper
 * only supplies the two reads.
 *
 * AGNOSTIC BY CONSTRUCTION: nothing here knows a vendor, a template slug, or a
 * workspace name. It joins two slug lists, so it works for any capability kind
 * and any workspace — a new template or a new pack needs no edit here.
 *
 * Read-only and cheap: ONE registry read (`listCapabilities`, the same cold
 * read every other capability door pays) + ONE single-row settings read.
 *
 * @throws if the declaration cannot be read. A gap is a returned fact, never a
 * throw; an unreadable declaration is NOT a fact and must not be reported as one.
 */
export async function workspaceIntentCoverage(input: {
  workspaceId: string;
  userId: string;
  /** Extra registry lens (e.g. an agent id) — forwarded verbatim. */
  agentUserId?: string;
}): Promise<IntentCoverageResult> {
  const declared = await readWorkspaceTaskIntents({
    workspaceId: input.workspaceId,
  });
  const ctx: CapabilityRegistryContext = {
    workspaceId: input.workspaceId,
    userId: input.userId,
  };
  const caps = await listCapabilities(ctx, { limit: null });
  return foldIntentCoverage({
    declared,
    caps,
    workspaceId: input.workspaceId,
  });
}

/**
 * The join, PURE: declared slugs × registry rows → per-intent coverage.
 *
 * Split out from {@link workspaceIntentCoverage} so the one piece with real
 * branching is unit-testable with no database and no mocks — the seam where a
 * coverage bug would actually live. `workspaceId` is passed IN rather than
 * inferred: the lens is the CALLER's fact, and a fold that stamped a literal
 * would report every workspace as pod-altitude.
 */
export function foldIntentCoverage(input: {
  declared: readonly string[];
  caps: RegistryCapability[];
  workspaceId: string | null;
}): IntentCoverageResult {
  const { declared, caps } = input;
  const provided = foldVerbsByIntent(caps);

  let verbs = 0;
  let verbsDeclaringIntent = 0;
  for (const c of caps) {
    for (const v of c.verbs ?? []) {
      verbs += 1;
      if (v.intent) verbsDeclaringIntent += 1;
    }
  }

  const intents: IntentCoverage[] = [];
  const gaps: string[] = [];
  // Declaration order, deduped: a template that repeats a slug (authoring error
  // the Phase-1 guard polices at the template layer) must not produce two rows
  // here, and a declaration is a SET of requirements.
  const seen = new Set<string>();
  for (const intent of declared) {
    if (!intent || seen.has(intent)) continue;
    seen.add(intent);
    const providedBy = provided.get(intent) ?? [];
    if (providedBy.length === 0) gaps.push(intent);
    intents.push({ intent, satisfied: providedBy.length > 0, providedBy });
  }

  return {
    lens: { workspaceId: input.workspaceId },
    intents,
    gaps,
    meta: {
      capabilityRows: caps.length,
      verbs,
      verbsDeclaringIntent,
      declared: intents.length,
    },
  };
}
