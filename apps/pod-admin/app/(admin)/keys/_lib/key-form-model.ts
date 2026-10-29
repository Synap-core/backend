/**
 * pod-admin's half of the ONE key page (keys plan §3, Decision 1): who holds
 * the key (so which mint door it goes through), what that door is sent, where
 * the person lands after, and what a CLI request lets the reviewer change.
 *
 * Every rule about the KEY itself — the four steps, where it acts and who
 * holds it, the templates that work there, the families and their levels,
 * uses → scopes, the sentence, the marks, validation, the wire shape — is the
 * shared model in `@synap-core/types/grants` (`key-draft.ts`, `key-steps.ts`,
 * `access-levels.ts`). This file only picks the door. Pure, so it is tested
 * without a browser.
 */

import {
  KEY_LIFETIME_CHOICES,
  KEY_TEMPLATES,
  grantLifetime,
  scopeWithin,
  setFamilyLevel,
  setFamilyPart,
  toKeyMintInput,
  type AccessFamily,
  type AccessLevel,
  type FamilyPartsContext,
  type GrantDraft,
  type GrantRole,
  type KeyCeiling,
  type KeyDraft,
  type KeyHolder,
  type KeyMintInput,
} from "@synap-core/types/grants";
import { keyPageHref, navHref } from "../../../../lib/console-nav";

/** Who holds the key (so which mint door): the shared model's `KeyHolder`. */
export type { KeyHolder } from "@synap-core/types/grants";

export interface KeyPageParams {
  /** `?template=<id>`: the template the page opens on. */
  readonly templateId: string | null;
  /** `?space=<id>`: the space the key is made for (its grant is pinned). */
  readonly workspaceId: string | null;
  readonly holder: KeyHolder;
  /** `?name=`: a name the door already knows (Add connection's service name). */
  readonly name: string | null;
}

/** The page's parameters, read from its URL. A holder that does not fit the space falls back to the person. */
export function keyPageParams(
  get: (key: string) => string | null
): KeyPageParams {
  const workspaceId = get("space")?.trim() || null;
  const asked = get("holder");
  const holder: KeyHolder =
    asked === "system" && !workspaceId
      ? "system"
      : asked === "service" && workspaceId
        ? "service"
        : "person";
  return {
    templateId: get("template")?.trim() || null,
    workspaceId,
    holder,
    name: get("name")?.trim() || null,
  };
}

/** The door to the page, for "New key" buttons (Keys, a space's keys, Add connection). */
export function newKeyHref(
  params: Partial<{
    template: string;
    space: string;
    holder: KeyHolder;
    name: string;
  }> = {}
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v && !(k === "holder" && v === "person")) q.set(k, v);
  const query = q.toString();
  return query ? `/keys/new?${query}` : "/keys/new";
}

/** The templates the page offers: the built-ins, then the person's stored roles. */
export function keyTemplates(stored: readonly GrantRole[]): GrantRole[] {
  return [...KEY_TEMPLATES, ...stored.map((r) => ({ ...r, stored: true }))];
}

/** One mint call: the door and its input, from the draft. */
export type KeyMintCall =
  | { readonly door: "create"; readonly input: PersonKeyInput }
  | { readonly door: "createSystemKey"; readonly input: ServiceKeyInput }
  | {
      readonly door: "adminCreateServiceKey";
      readonly input: ServiceKeyInput & { workspaceId: string };
    };

interface ServiceKeyInput {
  keyName: string;
  uses: KeyMintInput["uses"];
  grant: KeyMintInput["grant"];
  /** Omitted = 90 days; null = never (D-4: "Never" is sent as null). */
  expiresInDays?: number | null;
  note?: string;
}

interface PersonKeyInput extends ServiceKeyInput {
  templateId?: string;
  workspaceId?: string;
}

