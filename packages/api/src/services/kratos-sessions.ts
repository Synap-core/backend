/**
 * End every Kratos session of one identity (`DELETE
 * /admin/identities/{id}/sessions`): the one door for it in this package,
 * used by "Unlink {email}" and by `workspaces.removeFromPod`; and
 * `endOtherIdentitySessions`, which keeps the one the person is in.
 *
 * `true` = no session is left (a 404 means there was none, the outcome
 * wanted); `false` = Kratos refused or did not answer. The caller records a
 * `false`; it is never read as "ended".
 */

import { kratosAdmin } from "@synap/auth";

export async function endIdentitySessions(
  kratosIdentityId: string
): Promise<boolean> {
  try {
    await kratosAdmin.deleteIdentitySessions({ id: kratosIdentityId });
    return true;
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    return status === 404;
  }
}

/** Kratos lists at most this many sessions per page (its maximum). */
const SESSION_PAGE = 1000;

/**
 * End every ACTIVE Kratos session of one identity but `keepSessionId` (the
 * browser the person is in): a finished "I lost my passkey" signs out every
 * other browser (founder, 6 Nov 2026, answer 4819a6c3). A Synap app's device
 * token is not a Kratos session and is kept. Each session is ended on its own
 * (`DELETE /admin/sessions/{id}`); `failed` counts the ones Kratos refused,
 * and `listed: false` says the list itself could not be read (nothing was
 * ended): the caller records either, it is never "signed out".
 */
export async function endOtherIdentitySessions(
  kratosIdentityId: string,
  keepSessionId: string | null
): Promise<{ listed: boolean; ended: number; failed: number }> {
  let sessions: Array<{ id: string }>;
  try {
    const { data } = await kratosAdmin.listIdentitySessions({
      id: kratosIdentityId,
      active: true,
      pageSize: SESSION_PAGE,
    });
    sessions = data ?? [];
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    return { listed: status === 404, ended: 0, failed: 0 };
  }
  let ended = 0;
  let failed = 0;
  for (const s of sessions) {
    if (!s.id || s.id === keepSessionId) continue;
    try {
      await kratosAdmin.disableSession({ id: s.id });
      ended += 1;
    } catch {
      failed += 1;
    }
  }
  return { listed: true, ended, failed };
}
