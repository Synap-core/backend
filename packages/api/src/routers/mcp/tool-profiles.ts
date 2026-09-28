/**
 * MCP tool profiles — WHICH tools a key's MCP client lists (V1 D4, gap G10).
 *
 * Research the V1 plan leans on: tool-selection accuracy degrades past ~30-40
 * always-loaded tools, and Codex / Cursor do not defer MCP tools the way
 * Claude Code does. So a NEW agent key lists the 9-tool `entry` surface; the
 * rest arrive in named GROUPS, unlocked by `synap_load_skill` (`tools:<group>`,
 * `tools:builder` for all of them, or a skill whose teaching needs a group).
 *
 * Group refs carry the `tools:` prefix because group names and skill stems
 * share one `ref` namespace — `governance` and `capabilities` are BOTH a group
 * and a seeded skill. A bare ref is always a skill; `tools:` is always a group
 * (pinned by `tool-profiles.test.ts`, derived from the skills on disk).
 *
 * A profile narrows LISTING only. It is NOT a permission: `tools/call` of an
 * unlisted tool still runs under the key's scopes and governance, exactly as
 * before. That is deliberate — the claude.ai CP connector re-advertises its own
 * static catalog and proxies calls here, so gating calls on the profile would
 * break a connector whose list the pod does not control.
 *
 * `api_keys.tool_profile`: NULL = legacy (every tool — every key minted before
 * 0280, unchanged), `entry`, or `builder` (every tool, chosen).
 *
 * Pure: no DB, no SDK. The coverage test (`tool-profiles.test.ts`) derives the
 * advertised tool set from `tools.list()` and asserts every tool is either
 * entry or in exactly one group — a new tool cannot silently vanish from an
 * entry key's reach.
 */

import type { ApiKeyToolProfile } from "@synap/database/schema";

/** The entry surface — what an agent needs for the V1 loop, nothing more. */
export const ENTRY_TOOLS = [
  "synap_orient",
  "synap_ask",
  "synap_capture",
  "synap_start_session",
  "synap_update_session",
  "synap_wait_for_answer",
  "synap_post_message",
  "synap_complete_session",
  "synap_load_skill",
] as const;

/**
 * Deeper tools, grouped by the job they serve. Every advertised tool that is
 * not in {@link ENTRY_TOOLS} belongs to exactly one group (pinned by test).
 */
export const TOOL_GROUPS = {
  /** Look things up beyond `ask`. */
  read: [
    "synap_get_entities",
    "synap_get_entity",
    "synap_get_document",
    "synap_get_thread_context",
    "synap_get_relations",
    "synap_get_graph",
    "synap_resolve_identity",
    "synap_list_profiles",
    "synap_find",
    "synap_get_channel",
    "synap_diagnose",
    "synap_template_health",
  ],
  /** Precise writes beyond `capture`. */
  data: [
    "synap_create_entity",
    "synap_update_entity",
    "synap_create_document",
    "synap_update_document",
    "synap_store_file",
    "synap_remember_fact",
    "synap_link_entities",
    "synap_attach_facet",
    "synap_detach_facet",
    "synap_move_entities",
  ],
  /** The rest of the session lifecycle. */
  sessions: [
    "synap_get_session",
    "synap_list_sessions",
    "synap_evaluate_session",
    "synap_revert_session",
    "synap_rerun_session",
    "synap_promote_session_to_playbook",
  ],
  /** Proposals and trust rules. */
  governance: [
    "synap_list_proposals",
    "synap_get_proposal",
    "synap_governance",
    "synap_revise_proposal",
    "synap_reject_proposal",
    "synap_create_rule",
  ],
  /** Kinds, roles and who may see them. */
  schema: [
    "synap_define_kind",
    "synap_define_role",
    "synap_grant_profile_access",
  ],
  /** Spaces, projects and focus. */
  spaces: [
    "synap_set_workspace_focus",
    "synap_set_project_focus",
    "synap_list_workspaces",
    "synap_create_workspace",
    "synap_update_workspace",
    "synap_archive_workspace",
    "synap_declare_workspace_source",
    "synap_list_projects",
    "synap_get_project",
    "synap_create_project",
    "synap_update_project",
    "synap_project_use_workspace",
    "synap_export_project_pack",
  ],
  /** Tracks: multi-stage work over time. */
  tracks: [
    "synap_list_tracks",
    "synap_start_track",
    "synap_start_stage_session",
    "synap_advance_track",
    "synap_set_track_status",
    "synap_set_track_params",
  ],
  /** Views, cells, playbooks and skills. */
  build: [
    "synap_create_view",
    "synap_list_views",
    "synap_list_widgets",
    "synap_create_cell",
    "synap_promote_cell_to_renderer",
    "synap_list_playbooks",
    "synap_match_playbooks",
    "synap_create_playbook",
    "synap_run_playbook",
    "synap_create_skill",
  ],
  /** Connected services, verbs and automations. */
  capabilities: [
    "synap_list_capabilities",
    "synap_run_capability",
    "synap_create_verb",
    "synap_list_automations",
    "synap_trigger_automation",
    "synap_create_automation",
  ],
} as const satisfies Record<string, readonly string[]>;

