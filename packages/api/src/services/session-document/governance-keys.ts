/**
 * The governance keys the section write door files under.
 *
 * TWO keys (plus D4's refresher key, below), chosen by the DOOR from server-resolved facts — never by the caller:
 *
 *   - `document.session_narrative_update` — an agent writing an AI-owned (or new)
 *     section of the designated document of the session it is working in right
 *     now (the VERIFIED ambient session). Founder decision D10: this applies
 *     immediately with undo, and the way it does so is a stored
 *     `governance_rules` row (`ensureSessionNarrativeRule`), resolved at rung
 *     2.8 — not a code bypass and not a `DEFAULT_AUTO_APPROVE` entry. A person
 *     can revoke or tighten it in the rules editor like any other rule.
 *   - `document.section_update` — every other section write (another session's
 *     document, or a write with no ambient session). No rule and no default
 *     whitelist entry, so an agent's write lands at rung 9: a proposal.
 *
 * Neither verb is floor-class: not an ADMIN / HUMAN_GATE / ARBITRARY_EXECUTION /
 * AGENT_SCHEMA_DEFINITION event key and not a DESTRUCTIVE verb, so a rule CAN
 * resolve them (pinned by `nonWidenableFloorFor` in the tests). Every
 * context-dependent tightening still applies above the rule: an untrusted
 * origin (2.55), the daily ceiling (2.56) and a session's force-propose (2.1).
 *
 * Kept in a module with no imports so the boot seeder can read the key without
 * loading storage or the gate.
 */

export const SESSION_NARRATIVE_ACTION = "session_narrative_update" as const;
export const SECTION_UPDATE_ACTION = "section_update" as const;

/**
 * `document.refresher_section_update` — decision D4 (Generative UI plan
 * 678c56c4): a document's BOUND refresher (`documents.refresh_automation_id`)
 * rewriting sections of that document which already exist and are
 * `owner="ai"`, from an open run session of that automation. Chosen by the
 * patch door from server facts (`isBoundRefresherRun` +
 * `refresherRewritesOnlyItsSections`); applies through a stored rule
 * (`ensureDocumentRefresherRule`) exactly like D10. A new section, a person's
 * section, any other op, any other writer: `section_update` / `update`.
 */
export const REFRESHER_SECTION_ACTION = "refresher_section_update" as const;

/** The rung-2.8 target pattern the seeded auto rule names. */
export const SESSION_NARRATIVE_EVENT_KEY =
  `document.${SESSION_NARRATIVE_ACTION}` as const;

/** `created_by` of the seeded rule — tells an audit query who wrote it. */
export const SESSION_NARRATIVE_RULE_CREATED_BY = "system:session-document";

/** The rung-2.8 target pattern the seeded D4 rule names. */
export const REFRESHER_SECTION_EVENT_KEY =
  `document.${REFRESHER_SECTION_ACTION}` as const;

/** `created_by` of the seeded D4 rule. */
export const REFRESHER_RULE_CREATED_BY = "system:document-refresher";
