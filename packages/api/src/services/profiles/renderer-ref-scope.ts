/**
 * WHERE a renderer ref may be persisted — the ONE rule, shared by every door
 * that stores a `RendererRef`. It exists because `profiles.update` once wrote a
 * `source-app` pod default while only `setProfileRenderer` refused it.
 *
 * The rule today is a single arm:
 *   `source-app` ("open where it lives", Places) is a PERSONAL choice about one
 *   profile kind's DETAIL — user × kind (CONNECT-AND-MIRROR-PLAN §W3). It is
 *   refused at workspace / pod scope (it would open other members' records in
 *   an app account that is not theirs, and reach legacy readers that do not
 *   know the kind), on any non-detail slot (a list/card/dashboard has no single
 *   item to send anywhere), and on a capability page (there is no entity to
 *   resolve).
 *
 * Two entries over one predicate, so they can never disagree:
 *   - `rendererRefScopeViolation` — pure, for Zod `superRefine` on wire inputs
 *     (refused BEFORE a proposal is stored, not only at approval);
 *   - `assertRendererRefAllowedForScope` — throws, for the write services (the
 *     proposal executors replay stored payloads through them).
 *
 * Dependency-free like `renderer-slots.ts`, so a router importing it does not
 * pull the write path into its graph.
 */

import { TRPCError } from "@trpc/server";

import type { RendererScope, RendererSlot } from "./renderer-slots.js";

/** Where the ref lands: a profile binding scope, or a capability page. */
export type RendererRefPlacement = RendererScope | "capability";

export function rendererRefScopeViolation(
  ref: { kind?: unknown } | null | undefined,
  placement: RendererRefPlacement,
  slot: RendererSlot | null
): string | null {
  if (!ref || ref.kind !== "source-app") return null;
  if (placement === "user" && slot === "detail") return null;
  return (
    "An 'open in source' renderer is a personal choice for a profile's " +
    "detail: it requires scope 'user' and slot 'detail'."
  );
}

export function assertRendererRefAllowedForScope(
  ref: { kind?: unknown } | null | undefined,
  placement: RendererRefPlacement,
  slot: RendererSlot | null
): void {
  const violation = rendererRefScopeViolation(ref, placement, slot);
  if (violation) {
    throw new TRPCError({ code: "BAD_REQUEST", message: violation });
  }
}
