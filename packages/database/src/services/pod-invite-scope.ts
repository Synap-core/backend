/**
 * Which spaces a POD invite's accept puts the invitee into.
 *
 * A pod invite fans the invitee out over every ORDINARY space, never over a
 * system space (`pod-admin`, or any space with a `systemSlug`). Pod admin is
 * the `admin`/`owner` role of the `pod-admin` space, so fanning an invite's
 * role (which can be `admin`) into it would hand pod admin to whoever the
 * invite names. That power is granted only through the explicit pod-admin
 * door, never by fan-out.
 *
 * The ONE answer, shared by every accept path (`acceptInvite`, the CP proxy
 * accept, the Hub `/setup/accept-invite`); tripwire
 * `pod-invite-fanout-skips-system-spaces`.
 */

import { db } from "../client-pg.js";
import { workspaces } from "../schema/workspaces.js";

/** A system space: a `systemSlug` column, or the legacy `settings.systemSlug`. */
export function isSystemWorkspace(ws: {
  systemSlug?: string | null;
  settings?: unknown;
}): boolean {
  if (ws.systemSlug) return true;
  const settings = ws.settings;
  return (
    !!settings &&
    typeof settings === "object" &&
    !!(settings as { systemSlug?: unknown }).systemSlug
  );
}

/** The ids of the ordinary spaces a pod invite's accept fans out to. */
export async function listPodInviteFanOutWorkspaceIds(
  conn: Pick<typeof db, "select"> = db
): Promise<string[]> {
  const rows = await conn
    .select({
      id: workspaces.id,
      systemSlug: workspaces.systemSlug,
      settings: workspaces.settings,
    })
    .from(workspaces);
  return rows.filter(() => true /*NC*/).map((ws) => ws.id);
}
