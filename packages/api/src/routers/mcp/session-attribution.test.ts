import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { isReadOnlyTool } from "./adapter.js";

/**
 * MCP focus-session attribution coverage.
 *
 * `resolveSessionHandle` used to consult an ALLOW-list (`SESSION_LINKED_TOOLS`,
 * 18 entries) and early-return `undefined` for everything else — so
 * `synap_create_workspace`, `synap_create_skill`, `synap_create_automation`,
 * `synap_run_capability`, `synap_post_message`, `synap_create_cell`,
 * `synap_define_role` and `synap_trigger_automation` all wrote
 * `sessionId: undefined` even with an open session, and their proposals carried
 * no session provenance.
 *
 * It is now an INVERTED read-only DENY-list, so the default is "attribute the
 * write to the session that produced it" and a NEW write door is covered
 * automatically. These tests lock both halves: the previously-missed writes are
 * now session-linked, and the reads still skip the DB round-trip.
 */
describe("MCP session attribution — read-only deny-list", () => {
  const PREVIOUSLY_MISSED_WRITES = [
    "synap_create_workspace",
    "synap_create_skill",
    "synap_create_automation",
    "synap_run_capability",
    "synap_post_message",
    "synap_create_cell",
    "synap_define_role",
    "synap_trigger_automation",
    "synap_create_view",
    "synap_run_playbook",
    "synap_revise_proposal",
    "synap_promote_cell_to_renderer",
    "synap_declare_workspace_source",
    "synap_set_workspace_focus",
    "synap_store_file",
  ];

  it.each(PREVIOUSLY_MISSED_WRITES)(
    "%s is session-linked (was silently dropping provenance)",
    (tool) => {
      expect(isReadOnlyTool(tool)).toBe(false);
    }
  );

  const READS = [
    "synap_ask",
    "synap_orient",
    "synap_diagnose",
    "synap_load_skill",
    "synap_match_playbooks",
    "synap_resolve_identity",
    "synap_template_health",
    "synap_get_entity",
    "synap_get_entities",
    "synap_get_graph",
    "synap_get_relations",
    "synap_get_document",
    "synap_get_channel",
    "synap_get_session",
    "synap_get_thread_context",
    "synap_list_profiles",
    "synap_list_proposals",
    "synap_list_sessions",
    "synap_list_capabilities",
    "synap_list_automations",
    "synap_list_playbooks",
    // NOTE: `synap_list_projects` is deliberately absent — it was retired into
    // `synap_orient` (scope:['projects']) and only survives as a verb alias. The
    // `synap_list_` prefix still covers it if it ever returns.
  ];

  it.each(READS)("%s stays read-only (no session round-trip)", (tool) => {
    expect(isReadOnlyTool(tool)).toBe(true);
  });

  it("the write doors the OLD allow-list already covered are still covered", () => {
    // Regression floor: the inversion must not lose anything the allow-list had.
    const OLD_ALLOWLIST = [
      "synap_create_entity",
      "synap_update_entity",
      "synap_create_document",
      "synap_store_file",
      "synap_remember_fact",
      "synap_link_entities",
      "synap_attach_facet",
      "synap_detach_facet",
      "synap_capture",
      "synap_capture_graph",
      "synap_create_project",
      "synap_create_playbook",
      "synap_create_view",
      "synap_create_verb",
      "synap_start_session",
      "synap_update_session",
      "synap_complete_session",
      "synap_promote_session_to_playbook",
    ];
    expect(OLD_ALLOWLIST.filter(isReadOnlyTool)).toEqual([]);
  });

  it("an unknown/new tool defaults to session-linked (fails toward provenance)", () => {
    expect(isReadOnlyTool("synap_some_future_write_door")).toBe(false);
  });

  /**
   * Guards the deny-list against the shipped tool surface: every name it denies
   * must still be a real tool. A renamed/removed read would otherwise sit here
   * forever while its replacement silently pays for a round-trip.
   */
  it("every explicitly-denied name is a tool the MCP server actually ships", () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "tools/mcp-tools.manifest.json"), "utf8")
    ) as { tools: { name: string }[] };
    const shipped = new Set(manifest.tools.map((t) => t.name));
    const stale = READS.filter((t) => !shipped.has(t));
    expect(stale).toEqual([]);
  });
});
