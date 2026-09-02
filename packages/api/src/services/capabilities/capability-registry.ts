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
import { userVisibleWhere } from "@synap/database";
import { visibleSkillsWhere } from "../skills/visibility.js";
import { toolNotRetiredWhere } from "../tools/visibility.js";

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
   * The capability CONTAINER this brick belongs to (`tool|skill --member_of-->
   * capability`), or `null` for a brick that is in no container. DERIVED per
   * read from `links` — never stored, so it cannot drift. `null` is a real
   * answer (it is what makes un-packaged bricks renderable), never a placeholder.
   */
  containerId?: string | null;
  /** Display name of `containerId`'s container; null when unresolvable. */
  containerName?: string | null;
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

/**
 * Derive the read-model `governance` from a capability row's persisted
 * `approved` state instead of a hardcoded literal (C-DEAD-3). This is a
 * DISCOVERY read-model, NOT enforcement (the real gate is `decideAgentPolicy`
 * rung 2.6 + `gate-capability-execution.ts`), so it is intentionally minimal:
 *   - UNAPPROVED (born `false`) → "propose" — never auto-runnable, needs review;
 *   - APPROVED                  → "auto"    — operator-approved capability.
 * The point is to STOP hardcoding `"propose"`: the value now reflects the row.
 * The grant's per-grant exec-mode still narrows this at the gate (an approved
 * capability granted "propose-each" is proposed per run regardless).
 */
function deriveGovernance(
  approved: boolean | null | undefined
): "auto" | "propose" {
  return approved ? "auto" : "propose";
}

/** Minimal duck-typed shape a Zod field exposes — avoids importing full ZodTypeAny. */
interface ZodFieldLike {
  isOptional?: () => boolean;
  description?: string;
}

/**
 * Derive an honest params schema for a BUILTIN verb from its Zod param schema
 * (`BUILTIN_VERB_PARAM_SCHEMAS` — the actual execution-time validator, the SSOT
 * `execute-capability.ts` parses against). Reads the schema's `.shape` rather than
 * re-deriving from the seeded JSON `parameters` doc, so this can never drift from
 * what the handler actually accepts.
 */
