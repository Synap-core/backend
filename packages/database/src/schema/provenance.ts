/**
 * Shared provenance vocabulary for the uniform `created_by_kind` column added
 * across mutation-bearing tables (Wave B3). Type-only — no import cycle.
 *
 * NOTE: `cell_instances.createdByKind` (user|agent|system) and
 * `messages.authorType` (human|ai_agent|external|bot) are PRE-EXISTING and kept
 * as-is. This vocab (human|ai_agent|system — matching `channel_members.memberKind`)
 * is for the NEW provenance columns only.
 */
export type ProvenanceKind = "human" | "ai_agent" | "system";
