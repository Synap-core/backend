/**
 * End every Kratos session of one identity (`DELETE
 * /admin/identities/{id}/sessions`): the one door for it in this package,
 * used by "Unlink {email}" and by `workspaces.removeFromPod`.
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
