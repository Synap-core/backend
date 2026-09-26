/**
 * THE SHARE STATE OF A RECORD — one derivation, every surface (Sites W5a).
 *
 * "Who can see this?" answered as a MARK: a tone token + a glyph, never a
 * colour and never a sentence (ui-composition §1). The sibling of
 * `resolveUnitState` (./state.ts) and deliberately on the same palette: it
 * reuses `UnitTone` and `UnitGlyph`, so the web (`UnitMark`) and relay
 * (`UnitState`) glyph maps — both `Record<UnitGlyph, …>`, compile-floored —
 * render it with no second map. The label is `resolveStatusLabel(state)`.
 *
 * COLOUR SAYS "EXPOSED", THE GLYPH SAYS TO WHOM. Every live exposure is `info`
 * (it is a fact about reach, not your turn — `primary` — and not AI work —
 * `ai`, which is provenance only); `users` / `link` / `globe` tell guests, a
 * link and the public web apart. Private is the quiet default.
 *
 * ORDER IS THE RULE:
 *   1. `revoked` / `expired` describe the ROW being rendered (a link, a
 *      publication) and outrank everything: a dead link is dead however open
 *      the record is. Revoked outranks expired (permanent beats lapsed).
 *   2. Then the WIDEST live exposure wins: public > link > shared.
 *   3. `unmeasured` sits BELOW every positive answer and ABOVE `private`: an
 *      unreadable count removes only the calm claim "nobody else can see
 *      this", never a live one. "I could not find out" is not "private" — a
 *      failed read rendered as a lock is the calm-confident-wrong defect.
 */
import type { UnitGlyph, UnitTone } from "./state.js";

export const SHARE_STATES = [
  "private",
  "shared",
  "link",
  "public",
  "expired",
  "revoked",
  "unmeasured",
] as const;
export type ShareState = (typeof SHARE_STATES)[number];

export interface ShareStateView {
  state: ShareState;
  tone: UnitTone;
  glyph: UnitGlyph;
}

export interface ShareStateInput {
  /** The row being rendered was revoked (permanent, 0276). */
  revoked?: boolean;
  /** The row being rendered is past its `expires_at`. */
  expired?: boolean;
  /** A live (not revoked, not expired) publication in state `published`. */
  published?: boolean | null;
  /** Live link rows. `null` = the read FAILED (not zero). */
  liveLinks?: number | null;
  /** Projects whose guests can see it. `null` = the read FAILED (not zero). */
  guestProjects?: number | null;
}

const VIEWS: Record<ShareState, ShareStateView> = {
  revoked: { state: "revoked", tone: "error", glyph: "alert" },
  expired: { state: "expired", tone: "textSecondary", glyph: "clock" },
  public: { state: "public", tone: "info", glyph: "globe" },
  link: { state: "link", tone: "info", glyph: "link" },
  shared: { state: "shared", tone: "info", glyph: "users" },
  unmeasured: { state: "unmeasured", tone: "textSecondary", glyph: "question" },
  private: { state: "private", tone: "textMuted", glyph: "lock" },
};

export function resolveShareState(input: ShareStateInput): ShareStateView {
  if (input.revoked) return VIEWS.revoked;
  if (input.expired) return VIEWS.expired;
  if (input.published) return VIEWS.public;
  if ((input.liveLinks ?? 0) > 0) return VIEWS.link;
  if ((input.guestProjects ?? 0) > 0) return VIEWS.shared;
  if (
    input.published === null ||
    input.liveLinks === null ||
    input.guestProjects === null
  ) {
    return VIEWS.unmeasured;
  }
  return VIEWS.private;
}