export type ToolGroup = keyof typeof TOOL_GROUPS;
export const TOOL_GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroup[];

/** The namespace of a tool-group ref: `load_skill('tools:<group>')`. */
export const TOOL_GROUP_REF_PREFIX = "tools:";

/** `load_skill('tools:builder')` unlocks every group. */
export const BUILDER_REF = `${TOOL_GROUP_REF_PREFIX}builder`;

/** The `load_skill` ref that unlocks one group. */
export function toolGroupRef(group: ToolGroup | "builder"): string {
  return `${TOOL_GROUP_REF_PREFIX}${group}`;
}

/**
 * Seeded skills whose teaching USES a group's tools. Loading one unlocks the
 * groups it teaches, so an entry agent that reads "how to define a kind" can
 * then define one. Keyed by the skill's STEM (last path segment, no `.md`).
 */
const SKILL_STEM_GROUPS: Readonly<Record<string, readonly ToolGroup[]>> = {
  "focus-sessions": ["sessions"],
  "work-flow": ["sessions"],
  writes: ["data"],
  capture: ["data"],
  "multi-entity-capture": ["data"],
  linking: ["data", "read"],
  "linking-principle": ["data", "read"],
  "graph-gardening": ["data", "read"],
  reading: ["read"],
  diagnostics: ["read"],
  governance: ["governance"],
  "governance-rules": ["governance"],
  "from-intent": ["schema", "spaces"],
  "workspace-design": ["schema", "spaces"],
  "workspace-edges": ["spaces"],
  lenses: ["spaces"],
  scope: ["spaces"],
  automations: ["capabilities"],
  capabilities: ["capabilities"],
  "escalation-ladder": ["capabilities", "schema"],
  "viewframe-cells": ["build"],
  showing: ["build"],
  "document-embeds": ["build", "data"],
};

function stemOf(ref: string): string {
  const trimmed = ref.trim().replace(/\.md$/i, "").toLowerCase();
  const parts = trimmed.split("/");
  return parts[parts.length - 1] ?? trimmed;
}

/** Is `ref` in the tool-group namespace (`tools:…`), valid or not? */
export function isToolGroupRef(ref: string): boolean {
  return ref.trim().toLowerCase().startsWith(TOOL_GROUP_REF_PREFIX);
}

/**
 * The groups a `tools:` ref names, or `null` when the name after the prefix is
 * not a group (the caller says so instead of unlocking nothing silently).
 */
export function parseToolGroupRef(ref: string): ToolGroup[] | null {
  const name = ref
    .trim()
    .toLowerCase()
    .slice(TOOL_GROUP_REF_PREFIX.length)
    .trim();
  if (`${TOOL_GROUP_REF_PREFIX}${name}` === BUILDER_REF) {
    return [...TOOL_GROUP_NAMES];
  }
  return (TOOL_GROUP_NAMES as string[]).includes(name)
    ? [name as ToolGroup]
    : null;
}

/** The groups a `load_skill(ref)` unlocks. `[]` = none. */
export function groupsForLoadSkillRef(ref: string): ToolGroup[] {
  if (isToolGroupRef(ref)) return parseToolGroupRef(ref) ?? [];
  return [...(SKILL_STEM_GROUPS[stemOf(ref)] ?? [])];
}

/** The skill stems that unlock a group (test seam: every key is a real skill). */
export const SKILL_STEMS_THAT_UNLOCK = Object.keys(SKILL_STEM_GROUPS);

export interface KeyToolAccess {
  profile: ApiKeyToolProfile | null;
  /** Groups unlocked on the key (`api_keys.tool_groups`). */
  groups: readonly string[];
}

/**
 * The tool names a key lists, or `null` for "every tool" (legacy NULL and
 * `builder`). Unknown group strings in storage are ignored, never widened.
 */
export function visibleToolNames(access: KeyToolAccess): Set<string> | null {
  if (access.profile !== "entry") return null;
  const names = new Set<string>(ENTRY_TOOLS);
  for (const g of access.groups) {
    const tools = (TOOL_GROUPS as Record<string, readonly string[]>)[g];
    if (!tools) continue;
    for (const t of tools) names.add(t);
  }
  return names;
}

/** Filter an advertised tool list down to what the key lists. */
export function filterToolsForAccess<T extends { name: string }>(
  toolDefs: T[],
  access: KeyToolAccess
): T[] {
  const visible = visibleToolNames(access);
  return visible ? toolDefs.filter((t) => visible.has(t.name)) : toolDefs;
}
