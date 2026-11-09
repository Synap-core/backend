/**
 * The secure-access step's words (`/start/access`), as catalogs
 * (`@synap-core/types/i18n`). English is the source and the type. DRAFT
 * French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  title: "Keep two ways to confirm it’s you",
  lead: "Approving a deploy, a key or an AI’s access asks you to confirm it’s you. With two ways, losing one never locks you out. Add a passkey and recovery codes, or an authenticator app.",
  continue: "Continue",
  skip: "Skip for now",
  skipHint:
    "Security in the account menu keeps reminding you until you have two.",
  back: "Back",
  recordFailed: "Couldn’t save this step. Try again.",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Gardez deux moyens de confirmer que c’est vous",
  lead: "Approuver un déploiement, une clé ou l’accès d’une IA vous demande de confirmer que c’est vous. Avec deux moyens, en perdre un ne vous bloque jamais. Ajoutez une clé d’accès et des codes de secours, ou une app d’authentification.",
  continue: "Continuer",
  skip: "Plus tard",
  skipHint:
    "Sécurité, dans le menu du compte, vous le rappelle tant que vous n’en avez pas deux.",
  back: "Retour",
  recordFailed: "Impossible d’enregistrer cette étape. Réessayez.",
};
