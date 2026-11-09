/**
 * How an agent finds the pod's tools — ONE source for every place that says
 * it: the entry key's MCP `instructions` (rule 6, `entry-instructions.ts`),
 * `synap_load_skill`'s description, and `synap_orient`'s `yourTools` block.
 *
 * Why not `instructions` alone: some MCP clients never put the server's
 * `instructions` in their model's prompt. Hermes Agent 0.23 keeps the
 * InitializeResult only for its capabilities (finding d812debd), so its model
 * did not know `synap_ask` reads the pod or that `synap_load_skill` unlocks
 * tool groups. A tool description and a tool RESULT reach every client.
 *
 * Pure: no DB. Pinned by `tool-guidance.test.ts`.
 */

import {
  BUILDER_REF,
  ENTRY_TOOLS,
  TOOL_GROUP_NAMES,
  TOOL_GROUP_PURPOSES,
  toolGroupRef,
  type KeyToolAccess,
  type ToolGroup,
} from "./tool-profiles.js";
import { DOOR_TOOL_NAMES } from "./door-tool-names.generated.js";
import type { SkillDoor } from "../../services/capability-briefs/door-tool-render.js";

/** The group the worked example unlocks. */
export const EXAMPLE_GROUP: ToolGroup = "read";

/** The exact unlock call, for the name this door gives `load_skill`. */
export function loadSkillCall(
  loadSkillName: string,
  group: ToolGroup | "builder" = EXAMPLE_GROUP
): string {
  return `${loadSkillName}({ref: "${toolGroupRef(group)}"})`;
}

/** Every group ref, each wrapped in `quote`, optionally with what it is for. */
export function toolGroupList(quote: string, withPurpose = false): string {
  return TOOL_GROUP_NAMES.map(
    (g) =>
      `${quote}${toolGroupRef(g)}${quote}${withPurpose ? ` (${TOOL_GROUP_PURPOSES[g]})` : ""}`
  ).join(", ");
}

/** When unlocked tools show: the pod's HTTP door cannot push `list_changed`. */
export const RECONNECT_NOTE = "They appear after you reconnect.";

/**
 * When unlocked tools show, per door. The claude.ai connector lists them from
 * its next listing with no reconnect (its own unlock note says so).
 */
const UNLOCK_SHOWS: Readonly<Record<SkillDoor, string>> = {
  "pod-mcp": RECONNECT_NOTE,
  "cp-connector":
    "They are listed from your next conversation; nothing to reconnect.",
};

/** A pod tool's name on `door` (`pod__*` on the connector), else its pod name. */
export function doorToolName(podName: string, door: SkillDoor): string {
  return DOOR_TOOL_NAMES[podName]?.[door] ?? podName;
}

/** What `ask` is for, after its name. */
export const ASK_PURPOSE =
  "asks the pod in plain words (people, work, decisions, notes, how-tos, the user's preferences) and answers with sources: call it before you create anything and whenever you do not know where something is";

/**
 * `synap_orient`'s `yourTools`: what this key lists, what `ask` is for, and
 * the exact call that unlocks more, in `door`'s tool names. `access` null = no
 * key on this door (every tool is listed).
 */
export function yourToolsBlock(
  access: KeyToolAccess | null,
  door: SkillDoor
): Record<string, unknown> {
  const toolName = (podName: string) => doorToolName(podName, door);
  const ask = `${toolName("synap_ask")} ${ASK_PURPOSE}.`;
  const loadSkill = toolName("synap_load_skill");
  if (access?.profile !== "entry") {
    return {
      profile: access?.profile ?? "all",
      listed: "This key lists every Synap tool.",
      ask,
      skills: `${loadSkill}({ref: "catalog"}) lists the teaching skills.`,
    };
  }
  const unlocked = TOOL_GROUP_NAMES.filter((g) => access.groups.includes(g));
  const locked = TOOL_GROUP_NAMES.filter((g) => !access.groups.includes(g));
  return {
    profile: "entry",
    listed:
      `This key lists ${ENTRY_TOOLS.length} essential tools` +
      (unlocked.length ? ` plus the groups ${unlocked.join(", ")}` : "") +
      (locked.length
        ? "; more come in groups you unlock."
        : "; every group is unlocked."),
    ask,
    ...(locked.length
      ? {
          unlock: `${loadSkillCall(loadSkill, locked.includes(EXAMPLE_GROUP) ? EXAMPLE_GROUP : locked[0])}: one group below, or "${BUILDER_REF}" for every tool. ${UNLOCK_SHOWS[door]}`,
          groups: Object.fromEntries(
            locked.map((g) => [toolGroupRef(g), TOOL_GROUP_PURPOSES[g]])
          ),
        }
      : {}),
    ...(unlocked.length ? { unlocked: unlocked.map(toolGroupRef) } : {}),
  };
}
