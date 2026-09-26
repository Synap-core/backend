/**
 * Capture-prefix grammar — the ONE rule for `!text` / `/capture text`.
 *
 * Both omni inputs that offer an explicit "capture this" escape hatch — relay's
 * (`relay-app/src/lib/input-routing.ts`) and the desktop Home input
 * (`browser/.../components/home/home-input-model.ts`) — used to carry a
 * byte-for-byte MIRRORED copy of this detect+strip pair, policed by a
 * cross-repo tripwire. The rule itself has nothing relay- or browser-specific
 * about it, so it lives here once; each consumer imports it instead of
 * re-declaring it.
 *
 * Deliberately narrow: this is ONLY the prefix detect + strip. Relay's
 * `detectInputMode` additionally offers a local Ask-AI wording hint
 * (question-word / `?` heuristics) that the desktop Home input does NOT
 * adopt (Home's Enter never reads the wording) — that hint stays local to
 * relay, not shared.
 *
 * Pure, dependency-free: safe in browser, Electron, React Native, Node, CLI.
 */

/**
 * The ONE token rule both functions below read. A capture marker is, after
 * optional leading whitespace, EITHER:
 *   - `/capture` as a WHOLE word — followed by whitespace or the end of the
 *     text — case-insensitively (`/Capture x` is a capture; `/captured notes`
 *     and `/capturefoo` are NOT: they are other words that happen to share a
 *     prefix), OR
 *   - a single leading `!` (`!x` and `! x` both; `x!` is not — the bang must
 *     lead).
 * Group 1 is the whole marker plus the whitespace after it, so detect and
 * strip can never disagree about where the marker ends. (They used to: detect
 * was a case-SENSITIVE `startsWith("/capture")`, strip a case-INSENSITIVE
 * regex, so "/captured notes" was detected AND stripped to "d notes", while
 * "/Capture x" was stripped but never detected.)
 */
const CAPTURE_MARKER = /^\s*(?:\/capture(?=\s|$)|!)\s*/i;

/**
 * Is this text an explicit capture (`!text` or `/capture text`)?
 *
 * A marker with NOTHING after it is not a capture yet: bare `!` and bare
 * `/capture` (with or without trailing spaces) answer `false`. That keeps the
 * original intent of the old `length < 2` guard — "a lone `!` is not a
 * capture" — and applies it evenly to both markers, so a half-typed
 * `/capture` does not pin an input to Capture with an empty body to submit.
 */
export function isExplicitCapturePrefix(text: string): boolean {
  const m = CAPTURE_MARKER.exec(text);
  return m !== null && text.slice(m[0].length).trim().length > 0;
}

/**
 * Strip ONE leading capture marker (same token rule as the detector) so the
 * seeded/captured text is clean. Text without a marker is returned unchanged.
 */
export function stripCapturePrefix(text: string): string {
  return text.replace(CAPTURE_MARKER, "");
}
