/**
 * A THING's status strips — the ONE rule for which lifecycles a thing page
 * draws, and where each one stands (work model L8 §1, W18). Browser
 * (`ThingStatusStrips`) and relay (`ThingStatusSection`) both read it; each
 * host keeps only its rendering.
 *
 *   - its KIND's lifecycle first (when the host shows it), current status =
 *     the entity's `status` COLUMN (W18: the column is the store), else the
 *     projection `properties[property]` for a row the column does not hold yet;
 *   - then one per attached ROLE with a lifecycle, current status = the
 *     facet's `status`, in the order given.
 *
 * Reads keep their three facts apart (CLAUDE.md "an EMPTY result and a FAILED
 * read are different facts"): a profile with NO lifecycle, or one declaring no
 * options, draws no strip (OMIT); a FAILED read draws a failed strip (the host
 * puts its retry on it); a read in flight draws nothing yet.
 */
import { resolveObjectNoun, resolveStatusLabel } from "../vocabulary/index.js";
import type { LifecycleOption } from "./index.js";
import type { MoveStatusSubject } from "./move.js";
import { stepsFromLifecycle, type StepMark } from "./steps.js";

/** A declared lifecycle as a surface holds it (`lifecycle.get`'s answer fits). */
export interface ThingLifecycle {
  property: string;
  options: ReadonlyArray<LifecycleOption>;
}

/** One profile's lifecycle read, its facts kept apart. Extra fields (a retry) ride along. */
export type ThingLifecycleRead<L extends ThingLifecycle = ThingLifecycle> =
  | { status: "loading" }
  | { status: "undeclared" }
  | { status: "failed" }
  | { status: "ok"; lifecycle: L };

/** An attached role as the strips read it. */
export interface ThingStatusRole {
  slug: string;
  /** The facet id — a role move's subject. Null: no move can be addressed. */
  facetId: string | null;
  /** The role's name; absent ⇒ the vocabulary's noun for the slug. */
  label?: string | null;
  /** The facet's `status` column. */
  status: string | null;
}

export type ThingStatusStrip<L extends ThingLifecycle = ThingLifecycle> =
  | {
      key: string;
      /** The profile whose lifecycle this is (the read's key, the glance door). */
      slug: string;
      of: "kind" | "role";
      /** What the strip is OF: the kind's noun, or the role's name. */
      label: string;
      state: "ready";
      lifecycle: L;
      steps: StepMark[];
      /** The status SHOWN — the mover's compare-and-set `from`. */
      from: string | null;
      /** Null when no move can be addressed (a role without its facet id). */
      subject: MoveStatusSubject | null;
      /** An option key → its words (an undeclared key → the vocabulary). */
      labelOf: (key: string) => string;
    }
  | {
      key: string;
      slug: string;
      of: "kind" | "role";
      label: string;
      state: "failed";
    };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Where a thing stands on its KIND's lifecycle: the `status` column (W18),
 * else the projection `properties[property]`. Null = no status yet.
 */
export function kindCurrentStatus(
  entityStatus: unknown,
  properties: Readonly<Record<string, unknown>> | null | undefined,
  property: string
): string | null {
  return str(entityStatus) ?? str(properties?.[property]);
}

/** The strips a thing page draws, kind first, then each role's. `reads` is keyed by profile slug. */
export function thingStatusStrips<L extends ThingLifecycle>(input: {
  entityId: string;
  profileSlug: string;
  /** The entity's `status` column. */
  status?: unknown;
  properties?: Readonly<Record<string, unknown>> | null;
  roles: readonly ThingStatusRole[];
  reads: Readonly<Record<string, ThingLifecycleRead<L> | undefined>>;
  /** Draw the kind's own strip (a host whose header already draws it passes false). Default true. */
  showKind?: boolean;
}): ThingStatusStrip<L>[] {
  const strips: ThingStatusStrip<L>[] = [];
  const push = (
    key: string,
    slug: string,
    of: "kind" | "role",
    label: string,
    from: (lifecycle: L) => string | null,
    subject: (lifecycle: L) => MoveStatusSubject | null
  ) => {
    const read = input.reads[slug];
    if (read?.status === "failed") {
      strips.push({ key, slug, of, label, state: "failed" });
      return;
    }
    if (read?.status !== "ok" || read.lifecycle.options.length === 0) return;
    const { lifecycle } = read;
    const current = from(lifecycle);
    const byKey = new Map(
      lifecycle.options.map((o) => [
        o.key,
        o.label?.trim() || resolveStatusLabel(o.key),
      ])
    );
    strips.push({
      key,
      slug,
      of,
      label,
      state: "ready",
      lifecycle,
      steps: stepsFromLifecycle(lifecycle, current),
      from: current,
      subject: subject(lifecycle),
      labelOf: (k) => byKey.get(k) ?? resolveStatusLabel(k),
    });
  };
  if (input.showKind !== false) {
    push(
      `kind:${input.profileSlug}`,
      input.profileSlug,
      "kind",
      resolveObjectNoun(input.profileSlug),
      (l) => kindCurrentStatus(input.status, input.properties, l.property),
      (l) => ({ kind: "kind", entityId: input.entityId, property: l.property })
    );
  }
  for (const role of input.roles) {
    push(
      `role:${role.facetId ?? role.slug}`,
      role.slug,
      "role",
      role.label?.trim() || resolveObjectNoun(role.slug),
      () => str(role.status),
      () =>
        role.facetId
          ? { kind: "role", entityId: input.entityId, facetId: role.facetId }
          : null
    );
  }
  return strips;
}
