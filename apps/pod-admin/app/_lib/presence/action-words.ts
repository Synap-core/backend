/**
 * What the person is doing, for each sensitive action (`SENSITIVE_ACTIONS`,
 * `@synap-core/types/presence`), as the proof dialog says it: "To {doing},
 * confirm with your passkey." Both catalogs are typed over EVERY path, so a
 * path added to the pod's list fails this build until it has its words
 * (never a raw path in the dialog). DRAFT French, awaiting the founder's
 * review.
 */
import type { SensitiveActionPath } from "@synap-core/types/presence";
import { ambientCatalogLocale } from "@synap-core/types/i18n";

const en = {
  "apiKeys.create": "create a key",
  "apiKeys.rotate": "replace this key",
  "apiKeys.setGrants": "change what this key may do",
  "apiKeys.connectIntegration": "give this app a key to your pod",
  "apiKeys.beginMcpConnect": "connect this AI to your pod",
  "apiKeys.createSystemKey": "create a system key",
  "apiKeys.adminCreateServiceKey": "create a service key",
  "apiKeys.createForWorkspace": "create a key for this space",
  "apiKeys.setMachineDefaults": "change how long computer keys last",
  "apps.issueKey": "give this app a key",
  "apps.setWriteMode": "change how this app’s changes land",
  "apps.setRedirectUris": "change where this app may send you back",
  "apps.setSignInPolicy": "change who may sign in to this app",
  "intelligenceRegistry.register": "add an AI service",
  "intelligenceRegistry.update": "change this AI service",
  "intelligenceRegistry.rotateKey": "replace this AI service’s key",
  "intelligence.registerCustomService": "add your own AI service",
  "machines.setKeyTtl": "change how long this computer’s key lasts",
  "machines.setRunsScripts": "change whether this computer runs scripts",
  "machines.setBelongsTo": "change whose computer this is",
  "secretsVault.reveal": "show this secret",
  "agentUsers.create": "add an agent",
  "agentUsers.update": "change this agent",
  "agentUsers.setPosture": "change whether this agent’s changes wait for you",
  "connectors.setKeepSyncing": "change how this connection syncs",
  "trustedIssuers.adminRegister": "trust a new sign-in issuer",
  "governanceRules.create": "change what an agent may do without asking",
  "governanceRules.widenCell": "let this agent do more without asking",
  "governanceRules.proposeNextRung": "let this agent do more without asking",
  "governanceRules.setReversibleDefault":
    "change what agents may do without asking on this pod",
  "governanceRules.setOwnOrganiseDefault":
    "change what agents may do without asking on this pod",
  "governanceRules.setActionMode": "change how this tool runs for every AI",
  "govConfig.set": "change this pod’s governance",
} as const satisfies Record<SensitiveActionPath, string>;

const fr: Record<SensitiveActionPath, string> = {
  "apiKeys.create": "créer une clé",
  "apiKeys.rotate": "remplacer cette clé",
  "apiKeys.setGrants": "changer ce que cette clé peut faire",
  "apiKeys.connectIntegration": "donner à cette app une clé de votre pod",
  "apiKeys.beginMcpConnect": "connecter cette IA à votre pod",
  "apiKeys.createSystemKey": "créer une clé système",
  "apiKeys.adminCreateServiceKey": "créer une clé de service",
  "apiKeys.createForWorkspace": "créer une clé pour cet espace",
  "apiKeys.setMachineDefaults":
    "changer la durée de vie des clés des ordinateurs",
  "apps.issueKey": "donner une clé à cette app",
  "apps.setWriteMode":
    "changer la façon dont les modifications de cette app s’appliquent",
  "apps.setRedirectUris": "changer où cette app peut vous renvoyer",
  "apps.setSignInPolicy": "changer qui peut se connecter à cette app",
  "intelligenceRegistry.register": "ajouter un service d’IA",
  "intelligenceRegistry.update": "modifier ce service d’IA",
  "intelligenceRegistry.rotateKey": "remplacer la clé de ce service d’IA",
  "intelligence.registerCustomService": "ajouter votre propre service d’IA",
  "machines.setKeyTtl": "changer la durée de vie de la clé de cet ordinateur",
  "machines.setRunsScripts": "changer si cet ordinateur exécute des scripts",
  "machines.setBelongsTo": "changer à qui appartient cet ordinateur",
  "secretsVault.reveal": "afficher ce secret",
  "agentUsers.create": "ajouter un agent",
  "agentUsers.update": "modifier cet agent",
  "agentUsers.setPosture":
    "changer si les modifications de cet agent vous attendent",
  "connectors.setKeepSyncing":
    "changer la façon dont cette connexion se synchronise",
  "trustedIssuers.adminRegister": "faire confiance à un nouvel émetteur",
  "governanceRules.create": "changer ce qu’un agent peut faire sans demander",
  "governanceRules.widenCell": "laisser cet agent faire plus sans demander",
  "governanceRules.proposeNextRung":
    "laisser cet agent faire plus sans demander",
  "governanceRules.setReversibleDefault":
    "changer ce que les agents peuvent faire sans demander sur ce pod",
  "governanceRules.setOwnOrganiseDefault":
    "changer ce que les agents peuvent faire sans demander sur ce pod",
  "governanceRules.setActionMode":
    "changer comment cet outil s’exécute pour toutes les IA",
  "govConfig.set": "changer la gouvernance de ce pod",
};

/** "create a key": what the person does, in the ambient catalog language. */
export function actionDoing(path: SensitiveActionPath): string {
  return (ambientCatalogLocale() === "fr" ? fr : en)[path];
}
