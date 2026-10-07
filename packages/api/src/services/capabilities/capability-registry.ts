/**
 * Capability Registry Adapter — the unified READ-MODEL over the existing
 * capability source systems.
 *
 * Phase 1 of the Playbooks & Capability Substrate normalizes four disjoint
 * systems behind one `Capability` contract so a Playbook can grant capabilities
 * uniformly and the AI can discover them. THIS slice is the read-only adapter:
 * it reads existing rows and maps them into the `Capability` shape. It performs
 * NO writes and NO governance (callers gate; reads are auto-approved).
 *
 * Sources mapped today:
 *   - `tools` rows                 → kind by tool.kind (builtin-tool | tool | source-provider)
 *   - `skills` rows                → kind "skill"
 *   - `intelligence_commands` rows → kind "command"
 *
 * NOT yet mapped (TODO): the hardcoded builtin IS tools live in the Intelligence
 * Service, not the backend DB — exposing them requires an IS-side manifest
 * endpoint. Until that lands we return [] for them rather than hardcoding a fake
 * list that would drift from the real IS tool set.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.1)
 */

import {
  getDb,
  or,
  and,
  isNull,
  isNotNull,
  eq,
  inArray,
  gt,
  desc,
  drizzleSql,
} from "@synap/database";
import {
  tools,
  skills,
  intelligenceCommands,
  secrets,
  vaultGrants,
  links,
  capabilities as capabilityContainers,
  type ToolVerbCatalogEntry,
  type ProviderVerbSpec,
} from "@synap/database/schema";
import type {
  Capability,
  CapabilityKind,
  CapabilityVerbState,
  ExecMode,
  ExecutorRef,
} from "@synap/playbooks";
import { getDefaultActiveService } from "@synap/intelligence-client";
import { BUILTIN_VERB_PARAM_SCHEMAS } from "./builtin-verbs.js";
import {
  capabilityRowPosture,
  runPosture,
  type RunPosture,
} from "./run-posture.js";
import { userVisibleWhere } from "@synap/database";
import {
  visibleSkillsAnyWorkspaceWhere,
  visibleSkillsWhere,
} from "../skills/visibility.js";
import { isToolRowLaunchable } from "./verb-launchable.js";
import { declaredReadOnly } from "./capability-drift.js";
import { verbType } from "./capability-catalog.js";
import { toolNotRetiredWhere } from "../tools/visibility.js";
import { rankByTerms, type TermMatch } from "../../utils/term-match.js";
import {
  resolveCapabilityBlock,
  type CapabilityNextAction,
} from "./capability-enable-link.js";

export interface CapabilityRegistryContext {
  /**
   * The workspace lens, or `null` for POD ALTITUDE — the brick catalogue read
   * with no workspace selected. `null` narrows honestly rather than failing:
   * pod-wide tools/commands (workspace_id IS NULL) plus the caller's own
   * pod/user-scoped skills; workspace-scoped rows are simply not in view.
   *
   * IMPORTANT for callers: a non-null value is a LENS, not an authorization.
   * Any door that lets the CALLER choose it must verify membership first
   * (`getWorkspaceRole`) — the predicates below trust it.
   */
  workspaceId: string | null;
  userId: string;
  /**
   * EVERY SPACE AT ONCE: pod-wide rows plus every row in any workspace the
   * caller can see (`userVisibleWhere` — member, owner, or pod-visible), in ONE
   * read. `workspaceId` is ignored when set. Each row is then tagged with its
   * own `workspaceId` so a surface can say "in <space>". Replaces N per-space
   * reads (Settings › Tools did ~15). Absent → the lens behaviour above.
   */
  allSpaces?: boolean;
}

/** Map a `tools.kind` value to the read-model CapabilityKind. */
function toolKindToCapabilityKind(kind: string): CapabilityKind {
  switch (kind) {
    case "builtin":
      return "builtin-tool";
    case "provider":
      return "source-provider";
    // "api" | "mcp" | "external" are all granted as a plain "tool"
    default:
      return "tool";
  }
}

/**
 * A verb read-model row PLUS the declarative subset's `responseShape` — the
 * projection of what a provider verb RETURNS.
 *
 * WHY it is declared here and not on `CapabilityVerbState` (@synap/playbooks):
 * `responseShape` only exists for verbs backed by a `declarative` skill (it is
 * a `providerSpec` field, applied at execute time by `execute-provider-verb.ts`).
 * The registry is the only place that joins a verb to its backing skill's spec,
 * so it is the only place that can project it. Additive + optional: every
 * existing consumer typed against `CapabilityVerbState` still compiles.
 */
export interface CapabilityVerbStateWithResponseShape extends CapabilityVerbState {
  /**
   * The declarative verb's output contract — which fields the shaped result
   * carries and where they come from in the raw HTTP response. Present ONLY for
   * a provider verb whose backing declarative skill declares one; absent for
   * builtin verbs, verbs with no backing spec, and specs with no `responseShape`.
   * A brick can therefore state what it returns, not just what it takes.
   */
  responseShape?: ProviderVerbSpec["responseShape"];
  /**
   * Whether a VISIBLE active+approved backing skill exists for this verb, i.e.
   * whether `executeCapability` could actually run it. Emitted by
   * `buildVerbStates` since the backing-skill gate landed, but never declared —
   * so a consumer reading it (the intent reverse index) did not typecheck.
   * Optional: a verb state built by any other path simply does not carry it.
   */
  backingSkillExecutable?: boolean;
  /**
   * The backing skill's AUTHORED `metadata.readOnly` declaration, when it
   * declares one. The gate short-circuits to `run` on it, so every door's
   * `governance` must see it too — without this the registry displayed
   * `propose` for a verb the gate would RUN (observed live on `exa_search`).
   * Absent = the skill declares nothing, never `false`.
   */
  declaredReadOnly?: boolean;
}

/**
 * The registry's own capability row: the shared `Capability` contract with the
 * two fields this module actually emits but that the shared contract does not
 * declare — the extended verb rows (above) and `runnable` (skill lifecycle).
 * Assignable to `Capability` in both directions, so no consumer changes.
 */
export type RegistryCapability = Omit<Capability, "verbs"> & {
  verbs?: CapabilityVerbStateWithResponseShape[];
  /** Skill lifecycle: false for an inactive/errored skill (not launchable). */
  runnable?: boolean;
  /**
   * The row's OWN space: a workspace id, or `null` for a pod-wide / personal
   * row. Emitted ONLY by an `allSpaces` read (see `CapabilityRegistryContext`);
   * a lensed read leaves it absent, its shape unchanged.
   */
  workspaceId?: string | null;
  /** Why this row matched a `query`; absent without one. */
  match?: TermMatch;
  /**
   * The capability CONTAINER this brick belongs to (`tool|skill --member_of-->
   * capability`), or `null` for a brick that is in no container. DERIVED per
   * read from `links` — never stored, so it cannot drift. `null` is a real
   * answer (it is what makes un-packaged bricks renderable), never a placeholder.
   */
  containerId?: string | null;
  /** Display name of `containerId`'s container; null when unresolvable. */
  containerName?: string | null;
  /**
   * `skills.slug` — the ref `synap_load_skill` resolves. Emitted ONLY for
   * `teaching-doc` rows, because they are the only kind a caller reaches by
   * ref rather than by running it: a teaching doc listed by NAME alone is a
   * row nothing can open. `null` for a legacy row that predates the column.
   */
  slug?: string | null;
  /**
   * `skills.kind` (`builtin` | `code` | `declarative`) and `skills.metadata` of
   * a runnable `skill` row — the facts `runPosture` classifies a verb from.
   * Absent on every other kind.
   */
  skillKind?: string | null;
  skillMetadata?: Record<string, unknown> | null;
  /**
   * The approval gate: the row's `approved` column. `true` for kinds with no
   * approval column (commands, IS-native tools) — the gate's approval step does
   * not refuse them (`approved === null`). `governance` is the RUN POSTURE
   * (`capabilityRowPosture`), never this.
   */
  enabled: boolean;
};

// ── Container membership (derived per read, batched) ──────────────────────────

/**
 * The capability container a brick belongs to.
 *
 * `name` is non-null BY CONSTRUCTION: `capabilities.name` is NOT NULL with no
 * soft-delete, so a null name could only ever mean the container row is GONE and
 * the `member_of` edge is dangling. A dangling edge is not a membership — see
 * `indexContainerLinks`, which drops those rows rather than emitting a
 * `containerId` that resolves to nothing.
 */
export interface ContainerRef {
  id: string;
  name: string;
}

/** Index key for a polymorphic member endpoint (`tool`/`skill` + its id). */
export function containerMemberKey(fromType: string, fromId: string): string {
  return `${fromType}:${fromId}`;
}

/**
 * Fold `member_of` edge rows into a `fromType:fromId → container` index. Pure,
 * so the batching (below) and the mapping are independently testable. A brick
 * linked into several containers reports the OLDEST edge — the same "first row
 * wins" semantics as `resolveToolCapabilityId` (routers/tools.ts), which the
 * caller orders by `links.createdAt` to make deterministic.
 *
 * A row whose `containerName` is null is DROPPED, not recorded. `capabilities`
 * .name is NOT NULL, so null here means the container row no longer exists and
 * the edge is dangling. Recording it was harmful twice over: consumers navigated
 * to a `containerId` that 404s, and — worse — `sectionCapabilities`'s fill-in
 * (`if (!existing.containerId && c.containerId)`) read the dead id as truthy,
 * permanently BLOCKING a second row's real membership from landing, so a brick
 * reported a dead container forever while its live one stayed invisible.
 */
