/**
 * ONE shape for "this governed write became a proposal", on every hub door.
 *
 * The product rule: a proposal is SUCCESS, it carries its review link, and the
 * agent must be able to show that link. Before this module the hub doors
 * disagreed — `POST /playbooks/:id/run` answered 202 `{status, proposalId,
 * reviewUrl}` while `POST /profiles` answered 200 `{status, proposalId}` with no
 * link, and `POST /focus-sessions/:id/complete` answered 403. Every narrow door
 * (Raycast, CLI, the claude.ai connector) then had to special-case each route,
 * and a client keying on 202 or on `reviewUrl` silently mishandled one of them.
 *
 * Two helpers, one rule:
 * - `withReviewUrl` fills `reviewUrl` from `proposalId` when the inner door
 *   dropped it. The URL comes from `openLink` — the SAME `/open/<id>` builder
 *   `checkPermissionOrPropose` uses — never a second hand-concatenated rule.
 * - `isProposedBody` is the one predicate; `jsonGoverned` (rest/_shared.ts)
 *   turns it into the 202.
 *
 * Kept free of any Hono/REST import so the non-REST door modules
 * (`playbook-doors.ts`, `define-profile.ts`) and the MCP handlers that share
 * them can use the same rule without pulling in the HTTP layer.
 */

import type { Context } from "hono";

import { openLink } from "../../utils/deep-links.js";
import type { HubVariables } from "./rest/_shared.js";

/** The HTTP status a hub door answers when a write became a proposal. */
export const PROPOSED_HTTP_STATUS = 202 as const;

/** A response body that reports "this became a proposal". */
export function isProposedBody(
  body: unknown
): body is { status: "proposed"; proposalId: string } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { status?: unknown; proposalId?: unknown };
  return b.status === "proposed" && typeof b.proposalId === "string";
}

/**
 * A `proposed` result carries its review link, whichever door asked.
 *
 * Idempotent: a door whose gate already forwarded `perm.reviewUrl` is returned
 * untouched, so this never overwrites a link the gate computed.
 */
export function withReviewUrl<T>(result: T): T {
  if (!isProposedBody(result)) return result;
  if (typeof (result as { reviewUrl?: unknown }).reviewUrl === "string") {
    return result;
  }
  return {
    ...(result as object),
    reviewUrl: openLink(result.proposalId),
  } as T;
}

/**
 * The ONE hub REST responder for a governed write — a proposal is SUCCESS.
 *
 * Every door that can answer `{ status: "proposed" }` renders it through here,
 * so the wire shape can never fork again: **202** with `proposalId` AND
 * `reviewUrl`. `withReviewUrl` fills the link when the inner door dropped it
 * (the hub tRPC sub-routers forward the gate's `perm.reviewUrl`; the profile,
 * renderer and widget doors did not), and leaves a gate-computed link
 * untouched — there is no second URL rule.
 *
 * The direct (human, auto-approved) branch is unchanged: 200, exactly what
 * every converged route already answered. There is deliberately NO `okStatus`
 * parameter — a widened `200 | 201` return type is rejected by every
 * `app.openapi()` route that declares only {200, 202} (`_status` must be the
 * statuses the route can really answer), and no hub door needed a 201.
 *
 * Lives HERE and not in `rest/_shared.ts` on purpose: `_shared.ts` pulls in
 * `hubProtocolRouter` (and through it the whole database module graph), so a
 * route file that previously only `import type`d from it would gain that graph
 * at runtime just by responding — which broke a route test's `@synap/database`
 * mock the first time this helper lived there. The Hono/`HubVariables` imports
 * above are type-only and erase.
 */
export function jsonGoverned<T>(
  c: Context<{ Variables: HubVariables }>,
  body: T
) {
  const out = withReviewUrl(body);
  return c.json(
    out as T & object,
    isProposedBody(out) ? PROPOSED_HTTP_STATUS : 200
  );
}
