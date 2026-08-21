/**
 * CAPABILITY-COMPOSITION builder — "what did this installed capability
 * materialize, and is it healthy?".
 *
 * Reuses existing primitives, invents no new store:
 *   · members  — `getLinksFor(capability)`, the `member_of` graph (complete with
 *                playbook/automation after the T5 wiring);
 *   · wired    — per-member: a DECLARATIVE verb needs its `requires --> tool` edge
 *                (an orphaned verb has none — the exact T4 bug); a builtin `code`/
 *                `instruction` skill is self-standing (no parent tool, never a gap);
 *                a playbook/automation must not be archived; a dangling link
 *                resolves to no row;
 *   · health   — `listRuns` per materialized playbook/automation flow, rolled up
 *                to failed / stuck / lastRunAt;
 *   · gaps     — the human-readable list of what is unwired.
 *
 * Returns the FROZEN `CapabilityComposition` shape (types.ts) verbatim.
 */

import {
  db,
  and,
  eq,
  or,
  isNull,
  desc,
  inArray,
  capabilities,
  tools,
  skills,
  playbooks,
  automations,
  links,
  channels,
  workspaces,
} from "@synap/database";
import {
  getLinksFor,
  getCapabilityMemberParts,
} from "../links/links-service.js";
import { listRuns } from "../runs/index.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { deriveCapabilityMode } from "../signal/capability-mode.js";
import { createLogger } from "@synap-core/core";
import {
  DEFAULT_STUCK_THRESHOLD_HOURS,
  type CapabilityComposition,
} from "./types.js";

const logger = createLogger({ module: "capability-composition" });

type MemberKind = "tool" | "skill" | "playbook" | "automation";
const MEMBER_KINDS: readonly MemberKind[] = [
  "tool",
  "skill",
  "playbook",
  "automation",
];

/** The already-loaded capability row (diagnose selects it before calling here). */
export interface CapabilityCompositionInput {
  userId: string;
  capability: {
    id: string;
    name: string;
    approved: boolean;
    description?: string | null;
    metadata: Record<string, unknown> | null;
    /** `capabilities.workspaceId` — optional so existing callers that don't
     *  load it keep compiling; pass it whenever available so the output can
     *  carry it (labeling) and the channel-count fallback can scope by it. */
    workspaceId?: string | null;
  };
}

