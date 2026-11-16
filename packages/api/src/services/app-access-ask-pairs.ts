/**
 * The pure half of an app's ask for one more thing (`app-access-ask.ts`):
 * resolving the asked pairs within the ceiling. Kept apart so the consent
 * door (`routers/oauth/consent.ts`) reads it without the service's database
 * and proposal imports.
 */

import type { AppAccessAskPair } from "@synap-core/types/grants";
import type { OAuthAppOfferItem } from "./app-connect.js";

/** One pair resolved to a space the person may give it in. */
export interface ResolvedAskPair {
  permission: string;
  workspaceId: string;
  workspaceName: string;
}

const pairKey = (r: { permission: string; workspaceId: string | null }) =>
  `${r.permission}\u0000${r.workspaceId}`;

/**
 * The asked pairs, each resolved within the ceiling: a space id must be on
 * offer for that permission; a template names the offered spaces made from
 * it. `undeclared`: permissions the document does not declare (exactly);
 * `notOnOffer`: pairs whose space the person cannot give it in, or no space
 * made from that template. Pure.
 */
export function resolveAskPairs(
  ceiling: readonly OAuthAppOfferItem[],
  asked: readonly AppAccessAskPair[]
): {
  pairs: ResolvedAskPair[];
  undeclared: string[];
  notOnOffer: AppAccessAskPair[];
} {
  const pairs: ResolvedAskPair[] = [];
  const undeclared: string[] = [];
  const notOnOffer: AppAccessAskPair[] = [];
  const seen = new Set<string>();
  for (const ask of asked) {
    const item = ceiling.find((o) => o.permission === ask.permission);
    if (!item) {
      if (!undeclared.includes(ask.permission)) undeclared.push(ask.permission);
      continue;
    }
    const spaces = item.workspaces.filter((w) =>
      "workspaceId" in ask
        ? w.workspaceId === ask.workspaceId
        : w.templateSlug === ask.template
    );
    if (spaces.length === 0) {
      notOnOffer.push(ask);
      continue;
    }
    for (const w of spaces) {
      const pair = {
        permission: ask.permission,
        workspaceId: w.workspaceId,
        workspaceName: w.workspaceName,
      };
      if (seen.has(pairKey(pair))) continue;
      seen.add(pairKey(pair));
      pairs.push(pair);
    }
  }
  return { pairs, undeclared, notOnOffer };
}
