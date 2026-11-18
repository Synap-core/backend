/**
 * The MCP tools that take `supersedes` (plan 8032a127 D3): the id of a FAILED
 * proposal the call files again, corrected (`fileSuperseding`).
 *
 * Read from {@link SUPERSEDES_DOORS}, the one table that pairs each tool with
 * the Hub REST route filing the same request, so the MCP door and the Hub
 * door (the Intelligence Service's) take it on the same requests. Not every
 * write tool: one property on ~80 tools cost ~70 tokens each on every session
 * and broke the `token-budget` ratchet (decision of 17 Nov 2026, option A).
 * `tools.list()` declares it on exactly these, the adapter refuses it on any
 * other tool, and `synap_get_proposal` teaches it.
 */
import { SUPERSEDES_DOORS } from "../../services/proposals/supersedes-door.js";

export const SUPERSEDES_TOOLS: readonly string[] = SUPERSEDES_DOORS.map(
  (door) => door.tool
);