export function indexContainerLinks(
  rows: Array<{
    fromType: string;
    fromId: string;
    containerId: string;
    containerName: string | null;
  }>
): Map<string, ContainerRef> {
  const out = new Map<string, ContainerRef>();
  for (const r of rows) {
    if (r.containerName == null) continue; // dangling edge — not a membership
    const key = containerMemberKey(r.fromType, r.fromId);
    if (!out.has(key)) {
      out.set(key, { id: r.containerId, name: r.containerName });
    }
  }
  return out;
}

/**
 * Resolve the owning capability container for every tool/skill the caller has
 * already loaded — ONE batched query over `links`, never N single-row lookups.
 * Same predicate as `resolveToolCapabilityId` (`from_type` + `from_id` +
 * `link_type='member_of'` + `to_type='capability'`), which rides the
 * `idx_links_from` index, widened to an `inArray` fan-out and joined to the
 * container for its display name.
 *
 * The `::text` cast on `capabilities.id` is required, not cosmetic: `links.toId`
 * is text and Postgres has no implicit uuid=text operator (SQLSTATE 42883) — the
 * same trap the connection-state query above documents.
 */
export async function loadContainerRefs(members: {
  toolIds: string[];
  skillIds: string[];
  /** The reading identity — the container name is disclosed under THEIR lens. */
  userId: string;
}): Promise<Map<string, ContainerRef>> {
  const ids = [...members.toolIds, ...members.skillIds];
  if (ids.length === 0) return new Map();
  const db = await getDb();
  const rows = await db
    .select({
      fromType: links.fromType,
      fromId: links.fromId,
      containerId: links.toId,
      containerName: capabilityContainers.name,
    })
    .from(links)
    // INNER, not LEFT: an edge to a container row that no longer exists is a
    // dangling edge, not a membership. See `indexContainerLinks`.
    .innerJoin(
      capabilityContainers,
      eq(drizzleSql`${capabilityContainers.id}::text`, links.toId)
    )
    .where(
      and(
        inArray(links.fromType, ["tool", "skill"]),
        inArray(links.fromId, ids),
        eq(links.linkType, "member_of"),
        eq(links.toType, "capability"),
        // The membership edge must be visible to the reader. Without this, a
        // POD-WIDE brick (visible to everyone) that `addPart` deliberately allows
        // into a WORKSPACE-scoped container (capability-containers.ts: "attaching
        // a pod-wide tool/skill the caller can see is intentional") leaked that
        // private container's NAME to every other workspace — rendered verbatim
        // as a chip in the step picker and the browser catalogue. `addPart` stamps
        // the edge with the CONTAINER's workspaceId, so this predicate is exactly
        // the container's lens.
        userVisibleWhere(links.workspaceId, members.userId)
      )
    )
    .orderBy(links.createdAt);
  return indexContainerLinks(rows);
}

/** Coerce a loosely-typed jsonb input schema into the contract shape. */
function asInputSchema(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Minimal duck-typed shape a Zod field exposes — avoids importing full ZodTypeAny. */
interface ZodFieldLike {
  isOptional?: () => boolean;
  description?: string;
  /** Zod 4 introspection. `def.type` is a string tag; wrappers nest an `innerType`. */
  def?: {
    type?: string;
    innerType?: ZodFieldLike;
    entries?: Record<string, unknown>;
  };
}

/**
 * The param types a client can render a real control for.
 *
 * Closed on purpose: an open string would let a Zod tag nobody has a control
 * for reach the wire, and the client would fall back to a text box WITHOUT
 * saying so. `undefined` is the honest "we could not tell" — which
 * `paramsSchemaToFormSpec` already treats as "render untyped, never drop".
 */
export type ParamValueType = "string" | "number" | "boolean" | "date" | "enum";

const ZOD_TAG_TO_PARAM_TYPE: Record<string, ParamValueType> = {
  string: "string",
  number: "number",
  bigint: "number",
  boolean: "boolean",
  date: "date",
  enum: "enum",
};

/** Unwrap `optional` / `nullable` / `default` to the type that carries meaning. */
function unwrapZod(field: ZodFieldLike): ZodFieldLike {
  let current = field;
  // Bounded: these wrappers nest at most a few deep, and a cycle would hang.
  for (let i = 0; i < 8; i++) {
    const tag = current.def?.type;
    if (tag !== "optional" && tag !== "nullable" && tag !== "default") break;
    const inner = current.def?.innerType;
    if (!inner) break;
    current = inner;
  }
  return current;
}

/**
 * Derive an honest params schema for a BUILTIN verb from its Zod param schema
 * (`BUILTIN_VERB_PARAM_SCHEMAS` — the actual execution-time validator, the SSOT
 * `execute-capability.ts` parses against). Reads the schema's `.shape` rather than
 * re-deriving from the seeded JSON `parameters` doc, so this can never drift from
 * what the handler actually accepts.
 */
export function deriveBuiltinVerbParamsSchema(verbId: string):
  | Record<
      string,
      {
        required: boolean;
        description?: string;
        type?: ParamValueType;
        options?: string[];
      }
    >
  | undefined {
  const schema = BUILTIN_VERB_PARAM_SCHEMAS[verbId];
  if (!schema) return undefined;
  const shape = (schema as unknown as { shape: Record<string, ZodFieldLike> })
    .shape;
  const out: Record<
    string,
    {
      required: boolean;
      description?: string;
      type?: ParamValueType;
      options?: string[];
    }
  > = {};
  for (const [key, field] of Object.entries(shape)) {
    // ⚠️ THE TYPE WAS ALWAYS HERE AND WAS NEVER READ. This walked the Zod shape
    // for `required` and `description` and ignored the one thing that decides
    // which control renders — so every action param reached the phone as a
    // bare text box.
    //
    // ⚠️ Measured, after an earlier version of this comment named examples it
    // had not checked: of 100 top-level params across the 30 builtin schemas,
    // 80 are `string`, 4 `enum`, 3 `number` (all `z.coerce`), and there are
    // ZERO booleans and ZERO dates. `profileSlug` is `z.string()`, not an enum.
    // So this pays off for the 4 enums and 3 numbers, and the honest majority
    // stays a text box. Read at the EXECUTION-TIME schema, so the
    // control can never disagree with what the executor will accept.
    const inner = unwrapZod(field);
    const tag = inner.def?.type;
    const type = tag ? ZOD_TAG_TO_PARAM_TYPE[tag] : undefined;
    const entries = inner.def?.entries;
    out[key] = {
      required:
        typeof field.isOptional === "function" ? !field.isOptional() : true,
      description: field.description,
      // Omitted rather than guessed: an unknown tag degrades to an untyped
      // text box, which is the documented and correct behaviour.
      ...(type ? { type } : {}),
      ...(type === "enum" && entries ? { options: Object.keys(entries) } : {}),
    };
  }
  return out;
}

/** Every `{{param}}` token referenced across a provider verb's templated strings. */
function extractTemplateParams(spec: ProviderVerbSpec): string[] {
  const text = JSON.stringify([
    spec.pathTemplate,
    spec.query,
    spec.body,
    // GraphQL verbs template their args in the query text + variables, not
    // path/query/body — scan them too so params still project into the catalog.
    spec.graphql?.query,
    spec.graphql?.variables,
  ]);
  const found = new Set<string>();
  for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) found.add(m[1]);
  return [...found];
}

/**
 * Derive an honest params schema for a PROVIDER verb from its declarative spec:
 * every `{{param}}` referenced in path/query/body, `required` from
 * `paramMapping[param].required` (default false — a templated param with no
 * explicit `required:true` has a default/is optional). No description — not
 * modeled upstream, so none is fabricated.
 */
export function deriveProviderVerbParamsSchema(
  spec: ProviderVerbSpec
): Record<string, { required: boolean }> | undefined {
  const params = extractTemplateParams(spec);
  if (params.length === 0) return undefined;
  const out: Record<string, { required: boolean }> = {};
  for (const p of params) {
    out[p] = { required: spec.paramMapping?.[p]?.required === true };
  }
  return out;
}

/**
 * Join a tool's structured verb catalog (`tools.capabilities`) with the tool's
 * active grant to produce the connection × verb × grant matrix rows. Each verb
 * inherits the SAME tool-level grant state today (grants are issued per tool, not
 * per verb): `granted` reflects an active grant existing, and `effectiveExecMode`
 * is the grant's exec-mode when granted, else the verb's `govDefault` — exactly
 * what the gate would apply. `paramsSchema` is attached per verb: builtin verbs
 * from their Zod validator, provider verbs from the requiring declarative skill's
 * `providerSpec` (looked up by verb id = skill name in `providerSpecByName`).
 */
