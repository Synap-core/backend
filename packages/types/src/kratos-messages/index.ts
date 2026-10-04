/**
 * Kratos flow message ids the pod's sign-in surfaces branch on — the ONE place
 * these numbers live. The pod's registration gate (apps/api
 * `webhooks/kratos-registration-gate.ts`) EMITS the two pod-defined messages;
 * pod-admin (and any other sign-in client) MATCHES them, plus Kratos' own
 * account-linking ids, to render an explicit state instead of a raw banner.
 *
 * Pure + dependency-free — safe in browser, Node and Next.js server code.
 */

/**
 * Pod-defined refusal: a Synap Cloud user with no access to this pod.
 * 4000xxx is Kratos' validation-error range; 4000901+ is unused by Kratos
 * v1.3.1 (its own validation ids stop at 4000038).
 */
export const POD_ACCESS_REQUIRED = {
  id: 4000901,
  text: "You don't have access to this pod yet.",
  context: { reason: "pod_access_required" },
} as const;

/** Pod-defined refusal: password (or any non-Cloud) self sign-up is closed. */
export const SELF_REGISTRATION_DISABLED = {
  id: 4000902,
  text: "New accounts on this pod are created by invitation or with Synap Cloud.",
  context: { reason: "self_registration_disabled" },
} as const;

/**
 * Kratos v1.3.1 account-linking ids (ory/kratos@v1.3.1 `text/id.go`, values
 * obtained by compiling that file — not from memory). Kratos lands an existing
 * pod account that signs in with Synap Cloud for the first time on a LOGIN flow
 * that asks for the account's existing credential to link the two
 * (selfservice/strategy/oidc/strategy.go `populateAccountLinkingUI`).
 */
export const KRATOS_ACCOUNT_LINK_IDS = {
  /** ui.messages: "You tried to sign in with …, but that email is already used…" (context.duplicateIdentifier, context.provider). */
  loginLink: 1010016,
  /** node label replacing "Sign in": "Sign in and link". */
  loginAndLink: 1010017,
  /** node label replacing "Sign in with X": "Confirm with X". */
  loginWithAndLink: 1010018,
  /** ui.messages fallback when no duplicate-credential data was stored: "…sign in to your existing account to link your social profile." */
  duplicateCredentialsOnOidcLink: 4000027,
} as const;

export const KRATOS_ACCOUNT_LINK_ID_SET: ReadonlySet<number> = new Set(
  Object.values(KRATOS_ACCOUNT_LINK_IDS)
);
