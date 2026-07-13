/**
 * composeCapabilityBrief (AI Teaching Substrate Wave 2b) — the ONE composer
 * every door (MCP, `GET /api/hub/briefs`, future IS runtime-context) calls to
 * get a tool's just-in-time teaching brief: teaching core + governance verdict
 * + posture emphases + open-affordance footer. Never re-derive any of these
 * four pieces elsewhere — this is the single assembly point.
 *
 * Composed in order, hard-capped at ~4000 chars (~1000 tokens; smaller is
 * better and typical):
 *   1. Teaching core — seeded `system/*` instruction skills whose
 *      `teachesTools` overlaps this tool's teaching keys (MCP_TOOL_TEACHING_KEYS).
 *      Max 2 matches. Each contributes its `description` (L1) + a
 *      `synap_load_skill(slug)` pointer (L2), plus a verbatim `<!-- brief:start
 *      -->…<!-- brief:end -->` extract when the skill body carries one
 *      (author-controlled essentials — zero duplication with the L2 body).
 *   2. Governance verdict — `dryRunAgentGovernanceDecision` (pure, side-effect
 *      free) for the tool's (subjectType, action) pair, door-aware. Rendered
 *      only when workspaceId + agentUserId are both known (there is no verdict
 *      to preview otherwise) and the tool maps to a real governance door.
 *   3. Posture emphases — `getEffectiveAiPosture(profileSlug, workspaceId)`
 *      per D4; each set flag renders one imperative line.
 *   4. Open-affordance footer — appended for every WRITE tool (governance or
 *      posture entry present) so the AI is told, every time, to surface the
 *      result back to the user.
 *
 * Performance: the skills lookup is cached in-process (60s TTL, keyed by the
 * union of teaching keys queried) so repeated `tools/list` calls don't hit the
 * DB per tool — mirrors `fetchISNativeCapabilities`'s cache shape
 * (`capability-registry.ts`). Governance dry-runs are cached per
 * (workspaceId, agentUserId, subjectType, action, door) for 60s; posture reads
 * reuse `ProfileResolutionService`'s own 60s cache. Composition never throws —
 * any failure resolves to `null` (caller falls back to the static description).
 */

import { and, eq, isNull, like } from "drizzle-orm";
import { db, skills, ProfileResolutionService } from "@synap/database";

import { MCP_TOOL_TEACHING_KEYS } from "../../routers/mcp/tool-verb-aliases.js";

export type CapabilityBriefDoor = "chat" | "automation";

export interface CapabilityBriefContext {
  userId?: string | null;
  agentUserId?: string | null;
  workspaceId?: string | null;
  door: CapabilityBriefDoor;
}

/** One shared footer — appended to every WRITE tool's brief (D-footer). */
const OPEN_AFFORDANCE_FOOTER =
  "After a successful write, surface the result to the user: share the response's `/open/<id>` link, or in Companion chat emit an `[[open:side|entity:<id>]]` chip — never make the user hunt for what you just did.";

/**
 * Per-tool governance door mapping: the REAL (subjectType, action) pair the
 * write ultimately gates on, cross-checked against `checkPermissionOrPropose`
 * call sites (entities.ts, documents.ts, views.ts, cell-instances.ts,
 * focus-sessions.ts, projects.ts, playbooks.ts, workspaces.ts,
 * automations.ts). `postureSlug` is the `DEFAULT_AI_POSTURES` / `profiles`
 * key consulted for per-kind emphases (D4) — several are NOT `profiles` rows
 * (document/view/cell/session/project/playbook/workspace/automation/
 * capability/capture are first-class tables, not entity kinds); that's fine,
 * `getEffectiveAiPosture` falls back to code defaults + workspace overlay.
 * `governance: null` means no direct `checkPermissionOrPropose` door exists
 * for this tool today (e.g. capture writes via the capture pipeline, which is
 * gated upstream, not per-entity) — the verdict line is skipped, teaching +
 * posture still compose.
 */
const TOOL_METADATA: Record<
  string,
  {
    governance: { subjectType: string; action: string } | null;
    postureSlug: string | null;
    isWrite: boolean;
  }
