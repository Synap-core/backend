/**
 * The edges and the outreach moves an interaction is read from (CRM recall
 * C-W2). Dependency-free — exported as `@synap/database/interaction-kinds` so
 * the side-effect reactor (`@synap/events`) filters on the SAME set the
 * evidence rule (`interaction-evidence.ts`) reads, without loading the
 * database client.
 */
export const ATTENDED_BY = "attended_by";
export const MET_AT = "met_at";
export const DISCUSSED_WITH = "discussed_with";
export const SENT_TO = "sent_to";
/** The edges an interaction is read from. */
export const INTERACTION_RELATION_TYPES = [
  ATTENDED_BY,
  MET_AT,
  DISCUSSED_WITH,
  SENT_TO,
] as const;

/** The CRM outreach kind (`crm.yaml`) and the statuses meaning "it went out". */
export const OUTREACH_TOUCH_KIND = "outreach-touch";
export const OUTREACH_WENT_OUT_STATUSES = [
  "sent",
  "opened",
  "replied",
  "no_response",
] as const;
/** The touch moves that are interactions (`moveStatus` → `to`). */
export const OUTREACH_INTERACTION_MOVES = ["sent", "replied"] as const;