export async function buildCapabilityComposition(
  input: CapabilityCompositionInput
): Promise<CapabilityComposition> {
  const { userId } = input;
  const cap = input.capability;

  // ── Members: the `member_of` graph pointing AT this capability. ────────────
  const allLinks = await getLinksFor(userId, "capability", cap.id);
  const memberLinks = allLinks.filter(
    (l) =>
      l.toType === "capability" &&
      l.toId === cap.id &&
      l.linkType === "member_of" &&
      (MEMBER_KINDS as readonly string[]).includes(l.fromType)
  );

  const idsByKind: Record<MemberKind, string[]> = {
    tool: [],
    skill: [],
    playbook: [],
    automation: [],
  };
  for (const l of memberLinks) {
    idsByKind[l.fromType as MemberKind].push(l.fromId);
  }

  // Resolve names (+ the per-kind wiring signal) in one batched read per kind.
  // Tool rows also carry `config` + `kind` — reused below for
  // `deriveCapabilityMode` (bridge-transport detection) and `isBridge`
  // (connected-provider detection) instead of a second round-trip.
  const toolRows = await loadToolRows(idsByKind.tool);
  const toolNames = new Map(
    [...toolRows.entries()].map(([id, row]) => [id, row.name])
  );
  const skillRows = await loadSkillRows(idsByKind.skill);
  const playbookRows = await loadStatusRows(playbooks, idsByKind.playbook);
  const automationRows = await loadStatusRows(
    automations,
    idsByKind.automation
  );

  // A skill is WIRED iff it carries a `skill --requires--> tool` edge (the T4
  // orphaned-verb signal). Batched: one read over every skill member.
  const wiredSkillIds = new Set<string>();
  if (idsByKind.skill.length > 0) {
    const requiresRows = await db
      .select({ fromId: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "skill"),
          inArray(links.fromId, idsByKind.skill),
          eq(links.linkType, "requires"),
          eq(links.toType, "tool")
        )
      );
    for (const r of requiresRows) wiredSkillIds.add(r.fromId);
  }

  const members: CapabilityComposition["members"] = [];
  const gaps: string[] = [];

  for (const id of idsByKind.tool) {
    const name = toolNames.get(id) ?? id.slice(0, 8);
    if (!toolNames.has(id)) gaps.push(`Tool member ${id} not found`);
    // A tool is the parent brick — it is self-standing (its own connection/
    // credential gate is separate), so a resolved tool member is always wired.
    members.push({ kind: "tool", id, name, wired: toolNames.has(id) });
  }
  for (const id of idsByKind.skill) {
    const row = skillRows.get(id);
    const name = row?.name ?? id.slice(0, 8);
    // Only a DECLARATIVE verb requires a `requires-->tool` edge; a builtin
    // `code`/`instruction` skill is self-standing, so a missing parent tool is
    // NOT a gap (else every core verb reads as "broken").
    const needsTool = row?.kind === "declarative";
    const wired = !!row && (!needsTool || wiredSkillIds.has(id));
    members.push({ kind: "skill", id, name, wired });
    if (!row) gaps.push(`Verb member ${id} not found`);
    else if (needsTool && !wiredSkillIds.has(id))
      gaps.push(`Verb "${name}" has no parent tool (unwired)`);
  }
  for (const id of idsByKind.playbook) {
    const row = playbookRows.get(id);
    const name = row?.name ?? id.slice(0, 8);
    const wired = !!row && row.status !== "archived";
    members.push({ kind: "playbook", id, name, wired });
    if (!row) gaps.push(`Playbook member ${id} not found`);
    else if (!wired) gaps.push(`Playbook "${name}" is archived (unwired)`);
  }
  for (const id of idsByKind.automation) {
    const row = automationRows.get(id);
    const name = row?.name ?? id.slice(0, 8);
    const wired = !!row && row.status !== "archived";
    members.push({ kind: "automation", id, name, wired });
    if (!row) gaps.push(`Automation member ${id} not found`);
    else if (!wired) gaps.push(`Automation "${name}" is archived (unwired)`);
  }

  // ── Health: roll up runs over the materialized playbook/automation flows. ──
  const health = await rollUpHealth(userId, {
    playbookIds: idsByKind.playbook,
    automationIds: idsByKind.automation,
  });

  // ── Provenance: the template lineage stamped on the container (W1). ────────
  const meta = cap.metadata ?? {};
  const templateKey =
    typeof meta.templateKey === "string" ? meta.templateKey : undefined;
  const contentHash =
    typeof meta.contentHash === "string" ? meta.contentHash : undefined;
  const provenance =
    templateKey || contentHash
      ? {
          ...(templateKey ? { templateKey } : {}),
          ...(contentHash ? { contentHash } : {}),
        }
      : null;

  // ── Bridge channels: how many channels this capability materialized —
  // MIRRORS `resolveCapabilityChannelIds`'s union (`signal/index.ts`) so a
  // legacy slug-matched bridge (channels born pre-0234, before the `produced`
  // edge existed) counts the same UNFLOORED scope that resolver counts before
  // its visibility floor. Queried directly here (not via
  // `resolveCapabilityChannelIds` itself) to avoid re-introducing the exact
  // mutual import the capability-mode.ts split-out already documents —
  // `signal/index.ts` imports `buildCapabilityComposition` from this file, so
  // this file importing back from `signal/index.ts` would be circular. The
  // produced-edge half reuses `getCapabilityMemberParts` — the SAME
  // tool/skill/command part-scope `resolveCapabilityChannelIds` resolves via —
  // NOT this builder's own `idsByKind` (which spans tool/skill/playbook/
  // automation, a different set built for the members/gaps section above). ──
  const capabilityParts = await getCapabilityMemberParts([cap.id]);
  const memberToolNames = [...toolRows.values()]
    .map((t) => t.name)
    .filter((n): n is string => !!n);
  const producedChannelCount = await countBridgeChannels(
    capabilityParts.map((p) => p.id),
    memberToolNames,
    cap.workspaceId ?? null
  );

  // ── Mode: standing vs callable vs unknown — reuses the already-loaded
  // metadata + tool configs + produced-channel count above, no extra DB
  // round-trip beyond the one above. ──────────────────────────────────────
  const { mode, source: modeSource } = deriveCapabilityMode({
    metadata: cap.metadata,
    memberToolConfigs: [...toolRows.values()].map((t) => t.config),
    producedChannelCount,
  });

  // ── isBridge: product classification for the Bridges LIST — "does this
  // capability maintain a real connection to an external system?" DISTINCT
  // from `mode` (health semantics): a connected provider with zero produced
  // channels (e.g. Google Workspace) is `isBridge:true` but may still read
  // `mode:'unknown'` (no liveness signal) — that split is intentional, see
  // the doc on `CapabilityComposition.isBridge`. ANY of: declared standing,
  // a `transport:'bridge'` member tool, a produced channel, or a member tool
  // that is a connected provider (`kind==='provider'`, e.g. a Nango OAuth
  // account) — never a merely-callable `'api'`/`'builtin'`/`'mcp'`/`'script'`
  // tool (fal.ai/Exa/Apify are `'api'`, invocable, not bridges).
  const isBridge =
    mode === "standing" || // declared, derived_transport, or derived_produced
    [...toolRows.values()].some((t) => t.kind === "provider");

  // ── Direction: the honest ingest/callable PAIR. `mode` alone lies here — it
  // is a single enum that never concludes `callable` (see deriveCapabilityMode),
  // so a UI toggle needs BOTH halves derived from real signals:
  //   ingest   — standing mode, a declared `metadata.emits`, or a produced
  //              channel (data comes IN).
  //   callable — ≥1 resolved catalog verb; a catalog card's `verbs[]` are its
  //              member SKILLS (buildCapabilityCatalog → mySkills), so the honest
  //              count here is the resolved member-skill rows.
  // Neither → "unknown" (honest fallback, never a guessed default).
  const emits = meta.emits;
  const ingest =
    mode === "standing" ||
    (Array.isArray(emits) && emits.length > 0) ||
    producedChannelCount > 0;
  const callable = skillRows.size > 0;
  const directionKind: CapabilityComposition["direction"]["kind"] = ingest
    ? callable
      ? "both"
      : "ingest"
    : callable
      ? "callable"
      : "unknown";
  const direction = { ingest, callable, kind: directionKind };

  const extractionPolicy = normalizeExtractionPolicy(
    [...toolRows.values()].map((t) => t.metadata)
  );

  return {
    id: cap.id,
    name: cap.name,
    description: cap.description ?? null,
    approved: cap.approved,
    workspaceId: cap.workspaceId ?? null,
    provenance,
    members,
    health,
    gaps,
    mode,
    modeSource,
    isBridge,
    direction,
    extractionPolicy,
  };
}