export function deriveBuiltinVerbParamsSchema(
  verbId: string
): Record<string, { required: boolean; description?: string }> | undefined {
  const schema = BUILTIN_VERB_PARAM_SCHEMAS[verbId];
  if (!schema) return undefined;
  const shape = (schema as unknown as { shape: Record<string, ZodFieldLike> })
    .shape;
  const out: Record<string, { required: boolean; description?: string }> = {};
  for (const [key, field] of Object.entries(shape)) {
    out[key] = {
      required:
        typeof field.isOptional === "function" ? !field.isOptional() : true,
      description: field.description,
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
  backingSkillExecutableByName: Map<string, boolean>
): CapabilityVerbStateWithResponseShape[] {
  if (!Array.isArray(catalog) || catalog.length === 0) return [];
  const granted = !!grant;
  return catalog.map((v) => {
    const spec =
      toolKind === "provider" ? providerSpecByName.get(v.id) : undefined;
    const paramsSchema =
      toolKind === "builtin"
        ? deriveBuiltinVerbParamsSchema(v.id)
        : spec
          ? deriveProviderVerbParamsSchema(spec)
          : undefined;
    return {
      ...v,
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
    };
  });
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
      // Conservative default (like commands): IS-native tools route through a
      // proposal until per-tool read/write governance is modeled. Actual
      // execution is gated separately by the capability gate regardless.
      governance: deriveGovernance(undefined),
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
        ctx.workspaceId
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
    .where(visibleSkillsWhere(ctx.userId, ctx.workspaceId ?? undefined));

  // verb id (= skill name) → providerSpec, for declarative skills only. A tool's
  // verb catalog entry id mirrors the requiring skill's name (see deriveToolVerbs
  // in create-from-definition.ts), so this is a direct lookup, no join needed.
  const providerSpecByName = new Map<string, ProviderVerbSpec>();
  const backingSkillExecutableByName = new Map<string, boolean>();
  for (const s of skillRows) {
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
  // "connected" from "needs connection". One batched query, no live Nango probe:
  // a provider tool is connected iff a non-deleted connection-registry pointer
  // row (secrets.accountHint) exists for THIS caller on a capability that has the
  // tool as a member. Freshness is owned by Wave-5's disconnect self-heal + lazy
  // reconciler; authoritative live state is behind the connectors door.
  const providerToolIds = toolRows
    .filter((r) => r.kind === "provider")
    .map((r) => r.id);
  const connectedProviderToolIds = new Set<string>();
  if (providerToolIds.length > 0) {
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
          inArray(links.fromId, providerToolIds),
          eq(secrets.userId, ctx.userId),
          isNotNull(secrets.accountHint),
          isNull(secrets.deletedAt)
        )
      );
    for (const r of rows) connectedProviderToolIds.add(r.toolId);
  }

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

  const toolCaps: RegistryCapability[] = toolRows.map((row) => ({
    kind: toolKindToCapabilityKind(row.kind),
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    inputSchema: asInputSchema(row.inputSchema),
    executor: row.executor as ExecutorRef,
    governance: deriveGovernance(row.approved),
    containerId:
      containerByMember.get(containerMemberKey("tool", row.id))?.id ?? null,
    containerName:
      containerByMember.get(containerMemberKey("tool", row.id))?.name ?? null,
    verbs: buildVerbStates(
      row.capabilities as ToolVerbCatalogEntry[] | null,
      grantByGrantableId.get(row.id),
      row.kind,
      providerSpecByName,
      backingSkillExecutableByName
    ),
    ...(row.kind === "provider"
      ? {
          connection: {
            required: true,
            connected: connectedProviderToolIds.has(row.id),
            provider: row.credentialRef?.replace(/^nango:\/\//, "") ?? row.name,
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
          name: row.name,
          description: row.description ?? null,
          inputSchema: asInputSchema(row.parameters),
          executor: "is-agent",
          governance: "none",
        }
      : {
          kind: "skill",
          id: row.id,
          name: row.name,
          description: row.description ?? null,
          inputSchema: asInputSchema(row.parameters),
          executor: "is-agent",
          governance: deriveGovernance(row.approved),
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
        }
  );

  // ── Commands (intelligence_commands) ────────────────────────────────────────
  const commandRows = await db
    .select()
    .from(intelligenceCommands)
    .where(
      ctx.workspaceId
        ? or(
            isNull(intelligenceCommands.workspaceId),
            eq(intelligenceCommands.workspaceId, ctx.workspaceId)
          )
        : isNull(intelligenceCommands.workspaceId)
    );

  const commandCaps: Capability[] = commandRows.map((row) => ({
    kind: "command",
    id: row.id,
    name: row.title,
    description: null,
    // Commands declare inputs as DerivedInput[] — surfaced as the raw array under
    // a `derivedInputs` key (the contract's inputSchema is an open record).
    inputSchema: { derivedInputs: row.derivedInputs ?? [] },
    executor: "is-agent",
    // intelligence_commands has no `approved` column → always the conservative
    // needs-review default (no row state to derive from yet).
    governance: deriveGovernance(undefined),
  }));

  // IS-native tools, fetched (cached) from the IS manifest endpoint — see
  // fetchISNativeCapabilities above. Graceful: [] when the IS is unreachable.
  const builtinCaps: Capability[] = await fetchISNativeCapabilities();

  const all: RegistryCapability[] = [
    ...builtinCaps,
    ...toolCaps,
    ...skillCaps,
    ...commandCaps,
  ];

  let result = all;
  if (opts?.kind) result = result.filter((c) => c.kind === opts.kind);
  if (opts?.query && opts.query.trim().length > 0) {
    result = result
      .map((cap) => ({
        cap,
        score: scoreTextMatch(opts.query as string, {
          primary: cap.name,
          secondary: (cap.verbs ?? []).map((v) => v.label ?? v.id),
          tertiary: cap.description,
        }),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.cap);
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
export interface SectionedCapabilities {
  /** Integrations (Nango providers + API/MCP tools), one per name, verbs nested. */
  integrations: Array<{
    /**
     * The `tools` row id this entry stands for. Rows are still de-duplicated by
     * NAME (a provider installed twice), so this is the REPRESENTATIVE row —
     * the first one seen — not a claim that only one row exists.
     */
    id: string;
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
    connection?: { required: boolean; connected: boolean; provider: string };
    /** Verb rows incl. the declarative subset's `responseShape` (what it returns). */
    verbs: CapabilityVerbStateWithResponseShape[];
  }>;
  /** Standalone runnable skills — a skill that BACKS a provider verb is shown
   *  under that integration instead, never duplicated here. */
  skills: Array<{
    id: string;
    name: string;
    description: string | null;
    governance: "auto" | "propose" | "none";
    /** Owning capability container, or `null` for an un-packaged skill. */
    containerId: string | null;
    /** Display name of `containerId`'s container; null when it has none. */
    containerName: string | null;
  }>;
  /** Intelligence commands. */
  commands: Array<{ id: string; name: string; description: string | null }>;
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
    /** Verb catalog where the row carries one; `[]` for IS-native manifest tools. */
    verbs: CapabilityVerbStateWithResponseShape[];
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
          governance: c.governance,
          runnableHere: c.catalogOnly !== true,
          verbs: [...(c.verbs ?? [])],
        });
      } else {
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
      const existing = integrations.get(c.name);
      if (!existing) {
        integrations.set(c.name, {
          id: c.id,
          containerId: c.containerId ?? null,
          containerName: c.containerName ?? null,
          name: c.name,
          kind: c.kind,
          description: c.description ?? null,
          governance: c.governance,
          ...(c.connection ? { connection: c.connection } : {}),
          verbs: [...(c.verbs ?? [])],
        });
      } else {
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
      if (!skillByName.has(c.name)) {
        skillByName.set(c.name, {
          id: c.id,
          name: c.name,
          description: c.description ?? null,
          governance: c.governance,
          containerId: c.containerId ?? null,
          containerName: c.containerName ?? null,
        });
      }
      continue;
    }

    if (c.kind === "command") {
      commands.push({
        id: c.id,
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

  const full: SectionedCapabilities = {
    integrations: [...integrations.values()],
    skills,
    commands,
    builtins: [...builtinByName.values()],
    excluded: { teachingDocs },
  };

  if (typeof opts?.limit !== "number") return full;
  return capSectionsByRank(full, caps, opts.limit);
}

/** The dedupe identity `sectionCapabilities` folds each `caps` row onto, or
 *  `null` for a row that never lands in a ranked section (teaching-doc and
 *  any other grantable kind the fold above skips). Kept as ONE function so a
 *  row's rank key can never drift from the fold's own "what counts as the
 *  same row" rule above. */
function sectionDedupeKey(c: RegistryCapability): string | null {
  if (c.kind === "builtin-tool") return `builtin:${c.name}`;
  if (c.kind === "tool" || c.kind === "source-provider")
    return `integration:${c.name}`;
  if (c.kind === "skill") return `skill:${c.name}`;
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
  limit: number
): SectionedCapabilities {
  const firstIndex = new Map<string, number>();
  caps.forEach((c, i) => {
    const key = sectionDedupeKey(c);
    if (key && !firstIndex.has(key)) firstIndex.set(key, i);
  });

  const dedupeKeys = [
    ...full.integrations.map((it) => `integration:${it.name}`),
    ...full.skills.map((s) => `skill:${s.name}`),
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
      kept.has(`integration:${it.name}`)
    ),
    skills: full.skills.filter((s) => kept.has(`skill:${s.name}`)),
    commands: full.commands.filter((c) => kept.has(`command:${c.id}`)),
    builtins: full.builtins.filter((b) => kept.has(`builtin:${b.name}`)),
    excluded: full.excluded,
  };
}

// ── Shared search matcher (D1) ────────────────────────────────────────────────
// Simple v1 ranking — tokenized substring match, no embeddings. Pure + exported
// so both callers of the search feature (the registry above and the capability
// CONTAINERS REST route, which searches bundles rather than verbs) share the
// SAME scoring, never a second reimplementation.

/** The searchable text of one candidate, weighted by field. */
export interface MatchableText {
  /** Highest weight — e.g. the capability/container name. */
  primary: string;
  /** Medium weight — e.g. verb labels or member names. */
  secondary?: string[];
  /** Lowest weight — e.g. a free-text description. */
  tertiary?: string | null;
}

/**
 * Score a candidate against a query: tokens (lowercased, whitespace-split) are
 * matched as substrings against each weighted field; an exact `primary` match
 * scores highest. Returns 0 when no token matches anything (callers should
 * exclude/rank-last on 0).
 */
export function scoreTextMatch(query: string, target: MatchableText): number {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const primary = target.primary.toLowerCase();
  const secondary = (target.secondary ?? []).join(" ").toLowerCase();
  const tertiary = (target.tertiary ?? "").toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (primary === t) score += 10;
    else if (primary.includes(t)) score += 5;
    if (secondary.includes(t)) score += 3;
    if (tertiary.includes(t)) score += 1;
  }
  return score;
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
