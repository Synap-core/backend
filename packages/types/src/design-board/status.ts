/**
 * Whether the canvas edits a design, derived from the `ui-design` kind's
 * DECLARED lifecycle (Hub `GET /api/hub/lifecycle`, the `lifecycle.get` door;
 * declared in the catalog's builder.yaml, property `design-status`), never
 * from a hand list of statuses. Pure.
 *
 * The rule (founder, 2026-11-18): a design is edited while it is being worked
 * on, before the review approves it. Past that, it opens read-only and
 * changes only through a revision: a NEW design in the lifecycle's initial
 * state (the canvas's `reviseBoard`, and the pod's design door, which writes
 * any change to a design past its review as such a revision).
 *
 * Moved from app-bases `apps/ui-gallery/src/design/designStatus.ts`: the canvas
 * and the pod read this ONE rule.
 *
 * Where "past review" comes from: the categories alone cannot say it
 * (`in-review` and `approved` are both `active`). The declaration marks the
 * review's verdict as a person's call: the first option in declared order
 * that is `humanOnly` and not terminal (on ui-design, `approved`). A status at
 * or after that option is past review. A terminal status (category done or
 * lost) is closed, whatever the order says.
 */
import {
  LIFECYCLE_CATEGORIES,
  isTerminalLifecycleCategory,
  type LifecycleCategory,
} from "../lifecycle/index.js";

export interface DesignLifecycleOption {
  key: string;
  /** The pod's label for people (resolved by the pod). */
  label: string;
  category: LifecycleCategory;
  humanOnly: boolean;
}

export interface DesignLifecycle {
  /** The status field's key (`design-status`). */
  property: string;
  /** In declared order. */
  options: DesignLifecycleOption[];
  /** The option a new design starts in when its creator names none; null = the pod declares none. */
  initialStatus: string | null;
}

export type Editability =
  /**
   * new         not in the pod yet (no lifecycle read)
   * unset       no status
   * undeclared  a status the lifecycle does not declare: nothing says it is past review
   * working     before the review's verdict
   */
  | { editable: true; reason: "new" | "unset" | "undeclared" | "working" }
  /**
   * past-review  at or after the review's verdict
   * closed       a terminal status (done or lost)
   */
  | {
      editable: false;
      reason: "past-review" | "closed";
      option: DesignLifecycleOption;
    };

/** The review's verdict: the first non-terminal person-only option, or null when the lifecycle declares none. */
export function reviewGate(
  lifecycle: DesignLifecycle
): DesignLifecycleOption | null {
  return (
    lifecycle.options.find(
      (o) => o.humanOnly && !isTerminalLifecycleCategory(o.category)
    ) ?? null
  );
}

export function designEditability(
  status: string | undefined,
  lifecycle: DesignLifecycle | null
): Editability {
  if (!lifecycle) return { editable: true, reason: "new" };
  if (!status) return { editable: true, reason: "unset" };
  const at = lifecycle.options.findIndex((o) => o.key === status);
  if (at < 0) return { editable: true, reason: "undeclared" };
  const option = lifecycle.options[at]!;
  const gate = reviewGate(lifecycle);
  if (gate && at >= lifecycle.options.indexOf(gate))
    return { editable: false, reason: "past-review", option };
  if (isTerminalLifecycleCategory(option.category))
    return { editable: false, reason: "closed", option };
  return { editable: true, reason: "working" };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Read the pod's answer to `GET /lifecycle`. An answer that is not a
 * lifecycle THROWS: editability is never decided on an unreadable one.
 */
export function readDesignLifecycle(raw: unknown): DesignLifecycle {
  if (
    !isObj(raw) ||
    !Array.isArray(raw.options) ||
    typeof raw.property !== "string"
  )
    throw new Error(
      "The pod answered the design lifecycle with something that is not a lifecycle."
    );
  const options = raw.options.map((o): DesignLifecycleOption => {
    if (
      !isObj(o) ||
      typeof o.key !== "string" ||
      !(LIFECYCLE_CATEGORIES as readonly unknown[]).includes(o.category)
    )
      throw new Error(
        "The pod answered the design lifecycle with an option that has no key or no known category."
      );
    return {
      key: o.key,
      label:
        typeof o.label === "string" && o.label.trim() !== "" ? o.label : o.key,
      category: o.category as LifecycleCategory,
      humanOnly: o.humanOnly === true,
    };
  });
  return {
    property: raw.property,
    options,
    initialStatus:
      typeof raw.initialStatus === "string" && raw.initialStatus !== ""
        ? raw.initialStatus
        : null,
  };
}
