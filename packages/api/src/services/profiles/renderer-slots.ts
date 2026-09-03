/**
 * The renderer `slot` and `scope` vocabularies — ONE constant each, and the
 * only place either is spelled.
 *
 * THE DEFECT THIS FIXES. The backend has had FOUR slots since `entity-card`
 * landed, but the Hub `setRenderer` route and the MCP tool schema each
 * hand-wrote `["list", "detail", "dashboard"]` — three members. `card` was
 * unreachable from every external door: not an error, just a slot no outside
 * caller could name. Same class as the hand-mirrored status enums that let a
 * deployed expiry job expire nothing while the tests pinned the same lie.
 *
 * WHY ITS OWN MODULE, and not an export of `set-profile-renderer.ts`: a wire
 * schema needs the VOCABULARY, not the write path. Keeping it here means a
 * router importing the enum does not pull `@synap/database`, the repositories
 * and the event bus into its import graph — and, concretely, does not break the
 * moment a test mocks the write service (which is exactly what happened when
 * these constants lived next to `setProfileRenderer`). Dependency-free by
 * design, like `@synap-core/types/vocabulary`.
 *
 * Parity between this constant and every wire enum is enforced by
 * `src/__tripwires__/renderer-slot-enum-parity.tripwire.test.ts`.
 */

/** The wire-level slot names external agents use. */
export const RENDERER_SLOTS = ["list", "detail", "card", "dashboard"] as const;
export type RendererSlot = (typeof RENDERER_SLOTS)[number];

/**
 * WHERE a binding is written. `workspace` and `pod` are the two the legacy
 * stores had; `user` is new with `renderer_bindings` and is the personal
 * override — MY renderer for this subject, invisible to everyone else.
 */
export const RENDERER_SCOPES = ["workspace", "pod", "user"] as const;
export type RendererScope = (typeof RENDERER_SCOPES)[number];

/** slot → ContentKind (the canonical taxonomy used by workspace overlays). */
export const SLOT_TO_CONTENT_KIND = {
  list: "collection",
  detail: "entity-detail",
  card: "entity-card",
  dashboard: "entity-profile",
} as const satisfies Record<RendererSlot, string>;

export type RendererContentKind = (typeof SLOT_TO_CONTENT_KIND)[RendererSlot];