> = {
  synap_create_document: {
    governance: { subjectType: "document", action: "create" },
    postureSlug: "document",
    isWrite: true,
  },
  synap_create_entity: {
    governance: { subjectType: "entity", action: "create" },
    postureSlug: null, // varies by the entity's own profileSlug — no single kind
    isWrite: true,
  },
  synap_capture: {
    governance: null, // capture pipeline gates upstream, not per-entity checkPermissionOrPropose
    postureSlug: "capture",
    isWrite: true,
  },
  synap_start_session: {
    governance: { subjectType: "focus_session", action: "create" },
    postureSlug: "session",
    isWrite: true,
  },
  synap_update_session: {
    governance: { subjectType: "focus_session", action: "update" },
    postureSlug: "session",
    isWrite: true,
  },
  synap_complete_session: {
    governance: { subjectType: "focus_session", action: "update" },
    postureSlug: "session",
    isWrite: true,
  },
  synap_create_project: {
    governance: { subjectType: "project", action: "create" },
    postureSlug: "project",
    isWrite: true,
  },
  synap_create_view: {
    governance: { subjectType: "view", action: "create" },
    postureSlug: "view",
    isWrite: true,
  },
  synap_create_cell: {
    governance: { subjectType: "cell", action: "create" },
    postureSlug: "cell",
    isWrite: true,
  },
  synap_promote_cell_to_renderer: {
    governance: { subjectType: "cell", action: "update" },
    postureSlug: "cell",
    isWrite: true,
  },
  synap_create_playbook: {
    governance: { subjectType: "playbook", action: "create" },
    postureSlug: "playbook",
    isWrite: true,
  },
  synap_promote_session_to_playbook: {
    governance: { subjectType: "playbook", action: "create" },
    postureSlug: "playbook",
    isWrite: true,
  },
  synap_create_workspace: {
    governance: { subjectType: "workspace", action: "create" },
    postureSlug: "workspace",
    isWrite: true,
  },
  synap_list_capabilities: {
    governance: null, // read-only discovery, no checkPermissionOrPropose door
    postureSlug: "capability",
    isWrite: false,
  },
  synap_run_capability: {
    governance: null, // per-verb governance, not a single checkPermissionOrPropose door
    postureSlug: "capability",
    isWrite: true,
  },
  synap_governance: {
    governance: null, // this tool IS the governance query, not a governed write
    postureSlug: null,
    isWrite: false,
  },
  synap_list_profiles: {
    governance: null, // read-only discovery, no checkPermissionOrPropose door
    postureSlug: null,
    isWrite: false,
  },
  synap_attach_facet: {
    governance: { subjectType: "facet", action: "attach" },
    postureSlug: null, // varies by the target role's own profileSlug — no single kind
    isWrite: true,
  },
  synap_detach_facet: {
    governance: { subjectType: "facet", action: "detach" },
    postureSlug: null,
    isWrite: true,
  },
};

// ── Skills lookup cache (teaching core) — 60s TTL, keyed by the queried key set ──

interface CachedSkillRow {
  slug: string;
  description: string | null;
  body: string | null;
  teachesTools: string[];
  alwaysOn: boolean;
}

const SKILLS_CACHE_TTL_MS = 60_000;
let skillsCache: { at: number; rows: CachedSkillRow[] } | null = null;

/** One batched read of every seeded system instruction skill (not per-tool). */
async function getSystemInstructionSkills(): Promise<CachedSkillRow[]> {
  if (skillsCache && Date.now() - skillsCache.at < SKILLS_CACHE_TTL_MS) {
    return skillsCache.rows;
  }
  const rows = await db
    .select({
      slug: skills.slug,
      description: skills.description,
      body: skills.body,
      teachesTools: skills.teachesTools,
      alwaysOn: skills.alwaysOn,
    })
    .from(skills)
    .where(
      and(
        eq(skills.kind, "instruction"),
        isNull(skills.workspaceId),
        like(skills.slug, "system/%")
      )
    );
  const typed = rows.map((r) => ({
    slug: r.slug as string,
    description: r.description,
    body: r.body,
    teachesTools: r.teachesTools ?? [],
    alwaysOn: r.alwaysOn,
  }));
  skillsCache = { at: Date.now(), rows: typed };
  return typed;
}

/** Verbatim extract of a `<!-- brief:start -->…<!-- brief:end -->` block, if present. */
function extractBriefMarker(body: string | null): string | null {
  if (!body) return null;
  const match = body.match(
    /<!--\s*brief:start\s*-->([\s\S]*?)<!--\s*brief:end\s*-->/
  );
  return match ? match[1].trim() : null;
}

async function composeTeachingCore(
  teachingKeys: string[]
): Promise<string | null> {
  const allSkills = await getSystemInstructionSkills();
  const matched = allSkills.filter((s) =>
    s.teachesTools.some((t) => teachingKeys.includes(t))
  );
  if (matched.length === 0) return null;

  // Prefer alwaysOn (core reflex) skills first, then stable slug order; cap at 2.
  matched.sort(
    (a, b) =>
      Number(b.alwaysOn) - Number(a.alwaysOn) || a.slug.localeCompare(b.slug)
  );
  const top = matched.slice(0, 2);

  const lines: string[] = [];
  for (const s of top) {
    lines.push(`- ${s.description ?? s.slug}`);
    lines.push(
      `  Before first use, load the full guide: synap_load_skill("${s.slug}")`
    );
    const brief = extractBriefMarker(s.body);
    if (brief) lines.push(brief);
  }
  return lines.join("\n");
}

