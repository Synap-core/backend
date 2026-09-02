/**
 * The PROJECTION from a probed `ObjectKind` onto the browser's route table.
 *
 * ── WHY THIS IS A SEPARATE THING FROM THE PROBER ─────────────────────────────
 * "Which table holds this id?" is ONE mechanism (`services/diagnose/
 * resolve-object-kind.ts`). "What do you CALL that, to this consumer?" is not:
 * the two callers want different vocabularies for the same row.
 *
 *   • `diagnose` wants EXPLANATORY kinds — `automation_run` and `playbook_run`
 *     are separate because it renders two different run reports; `capability`
 *     covers a verb, a bare skill and a bare tool because it explains all three
 *     the same way.
 *   • `/resolve/:id` wants ROUTABLE labels, because its only consumer is the
 *     CLI, which emits `synap://open/<label>/<id>` for ANY label handed to it
 *     (the CLI's own kind allowlist was deleted — it is no longer a second
 *     table). A label the browser has no `case` for produces a DEAD LINK.
 *
 * So the labels below are not free strings: every one of them MUST exist as an
 * arm of `browser/electron/renderer/src/navigation/object-nav.ts`, the SSOT for
 * where a kind opens. `resolve-browser-route.test.ts` pins that by PARSING that
 * file's `case` labels — the list is never hand-copied here.
 *
 * ── THE THREE HONEST CASES ───────────────────────────────────────────────────
 * 1. A kind whose label is the same word (`entity`, `view`, `proposal`, …).
 * 2. A kind the browser addresses with a DISCRIMINATOR: a run is addressed by
 *    `{flowType, runId}`, so `automation_run`/`playbook_run` both project onto
 *    `run` plus a `flowType` param — exactly what object-nav's `run` arm reads
 *    off `opts.params`.
 * 3. A kind with NO browser door at all (`external_send`: a correlationId-keyed
 *    audit event, no row and no surface). It resolves — we can say what it is —
 *    but it is NOT openable, and saying so is strictly better than minting a
 *    link that lands nowhere.
 */

import type { ObjectKind } from "../../../services/diagnose/types.js";
import type { ResolvedObject } from "../../../services/diagnose/resolve-object-kind.js";

/** A browser-routable address: the `case` label plus any address parameters. */
export interface BrowserRoute {
  /** MUST be a `case` label in `object-nav.ts`. */
  label: string;
  /** Address parameters object-nav reads off `opts.params` (only `run` today). */
  params?: Record<string, string>;
}

/**
 * Kind → route, or `null` for a kind with no browser door.
 *
 * Typed as an EXHAUSTIVE `Record<ObjectKind, …>`: adding an `ObjectKind` fails
 * the typecheck until someone decides, explicitly, whether it is openable.
 * That is the whole guard against a new kind silently becoming a dead link.
 */
const ROUTE_BY_KIND: Record<ObjectKind, BrowserRoute | null> = {
  proposal: { label: "proposal" },
  session: { label: "session" },
  capability: { label: "capability" },
  // A run's id alone does not identify it — object-nav's `run` arm reads
  // `?flowType=` to pick the flow. Defaulting silently to `automation` (which
  // that arm does for a missing param) would send every playbook run to the
  // wrong reader, so the discriminator is emitted, never assumed.
  automation_run: { label: "run", params: { flowType: "automation" } },
  playbook_run: { label: "run", params: { flowType: "playbook" } },
  agent: { label: "agent" },
  view: { label: "view" },
  document: { label: "document" },
  entity: { label: "entity" },
  // NO BROWSER DOOR. Not an oversight: an external send has no row and no
  // surface — object-nav has no arm for it and inventing one here would be a
  // link into nothing.
  external_send: null,
};

/**
 * The `capability` umbrella's three tables, which the browser routes to three
 * DIFFERENT arms. The prober records which one matched (`subKind`) rather than
 * making this module re-probe to find out.
 */
const ROUTE_BY_SUBKIND: Record<
  NonNullable<ResolvedObject["subKind"]>,
  BrowserRoute
> = {
  capability: { label: "capability" },
  skill: { label: "skill" },
  tool: { label: "tool" },
};

/**
 * Every label this module can ever emit — derived from both tables above, so it
 * cannot drift from them. The parity test asserts this set is a SUBSET of
 * object-nav's `case` labels.
 */
export const EMITTABLE_LABELS: readonly string[] = [
  ...new Set([
    ...Object.values(ROUTE_BY_KIND)
      .filter((r): r is BrowserRoute => r !== null)
      .map((r) => r.label),
    ...Object.values(ROUTE_BY_SUBKIND).map((r) => r.label),
  ]),
].sort();

/** Kinds that resolve but have no browser door — reported, never linked. */
export const UNOPENABLE_KINDS: readonly ObjectKind[] = (
  Object.keys(ROUTE_BY_KIND) as ObjectKind[]
).filter((k) => ROUTE_BY_KIND[k] === null);

/**
 * Project a probed object onto a browser address. `null` means "we know what
 * this is, and it has nowhere to open".
 */
export function browserRouteFor(
  resolved: Pick<ResolvedObject, "kind" | "subKind">
): BrowserRoute | null {
  if (resolved.subKind) return ROUTE_BY_SUBKIND[resolved.subKind];
  return ROUTE_BY_KIND[resolved.kind];
}