/**
 * LIST mode — the whole-pod composition map (`capabilities.compositions` tRPC
 * door). Loads every capability CONTAINER visible to the caller (same lens as
 * `capabilities.containers.list`: user-visible floor + optional workspace
 * narrow, pod-wide NULL rows always included), then composes each. One element
 * per container; `.id` IS the container id (joins 1:1 to the atlas node). A
 * per-container composition failure degrades to omission, never a 500.
 */
export async function listCapabilityCompositions(args: {
  userId: string;
  workspaceId?: string | null;
}): Promise<CapabilityComposition[]> {
  const { userId, workspaceId } = args;
  const lens = workspaceId
    ? or(
        isNull(capabilities.workspaceId),
        eq(capabilities.workspaceId, workspaceId)
      )
    : undefined;
  const rows = await db
    .select({
      id: capabilities.id,
      name: capabilities.name,
      description: capabilities.description,
      approved: capabilities.approved,
      metadata: capabilities.metadata,
      workspaceId: capabilities.workspaceId,
    })
    .from(capabilities)
    .where(and(lens, userVisibleWhere(capabilities.workspaceId, userId)))
    .orderBy(desc(capabilities.createdAt));

  // Batched name lookup for every distinct workspace the page's containers
  // belong to — ONE extra query for the whole list, not per-row. Feeds
  // `workspaceName` below so the UI can label two same-named installs
  // ("Discord Bot" in Marketing vs Discord Bot in Ops) without an N+1.
  const distinctWorkspaceIds = [
    ...new Set(
      rows.map((r) => r.workspaceId).filter((id): id is string => !!id)
    ),
  ];
  const workspaceNames = new Map<string, string>();
  if (distinctWorkspaceIds.length > 0) {
    const wsRows = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(inArray(workspaces.id, distinctWorkspaceIds));
    for (const w of wsRows) workspaceNames.set(w.id, w.name);
  }

  // Fan the per-container builds out in parallel. Each buildCapabilityComposition
  // does ~6 independent reads plus a per-flow listRuns; this list backs a Studio
  // surface polled ~every 15s, so a sequential for…await serialized ~120 DB
  // round-trips per call. Promise.all preserves input order (createdAt DESC).
  //
  // Per-container isolation is preserved AND now real: buildCapabilityComposition
  // can throw (a dangling link, a read error), and a bare Promise.all would reject
  // the whole batch on one bad row. Catching per-row degrades that container to
  // omission — the contract this function's doc already promises — instead of a 500.
  // TODO(perf): rollUpHealth still issues N listRuns per container; listRunGroups
  // groups by flowId in-DB and would collapse that to one grouped read per call.
  const built = await Promise.all(
    rows.map(async (row) => {
      try {
        const composition = await buildCapabilityComposition({
          userId,
          capability: {
            id: row.id,
            name: row.name,
            description: row.description,
            approved: row.approved,
            metadata: row.metadata as Record<string, unknown> | null,
            workspaceId: row.workspaceId,
          },
        });
        const enriched: CapabilityComposition = {
          ...composition,
          workspaceName: row.workspaceId
            ? (workspaceNames.get(row.workspaceId) ?? null)
            : null,
        };
        return enriched;
      } catch (err) {
        logger.warn(
          { capabilityId: row.id, err },
          "listCapabilityCompositions: skipped a container that failed to compose"
        );
        return null;
      }
    })
  );
  return built.filter((c): c is CapabilityComposition => c !== null);
}

