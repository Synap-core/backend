/**
 * The secure-access step's one decision: what its main button says. Pure,
 * so each state is tested.
 *
 * With two ways in the person goes on ("Continue"). With fewer, or while the
 * count is unknown, they may still go on ("Skip for now", founder decision
 * R3 of 4 Oct 2026: skippable, with a persistent mark until done); the top
 * bar's mark keeps asking (`securityNudge`). A failed count is never read as
 * "enough".
 */
import type { WaysIn } from "../../../_lib/presence/ways-in/ways-in-model";

export function accessContinue(state: WaysIn): "continue" | "skip" {
  return state.kind === "ready" && state.enough ? "continue" : "skip";
}
