/**
 * Renderer TARGETS — the ONE vocabulary of "what a renderer can be bound to".
 *
 * A renderer binding says: for this target, in this slot, show this cell. Four
 * kinds of target carry one today, and every door reads this table instead of
 * spelling its own list:
 *
 *   - `profile`    — a whole entity KIND (every task, every deal). The slot is
 *                    one of the four entity slots. Whole-kind only (decision
 *                    2026-09-07, `renderer-bindings.ts`).
 *   - `capability` — ONE capability's page. Stored as the capability's ordered
 *                    page-set (`capabilities.metadata.renderers` or the
 *                    workspace overlay), the store the desktop's capability
 *                    page already reads.
 *   - `playbook`   — ONE playbook's detail page.
 *   - `view`       — ONE view's detail page.
 *
 * `playbook` and `view` live in `renderer_bindings` as per-OBJECT rows
 * (`subject_kind` = the kind, `subject_id` = the object). The whole-kind rule
 * was decided for ENTITY kinds, where prior art stops layout assignment at the
 * class; a playbook or a view is itself a definition, and its own page is what
 * a person asks a custom UI for (founder, 2026-11-09: "a custom renderer for
 * the detail page of anything: an entity, a capability, a view, a playbook").
 * A capability renderer was per-object from the start; these two follow it.
 *
 * Dependency-free on purpose (like `renderer-slots.ts`): a wire schema and a
 * tripwire need the vocabulary, not the write path.
 *
 * Every target kind names the openable kind it resolves as (`openAs`, a kind
 * of `resolveObjectKind`'s probe list) and the store that holds its binding.
 * `renderer-targets-have-a-resolver.tripwire.test.ts` fails when a target kind
 * is not openable, or its store has no reader.
 */

import {
  RENDERER_SCOPES,
  RENDERER_SLOTS,
  type RendererScope,
  type RendererSlot,
} from "../profiles/renderer-slots.js";

/** Where a target's binding is stored, and therefore which reader answers it. */
export type RendererStore = "renderer_bindings" | "capability_pages";

export interface RendererTargetDef {
  /** `kind` = the binding covers a whole kind (named by slug); `object` = one object (named by id). */
  subject: "kind" | "object";
  store: RendererStore;
  /** The kind `resolveObjectKind` reports for this target's object. */
  openAs: "entity" | "capability" | "playbook" | "view";
  /** The slots this target has. A slot outside this list is refused. */
  slots: readonly RendererSlot[];
  /** The scopes this target's store can hold. */
  scopes: readonly RendererScope[];
}

export const RENDERER_TARGETS = {
  profile: {
    subject: "kind",
    store: "renderer_bindings",
    openAs: "entity",
    slots: RENDERER_SLOTS,
    scopes: RENDERER_SCOPES,
  },
  // A capability page-set has no personal layer: `workspace` is the overlay,
  // `pod` is the capability's own default (seen in every space). The desktop
  // shows the `dashboard` page first, then the first page.
  capability: {
    subject: "object",
    store: "capability_pages",
    openAs: "capability",
    slots: ["detail", "dashboard"],
    scopes: ["workspace", "pod"],
  },
  playbook: {
    subject: "object",
    store: "renderer_bindings",
    openAs: "playbook",
    slots: ["detail"],
    scopes: RENDERER_SCOPES,
  },
  view: {
    subject: "object",
    store: "renderer_bindings",
    openAs: "view",
    slots: ["detail"],
    scopes: RENDERER_SCOPES,
  },
} as const satisfies Record<string, RendererTargetDef>;

export type RendererTargetKind = keyof typeof RENDERER_TARGETS;

export const RENDERER_TARGET_KINDS = Object.keys(
  RENDERER_TARGETS
) as RendererTargetKind[];

/** A target as the doors receive it: a kind by slug, or one object by id. */
export type RendererTarget =
  | { kind: "profile"; slug: string }
  | { kind: Exclude<RendererTargetKind, "profile">; id: string };

export function isRendererTargetKind(kind: string): kind is RendererTargetKind {
  return Object.hasOwn(RENDERER_TARGETS, kind);
}

/**
 * True when `subjectKind` is a target whose binding is ONE object's row in
 * `renderer_bindings` (`playbook`, `view`). The write door admits a
 * `subjectId` for exactly these kinds and refuses it for every other.
 */
export function isPerObjectBindingKind(subjectKind: string): boolean {
  if (!isRendererTargetKind(subjectKind)) return false;
  const def: RendererTargetDef = RENDERER_TARGETS[subjectKind];
  return def.subject === "object" && def.store === "renderer_bindings";
}

/**
 * Why `slot` / `scope` cannot be bound on `kind`, or null when they can. One
 * sentence that names what IS allowed, so an agent can retry right.
 */
export function rendererTargetProblem(
  kind: RendererTargetKind,
  slot: string,
  scope: string
): string | null {
  const def: RendererTargetDef = RENDERER_TARGETS[kind];
  if (!(def.slots as readonly string[]).includes(slot)) {
    return `A ${kind} has no '${slot}' renderer slot. Its slots: ${def.slots.join(", ")}.`;
  }
  if (!(def.scopes as readonly string[]).includes(scope)) {
    return `A ${kind} renderer cannot be bound at scope '${scope}'. Its scopes: ${def.scopes.join(", ")}.`;
  }
  return null;
}

/**
 * Read a door's target from its arguments: `target: {kind, id | slug}`, or the
 * older `profileSlug` (a kind's records). Returns the target, or one sentence
 * saying what to pass instead.
 */
export function readRendererTarget(
  args: Record<string, unknown>
): RendererTarget | string {
  const raw = args.target as Record<string, unknown> | undefined;
  const profileSlug =
    typeof args.profileSlug === "string" && args.profileSlug.trim()
      ? args.profileSlug.trim()
      : null;
  if (raw === undefined || raw === null) {
    return profileSlug
      ? { kind: "profile", slug: profileSlug }
      : "Name what the renderer is for: target {kind, id} (a capability, playbook or view) or profileSlug (a kind's records).";
  }
  if (profileSlug) {
    return "Pass target or profileSlug, not both.";
  }
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  if (!isRendererTargetKind(kind)) {
    return `target.kind must be one of: ${RENDERER_TARGET_KINDS.join(", ")}.`;
  }
  if (kind === "profile") {
    const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
    return slug
      ? { kind, slug }
      : "target {kind:'profile'} needs slug (the profile slug).";
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  return id
    ? { kind, id }
    : `target {kind:'${kind}'} needs id (the ${kind} id).`;
}
