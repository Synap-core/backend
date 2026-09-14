/**
 * Door-aware skill teaching — render time only.
 *
 * Skills are authored once (`synap-backend/skills/**`) and name tools in three
 * spellings: the pod MCP name (`synap_define_kind`), a bare stem (`define_kind`),
 * or an IS tool name (`search_unified`, `generate_widget`). Served verbatim, an
 * agent on Raycast reads "call synap_define_kind" and dead-ends. This module
 * rewrites every taught tool token to the name the SERVING door exposes, and marks
 * the ones the door lacks with a closing note — the source text is never changed.
 *
 * ONE name table: token → pod tool resolves through `MCP_TOOL_TEACHING_KEYS`
 * (`tool-verb-aliases.ts`, the existing bridge, read in reverse) and pod tool →
 * door name through `DOOR_TOOL_NAMES` (generated from the three door manifests).
 * The tripwire `__tripwires__/skill-tool-tokens-resolve.test.ts` proves every
 * token taught by a skill file resolves here or is classified below.
 */

import type { SkillDoor } from "../../routers/mcp/door-tool-names.build.js";
import { DOOR_TOOL_NAMES } from "../../routers/mcp/door-tool-names.generated.js";
import { MCP_TOOL_TEACHING_KEYS } from "../../routers/mcp/tool-verb-aliases.js";

export type { SkillDoor };

/**
 * Tokens skills teach that exist ONLY as Intelligence Service tools (the in-app
 * assistant) — no pod MCP tool, so no agent door has them. Each carries the reason
 * the note shows.
 */
export const IS_ONLY_TOOL_TOKENS: Record<string, string> = {
  create_property_def:
    "in-app assistant only; from an agent door add the field through define_kind with the kind's slug and the new field in properties[]",
  get_profile:
    "in-app assistant only; list_profiles returns each kind's fields",
  get_bento_schema: "in-app assistant only (workspace layout read)",
  focus_surface: "in-app assistant only (drives the user's open screen)",
  place_on_whiteboard:
    "in-app assistant only (drives the user's open whiteboard)",
  link_entity_to_thread:
    "in-app assistant only (binds the current chat thread)",
  link_document_to_thread:
    "in-app assistant only (binds the current chat thread)",
  propose_channel_bind:
    "in-app assistant only (binds the current chat channel)",
  record_observation:
    "in-app assistant only; remember_fact is the agent-door equivalent",
  propose_workspace_template:
    "in-app assistant only; agents search the marketplace with run_capability",
  consolidate_branches: "in-app assistant only (merges chat branches)",
  discover_tools:
    "in-app assistant only; agent doors list their tools natively",
  list_commands: "in-app assistant only (the user's saved commands)",
  get_work_guidelines:
    "in-app assistant only (reads the work guideline for a blocked session)",
};

/**
 * Tokens that look like tools (a verb prefix or a call form) but are NOT door
 * tools — never rewritten, never noted. Each says what the token really is.
 */
export const NOT_A_DOOR_TOOL_TOKENS: Record<string, string> = {
  synap_packages: "a database table (the marketplace catalog), not a tool",
  market_search:
    "the builtin verb market.search, run through run_capability on every door",
  declare_source:
    "the governance action in `workspace/declare_source` (a proposal type), not a tool",
};

/** Human door name for the closing note. Product copy, not a domain token. */
const DOOR_LABEL: Record<SkillDoor, string> = {
  "pod-mcp": "Synap MCP",
  "cp-connector": "claude.ai Synap connector",
  raycast: "Raycast",
};

/** The pod MCP tool a taught token names, or `null` when it names none. */
export function resolveTaughtToolToken(token: string): string | null {
  if (DOOR_TOOL_NAMES[token]) return token;
  if (DOOR_TOOL_NAMES[`synap_${token}`]) return `synap_${token}`;
  const teachers = Object.entries(MCP_TOOL_TEACHING_KEYS)
    .filter(([tool, keys]) => DOOR_TOOL_NAMES[tool] && keys.includes(token))
    .map(([tool]) => tool);
  // An ambiguous alias (two tools teach it) resolves to neither: guessing would
  // hand the agent the wrong tool with full confidence.
  return teachers.length === 1 ? teachers[0]! : null;
}

/** A tool-shaped token: `synap_*` or any snake_case identifier. */
const TOKEN_RE = /\b(?:synap_[a-z0-9_]+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

const MISSING_MARK = "†";

/**
 * Rewrite a skill body (or brief) for the door serving it. A token the door has
 * becomes its door name; a token the door lacks keeps its pod name, gains `†`, and
 * is listed in a closing note that says what to do instead. Unresolvable tokens
 * (relation types, field names) are left exactly as written.
 */
export function renderSkillForDoor(text: string, door: SkillDoor): string {
  const missing = new Map<string, string>();
  const out = rewriteTokens(text, door, missing);
  if (missing.size === 0) return out;
  // Reasons name tools too ("add the field through define_kind"): render them for
  // the same door, so the note never re-teaches a dead name.
  const lines = [...missing].map(
    ([tool, why]) => `- \`${tool}\` — ${rewriteTokens(why, door, new Map())}`
  );
  return `${out}\n\n---\n**Door note (${DOOR_LABEL[door]}):** ${MISSING_MARK} marks a tool this door does not have. Do not call it; ask the user to do that step in the Synap app, or say which step needs a door that has it.\n${lines.join("\n")}\n`;
}

function rewriteTokens(
  text: string,
  door: SkillDoor,
  missing: Map<string, string>
): string {
  return text.replace(TOKEN_RE, (token) => {
    const isOnly = IS_ONLY_TOOL_TOKENS[token];
    if (isOnly) {
      missing.set(token, isOnly);
      return `${token}${MISSING_MARK}`;
    }
    const podTool = resolveTaughtToolToken(token);
    if (!podTool) return token;
    const name = DOOR_TOOL_NAMES[podTool]![door];
    if (name) return name;
    missing.set(podTool, `not on ${DOOR_LABEL[door]}`);
    return `${podTool}${MISSING_MARK}`;
  });
}

/** Agent types whose door renames tools. Sources cited per entry. */
const CP_CONNECTOR_AGENT_TYPE = "claude-web"; // mcp-redeem.ts owner floor, api-keys.ts z.literal
const RAYCAST_AGENT_TYPE = "raycast"; // setup.ts SURFACE_AGENT_TYPES; `synap connect --target=raycast`

/**
 * Which door is serving, from the transport and the acting agent's `agentType`.
 * `/mcp` always has a door (pod MCP unless the key is the CP connector's). A hub
 * REST caller is only rendered for when it is Raycast; every other REST consumer
 * (the IS, the CLI, scripts) keeps the source text — `null`.
 */
export function skillDoorFor(
  transport: "mcp" | "hub",
  agentType: string | null | undefined
): SkillDoor | null {
  if (transport === "mcp")
    return agentType === CP_CONNECTOR_AGENT_TYPE ? "cp-connector" : "pod-mcp";
  return agentType === RAYCAST_AGENT_TYPE ? "raycast" : null;
}
