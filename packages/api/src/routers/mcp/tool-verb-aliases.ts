/**
 * MCP tool ↔ teaching-key alias map (AI Teaching Substrate Wave 1b, plan D3).
 *
 * `skills.teachesTools` and `SYSTEM_SKILL_TEACHING` (system-skill-teaching.ts) are keyed
 * by IS tool names / builtin verb ids (e.g. `create_document`, `entity.create`) — the
 * canonical teaching keyspace, because builtin verbs are `skills` rows, not `tools` rows.
 * MCP tools use their own `synap_*` names, so the brief composer (Wave 2b) needs a
 * bridge: given an MCP tool name, which teaching keys does it resolve to? Every MCP
 * tool gets an entry — where a matching builtin verb / IS tool name exists it's listed
 * first, followed by the tool's own name as a fallback key (so a skill authored to
 * teach the MCP name directly still matches).
 *
 * Cross-referenced against: MCP dispatch (`adapter.ts`), builtin verb names
 * (`builtin-verbs.ts` / `SYNAP_CORE_DEFINITION` in `ensure-synap-core.ts`), and IS tool
 * names (`SKILL_TRIGGERS` in synap-intelligence-service's `skill-loader.ts`).
 *
 * Consumed by the brief composer (Wave 2b) to resolve `skills.teachesTools` matches for
 * an MCP tool invocation — do not import this from `tools/index.ts` or `adapter.ts`
 * (owned by a parallel wave); it's a standalone lookup module.
 */

export const MCP_TOOL_TEACHING_KEYS: Record<string, string[]> = {
  synap_ask: ["search_unified", "synap_ask"],
  synap_get_entities: ["list_entities", "synap_get_entities"],
  synap_get_entity: ["get_entity", "synap_get_entity"],
  synap_create_entity: ["entity.create", "create_entity"],
  synap_update_entity: ["entity.update", "update_entity"],
  synap_get_relations: ["graph.relations", "synap_get_relations"],
  synap_link_entities: ["graph.link", "create_relation"],
  synap_get_graph: ["graph.relations", "synap_get_graph"],
  synap_resolve_identity: ["synap_resolve_identity"],
  synap_attach_facet: ["entity_facet.attach"],
  synap_detach_facet: ["entity_facet.detach"],
  synap_define_role: ["profile.create", "synap_define_role"],
  synap_remember_fact: ["remember_fact"],
  synap_capture: ["propose_entity_graph", "synap_capture"],
  synap_create_document: ["document.create", "create_document"],
  synap_get_document: ["document.read", "get_document"],
  synap_create_view: ["create_view"],
  synap_create_cell: ["create_cell", "generate_widget"],
  synap_promote_cell_to_renderer: ["synap_promote_cell_to_renderer"],
  synap_promote_session_to_playbook: ["synap_promote_session_to_playbook"],
  synap_create_playbook: ["synap_create_playbook"],
  synap_list_playbooks: ["synap_list_playbooks"],
  synap_start_session: ["synap_start_session"],
  synap_update_session: ["synap_update_session"],
  synap_complete_session: ["synap_complete_session"],
  synap_create_workspace: ["create_workspace"],
  synap_declare_workspace_source: [
    "declare_workspace_source",
    "synap_declare_workspace_source",
  ],
  synap_create_project: ["synap_create_project"],
  synap_list_projects: ["synap_list_projects"],
  synap_list_profiles: ["list_profiles"],
  synap_orient: ["synap_orient"],
  synap_list_capabilities: ["list_capabilities", "synap_list_capabilities"],
  synap_run_capability: ["run_capability", "synap_run_capability"],
  synap_governance: ["synap_governance"],
  synap_list_proposals: ["synap_list_proposals"],
  synap_revise_proposal: ["synap_revise_proposal"],
  synap_get_channel: ["channel.resolve", "channel.ensure"],
  synap_post_message: ["feed.post", "synap_post_message"],
  synap_send_message: ["feed.post", "synap_send_message"],
  synap_get_thread_context: ["feed.read", "synap_get_thread_context"],
  synap_write_knowledge: ["synap_write_knowledge"],
};