/** The call that mints this draft for this holder. Scopes are never sent: the door derives them from `uses`. */
export function keyMintCall(
  holder: KeyHolder,
  draft: KeyDraft,
  workspaceId: string | null
): KeyMintCall {
  const m = toKeyMintInput(draft);
  const base: ServiceKeyInput = {
    keyName: m.name,
    uses: m.uses,
    grant: m.grant,
    ...(m.expiresInDays !== undefined
      ? { expiresInDays: m.expiresInDays }
      : {}),
    ...(m.note ? { note: m.note } : {}),
  };
  if (holder === "system") return { door: "createSystemKey", input: base };
  if (holder === "service" && workspaceId)
    return {
      door: "adminCreateServiceKey",
      input: { ...base, workspaceId },
    };
  return {
    door: "create",
    input: {
      ...base,
      ...(m.templateId ? { templateId: m.templateId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    },
  };
}

/** The keys list the page came from: a space's keys tab, or Keys. */
export function keysListHref(workspaceId: string | null): string {
  return workspaceId
    ? `${navHref("spaces")}/${encodeURIComponent(workspaceId)}?tab=api-keys`
    : navHref("keys");
}

/**
 * Where the person lands after the key is shown once: the key's own page,
 * never the list (finding d99517f7).
 */
export function afterCreateHref(keyId: string): string {
  return keyPageHref(keyId);
}

// ── a CLI's request: narrow, never widen ──────────────────────────────────

/**
 * Under a request's ceiling, a family may be set to a level only when the
 * result stays within what was asked; the reviewer can always lower it.
 * (`validateKeyDraft` with the ceiling refuses the rest anyway; this keeps
 * the page from offering it.)
 */
export function levelAllowed(
  ceiling: KeyCeiling | undefined,
  grant: GrantDraft,
  family: AccessFamily,
  level: AccessLevel
): boolean {
  return (
    !ceiling || scopeWithin(setFamilyLevel(grant, family, level), ceiling.grant)
  );
}

/** The same for leaving one part of a family in ("Only some…"). */
export function partAllowed(
  ceiling: KeyCeiling | undefined,
  grant: GrantDraft,
  family: AccessFamily,
  partId: string,
  ctx: FamilyPartsContext
): boolean {
  return (
    !ceiling ||
    scopeWithin(setFamilyPart(grant, family, partId, true, ctx), ceiling.grant)
  );
}

/** Under a request's ceiling, a door may be ticked only when the request names it. */
export function keyUseAllowed(
  ceiling: KeyCeiling | undefined,
  use: string
): boolean {
  return !ceiling || ceiling.uses.includes(use);
}

/** The lifetime choices (days, then "never"), capped by a ceiling's own lifetime. */
export function lifetimeChoices(
  ceiling: KeyCeiling | undefined
): readonly (number | null)[] {
  const all: (number | null)[] = [...KEY_LIFETIME_CHOICES, null];
  if (!ceiling) return all;
  const cap = grantLifetime(ceiling.grant);
  if (cap.kind === "never") return all;
  const within = all.filter((d): d is number => d !== null && d <= cap.days);
  return within.includes(cap.days) ? within : [...within, cap.days];
}

/** "1 day", "30 days", "1 year", "Never". */
export function lifetimeLabel(days: number | null): string {
  if (days === null) return "Never";
  if (days === 1) return "1 day";
  if (days === 365) return "1 year";
  return `${days} days`;
}

/** A request's state, as the Review page says it once it is no longer open. */
export type KeyRequestState =
  "pending" | "approved" | "denied" | "consumed" | "expired";

/**
 * A closed request's status token, for the vocabulary's words: a key the
 * computer collected was approved first, so it reads "Approved".
 */
export function keyRequestStatus(
  state: KeyRequestState
): Exclude<KeyRequestState, "consumed"> {
  return state === "consumed" ? "approved" : state;
}

/** One sentence beside a closed request's status (copy), naming who asked. */
export function keyRequestOutcome(
  state: Exclude<KeyRequestState, "pending">,
  requester: string
): string {
  switch (state) {
    case "approved":
      return `${requester} collects it once, the next time it checks. You can revoke it from your keys.`;
    case "consumed":
      return `${requester} collected the key. Revoke it from your keys when it is no longer needed.`;
    case "denied":
      return `No key was made, and the command ${requester} ran stops.`;
    case "expired":
      return "No key was made. Run the command again to ask for a new one.";
  }
}