export function buildVerbStates(
  catalog: ToolVerbCatalogEntry[] | null | undefined,
  grant: { execMode: ExecMode } | undefined,
  toolKind: string,
  providerSpecByName: Map<string, ProviderVerbSpec>,
  backingSkillExecutableByName: Map<string, boolean>,
  declaredReadOnlyByName: Map<string, boolean> = new Map(),
  /**
   * verb id (= skill name) → the skill row's OWN `intent` column.
   *
   * The authority for the routing axis (migration 0292). Preferred over the
   * catalog entry's mirrored `intent`, and this is the whole point: a skill that
   * `requires` NO tool has no catalog entry at all — so on `tools: []`
   * definitions (all of Synap Core's 47 builtins) the column is the only place
   * an intent can exist. See the fallback note in the body.
   *
   * ALSO used when a tool row has an empty catalog but its backing skills declare
   * intents — the column is the only source of truth there. This mirrors the
   * same logic in `buildSkillVerb` for tool-less skills.
   */
  skillIntentByName: Map<string, string> = new Map(),
  /**
   * THIS tool's own skills that declare an intent, keyed by verb id.
   *
   * The empty-catalog fallback below is scoped to these, and MUST be: adopting
   * the pod-wide `skillIntentByName` here would attach every annotated skill on
   * the pod to every catalog-less tool row, so a `twilio` connection row would
   * advertise `gmail_send` and `isToolRowLaunchable` would judge the row on a
   * verb it cannot run. The `requires` declaration is the real relationship —
   * the same one `deriveToolVerbs` walks to build a catalog in the first place.
   */
  ownSkillIntents: Map<string, string> = new Map()
): CapabilityVerbStateWithResponseShape[] {
  const granted = !!grant;

  // If catalog is empty but THIS tool's own skills declare intents, build verb
  // states from the authoritative column (migration 0292). Scoped to
  // `ownSkillIntents` — the pod-wide map would adopt every annotated skill onto
  // every catalog-less tool row, advertising verbs the tool cannot run.
  // A tool-less skill has no entry here by construction and is projected by
  // `buildSkillVerb` on its own capability row instead.
  if (!Array.isArray(catalog) || catalog.length === 0) {
    if (ownSkillIntents.size === 0) return [];
    const verbs: CapabilityVerbStateWithResponseShape[] = [];
    for (const [verbId, intent] of ownSkillIntents.entries()) {
      const declared = declaredReadOnlyByName.get(verbId);
      const backingExecutable =
        backingSkillExecutableByName.get(verbId) === true;
      verbs.push({
        id: verbId,
        label: verbId,
        kind: "action" as const, // default for tool verbs
        granted: false, // ROUTING, NEVER AUTHORIZATION — a catalog-less tool has no grant
        govDefault: "propose", // absent grant, the posture is propose
        effectiveExecMode: "propose", // intent is routing; never widen authority
        ...(intent ? { intent } : {}),
        ...(declared !== undefined ? { declaredReadOnly: declared } : {}),
        backingSkillExecutable: backingExecutable,
      });
    }
    return verbs;
  }

  return catalog.map((v) => {
    const spec =
      toolKind === "provider" ? providerSpecByName.get(v.id) : undefined;
    const paramsSchema =
      toolKind === "builtin"
        ? deriveBuiltinVerbParamsSchema(v.id)
        : spec
          ? deriveProviderVerbParamsSchema(spec)
          : undefined;
    // COLUMN FIRST, CATALOG MIRROR SECOND. The column is the single writer; the
    // mirror only exists for rows installed before 0292 (which the migration's
    // backfill covers by deriving intent from exactly this catalog entry), so a
    // null column with a non-null mirror is the expected shape of a pod that has
    // not been re-applied yet. The column therefore OVERRIDES the mirror, not
    // merely fills a gap — otherwise a value the applier has since changed could
    // never take effect and the re-apply would be a no-op forever.
    //
    // When NEITHER side has one the key stays ABSENT (not `intent: undefined`),
    // so a consumer can tell "declares none" from "declares something" and
    // `foldVerbsByIntent` can leave the verb out of the index rather than guess
    // it into a bucket.
    const columnIntent = skillIntentByName.get(v.id);
    const intent = columnIntent ?? v.intent;
    return {
      ...v,
      ...(intent ? { intent } : {}),
      granted,
      effectiveExecMode: grant ? grant.execMode : v.govDefault,
      ...(paramsSchema ? { paramsSchema } : {}),
      // What this verb RETURNS — read off the same declarative spec the executor
      // applies (`execute-provider-verb.ts`), never re-derived or fabricated.
      ...(spec?.responseShape ? { responseShape: spec.responseShape } : {}),
      // A tool verb is only a real action when its backing skill can clear the
      // execute door's lifecycle + approval gates. The tool row's own approval
      // is not enough: executeCapability resolves and gates this skill.
      backingSkillExecutable: backingSkillExecutableByName.get(v.id) === true,
      // Only when the backing skill actually declares it — an absent key must
      // stay absent, so a consumer can tell "declares false" from "declares
      // nothing".
      ...(declaredReadOnlyByName.has(v.id)
        ? { declaredReadOnly: declaredReadOnlyByName.get(v.id) }
        : {}),
    };
  });
}

// ── Skill rows as verbs (the tool-less half of the routing axis) ─────────────

/**
 * The facts a `skills` row carries that a verb row is built from. Structurally a
 * subset of the `skills` table select, named so the projection below reads as
 * what it consumes rather than taking the whole row.
 */
interface SkillVerbFacts {
  name: string;
  kind: string;
  status: string;
  approved: boolean | null;
  metadata: unknown;
  parameters: unknown;
  intent: string | null;
}

/**
 * A tool-less skill IS a verb, and the registry must say so.
 *
 * ── WHY THIS EXISTS (the live defect, 2026-10-01) ──────────────────────────
 * `buildVerbStates` above can only see verbs that hang off a `tools` row's
 * catalog. A skill that `requires` NO tool has no such row — and both producers
 * of that shape declare `tools: []`: `SYNAP_CORE_DEFINITION` (47 builtins) and
 * the CP's `web-read` template. Those verbs therefore reached the registry as
 * `kind:"skill"` rows carrying NO `verbs` array at all, and every consumer that
 * folds the routing axis iterates `c.verbs ?? []`. So the intent was written,
 * stored, and read, and still reached nothing: an agent asking
 * `intent:"send_message"` got only `gmail_send`, while the always-installed
 * `messaging.send` was invisible. Verified live, and reproduced under PGlite in
 * `builtin-skill-intent-reachability.pglite.test.ts`.
 *
 * ── WHY THE VERB ID IS THE SKILL NAME ──────────────────────────────────────
 * It is already the identity, three times over, and re-deriving a new one would
 * make the intent resolve to a verb no door can run:
 *   - `executeCapability` resolves `verbId` with `eq(skills.name, verbId)`;
 *   - `projectRunnableActions` already projects a skill-only row with
 *     `verbId = capability.name` and calls it "the same key the catalog card's
 *     verb and the execute door's `verbId` resolve by";
 *   - the registry's own contract for a TOOL verb is that its catalog `id`
 *     mirrors the requiring skill's name.
 * So the skill name is what a caller must be handed, and this row says so.
 *
 * ── WHY `[]` RATHER THAN A ROW WITH NO INTENT ───────────────────────────────
 * A verb that declares no intent must stay ABSENT from the index so a consumer
 * can tell "declares none" from "declares something" — the same reason
 * `buildVerbStates` omits the key entirely rather than writing
 * `intent: undefined`, and the reason `foldVerbsByIntent` never guesses. An
 * unannotated verb (all 30-odd pod-internal exemptions) is still listed as a
 * `verbs` row so the shape is uniform and `isVerbLaunchable` has something to
 * judge; it simply carries no `intent` and so cannot enter the index.
 *
 * ── ROUTING, NEVER AUTHORIZATION ───────────────────────────────────────────
 * This adds DISCOVERABILITY. It cannot widen what a caller may run: every
 * execution fact below (`backingSkillExecutable`, the read-only declaration)
 * is read off the SAME row the run door reads, and `granted` is `false`
 * unconditionally — a skill row carries no tool grant, so `foldVerbsByIntent`
 * reports it un-granted and `runPosture` therefore PROPOSES, exactly as it did
 * before this row existed. The action projection's own skill-only arm, which
 * governs what a run actually meets, is untouched.
 */
function buildSkillVerb(
  row: SkillVerbFacts,
  skillIntentByName: Map<string, string>
): CapabilityVerbStateWithResponseShape[] {
  const declared = declaredReadOnly(
    (row.metadata as Record<string, unknown> | null) ?? null
  );
  // The COLUMN is the single writer (migration 0292). The map is built from
  // `skillRows` with the same empty-string-is-absent rule the write door applies
  // (`z.string().min(1)`), so a `""` never becomes a routable slug.
  const intent = skillIntentByName.get(row.name);
  return [
    {
      id: row.name,
      label: row.name,
      // Direction for a skill verb, from the SAME `verbType` the catalog card
      // and the action projection use — never a fresh heuristic that could
      // disagree with them about whether this verb pulls or pushes.
      kind: verbType(
        row.name,
        row.metadata as Record<string, unknown> | null,
        row.kind
      ),
      // A skill row is not a tool row, so there is no tool grant to resolve and
      // no `govDefault` in a catalog. `false` is the honest "no grant exists",
      // which is what makes a non-read-only verb PROPOSE rather than run.
      granted: false,
      // Required by the `CapabilityVerbState` contract (`ToolVerb.govDefault`) —
      // the posture this verb would get with no grant, i.e. exactly the
      // `effectiveExecMode` below. It carries no decision here: `runPosture`
      // reads `granted` first and a skill row is never granted, so this is the
      // value a reader sees for "absent grant", not a second authority.
      govDefault: "propose",
      // The verb's default posture absent any grant, kept as the same value a
      // catalog-derived verb would carry so a consumer reading it cannot
      // mistake "unmeasured" for "auto".
      effectiveExecMode: "propose",
      // Read off THIS row, exactly as `buildVerbStates` does for a tool verb —
      // so `runPosture` short-circuits to `auto` for a skill that declares
      // itself read-only, identically on both paths.
      ...(declared !== undefined ? { declaredReadOnly: declared } : {}),
      ...(intent ? { intent } : {}),
      // Whether the execute door COULD launch it: the same lifecycle + approval
      // test `buildVerbStates` applies to a tool verb's backing skill.
      backingSkillExecutable: row.status === "active" && row.approved === true,
    },
  ];
}

