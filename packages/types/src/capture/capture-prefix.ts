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

/** Is this text an explicit capture prefix (`!text` or `/capture text`)? */
export function isExplicitCapturePrefix(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return trimmed.startsWith("/capture") || trimmed.startsWith("!");
}

/** Strip the explicit capture markers so the seeded/captured text is clean. */
export function stripCapturePrefix(text: string): string {
  return text.replace(/^\/capture\s*/i, "").replace(/^!\s*/, "");
}