/** id → { name, config, kind, metadata }, batched — tool member rows (name +
 *  transport config + `ToolKind`, e.g. `'provider'` for a connected Nango
 *  OAuth account vs `'api'` for a merely-callable API-key tool like
 *  fal.ai/Exa/Apify + provider-specific `metadata` — e.g. the Discord bot's
 *  extraction settings live at `metadata.discord.*`, NOT `config`). */
async function loadToolRows(
  ids: string[]
): Promise<
  Map<
    string,
    { name: string; config: unknown; kind: string; metadata: unknown }
  >
> {
  const out = new Map<
    string,
    { name: string; config: unknown; kind: string; metadata: unknown }
  >();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: tools.id,
      name: tools.name,
      config: tools.config,
      kind: tools.kind,
      metadata: tools.metadata,
    })
    .from(tools)
    .where(inArray(tools.id, ids));
  for (const r of rows)
    out.set(r.id, {
      name: r.name,
      config: r.config,
      kind: r.kind,
      metadata: r.metadata,
    });
  return out;
}

/**
 * Best-effort, normalized read of member tools' provider-specific extraction
 * config. Today only the Discord bot template populates this, nested at
 * `tools.metadata.discord.*` (confirmed against the actual reader sites —
 * `event-sync`/`mail-feed` services — NOT `tools.config`, which carries an
 * unrelated transport marker for other providers). Read defensively: config
 * shapes vary across providers, so only keys that are PRESENT and the right
 * type are included. Scans every member tool and merges the first hit per
 * key (today there is at most one Discord-shaped tool per capability, so
 * this never actually needs to arbitrate a conflict). Returns `null` when
 * NONE of the recognized keys are present anywhere — never a fabricated
 * default.
 */