// ── IS-native tool manifest (Spine 2 / 2b) ────────────────────────────────────
// The IS publishes its in-process tool registry at GET /api/manifest/tools. We
// fetch it (cached, TTL below) and map each tool to a `builtin-tool` capability
// so IS-native tools (web_search, graph_traverse, …) are discoverable AND
// governable through the ONE registry — filling the historical `builtinCaps: []`
// gap without hardcoding a list that would drift from the IS. Failure is
// graceful: `listCapabilities` never breaks if the IS is unreachable (returns
// the last good cache, else nothing).
interface ISManifestTool {
  name: string;
  category?: string;
  description?: string;
}
let isManifestCache: { at: number; caps: Capability[] } | null = null;
const IS_MANIFEST_TTL_MS = 60_000;

async function fetchISNativeCapabilities(): Promise<Capability[]> {
  if (isManifestCache && Date.now() - isManifestCache.at < IS_MANIFEST_TTL_MS) {
    return isManifestCache.caps;
  }
  try {
    const svc = await getDefaultActiveService();
    const res = await fetch(`${svc.endpoint}/api/manifest/tools`, {
      headers: { "X-API-Key": svc.apiKey },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return isManifestCache?.caps ?? [];
    const body = (await res.json()) as { tools?: ISManifestTool[] };
    const caps: Capability[] = (body.tools ?? []).map((t) => ({
      kind: "builtin-tool" as CapabilityKind,
      id: `is-native:${t.name}`,
      name: t.name,
      description: t.description ?? null,
      inputSchema: {},
      executor: "is-agent" as ExecutorRef,
      // Run posture: catalog-only, so nothing runs through the execute door
      // (`capabilityRowPosture` stamps the same `none` on the listed row).
      governance: "none",
      // IS-native tools are discoverable but NOT invokable through this door yet
      // (no run_capability bridge to the IS's in-process tool registry — recon-
      // verified they 404). Flagged explicitly so consumers (the MCP `runnable`
      // projection) exclude them by a real signal, not by string-sniffing the id.
      catalogOnly: true,
    }));
    isManifestCache = { at: Date.now(), caps };
    return caps;
  } catch {
    // IS down / no active service — never break the capability read-model.
    return isManifestCache?.caps ?? [];
  }
}

/**
 * Options narrowing the read-model to what an agent is actually looking for
 * (D1 — `list_capabilities(query, kind, limit)`). All optional; omitting every
 * option preserves the original full, unfiltered, unranked dump (back-compat for
 * existing consumers — the playbooks router, MCP adapter).
 */
export interface ListCapabilitiesOptions {
  /** Ranked tokenized substring match over name + verb labels + description. */
  query?: string;
  /** Exact `CapabilityKind` filter, applied before ranking. */
  kind?: CapabilityKind;
  /**
   * Cap the result count. Three states, not two:
   *   - `undefined` (omitted) — default behaviour: `DEFAULT_QUERY_LIMIT` when
   *     `query` is set, unbounded otherwise. Unchanged for every existing caller.
   *   - a `number` — explicit cap, sliced from this RAW (pre-dedup) flat list.
   *     Unchanged for every existing caller.
   *   - `null` — explicitly UNBOUNDED: skip the slice below entirely, even with
   *     a `query` set. For a caller that is about to fold this list through
   *     `sectionCapabilities` — slicing the raw list first can push a genuine
   *     match out of the window behind duplicate rows (a provider installed
   *     twice, N backing-skill copies of one verb) that dedup would otherwise
   *     collapse. Pass `null` and cap AFTER dedup instead (`sectionCapabilities`'s
   *     own `limit` option), over distinct rows.
   */
  limit?: number | null;
}

/** Default result cap when a query narrows the list (keeps agent responses compact). */
/**
 * Does this tool's credential live in the VAULT (a secret the person pasted)
 * rather than at the BROKER (an OAuth account Nango holds)?
 *
 * The two are not interchangeable and the difference decides two things, both
 * of which were wrong when they were treated as one:
 *
 *  - what "connected" MEANS. A brokered provider is connected iff a live secret
 *    row carries an `accountHint` (the broker's connection id). A vault-backed
 *    provider has no broker account — `accountHint` is NULL by construction — so
 *    requiring it made every pasted-key provider read "not connected" while its
 *    key sat in the vault.
 *  - what its provider id IS. Apply-time remapping rewrites `vault://stripe`
 *    into `vault://<uuid>`, which names no service a connector could match; the
 *    tool's own name is the provider. A `nango://` ref survives intact, so its
 *    scheme-stripped remainder is the provider.
 *
 * Exported (and pure) so the rule is testable without a database — the two bugs
 * above both lived in this derivation, not in the query around it.
 */
export function isVaultCredentialRef(ref: string | null | undefined): boolean {
  return (ref ?? "").trim().toLowerCase().startsWith("vault://");
}

/**
 * Split PROVIDER tool ids by how their credential is held, because the two
 * halves need DIFFERENT proof of "connected" (see `markConnected`): a brokered
 * connection must point at an account (`accountHint`), a stored vault secret IS
 * the connection. One query over both sets with one predicate is precisely the
 * defect this split fixes — a vault tool can never satisfy `accountHint`.
 *
 * Pure, so the branch that sends each half to the right query is testable
 * without a database.
 */
export function partitionProvidersByCredential(
  toolRows: ReadonlyArray<{
    id: string;
    kind: string;
    credentialRef: string | null;
  }>
): { brokered: string[]; vault: string[] } {
  const brokered: string[] = [];
  const vault: string[] = [];
  for (const row of toolRows) {
    if (row.kind !== "provider") continue;
    (isVaultCredentialRef(row.credentialRef) ? vault : brokered).push(row.id);
  }
  return { brokered, vault };
}

/** The provider id a connector could match, for a provider-kind tool. */
export function providerIdForTool(tool: {
  credentialRef: string | null;
  name: string;
}): string {
  if (isVaultCredentialRef(tool.credentialRef)) return tool.name;
  // `||`, not `??`: stripping the scheme off a bare `nango://` yields "", and an
  // empty provider is not a provider.
  return tool.credentialRef?.replace(/^nango:\/\//, "").trim() || tool.name;
}

export const DEFAULT_QUERY_LIMIT = 20;

/**
 * List every capability visible to the caller in this workspace, normalized into
 * the `Capability` read-model. Read-only — no writes, no governance.
 *
 * Visibility: pod-wide (workspaceId IS NULL) OR rows belonging to this workspace.
 * (Reads are auto-approved by governance-policy "*.read" entries.)
 */
export async function listCapabilities(
  ctx: CapabilityRegistryContext,
  opts?: ListCapabilitiesOptions
): Promise<RegistryCapability[]> {
  const db = await getDb();

  // ── Tools ──────────────────────────────────────────────────────────────────
  // Pod altitude (workspaceId === null) sees pod-wide rows only — no workspace
  // branch, so no chance of an unbound `eq(...)` against a missing lens.
  // `toolNotRetiredWhere()` is the same floor the skill branch below applies in
  // JS (`s.status === "active" && s.approved`): a retired row must not be
  // advertised as an action. See that helper for why the predicate is
  // `status <> 'inactive'` and not `= 'active'`, and why `approved` — which
  // gates EXECUTION, not visibility — is deliberately not consulted here.
  const toolRows = await db
    .select()
    .from(tools)
    .where(
      and(
        ctx.allSpaces
          ? // Pod-wide + every space the caller can see — the access floor,
            // never a hand-rolled membership join.
            userVisibleWhere(tools.workspaceId, ctx.userId)
          : ctx.workspaceId
            ? or(
                isNull(tools.workspaceId),
                eq(tools.workspaceId, ctx.workspaceId)
              )
            : isNull(tools.workspaceId),
        toolNotRetiredWhere()
      )
    );

  // Resolve each tool's active grant so the verb catalog can be surfaced WITH
  // grant-state (the connection × verb × grant matrix). "Active" = not revoked,
  // not expired, and uses remaining (or unlimited). When several grants exist for
  // a tool we keep the first active row — the gate's resolver applies the same
  // narrowing per redemption. Aligns the read-model to the founder's grant model.
  const toolIds = toolRows.map((r) => r.id);
  const grantByGrantableId = new Map<string, { execMode: ExecMode }>();
  if (toolIds.length > 0) {
    const now = new Date();
    const grantRows = await db
      .select({
        grantableId: vaultGrants.grantableId,
        execMode: vaultGrants.execMode,
      })
      .from(vaultGrants)
      .where(
        and(
          eq(vaultGrants.grantableType, "tool"),
          inArray(vaultGrants.grantableId, toolIds),
          isNull(vaultGrants.revokedAt),
          or(isNull(vaultGrants.expiresAt), gt(vaultGrants.expiresAt, now)),
          or(
            isNull(vaultGrants.maxUses),
            gt(vaultGrants.maxUses, vaultGrants.useCount)
          )
        )
      );
    for (const g of grantRows) {
      if (!grantByGrantableId.has(g.grantableId)) {
        grantByGrantableId.set(g.grantableId, { execMode: g.execMode });
      }
    }
  }

  // ── Skills (instruction | code) ─────────────────────────────────────────────
  // Same three-tier lens as execution: pod-wide, the caller's user-scoped
  // skills, and workspace skills only in this selected accessible workspace.
  // Fetched BEFORE toolCaps so declarative skills' `providerSpec` (the source of
  // truth for a provider verb's real param shape) is available to buildVerbStates.
  const skillRows = await db
    .select()
    .from(skills)
    // Owner-aware by construction: `visibleSkillsWhere` ANDs `skills.userId` on
    // the user tier and re-ANDs the membership lens on the workspace tier. At
    // pod altitude it degrades to `pod OR (user AND userId = caller)`.
    .where(
      ctx.allSpaces
        ? visibleSkillsAnyWorkspaceWhere(ctx.userId)
        : visibleSkillsWhere(ctx.userId, ctx.workspaceId ?? undefined)
    );

  // The skill→tool `requires` edges live in the `links` table, not on the skill row.
  // Fetch them in one batched query for all visible skills.
  const skillIds = skillRows.map((s) => s.id);
  const skillRequiredTools = new Map<string, string[]>();
  if (skillIds.length > 0) {
    const requiredToolEdges = await db
      .select({
        skillId: links.fromId,
        toolId: links.toId,
      })
      .from(links)
      .where(
        and(
          eq(links.fromType, "skill"),
          eq(links.toType, "tool"),
          eq(links.linkType, "requires"),
          inArray(links.fromId, skillIds)
        )
      );
    for (const e of requiredToolEdges) {
      const arr = skillRequiredTools.get(e.skillId) ?? [];
      arr.push(e.toolId);
      skillRequiredTools.set(e.skillId, arr);
    }
  }

  // verb id (= skill name) → providerSpec, for declarative skills only. A tool's
  // verb catalog entry id mirrors the requiring skill's name (see deriveToolVerbs
  // in create-from-definition.ts), so this is a direct lookup, no join needed.
  const providerSpecByName = new Map<string, ProviderVerbSpec>();
  const backingSkillExecutableByName = new Map<string, boolean>();
  // verb id (= skill name) → the skill's authored read-only declaration, read
  // through the same helper the gate uses.
  const declaredReadOnlyByName = new Map<string, boolean>();
  // verb id (= skill name) → the skill row's own `intent` COLUMN. Read straight
  // off `skillRows` (which selects every column), never off the tool's catalog:
  // a skill requiring no tool has no catalog to read, which is precisely why
  // this map exists.
  const skillIntentByName = new Map<string, string>();
  // tool id → the intent-slug-bearing skills that DECLARE that tool, i.e. the
  // real `skills.requires` join. The empty-catalog fallback in `buildVerbStates`
  // must be scoped to the tool being read: a pod-wide intent map would adopt
  // every annotated skill on the pod onto every catalog-less tool row, so a
  // `twilio` connection row would be advertised as offering `gmail_send`, and
  // `isToolRowLaunchable` would judge it on a verb it cannot run. A skill that
  // requires no tool belongs to NO entry here and is projected by
  // `buildSkillVerb` on its own row instead — which is where tool-less skills
  // were always meant to surface.
  const skillIntentsByTool = new Map<string, Map<string, string>>();
  for (const s of skillRows) {
    const declared = declaredReadOnly(s.metadata);
    if (declared !== undefined) declaredReadOnlyByName.set(s.name, declared);
    // Empty string is treated as absent, matching the write door's `z.string()
    // .min(1)` — an empty intent is not a routable slug.
    if (typeof s.intent === "string" && s.intent.length > 0) {
      skillIntentByName.set(s.name, s.intent);
      // Use the batched links query instead of s.requires (which doesn't exist on the row)
      const requiredTools = skillRequiredTools.get(s.id) ?? [];
      for (const requiredTool of requiredTools) {
        let bySkill = skillIntentsByTool.get(requiredTool);
        if (!bySkill) {
          bySkill = new Map<string, string>();
          skillIntentsByTool.set(requiredTool, bySkill);
        }
        bySkill.set(s.name, s.intent);
      }
    }
    if (s.kind === "declarative" && s.providerSpec) {
      providerSpecByName.set(s.name, s.providerSpec as ProviderVerbSpec);
    }
    // `executeCapability` prefers approved candidates when duplicate verb names
    // exist. Any visible active+approved backing skill therefore makes this verb
    // executable; absent/draft/inactive rows must not be advertised as actions.
    if (s.status === "active" && s.approved) {
      backingSkillExecutableByName.set(s.name, true);
    } else if (!backingSkillExecutableByName.has(s.name)) {
      backingSkillExecutableByName.set(s.name, false);
    }
  }

  // Last-known connection state for PROVIDER tools, so an agent can tell
  // "connected" from "needs connection". Batched, no live probe — freshness is
  // owned by Wave-5's disconnect self-heal + lazy reconciler; authoritative live
  // state is behind the connectors door.
  //
  // A provider authenticates one of TWO ways, and the difference decides both
  // what its `provider` id is and what "connected" MEANS:
  //
  //   BROKER  `credentialRef` is `nango://<provider>` — an OAuth account the
  //           broker holds. Connected iff a live secret row carries an
  //           `accountHint`, which selects 1-of-N Nango connections
  //           (schema/secrets-vault.ts:169).
  //   VAULT   `credentialRef` was rewritten to `vault://<id>` at apply time — a
  //           key the person pasted, stored server-side (Stripe). There is no
  //           broker account, so `accountHint` is NULL BY CONSTRUCTION; requiring
  //           it made every vault-backed provider read "not connected" while its
  //           key sat in the vault. Connected iff a live secret row exists.
  //
  // The scheme is also the only surviving clue to the SERVICE: the remap
  // rewrites `vault://stripe` to `vault://<uuid>`, so the id names nothing a
  // connector could match — the tool's own name is the provider.
  const connectedProviderToolIds = new Set<string>();
  const markConnected = async (
    ids: string[],
    requireBrokerAccount: boolean
  ): Promise<void> => {
    if (ids.length === 0) return;
    const rows = await db
      .selectDistinct({ toolId: links.fromId })
      .from(links)
      // `secrets.capabilityId` is uuid, `links.toId` is text — Postgres has no
      // implicit uuid=text operator (SQLSTATE 42883), which crashed EVERY
      // list_capabilities call on any pod with a provider tool (the guard above
      // fires whenever a Gmail/Calendar connector is installed). Cast the uuid
      // side to text (always safe; both store canonical lowercase uuids). The
      // reverse cast (text::uuid) could throw 22P02 on a malformed to_id.
      .innerJoin(
        secrets,
        eq(drizzleSql`${secrets.capabilityId}::text`, links.toId)
      )
      .where(
        and(
          eq(links.fromType, "tool"),
          eq(links.toType, "capability"),
          eq(links.linkType, "member_of"),
          inArray(links.fromId, ids),
          eq(secrets.userId, ctx.userId),
          isNull(secrets.deletedAt),
          // A brokered connection must name the account it points at; a stored
          // vault secret IS the connection, so its row alone is the proof.
          requireBrokerAccount ? isNotNull(secrets.accountHint) : undefined
        )
      );
    for (const r of rows) connectedProviderToolIds.add(r.toolId);
  };
  const { brokered, vault } = partitionProvidersByCredential(toolRows);
  await markConnected(brokered, true);
  await markConnected(vault, false);

  // Which capability container each brick belongs to — ONE batched `links`
  // fan-out over the ids already loaded above. Derived per read, never stored:
  // nothing denormalises verb→tool→container, so there is no cache to drift.
  const containerByMember = await loadContainerRefs({
    toolIds,
    // `kind: 'instruction'` rows are teaching-doc skills — the branch below
    // never reads their containerByMember entry, so exclude them here to
    // avoid widening the `inArray` fan-out for nothing.
    skillIds: skillRows
      .filter((r) => r.kind !== "instruction")
      .map((r) => r.id),
    userId: ctx.userId,
  });

  // Only an all-spaces read tags a row with its space (shape unchanged otherwise).
  const spaceTag = (workspaceId: string | null | undefined) =>
    ctx.allSpaces ? { workspaceId: workspaceId ?? null } : {};

  const toolCaps: RegistryCapability[] = toolRows.map((row) => ({
    kind: toolKindToCapabilityKind(row.kind),
    id: row.id,
    ...spaceTag(row.workspaceId),
    name: row.name,
    description: row.description ?? null,
    inputSchema: asInputSchema(row.inputSchema),
    executor: row.executor as ExecutorRef,
    // Run posture, stamped once every row is built (below).
    governance: "none",
    enabled: row.approved === true,
    containerId:
      containerByMember.get(containerMemberKey("tool", row.id))?.id ?? null,
    containerName:
      containerByMember.get(containerMemberKey("tool", row.id))?.name ?? null,
    verbs: buildVerbStates(
      row.capabilities as ToolVerbCatalogEntry[] | null,
      grantByGrantableId.get(row.id),
      row.kind,
      providerSpecByName,
      backingSkillExecutableByName,
      declaredReadOnlyByName,
      skillIntentByName,
      skillIntentsByTool.get(row.id) ?? new Map()
    ),
    ...(row.kind === "provider"
      ? {
          connection: {
            required: true,
            connected: connectedProviderToolIds.has(row.id),
            provider: providerIdForTool(row),
          },
        }
      : {}),
  }));

  // `kind='instruction'` rows are teaching prose (system-prompt text), not a
  // runnable capability — map them to "teaching-doc" so flat-list consumers
  // (e.g. the MCP `runnable` verb projection) don't offer them as an action.
  // Still LISTED: discoverability is the point, just honestly typed.
  const skillCaps: RegistryCapability[] = skillRows.map((row) =>
    row.kind === "instruction"
      ? {
          kind: "teaching-doc",
          id: row.id,
          // The ref `synap_load_skill` takes. A teaching doc is READ, never
          // run, so its name is not an identifier any door resolves — without
          // this the MCP `kind:"teaching-doc"` listing would name rows the
          // caller then cannot open.
          slug: row.slug ?? null,
          name: row.name,
          description: row.description ?? null,
          inputSchema: asInputSchema(row.parameters),
          executor: "is-agent",
          governance: "none",
          enabled: row.approved === true,
        }
      : {
          kind: "skill",
          id: row.id,
          // A pod/user-scoped skill belongs to no space even if a stale
          // workspace_id lingers on it — visibility keys off `scope`.
          ...spaceTag(row.scope === "workspace" ? row.workspaceId : null),
          name: row.name,
          description: row.description ?? null,
          inputSchema: asInputSchema(row.parameters),
          executor: "is-agent",
          // Run posture, stamped once every row is built (below).
          governance: "none",
          enabled: row.approved === true,
          skillKind: row.kind,
          skillMetadata:
            (row.metadata as Record<string, unknown> | null) ?? null,
          containerId:
            containerByMember.get(containerMemberKey("skill", row.id))?.id ??
            null,
          containerName:
            containerByMember.get(containerMemberKey("skill", row.id))?.name ??
            null,
          // Lifecycle is distinct from approval. Keep inactive/error skills in
          // the broad registry for management surfaces, but mark them so the
          // shared action projection never advertises an unlaunchable skill.
          runnable: row.status === "active",
          verbs: buildSkillVerb(row, skillIntentByName),
        }
  );

  // ── Commands (intelligence_commands) ────────────────────────────────────────
  const commandRows = await db
    .select()
    .from(intelligenceCommands)
    .where(
      ctx.allSpaces
        ? userVisibleWhere(intelligenceCommands.workspaceId, ctx.userId)
        : ctx.workspaceId
          ? or(
              isNull(intelligenceCommands.workspaceId),
              eq(intelligenceCommands.workspaceId, ctx.workspaceId)
            )
          : isNull(intelligenceCommands.workspaceId)
    );

  const commandCaps: Capability[] = commandRows.map((row) => ({
    kind: "command",
    id: row.id,
    ...spaceTag(row.workspaceId),
    name: row.title,
    description: null,
    // Commands declare inputs as DerivedInput[] — surfaced as the raw array under
    // a `derivedInputs` key (the contract's inputSchema is an open record).
    inputSchema: { derivedInputs: row.derivedInputs ?? [] },
    executor: "is-agent",
    governance: "none",
  }));

  // IS-native tools, fetched (cached) from the IS manifest endpoint — see
  // fetchISNativeCapabilities above. Graceful: [] when the IS is unreachable.
  const builtinCaps: Capability[] = await fetchISNativeCapabilities();

  const all = assembleRegistryRows({
    builtinCaps,
    toolCaps,
    skillCaps,
    commandCaps,
  });

  let result = all;
  if (opts?.kind) result = result.filter((c) => c.kind === opts.kind);
  if (opts?.query && opts.query.trim().length > 0) {
    result = rankByTerms(
      opts.query,
      result,
      (cap) => ({
        primary: cap.name,
        secondary: (cap.verbs ?? []).map((v) => v.label ?? v.id),
        tertiary: cap.description,
      }),
      { primary: "name", secondary: "verbs", tertiary: "description" }
    ).map((s) => ({ ...s.item, match: s.match }));
    // `null` means "an explicit caller-owned cap runs later, over deduped
    // rows — don't slice the raw list here." See `ListCapabilitiesOptions.limit`.
    if (opts.limit !== null) {
      result = result.slice(0, opts.limit ?? DEFAULT_QUERY_LIMIT);
    }
  } else if (typeof opts?.limit === "number") {
    result = result.slice(0, opts.limit);
  }
  return result;
}

/**
 * The flat registry's final rows. `governance` on every row is the RUN POSTURE
 * (`capabilityRowPosture`), stamped from the facts each row carries; `enabled` is
 * the approval gate. Commands and IS-native tools have no `approved` column, so
 * the gate's approval step does not refuse them (`approved === null`) →
 * `enabled: true`. Pure and exported so the flat door's label is tested at the
 * seam that stamps it.
 */
export function assembleRegistryRows(parts: {
  builtinCaps: Capability[];
  toolCaps: RegistryCapability[];
  skillCaps: RegistryCapability[];
  commandCaps: Capability[];
}): RegistryCapability[] {
  return [
    ...parts.builtinCaps.map((c) => ({ ...c, enabled: true })),
    ...parts.toolCaps,
    ...parts.skillCaps,
    ...parts.commandCaps.map((c) => ({ ...c, enabled: true })),
  ].map((c) => ({ ...c, governance: capabilityRowPosture(c) }));
}

// ── Sectioned, deduped view (agent-facing "what can I DO") ────────────────────
/**
 * The agent-facing projection of the flat capability list: real, distinct,
 * runnable capabilities grouped by TYPE, with each integration's verbs nested.
 *
 * WHY this exists: the flat `listCapabilities` dump is a management read-model —
 * it includes 90+ IS-native `builtin-tool`s (already exposed directly as MCP
 * tools, `catalogOnly` so not even runnable through `run_capability`) and 100+
 * `teaching-doc`s (prompt prose, not actions), plus duplicate rows (a provider
 * installed twice, N backing-skill copies of one verb). Handing all of that to
 * an agent as "your capabilities" buries the ~20 things it can actually do. This
 * view de-duplicates and nests verbs under their integration so the shape reads
 * like "a package and the verbs inside it".
 *
 * Built-ins are a SECTION, not an exclusion. A capability verb is to a process
 * what an entity is to the pod — a brick — so a built-in must be browsable and
 * inspectable even when it cannot be picked as a step. It therefore gets its own
 * section (a UI renders it collapsed), each row carrying `runnableHere` so a
 * flow-node picker can filter on a fact instead of on the section's name. Only
 * `teaching-doc`s are still folded out — prompt prose is not a brick at all.
 */
/** A verb row in a section, with its own run posture (see `runPosture`). */
export type SectionVerb = CapabilityVerbStateWithResponseShape & {
  governance?: RunPosture;
};

/**
 * `governance` on every section row is the RUN POSTURE (`runPosture`): what an
 * agent's run experiences — `auto` runs now, `propose` files a review, `none`
 * nothing runnable. A multi-verb row is `auto` only when EVERY verb is. The
 * enable/approval gate is `enabled`, a separate fact, never `governance`.
 */
export interface SectionedCapabilities {
  /** Integrations (Nango providers + API/MCP tools), one per name, verbs nested. */
  integrations: Array<{
    /**
     * The `tools` row id this entry stands for. Rows are still de-duplicated by
     * NAME (a provider installed twice), so this is the REPRESENTATIVE row —
     * the first one seen — not a claim that only one row exists.
     */
    id: string;
    /** The row's own space (`null` = pod-wide). Present ONLY with `bySpace`. */
    workspaceId?: string | null;
    /**
     * The capability container this integration belongs to, or `null` for an
     * un-packaged brick. `null` is a real answer, not a missing one: it is what
     * lets a catalogue render packaged capabilities and loose bricks apart.
     * Derived per read from the `member_of` links — never stored.
     */
    containerId: string | null;
    /** Display name of `containerId`'s container; null when it has none. */
    containerName: string | null;
    name: string;
    kind: CapabilityKind;
    description: string | null;
    governance: "auto" | "propose" | "none";
    /** Operator approval of the tool row (any same-named copy approved). */
    enabled: boolean;
    connection?: { required: boolean; connected: boolean; provider: string };
    /** Verb rows incl. the declarative subset's `responseShape` (what it returns). */
    verbs: SectionVerb[];
    /**
     * What is BLOCKING this integration and the link to where a human unblocks
     * it — `connect` (dead/absent account) or `enable` (unapproved verbs), never
     * collapsed, because they are different fixes. Absent when nothing blocks.
     *
     * This is the DISCOVERY moment: `granted:false` / `connected:false` were
     * already returned per verb, but an agent reading them had no next step to
     * hand back. Resolved by the same `capabilityNextAction` the catalog card
     * uses (`capability-enable-link.ts`), so the hint can never fork.
     */
    blocked?: CapabilityNextAction;
    /** Why this row matched the `query` (see `RegistryCapability.match`). */
    match?: TermMatch;
  }>;
  /** Standalone runnable skills — a skill that BACKS a provider verb is shown
   *  under that integration instead, never duplicated here. */
  skills: Array<{
    id: string;
    /** The row's own space (`null` = pod-wide). Present ONLY with `bySpace`. */
    workspaceId?: string | null;
    name: string;
    description: string | null;
    governance: "auto" | "propose" | "none";
    /** Operator approval of the skill row. */
    enabled: boolean;
    /** Owning capability container, or `null` for an un-packaged skill. */
    containerId: string | null;
    /** Display name of `containerId`'s container; null when it has none. */
    containerName: string | null;
    /** See `integrations[].blocked` — a skill blocks on approval only (it has no
     *  connection of its own), so this is `kind:"enable"` whenever present. */
    blocked?: CapabilityNextAction;
    /** Why this row matched the `query` (see `RegistryCapability.match`). */
    match?: TermMatch;
  }>;
  /** Intelligence commands. */
  commands: Array<{
    id: string;
    /** The row's own space (`null` = pod-wide). Present ONLY with `bySpace`. */
    workspaceId?: string | null;
    name: string;
    description: string | null;
  }>;
  /**
   * Built-in capabilities — browsable bricks, rendered as a collapsed section.
   * De-duplicated by name like every other section (the IS manifest and the
   * `tools` table can both describe the same built-in).
   */
  builtins: Array<{
    id: string;
    name: string;
    description: string | null;
    governance: "auto" | "propose" | "none";
    /**
     * Whether the shared capability-execution door can invoke this brick.
     *
     * DERIVED, never hardcoded: it is `catalogOnly !== true`, the same fact the
     * runnable projection (`action-projection.ts`) already gates on. The
     * distinction is real PER ROW, not per kind — an IS-native manifest tool is
     * emitted with `catalogOnly: true` (recon-verified: no `run_capability`
     * bridge to the IS's in-process registry, those calls 404), while a
     * `tools.kind='builtin'` row carries a verb catalog and no such flag. So
     * stamping every built-in `false` would assert something the data does not
     * back. A picker must offer a built-in as a step only when this is `true`.
     */
    runnableHere: boolean;
    /** Operator approval of the row (any same-named copy approved). */
    enabled: boolean;
    /** Verb catalog where the row carries one; `[]` for IS-native manifest tools. */
    verbs: SectionVerb[];
  }>;
  /**
   * Honest accounting of what was folded out of this view. Built-ins are NOT
   * counted here any more — they are shown, so listing them as excluded would be
   * a lie. Teaching docs stay: prompt prose is not a capability.
   */
  excluded: { teachingDocs: number };
}

export interface SectionCapabilitiesOptions {
  /**
   * Cap the DISTINCT row count across every section combined, ranked by each
   * row's first-occurrence position in `caps` (its score rank, when `caps` was
   * produced by a `query`). Applied AFTER dedup — the fix for the truncation
   * bug: pass the FULL (pre-dedup, unsliced — `listCapabilities({ limit: null,
   * query })`) list in and cap here, never by slicing `caps` before folding.
   * Omit for the historic behaviour: every distinct row, unbounded.
   */
  limit?: number;
  /**
   * Fold per SPACE: a row's dedupe identity becomes (its `workspaceId`, name)
   * instead of name alone, and every integration / skill / command row carries
   * `workspaceId`. For an `allSpaces` registry read — pod-wide copies still
   * collapse into one row, while a space-scoped copy stays its own row so a
   * surface can say "in <space>". Omit for the lensed fold (unchanged).
   */
  bySpace?: boolean;
}

/**
 * Fold the flat `Capability[]` read-model into the agent-facing sectioned view.
 * Pure — no I/O — so it is unit-testable and reusable by any door.
 */
export function sectionCapabilities(
  caps: RegistryCapability[],
  opts?: SectionCapabilitiesOptions
): SectionedCapabilities {
  const integrations = new Map<
    string,
    SectionedCapabilities["integrations"][number]
  >();
  const providerVerbIds = new Set<string>();
  const skillByName = new Map<
    string,
    SectionedCapabilities["skills"][number]
  >();
  const commands: SectionedCapabilities["commands"] = [];
  const builtinByName = new Map<
    string,
    SectionedCapabilities["builtins"][number]
  >();
  let teachingDocs = 0;
  const bySpace = opts?.bySpace === true;
  const key = (c: RegistryCapability) => spacedName(c, bySpace);
  const spaceOf = (c: RegistryCapability) =>
    bySpace ? { workspaceId: c.workspaceId ?? null } : {};
  const seenCommands = new Set<string>();

  for (const c of caps) {
    // Browsable, but usually not launchable through this door — carried as a row
    // with the fact attached rather than dropped and counted (a count cannot
    // render a collapsed section).
    if (c.kind === "builtin-tool") {
      const existing = builtinByName.get(c.name);
      if (!existing) {
        builtinByName.set(c.name, {
          id: c.id,
          name: c.name,
          description: c.description ?? null,
          // Run posture, stamped after the merge below.
          governance: "none",
          enabled: c.enabled,
          runnableHere: c.catalogOnly !== true,
          verbs: [...(c.verbs ?? [])],
        });
      } else {
        existing.enabled = existing.enabled || c.enabled;
        // Same built-in described twice: union the verbs and let the runnable
        // copy win — the merge must never DOWNGRADE a launchable brick, and
        // never UPGRADE a catalog-only one.
        const vmap = new Map(existing.verbs.map((v) => [v.id, v]));
        for (const v of c.verbs ?? []) if (!vmap.has(v.id)) vmap.set(v.id, v);
        existing.verbs = [...vmap.values()];
        existing.runnableHere = existing.runnableHere || c.catalogOnly !== true;
        if (!existing.description && c.description) {
          existing.description = c.description;
        }
      }
      continue;
    }
    // Prompt prose, not a capability.
    if (c.kind === "teaching-doc") {
      teachingDocs += 1;
      continue;
    }

    if (c.kind === "tool" || c.kind === "source-provider") {
      for (const v of c.verbs ?? []) providerVerbIds.add(v.id);
      const existing = integrations.get(key(c));
      if (!existing) {
        integrations.set(key(c), {
          id: c.id,
          ...spaceOf(c),
          containerId: c.containerId ?? null,
          containerName: c.containerName ?? null,
          name: c.name,
          kind: c.kind,
          description: c.description ?? null,
          // Run posture, stamped after the merge below.
          governance: "none",
          enabled: c.enabled,
          ...(c.connection ? { connection: c.connection } : {}),
          verbs: [...(c.verbs ?? [])],
          ...(c.match ? { match: c.match } : {}),
        });
      } else {
        existing.enabled = existing.enabled || c.enabled;
        // Duplicate rows of the SAME integration (the pod had e.g. `discord` ×5,
        // `google` connected+disconnected): union the verbs (prefer a granted
        // copy), OR the connected flag up, keep the first non-empty description.
        const vmap = new Map(existing.verbs.map((v) => [v.id, v]));
        for (const v of c.verbs ?? []) {
          const ev = vmap.get(v.id);
          if (!ev || (v.granted && !ev.granted)) vmap.set(v.id, v);
        }
        existing.verbs = [...vmap.values()];
        if (c.connection?.connected) {
          existing.connection = {
            ...(existing.connection ?? c.connection),
            connected: true,
          };
        }
        if (!existing.description && c.description) {
          existing.description = c.description;
        }
        if (!existing.match && c.match) existing.match = c.match;
        // Only one of several same-named rows may carry the `member_of` edge —
        // take the first that does rather than letting the representative row's
        // `null` mask a real membership.
        if (!existing.containerId && c.containerId) {
          existing.containerId = c.containerId;
          existing.containerName = c.containerName ?? null;
        }
      }
      continue;
    }

    if (c.kind === "skill") {
      // An unlaunchable skill (inactive/error) is management noise here.
      if (c.runnable === false) continue;
      if (!skillByName.has(key(c))) {
        skillByName.set(key(c), {
          id: c.id,
          ...spaceOf(c),
          name: c.name,
          description: c.description ?? null,
          governance: runPosture({
            verbId: c.name,
            skillKind: c.skillKind,
            declaredReadOnly: declaredReadOnly(c.skillMetadata),
          }),
          enabled: c.enabled,
          containerId: c.containerId ?? null,
          containerName: c.containerName ?? null,
          ...(c.match ? { match: c.match } : {}),
        });
      }
      continue;
    }

    if (c.kind === "command") {
      // A row id is unique, so this only dedupes a row handed in twice.
      if (seenCommands.has(c.id)) continue;
      seenCommands.add(c.id);
      commands.push({
        id: c.id,
        ...spaceOf(c),
        name: c.name,
        description: c.description ?? null,
      });
      continue;
    }
    // Other grantable kinds (secret, workspace…) are not agent-runnable — skip.
  }

  // A skill whose NAME is a provider verb id is the backing skill for that verb
  // (registry contract: a verb's catalog id mirrors its requiring skill's name).
  // It is already surfaced under the integration — don't list it a second time.
  const skills = [...skillByName.values()].filter(
    (s) => !providerVerbIds.has(s.name)
  );

  // ── DISCOVERY moment: attach what is blocking each row, and the link ────────
  // Computed AFTER the merge loop, never at first insert: duplicate rows of the
  // same integration union their verbs (preferring a granted copy), OR the
  // connected flag up, and fill in a `containerId` the representative row lacked
  // — so a pre-merge read would report `connect`/`enable` against state the
  // caller never sees, and could point at a container id that only became known
  // one row later.
  // Run posture per verb, then per row — after the merge, so a verb unioned in
  // from a duplicate row is classified too. A builtin-tool's verbs are builtin
  // skills; an integration's are not.
  for (const row of integrations.values()) stampRunPosture(row, null);
  for (const row of builtinByName.values()) stampRunPosture(row, "builtin");

  for (const row of integrations.values()) {
    const blocked = resolveCapabilityBlock({
      name: row.name,
      containerId: row.containerId,
      // The registry's `connection` is the flat `{required, connected, provider}`
      // projection; `resolveCapabilityBlock` speaks the catalog's
      // `CapabilityCardConnection`. Fold the one projection into the other HERE
      // (the single call site) rather than through a second converter.
      connection: row.connection
        ? {
            required: row.connection.required,
            kind: "provider",
            provider: row.connection.provider,
            state: row.connection.connected ? "connected" : "missing",
          }
        : undefined,
      // "Needs enable" = the execute door would REFUSE (`not_approved`): the
      // SAME predicate the runnable-action projection advertises by
      // (`isToolRowLaunchable` — tool approved AND a verb whose backing skill
      // is active+approved). NOT grant state: a missing tool grant only makes
      // an agent run PROPOSE (already said by `governance`), and no enable
      // switch issues a grant — so a grant-derived block could never clear.
      enabled: isToolRowLaunchable(row),
    });
    if (blocked) row.blocked = blocked;
  }
  for (const row of skillByName.values()) {
    // A standalone skill has no connection of its own — only approval can block
    // it, so this is always `kind:"enable"`.
    const blocked = resolveCapabilityBlock({
      name: row.name,
      containerId: row.containerId,
      enabled: row.enabled,
    });
    if (blocked) row.blocked = blocked;
  }

  const full: SectionedCapabilities = {
    integrations: [...integrations.values()],
    skills,
    commands,
    builtins: [...builtinByName.values()],
    excluded: { teachingDocs },
  };

  if (typeof opts?.limit !== "number") return full;
  return capSectionsByRank(full, caps, opts.limit, bySpace);
}

/**
 * A row's name-identity for the fold: the name alone (lensed), or the name
 * within its own space (`bySpace`). Pod-wide rows share the empty space, so
 * their duplicates still collapse. The ONE spelling — the fold and the rank cap
 * both key on it, so "the same row" cannot drift between them.
 */
function spacedName(
  c: { name: string; workspaceId?: string | null },
  bySpace: boolean
): string {
  return bySpace ? `${c.workspaceId ?? ""}\u0000${c.name}` : c.name;
}

/** Stamp each verb's run posture and fold the row's: `auto` only when every
 *  verb runs now, `none` when the row has no verb to run. */
function stampRunPosture(
  row: { verbs: SectionVerb[]; governance: "auto" | "propose" | "none" },
  skillKind: "builtin" | null
): void {
  row.verbs = row.verbs.map((v) => ({
    ...v,
    governance: runPosture({
      verbId: v.id,
      skillKind,
      granted: v.granted,
      execMode: v.effectiveExecMode,
    }),
  }));
  row.governance =
    row.verbs.length === 0
      ? "none"
      : row.verbs.every((v) => v.governance === "auto")
        ? "auto"
        : "propose";
}

/** The dedupe identity `sectionCapabilities` folds each `caps` row onto, or
 *  `null` for a row that never lands in a ranked section (teaching-doc and
 *  any other grantable kind the fold above skips). Kept as ONE function so a
 *  row's rank key can never drift from the fold's own "what counts as the
 *  same row" rule above. */
function sectionDedupeKey(
  c: RegistryCapability,
  bySpace: boolean
): string | null {
  if (c.kind === "builtin-tool") return `builtin:${c.name}`;
  if (c.kind === "tool" || c.kind === "source-provider")
    return `integration:${spacedName(c, bySpace)}`;
  if (c.kind === "skill") return `skill:${spacedName(c, bySpace)}`;
  if (c.kind === "command") return `command:${c.id}`;
  return null;
}

/**
 * Trim an already-deduped sectioned view down to `limit` DISTINCT rows,
 * keeping the highest-ranked ones. Rank = a row's first-occurrence position in
 * the ORIGINAL `caps` array — which is score-sorted top-first when the caller
 * ran a `query` through `listCapabilities`, so insertion order IS rank order.
 *
 * This is what fixes the truncation bug: capping HERE, after `sectionCapabilities`
 * has already unioned every duplicate row (multiple installs of one provider,
 * N backing-skill copies of one verb), means the cap counts distinct, visible
 * items — never a raw-row slice that could bury a real match behind duplicates
 * of something else. Re-derives no identity of its own: `sectionDedupeKey`
 * mirrors exactly what the fold above already decided "the same row" means.
 */
function capSectionsByRank(
  full: SectionedCapabilities,
  caps: RegistryCapability[],
  limit: number,
  bySpace: boolean
): SectionedCapabilities {
  const firstIndex = new Map<string, number>();
  caps.forEach((c, i) => {
    const key = sectionDedupeKey(c, bySpace);
    if (key && !firstIndex.has(key)) firstIndex.set(key, i);
  });

  const dedupeKeys = [
    ...full.integrations.map((it) => `integration:${spacedName(it, bySpace)}`),
    ...full.skills.map((s) => `skill:${spacedName(s, bySpace)}`),
    ...full.builtins.map((b) => `builtin:${b.name}`),
    ...full.commands.map((c) => `command:${c.id}`),
  ];
  const ranked = dedupeKeys
    .map((key) => ({
      key,
      rank: firstIndex.get(key) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.rank - b.rank);
  const kept = new Set(ranked.slice(0, limit).map((r) => r.key));

  return {
    integrations: full.integrations.filter((it) =>
      kept.has(`integration:${spacedName(it, bySpace)}`)
    ),
    skills: full.skills.filter((s) =>
      kept.has(`skill:${spacedName(s, bySpace)}`)
    ),
    commands: full.commands.filter((c) => kept.has(`command:${c.id}`)),
    builtins: full.builtins.filter((b) => kept.has(`builtin:${b.name}`)),
    excluded: full.excluded,
  };
}

// ── Capability grant listing (polymorphic — all grantableTypes) ───────────────

/** The grantable kinds the vault_grants table discriminates over. */
export type CapabilityGrantKind = "secret" | "tool" | "skill" | "command";

/** One grant row enriched with the joined capability's display name. */
export interface CapabilityGrantRow {
  grantId: string;
  grantableType: CapabilityGrantKind;
  grantableId: string;
  /** Display name of the granted capability (secret/tool/skill/command), null if dead. */
  capabilityName: string | null;
  execMode: string;
  scope: string;
  grantedTo: string | null;
  workspaceId: string | null;
  proposalId: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  revokedAt: string | null;
  createdAt: string;
  active: boolean;
}

/**
 * List capability grants across ALL grantable kinds (tool · skill · command ·
 * secret), each enriched with the granted capability's display name. This is the
 * generalization of `secretsVault.listAllGrants` (which filtered to secrets only):
 * the same `vault_grants` table powers every kind, so one resolver surfaces the
 * polymorphic grants the applier seeds (`issueCapabilityGrant`) — previously
 * invisible because no read path covered tool/skill/command kinds.
 *
 * Visibility: pod-wide grants (workspaceId IS NULL) OR grants belonging to one of
 * the workspaces the caller can see (passed in by the router, which knows the
 * caller's membership). Names are resolved per-kind from the owning tables; a
 * grant whose subject was deleted surfaces `capabilityName: null` (lazily-dead,
 * still revocable). Reads only — no governance.
 */
export async function listCapabilityGrants(args: {
  /** Workspaces the caller may see (their memberships). Pod-wide (null) always included. */
  visibleWorkspaceIds: string[];
  /** Optional kind filter; omit for every kind. */
  kind?: CapabilityGrantKind;
}): Promise<CapabilityGrantRow[]> {
  const db = await getDb();

  // Visibility predicate: pod-wide (null ws) OR a workspace the caller can see.
  const wsVisibility =
    args.visibleWorkspaceIds.length > 0
      ? or(
          isNull(vaultGrants.workspaceId),
          inArray(vaultGrants.workspaceId, args.visibleWorkspaceIds)
        )
      : isNull(vaultGrants.workspaceId);

  const rows = await db
    .select()
    .from(vaultGrants)
    .where(
      and(
        wsVisibility,
        args.kind ? eq(vaultGrants.grantableType, args.kind) : undefined
      )
    )
    .orderBy(desc(vaultGrants.createdAt));

  if (rows.length === 0) return [];

  // Resolve display names per kind in batch (one query per table touched).
  const idsByKind: Record<CapabilityGrantKind, string[]> = {
    secret: [],
    tool: [],
    skill: [],
    command: [],
  };
  for (const r of rows) {
    const k = r.grantableType as CapabilityGrantKind;
    if (idsByKind[k]) idsByKind[k].push(r.grantableId);
  }

  const nameById = new Map<string, string>();
  const collect = (list: { id: string; name: string }[]): void => {
    for (const row of list) nameById.set(row.id, row.name);
  };

  if (idsByKind.tool.length > 0) {
    collect(
      await db
        .select({ id: tools.id, name: tools.name })
        .from(tools)
        .where(inArray(tools.id, idsByKind.tool))
    );
  }
  if (idsByKind.skill.length > 0) {
    collect(
      await db
        .select({ id: skills.id, name: skills.name })
        .from(skills)
        .where(inArray(skills.id, idsByKind.skill))
    );
  }
  if (idsByKind.command.length > 0) {
    collect(
      await db
        .select({
          id: intelligenceCommands.id,
          name: intelligenceCommands.title,
        })
        .from(intelligenceCommands)
        .where(inArray(intelligenceCommands.id, idsByKind.command))
    );
  }
  if (idsByKind.secret.length > 0) {
    collect(
      await db
        .select({ id: secrets.id, name: secrets.name })
        .from(secrets)
        .where(inArray(secrets.id, idsByKind.secret))
    );
  }

  const now = Date.now();
  return rows.map((g) => ({
    grantId: g.id,
    grantableType: g.grantableType as CapabilityGrantKind,
    grantableId: g.grantableId,
    capabilityName: nameById.get(g.grantableId) ?? null,
    execMode: g.execMode,
    scope: g.scope,
    grantedTo: g.grantedTo,
    workspaceId: g.workspaceId,
    proposalId: g.proposalId,
    expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
    maxUses: g.maxUses,
    useCount: g.useCount,
    revokedAt: g.revokedAt ? g.revokedAt.toISOString() : null,
    createdAt: g.createdAt.toISOString(),
    active:
      !g.revokedAt &&
      (!g.expiresAt || g.expiresAt.getTime() > now) &&
      (g.maxUses == null || g.useCount < g.maxUses),
  }));
}
