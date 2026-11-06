/**
 * /settings/security/passkeys — your passkeys, on their own page: the door
 * every "Add a passkey" in pod admin opens (`PASSKEYS_PATH`), never a scroll
 * to a section of Security. Self-service like Security (`lib/route-policy.ts`):
 * every call behind it is scoped to the caller's own account.
 */

import { PasskeysPage } from "./passkeys-page";

export const dynamic = "force-dynamic";

export default function Passkeys() {
  return <PasskeysPage />;
}
