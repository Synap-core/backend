/**
 * THE ONE RULE for "does this provider serve this need" (plan U5, addendum
 * 000e75ff §3 "Matching is declarative", §5). Used for an INSTALLED provider
 * (`resolve-need.ts`) and for a CATALOG entry (`selectIntentProviders`), so the
 * install wizard, the gap proposer and `synap_find` cannot disagree.
 *
 * A need's constraint is met when the provider's `offers` entry for the intent
 * includes it. No provider name appears anywhere here.
 *
 * PURE: no I/O.
 */
import {
  missingIntentOps,
  type IntentContract,
} from "@synap-core/types/capability-intents";
import type {
  ManifestNeed,
  ManifestOffer,
} from "@synap-core/types/capability-manifest";

/**
 * Need constraints that are INPUTS to the provider, not filters on it: the
 * port to expose, the hostname to prefer. They reach `create`; they never
 * exclude a provider.
 */
const INPUT_CONSTRAINTS: ReadonlySet<string> = new Set(["port"]);

/**
 * Constraints a provider must SAY it meets: an offer that is silent on them is
 * a misfit, never a silent fit. `auth` is the one that decides who can reach a
 * thing, so silence there is never read as "any".
 */
const MUST_DECLARE: ReadonlySet<string> = new Set(["auth"]);

/** A constraint value read as the set of values it accepts. */
function acceptedValues(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.anyOf)) return v.anyOf;
    if (typeof v.kind === "string") return [v.kind];
    // `{ prefer }` and other shapes are wishes, not filters.
    return null;
  }
  return [value];
}

/** An offer value read as the set of values it supports. */
function offeredValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return typeof v.kind === "string" ? [v.kind] : [];
  }
  return [value];
}

const words = (values: readonly unknown[]): string =>
  values.map((v) => String(v)).join(", ");

/**
 * Why `offer` does not meet `need`'s constraints, or null when it does. One
 * reason, in words the consent screen can show ("offers public access only").
 */
export function offerMisfit(
  need: Pick<ManifestNeed, "intent" | "constraints">,
  offer: ManifestOffer | undefined
): string | null {
  if (!offer) return `it declares no offer for ${need.intent}`;
  const constraints = need.constraints ?? {};
  for (const key of [...MUST_DECLARE]) {
    if (key in constraints && !(key in offer)) {
      return `it does not say which ${key} it enforces`;
    }
  }
  for (const [key, wanted] of Object.entries(constraints)) {
    if (INPUT_CONSTRAINTS.has(key)) continue;
    const accepted = acceptedValues(wanted);
    if (accepted === null) continue;
    if (!(key in offer)) continue;
    const offered = offeredValues((offer as Record<string, unknown>)[key]);
    if (!accepted.some((a) => offered.includes(a))) {
      return `it offers ${key} ${words(offered) || "none"} only, and the need allows ${words(accepted)}`;
    }
  }
  return null;
}

/**
 * Why a provider's verbs do not cover the intent's required ops, or null when
 * they do ("it cannot revoke"). A provider with no contract to meet (a
 * one-shot intent) is never refused here.
 */
export function opsMisfit(
  contract: IntentContract | null | undefined,
  implemented: Iterable<string>
): string | null {
  if (!contract) return null;
  const missing = missingIntentOps(contract, implemented);
  return missing.length > 0
    ? `it cannot ${missing.join(", ")} (the contract requires it)`
    : null;
}
