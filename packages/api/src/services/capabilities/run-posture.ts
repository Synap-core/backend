/**
 * Run posture — the ONE meaning of `governance` on every capability door (the
 * flat registry `GET /capabilities` + tRPC `capabilityRegistry.list`, the MCP
 * `synap_list_capabilities` sections, `GET /capabilities/actions`, the pack
 * catalog card): what an AGENT's run meets at the gate once the capability is
 * enabled.
 *   - `auto`    — runs now;
 *   - `propose` — files a review;
 *   - `none`    — (rows only) nothing here runs through the execute door.
 *
 * It is NOT the enable/approval gate. That is a separate fact (`enabled`): an
 * unapproved row is refused by the gate's approval step before any of this, for
 * every caller. Reading approval as `governance` is how every action on the
 * actions door came to be labeled `auto`, entity.delete and messaging.send
 * included.
 *
 * Transcribed from `gateCapabilityExecution` (capability-gate) + the policy's
 * capability rung 2.7 (governance-policy), for an agent caller (owner runs
 * owner-bypass and always run):
 *   1. a BUILTIN verb in `READ_ONLY_BUILTIN_VERBS` → `auto`: `execute-capability`
 *      marks it `readOnly`, and the gate returns `run` before any grant rung;
 *   2. anything else runs now only under an ACTIVE grant whose exec mode is
 *      `auto` (rung 2.7 executes an `auto` mode outright) — a write included,
 *      because the gate runs it. No grant → the no-grant rung proposes; a
 *      `propose` grant proposes; a `dry-run` grant never "runs now". An unknown
 *      grant (skill-only rows and commands carry no grant state) reads as none.
 *
 * Where a single gate run can still differ, measured against that source:
 *   - a stored capability rule can authorize a run with no grant (rung 2.8);
 *   - an untrusted-origin channel (rung 2.55) or a stricter channel grant
 *     (rung 7) force-proposes. Both are per-turn facts no listing can know;
 *   - the registry's `granted` is "an active grant exists on the tool", not
 *     "for THIS agent" — `buildVerbStates` resolves it without a redeemer.
 */
import { READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";

export type RunPosture = "auto" | "propose";

export function runPosture(input: {
  /** Verb id = the backing skill's name. */
  verbId: string;
  /** `skills.kind` of the backing skill (`builtin`, `code`, `declarative`, …). */
  skillKind?: string | null;
  /** An ACTIVE grant exists for this verb (`CapabilityVerbState.granted`).
   *  Absent = unknown, which reads as no grant. */
  granted?: boolean;
  /** The verb's effective exec mode (grant mode, else `govDefault`). */
  execMode?: string | null;
}): RunPosture {
  if (
    input.skillKind === "builtin" &&
    READ_ONLY_BUILTIN_VERBS.has(input.verbId)
  ) {
    return "auto";
  }
  return input.granted === true && input.execMode === "auto"
    ? "auto"
    : "propose";
}

/**
 * The flat registry row's label. A row with verbs is `auto` only when EVERY verb
 * runs now; a row nothing runs through the execute door (a teaching doc, an
 * IS-native catalog-only tool, a verbless tool) is `none`.
 */
export function capabilityRowPosture(row: {
  kind: string;
  name: string;
  catalogOnly?: boolean;
  skillKind?: string | null;
  verbs?: Array<{
    id: string;
    granted?: boolean;
    effectiveExecMode?: string | null;
  }>;
}): RunPosture | "none" {
  if (row.kind === "teaching-doc" || row.catalogOnly) return "none";
  // A skill or command row carries no grant state of its own.
  if (row.kind === "skill") {
    return runPosture({ verbId: row.name, skillKind: row.skillKind });
  }
  if (row.kind === "command") return "propose";
  const verbs = row.verbs ?? [];
  if (verbs.length === 0) return "none";
  const skillKind = row.kind === "builtin-tool" ? "builtin" : null;
  return verbs.every(
    (v) =>
      runPosture({
        verbId: v.id,
        skillKind,
        granted: v.granted,
        execMode: v.effectiveExecMode,
      }) === "auto"
  )
    ? "auto"
    : "propose";
}

/**
 * The pack catalog card's label for one verb. Under a lens, the posture the
 * runnable-actions projection judged for that container's verb (so the card
 * honours the lens's grant); otherwise — no lens, a verb nothing can launch,
 * or an available template — the grant is unmeasured and `runPosture` reads it
 * as absent.
 */
export function catalogVerbPosture(
  verb: { name: string; kind?: string | null },
  projected: RunPosture | undefined
): RunPosture {
  return projected ?? runPosture({ verbId: verb.name, skillKind: verb.kind });
}