// ── Governance verdict cache — 60s TTL per (workspace, agent, subject, action, door) ──

interface CachedVerdict {
  outcome: "auto" | "propose" | "deny";
  reason: string;
}

const GOVERNANCE_CACHE_TTL_MS = 60_000;
const governanceCache = new Map<
  string,
  { at: number; verdict: CachedVerdict }
>();

async function composeGovernanceLine(
  meta: { subjectType: string; action: string },
  ctx: CapabilityBriefContext
): Promise<string | null> {
  if (!ctx.workspaceId || !ctx.agentUserId) return null;

  const cacheKey = `${ctx.workspaceId}:${ctx.agentUserId}:${meta.subjectType}:${meta.action}:${ctx.door}`;
  const cached = governanceCache.get(cacheKey);
  let verdict: CachedVerdict;
  if (cached && Date.now() - cached.at < GOVERNANCE_CACHE_TTL_MS) {
    verdict = cached.verdict;
  } else {
    const { dryRunAgentGovernanceDecision } =
      await import("@synap/database/agent-governance");
    const result = await dryRunAgentGovernanceDecision({
      db,
      agentUserId: ctx.agentUserId,
      workspaceId: ctx.workspaceId,
      subjectType: meta.subjectType,
      action: meta.action,
      door: ctx.door,
    });
    verdict = { outcome: result.outcome, reason: result.reason };
    governanceCache.set(cacheKey, { at: Date.now(), verdict });
    // Bounded growth: expired entries are otherwise only refreshed in place,
    // never evicted — a long-lived multi-workspace pod would leak keys.
    if (governanceCache.size > 512) {
      const now = Date.now();
      for (const [k, v] of governanceCache) {
        if (now - v.at >= GOVERNANCE_CACHE_TTL_MS) governanceCache.delete(k);
      }
      if (governanceCache.size > 512) governanceCache.clear();
    }
  }

  switch (verdict.outcome) {
    case "auto":
      return "In this workspace this write applies directly.";
    case "propose":
      return "This write lands as a PROPOSAL — explain in one sentence why you're doing it, and give the user the reviewUrl link from the response.";
    case "deny":
      return `This write is DENIED by workspace policy (${verdict.reason}) — do not attempt it; tell the user instead.`;
  }
}

// ── Posture emphases ──────────────────────────────────────────────────────

function composePostureLines(posture: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (posture.explainWhy) {
    lines.push("State why you're creating this before you do.");
  }
  if (posture.openAfterCreate) {
    lines.push("Open the result for the user after creating it.");
  }
  if (posture.attachOutputs) {
    lines.push("Attach the session's outputs so the user can inspect results.");
  }
  const directives = posture.directives;
  if (Array.isArray(directives)) {
    for (const d of directives) {
      if (typeof d === "string") lines.push(d);
    }
  }
  return lines;
}

/**
 * Compose the full teaching brief for a tool, or `null` if the tool has no
 * teaching content and no governance/posture to report (a static description
 * alone is enough). Never throws.
 */
export async function composeCapabilityBrief(
  toolName: string,
  ctx: CapabilityBriefContext
): Promise<string | null> {
  try {
    const meta = TOOL_METADATA[toolName];
    const teachingKeys = MCP_TOOL_TEACHING_KEYS[toolName] ?? [toolName];

    const sections: string[] = [];

    const teaching = await composeTeachingCore(teachingKeys);
    if (teaching) sections.push(teaching);

    if (meta?.governance) {
      const govLine = await composeGovernanceLine(meta.governance, ctx);
      if (govLine) sections.push(govLine);
    }

    if (meta?.postureSlug) {
      const resolver = new ProfileResolutionService(db);
      const posture = await resolver.getEffectiveAiPosture(
        meta.postureSlug,
        ctx.workspaceId ?? null
      );
      const postureLines = composePostureLines(
        posture as unknown as Record<string, unknown>
      );
      if (postureLines.length > 0) sections.push(postureLines.join(" "));
    }

    if (meta?.isWrite && sections.length > 0) {
      sections.push(OPEN_AFFORDANCE_FOOTER);
    }

    if (sections.length === 0) return null;

    const composed = sections.join("\n\n");
    // Hard cap ~4000 chars (~1000 tokens) — truncate defensively; composition
    // should stay well under this in practice.
    return composed.length > 4000 ? `${composed.slice(0, 3980)}\n…` : composed;
  } catch {
    // Failure-safe: never break tools/list or the briefs door over a brief.
    return null;
  }
}

/** The main-capability tool names briefs v1 covers (plan §Waves, Wave 2). */
export const MAIN_CAPABILITY_TOOLS = Object.keys(TOOL_METADATA);

/** Test-only seam: clear the module-level TTL caches between test cases. */
export function __resetCapabilityBriefCachesForTest(): void {
  skillsCache = null;
  governanceCache.clear();
}
