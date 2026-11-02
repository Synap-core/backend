/**
 * Where a grant reaches, in words — the ONE source of the place words every
 * access sentence uses (access model B, founder decision of 2 Nov 2026, plan
 * 2c8fca91 §1). Before it, seven surfaces said the same place four ways
 * ("Anywhere", "Everywhere", "Everywhere in your pod", "Anywhere you can
 * reach").
 *
 * A place is the explicit `Place` the grants parse (`../grants/reach.ts`):
 * the holder's meaning of "no space" (an app's pod-wide read, a key's or an
 * AI's unbounded reach) is decided there, once, so the words here need only
 * the place.
 *
 * Pure + dependency-free (the vocabulary contract).
 */

import type { Place } from "../grants/reach.js";
import { resolveObjectNoun, resolveObjectNounPlural } from "./index.js";

/** Where a pod-wide read applies, after its verb ("reads decisions everywhere in your pod"). */
export const EVERYWHERE_IN_POD = "everywhere in your pod";

/** The same place as a heading, where a space's name would go. */
export const POD_WIDE_HEADING = "Everywhere in your pod";

/** Where an unbounded key or AI reaches, after its verb. */
export const ANYWHERE_YOU_CAN_REACH = "anywhere you can reach";

/** The same place as a heading. */
export const UNBOUNDED_HEADING = "Anywhere you can reach";

function andList(parts: readonly string[]): string {
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : (parts[0] ?? "");
}

/**
 * Spaces by name: "Sales", "Sales and Finance", then a count ("3 spaces").
 * A space whose name the caller does not know reads as the noun ("Space"),
 * never as its raw id.
 */
export function resolveSpacesLabel(
  ids: readonly string[],
  names?: Readonly<Record<string, string>>
): string {
  if (ids.length > 2)
    return `${ids.length} ${resolveObjectNounPlural("workspace").toLowerCase()}`;
  return andList(
    ids.map((id) => names?.[id] ?? resolveObjectNoun("workspace"))
  );
}

/**
 * A place as a heading or a chip: "Everywhere in your pod", "Anywhere you can
 * reach", "Sales and Finance", "3 spaces".
 */
export function resolvePlaceLabel(
  place: Place,
  names?: Readonly<Record<string, string>>
): string {
  switch (place.kind) {
    case "pod":
      return POD_WIDE_HEADING;
    case "unbounded":
      return UNBOUNDED_HEADING;
    case "spaces":
      return resolveSpacesLabel(place.ids, names);
    default:
      return unreachablePlace(place);
  }
}

/**
 * A place after a verb, in a sentence: "everywhere in your pod", "anywhere
 * you can reach", "in Sales and Finance".
 */
export function resolvePlacePhrase(
  place: Place,
  names?: Readonly<Record<string, string>>
): string {
  switch (place.kind) {
    case "pod":
      return EVERYWHERE_IN_POD;
    case "unbounded":
      return ANYWHERE_YOU_CAN_REACH;
    case "spaces":
      return `in ${resolveSpacesLabel(place.ids, names)}`;
    default:
      return unreachablePlace(place);
  }
}

/** A fourth place kind fails to compile here, before it reads as a wrong place. */
function unreachablePlace(place: never): never {
  throw new Error(`Unknown place: ${JSON.stringify(place)}`);
}
