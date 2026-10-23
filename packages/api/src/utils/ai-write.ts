/**
 * Is this write an AI write? The governance gate's own answer
 * (`checkPermissionOrPropose`: an attributed agent, or an unattributed
 * `ai` / `intelligence` source — a hub key or IS call whose agent did not
 * resolve). Doors that decide something BEFORE the gate (a duplicate floor, a
 * forced review, a stricter scope rule) ask this same question, so an
 * unattributed AI caller can never take the person's path at one door while
 * the gate treats it as AI. Approval replays are `source: "system"` and stay
 * out.
 */
export function isAiWriteRequest(write: {
  agentUserId?: string | null;
  source?: string | null;
}): boolean {
  return (
    Boolean(write.agentUserId) ||
    write.source === "ai" ||
    write.source === "intelligence"
  );
}
