/**
 * The words of "Where should this passkey live?" (founder, 6 Nov 2026), asked
 * wherever pod admin creates a passkey, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French ("vous"), awaiting the
 * founder's review.
 *
 * Honest by design: the browser follows the answer, but a password-manager
 * extension can still open first, so the device answer says how to get past it.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "placement.question": "Where should this passkey live?",
  "placement.device.label": "This device (Touch ID / Windows Hello)",
  "placement.device.hint":
    "Kept by this computer’s own lock. If your password manager opens instead, choose its option to use this device, or turn it off for this site and try again.",
  "placement.manager.label": "Password manager or security key",
  "placement.manager.hint":
    "Kept by your password manager, a security key or your phone.",
} as const;

export const fr: Catalog<typeof en> = {
  "placement.question": "Où garder cette clé d’accès ?",
  "placement.device.label": "Cet appareil (Touch ID / Windows Hello)",
  "placement.device.hint":
    "Gardée par le verrou de cet ordinateur. Si votre gestionnaire de mots de passe s’ouvre à la place, choisissez son option pour utiliser cet appareil, ou désactivez-le pour ce site et réessayez.",
  "placement.manager.label": "Gestionnaire de mots de passe ou clé de sécurité",
  "placement.manager.hint":
    "Gardée par votre gestionnaire de mots de passe, une clé de sécurité ou votre téléphone.",
};
