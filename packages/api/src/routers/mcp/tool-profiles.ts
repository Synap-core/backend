/**
 * MCP tool profiles — WHICH tools a key's MCP client lists (V1 D4, gap G10).
 *
 * Research the V1 plan leans on: tool-selection accuracy degrades past ~30-40
 * always-loaded tools, and Codex / Cursor do not defer MCP tools the way
 * Claude Code does. So a NEW agent key lists the 13-tool `entry` surface; the
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
 * before. (`synap_call_tool` alone runs only what the key lists:
 * `call-tool.ts`.) That is deliberate — the claude.ai CP connector re-advertises its own
 * static catalog and proxies calls here, so gating calls on the profile would
 * break a connector whose list the pod does not control.
 *
 * `api_keys.tool_profile`: NULL = legacy (every tool — every key minted before
 * 0280, unchanged), `entry`, or `builder` (every tool, chosen).
 *
 * No DB. A tool's place (entry or one group) is its `defineTool` `group`, so a
 * new tool cannot silently vanish from an entry key's reach.
 */

import type { ApiKeyToolProfile } from "@synap/database/schema";
import {
  MCP_TOOL_GROUP_NAMES,
  type McpToolGroupName,
} from "@synap-core/types/agents";
import {
  entryToolNames,
  toolGroupMembers,
  unlistedToolNames,
} from "./define-tool.js";

/**
 * The groups, in the ONE order (`@synap-core/types/agents`). Which tool is in
 * which group (or on the entry surface) is its definition's `group`
 * (`define-tool.ts`: `entryToolNames`, `toolGroupMembers`), never a list here.
 * Every tool is entry or in exactly one group by construction.
 */
export type ToolGroup = McpToolGroupName;
export const TOOL_GROUP_NAMES: ToolGroup[] = [...MCP_TOOL_GROUP_NAMES];

/**
 * What each group is FOR, in a few words — the line a model reads to pick one
 * (`synap_load_skill`'s description, `synap_orient`'s `yourTools`). Typed on
 * {@link ToolGroup}, so a new group cannot ship without its line.
 */
export const TOOL_GROUP_PURPOSES: Readonly<Record<ToolGroup, string>> = {
  read: "look things up beyond ask",
  data: "precise writes beyond capture",
  sessions: "the rest of the session lifecycle",
  governance: "proposals and trust rules",
  schema: "kinds, roles and who may see them",
  spaces: "spaces, projects and focus",
  tracks: "goals (tracks): multi-stage work over time",
  build: "views, cells, playbooks and skills",
  capabilities: "connected services, verbs and automations",
};

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
  "hand-off": ["sessions", "read"],
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
  showing: ["build"],
  "document-embeds": ["build", "data"],
};

/**
 * Seeded skill PACKAGES whose every chapter teaches building: a ref INSIDE one
 * (`system/synap-ui/views`, `synap-app/overview`) unlocks its groups whatever
 * the chapter's stem. Keyed by the package directory (`skills/<package>/`), not
 * by stem, because a package's stems are ambiguous across packages: `skill`,
 * `overview`, `views`, `workspaces`, `governance`, `more` also name chapters of
 * `synap`, `synap-design`, `synap-market`… A stem key would unlock `build` for
 * `system/synap-design/skill` too. A BARE stem (`views`) carries no package, so
 * only the stem map above applies to it.
 *
 * synap-ui teaches views, bento, cells (`build`) over profiles and the flow it
 * reads first (`synap_list_profiles`, `synap_get_flow`: `read`); synap-app
 * teaches the same pod-native build before a separate app, and `flow.of`;
 * surfaces teaches the same build (find what an object carries, pick the
 * body, anchor it) over the same reads.
 */
const SKILL_PACKAGE_GROUPS: Readonly<Record<string, readonly ToolGroup[]>> = {
  surfaces: ["build", "read"],
  "synap-ui": ["build", "read"],
  "synap-app": ["build", "read"],
};

function refSegments(ref: string): string[] {
  return ref.trim().replace(/\.md$/i, "").toLowerCase().split("/");
}

function stemOf(ref: string): string {
  const parts = refSegments(ref);
  return parts[parts.length - 1] ?? "";
}

/** The package a ref names (`system/<pkg>/<stem>` or `<pkg>/<stem>`), else null. */
function packageOf(ref: string): string | null {
  const parts = refSegments(ref);
  if (parts.length === 3 && parts[0] === "system") return parts[1] ?? null;
  if (parts.length === 2) return parts[0] ?? null;
  return null;
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
  // Own keys only: a ref is agent input, and `constructor` is on every object.
  const own = (
    map: Readonly<Record<string, readonly ToolGroup[]>>,
    key: string | null
  ) => (key !== null && Object.hasOwn(map, key) ? map[key]! : []);
  return [
    ...new Set([
      ...own(SKILL_STEM_GROUPS, stemOf(ref)),
      ...own(SKILL_PACKAGE_GROUPS, packageOf(ref)),
    ]),
  ];
}

/** The skill stems that unlock a group (test seam: every key is a real skill). */
export const SKILL_STEMS_THAT_UNLOCK = Object.keys(SKILL_STEM_GROUPS);

/** The skill packages whose every chapter unlocks a group (test seam: every key is a real package). */
export const SKILL_PACKAGES_THAT_UNLOCK = Object.keys(SKILL_PACKAGE_GROUPS);

export interface KeyToolAccess {
  profile: ApiKeyToolProfile | null;
  /** Groups unlocked on the key (`api_keys.tool_groups`). */
  groups: readonly string[];
}

/**
 * The tool names a key may reach: the entry tools plus every tool of its
 * unlocked groups (hidden doors and old names included: `synap_call_tool`
 * runs them), or
 * `null` for "every tool" (legacy NULL and `builder`). Unknown group strings
 * in storage are ignored, never widened.
 */
export function visibleToolNames(access: KeyToolAccess): Set<string> | null {
  if (access.profile !== "entry") return null;
  const names = new Set<string>(entryToolNames(true));
  const groups = toolGroupMembers(true) as Record<string, string[]>;
  for (const g of access.groups) {
    if (!Object.hasOwn(groups, g)) continue;
    for (const t of groups[g]!) names.add(t);
  }
  return names;
}

/**
 * Filter an advertised tool list down to what the key lists. An old name and
 * a hidden door are never listed (they still answer a call).
 */
export function filterToolsForAccess<T extends { name: string }>(
  toolDefs: T[],
  access: KeyToolAccess
): T[] {
  const visible = visibleToolNames(access);
  const unlisted = unlistedToolNames();
  return toolDefs.filter(
    (t) => !unlisted.has(t.name) && (!visible || visible.has(t.name))
  );
}