function normalizeExtractionPolicy(
  toolMetadatas: unknown[]
): CapabilityComposition["extractionPolicy"] {
  const out: NonNullable<CapabilityComposition["extractionPolicy"]> = {};

  for (const meta of toolMetadatas) {
    const discord = (meta as Record<string, unknown> | null | undefined)
      ?.discord as Record<string, unknown> | undefined;
    if (!discord || typeof discord !== "object") continue;

    if (
      out.reactCapture === undefined &&
      typeof discord.reactCapture === "boolean"
    ) {
      out.reactCapture = discord.reactCapture;
    }
    if (out.captureFlows === undefined && Array.isArray(discord.captureFlows)) {
      out.captureFlows = discord.captureFlows.length;
    }
    if (
      out.eventSync === undefined &&
      discord.eventSync &&
      typeof discord.eventSync === "object" &&
      typeof (discord.eventSync as Record<string, unknown>).enabled ===
        "boolean"
    ) {
      out.eventSync = (discord.eventSync as Record<string, unknown>)
        .enabled as boolean;
    }
    if (
      out.captureChannel === undefined &&
      typeof discord.captureChannel === "string" &&
      discord.captureChannel.length > 0
    ) {
      out.captureChannel = discord.captureChannel;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * How many DISTINCT channels this capability materialized — the SAME union
 * `resolveCapabilityChannelIds` (`signal/index.ts`) resolves, minus its
 * visibility floor:
 *
 *   member --produced--> channel                              (precise half)
 *   ∪  channels WHERE externalSource IN (member tools' provider slugs)  (legacy half)
 *
 * `memberIds` here is the capability's `tool|skill|command` part scope
 * (`getCapabilityMemberParts` — the exact set `resolveCapabilityChannelIds`
 * resolves its parts over), not this file's own `idsByKind` (which spans a
 * different kind set for the members/gaps section). `tools.name` == provider
 * slug (same convention `resolveCapabilityChannelIds` relies on), so the
 * fallback catches legacy channels born with a bare `source` slug origin
 * (pre-0234) that never got a `produced` edge — the exact gap that made a
 * real bridge (e.g. a Discord ingest with 9 slug-matched channels but 0
 * produced edges) read as `isBridge:false`.
 *
 * UNFLOORED on purpose: this count feeds `isBridge` / `mode` classification
 * only (a boolean/count signal), never a channel listing — the visible "N
 * channels" the Bridges card shows to a user comes from the FLOORED
 * `signal.capabilityHealth` door (`getCapabilityHealth` → `listChannels` →
 * `resolveCapabilityChannelIds` with `channelVisibilityWhere` applied), a
 * different, smaller number by design. Queried locally instead of via
 * `resolveCapabilityChannelIds` itself to avoid the exact circular import
 * `capability-mode.ts`'s split-out already documents — see the call site.
 *
 * LEAK GUARD (`capabilityWorkspaceId`): the legacy slug half is keyed by TOOL
 * NAME, not tool id — two containers whose member tool shares a name (e.g.
 * two "Discord Bot" installs in different workspaces, each with its own
 * `tools` row named "discord") would otherwise both slug-match the SAME
 * `channels.externalSource = 'discord'` rows and both report the same count.
 * The `produced` half can't leak this way (it's keyed by this capability's
 * own tool/skill/command ids), so it stays authoritative and unscoped; the
 * slug half is scoped to channels that are either workspace-less (pod-wide,
 * e.g. genuinely ambiguous pre-0234 legacy rows the birth-time resolver in
 * `channel-origin.ts` deliberately left un-upgraded — see migration 0234's
 * comment) or already IN this capability's own workspace. This can't be
 * simply deleted: `recordChannelOrigin`/`resolveSourceProducerTool` leaves a
 * channel on the honest `source` slug (no `tool --produced--> channel` edge
 * at all) whenever tool-name resolution is ambiguous, so some channels rely
 * on this fallback permanently, not just pre-0234. A capability with
 * `workspaceId == null` (itself pod-wide) keeps the old unscoped match —
 * there is no workspace to scope against, and a pod-wide install's slug
 * match legitimately spans every workspace's channels of that provider.
 */
async function countBridgeChannels(
  memberIds: string[],
  memberToolNames: string[],
  capabilityWorkspaceId: string | null
): Promise<number> {
  if (memberIds.length === 0 && memberToolNames.length === 0) return 0;

  const producedRows = memberIds.length
    ? await db
        .select({ channelId: links.toId })
        .from(links)
        .where(
          and(
            eq(links.linkType, "produced"),
            eq(links.toType, "channel"),
            inArray(links.fromId, memberIds)
          )
        )
    : [];
  const producedChannelIds = producedRows.map((r) => r.channelId);

  const slugChannelIds = memberToolNames.length
    ? (
        await db
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              inArray(channels.externalSource, memberToolNames),
              capabilityWorkspaceId
                ? or(
                    isNull(channels.workspaceId),
                    eq(channels.workspaceId, capabilityWorkspaceId)
                  )
                : undefined
            )
          )
      ).map((r) => r.id)
    : [];

  return new Set([...producedChannelIds, ...slugChannelIds]).size;
}

