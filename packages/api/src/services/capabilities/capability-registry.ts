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
import { visibleSkillsWhere } from "../skills/visibility.js";

export interface CapabilityRegistryContext {
  workspaceId: string;
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
  const text = JSON.stringify([spec.pathTemplate, spec.query, spec.body]);
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
function buildVerbStates(
  catalog: ToolVerbCatalogEntry[] | null | undefined,
  grant: { execMode: ExecMode } | undefined,
  toolKind: string,
  providerSpecByName: Map<string, ProviderVerbSpec>,
  backingSkillExecutableByName: Map<string, boolean>
): CapabilityVerbState[] {
  if (!Array.isArray(catalog) || catalog.length === 0) return [];
  const granted = !!grant;
  return catalog.map((v) => {
    const paramsSchema =
      toolKind === "builtin"
        ? deriveBuiltinVerbParamsSchema(v.id)
        : toolKind === "provider"
          ? (() => {
              const spec = providerSpecByName.get(v.id);
              return spec ? deriveProviderVerbParamsSchema(spec) : undefined;
            })()
          : undefined;
    return {
      ...v,
      granted,
      effectiveExecMode: grant ? grant.execMode : v.govDefault,
      ...(paramsSchema ? { paramsSchema } : {}),
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
  /** Cap the result count. Defaults to 20 when `query` is set; unset otherwise. */
  limit?: number;
}

/** Default result cap when a query narrows the list (keeps agent responses compact). */
const DEFAULT_QUERY_LIMIT = 20;

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
): Promise<Capability[]> {
  const db = await getDb();

  // ── Tools ──────────────────────────────────────────────────────────────────
  const toolRows = await db
    .select()
    .from(tools)
    .where(
      or(isNull(tools.workspaceId), eq(tools.workspaceId, ctx.workspaceId))
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
    .where(visibleSkillsWhere(ctx.userId, ctx.workspaceId));

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

  const toolCaps: Capability[] = toolRows.map((row) => ({
    kind: toolKindToCapabilityKind(row.kind),
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    inputSchema: asInputSchema(row.inputSchema),
    executor: row.executor as ExecutorRef,
    governance: deriveGovernance(row.approved),
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
  const skillCaps: Capability[] = skillRows.map((row) =>
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
      or(
        isNull(intelligenceCommands.workspaceId),
        eq(intelligenceCommands.workspaceId, ctx.workspaceId)
      )
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

  const all: Capability[] = [
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
      .map((s) => s.cap)
      .slice(0, opts.limit ?? DEFAULT_QUERY_LIMIT);
  } else if (typeof opts?.limit === "number") {
    result = result.slice(0, opts.limit);
  }
  return result;
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
