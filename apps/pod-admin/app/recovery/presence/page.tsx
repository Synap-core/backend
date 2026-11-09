/**
 * /recovery/presence: "I lost my passkey" (`CONSOLE_PAGES.presenceRecovery`),
 * the ONE recovery door of proof of presence. Under `/recovery`, so the proxy
 * lets a signed-out reader in; the page then asks them to sign in (every step
 * is a signed-in person's, checked by the pod).
 */

import { PresenceRecoveryView } from "./PresenceRecoveryView";

export const dynamic = "force-dynamic";

export default function PresenceRecoveryPage() {
  return <PresenceRecoveryView />;
}