/** id → { name, kind }, batched — skills carry the declarative/code/instruction axis. */
async function loadSkillRows(
  ids: string[]
): Promise<Map<string, { name: string; kind: string }>> {
  const out = new Map<string, { name: string; kind: string }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: skills.id, name: skills.name, kind: skills.kind })
    .from(skills)
    .where(inArray(skills.id, ids));
  for (const r of rows) out.set(r.id, { name: r.name, kind: r.kind });
  return out;
}

/** id → { name, status }, batched (playbooks / automations both have both). */
async function loadStatusRows(
  table: typeof playbooks | typeof automations,
  ids: string[]
): Promise<Map<string, { name: string; status: string }>> {
  const out = new Map<string, { name: string; status: string }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: table.id, name: table.name, status: table.status })
    .from(table)
    .where(inArray(table.id, ids));
  for (const r of rows) out.set(r.id, { name: r.name, status: r.status });
  return out;
}

/**
 * Aggregate run health across a capability's materialized flows. Reuses the ONE
 * runs substrate (`listRuns`) per flow so the numbers match the runs feed. Status
 * ladder: any failed → failed; else any stuck → degraded; else runs exist → ok;
 * no flows or no runs → unknown.
 */
async function rollUpHealth(
  userId: string,
  flows: { playbookIds: string[]; automationIds: string[] }
): Promise<CapabilityComposition["health"]> {
  const specs: Array<{ flowType: "playbook" | "automation"; flowId: string }> =
    [
      ...flows.playbookIds.map((flowId) => ({
        flowType: "playbook" as const,
        flowId,
      })),
      ...flows.automationIds.map((flowId) => ({
        flowType: "automation" as const,
        flowId,
      })),
    ];

  if (specs.length === 0) {
    return { status: "unknown", failedRuns: 0, stuckRuns: 0 };
  }

  const stuckBefore =
    Date.now() - DEFAULT_STUCK_THRESHOLD_HOURS * 60 * 60 * 1000;
  let failedRuns = 0;
  let stuckRuns = 0;
  let lastRunAt: Date | null = null;
  let sawAnyRun = false;

  for (const spec of specs) {
    const runs = await listRuns({
      userId,
      flowType: spec.flowType,
      flowId: spec.flowId,
      limit: 100,
    });
    for (const r of runs) {
      sawAnyRun = true;
      if (r.status === "failed") failedRuns += 1;
      if (r.status === "running" && r.startedAt.getTime() < stuckBefore) {
        stuckRuns += 1;
      }
      if (!lastRunAt || r.startedAt.getTime() > lastRunAt.getTime()) {
        lastRunAt = r.startedAt;
      }
    }
  }

  const status: CapabilityComposition["health"]["status"] = !sawAnyRun
    ? "unknown"
    : failedRuns > 0
      ? "failed"
      : stuckRuns > 0
        ? "degraded"
        : "ok";

  return {
    status,
    failedRuns,
    stuckRuns,
    ...(lastRunAt ? { lastRunAt: lastRunAt.toISOString() } : {}),
  };
}
