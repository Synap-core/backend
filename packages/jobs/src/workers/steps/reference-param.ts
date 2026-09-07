/**
 * Resolve a `reference` PARAM VALUE into the plain object id(s) the output
 * executor can act on.
 *
 * WHY THIS EXISTS. `packages/api/src/routers/automations.ts` declares the wire
 * contract for a `type: "reference"` param: the stored value is a TAGGED UNION
 * (`referenceValueSchema`), never a bare id —
 *
 *     { mode: "bound", refKind: "entity", value: [{ id, label? }] }
 *     { mode: "ask",   refKind: "entity", prompt?: string }
 *
 * — and `value` is ALWAYS an array, for both `single` and `multiple`
 * cardinality. The executor could not read that. Both target sites read the
 * slot as a bare cast:
 *
 *     const entityId = config.entityId as string;          // entity_update
 *     let channelId = config.channelId as string | undefined; // channel_message
 *
 * A cast is not a parse. `{mode:"bound",value:[{id}]}` cast to string is
 * `"[object Object]"`, and `eq(entities.id, "[object Object]")` matches nothing
 * — so the rule saves green, fires, and writes NOTHING, with no error anywhere.
 * That silent no-op is the reason `SENTENCE_ACTION_PARAMS` still leaves
 * `entity_update.entityId` and `channel_message.channelId` untyped: tagging a
 * param before this resolver existed would have stored values nothing executes.
 *
 * WHY IT FAILS LOUD. Windmill's `#7800` is precisely the near-miss shape: a
 * resolver that handled the SCALAR case let every ARRAY element through as an
 * unresolved `"$res:path"` literal, so the pointer reached the job as data. A
 * reference this module cannot read therefore THROWS — it never degrades to
 * `undefined` and lets the step widen (an `entity_update` with no id) or no-op.
 * An unreadable destination is a wiring fault, which is the same posture the
 * `channel_message` cross-workspace guard already takes a few lines below its
 * call site.
 *
 * WHAT IT DOES NOT DO. `mode: "ask"` is DELIBERATELY UNBOUND ("ask me when it
 * runs") and there is no runtime disambiguation channel in this wave — nothing
 * anywhere can put the question to a human mid-run. So `ask` fails with its own
 * distinct message NAMING that silence, rather than being quietly treated as
 * absent (which would widen the write) or resolved to some default (which would
 * act on an object the author never picked). Building a prompt mechanism is a
 * separate wave; this module must not invent one.
 *
 * ⚠️ VOCABULARY. `REFERENCE_MODES` lives in `routers/automations.ts` and CANNOT
 * be imported here — `@synap/jobs` does not (and must not) depend on
 * `@synap/api`. The mode literals below are therefore a mirror, held in lockstep
 * by `reference-param-mode-parity.test.ts`, a source scan of the SSOT — the same
 * device `action-option-parity.test.ts` uses for the synap-app mirror.
 */

/** Every mode this resolver knows how to handle. Mirrors `REFERENCE_MODES`. */
export const RESOLVABLE_REFERENCE_MODES = ["bound", "ask"] as const;

/**
 * A reference that cannot become an id at execution time.
 *
 * A distinct class (not a bare `Error`) so the run's failure is attributable to
 * the reference and not to whatever the step would have done with a bad id.
 * Plain `Error` subclass rather than `PolicyBlockedError`: nothing was blocked
 * by policy — the stored value is unreadable or unbound, which is a wiring
 * fault the author has to fix.
 */
export class UnresolvableReferenceError extends Error {
  readonly paramPath: string;
  constructor(paramPath: string, detail: string) {
    super(`${paramPath}: ${detail}`);
    this.name = "UnresolvableReferenceError";
    this.paramPath = paramPath;
  }
}

/** `{ id, label? }` — the picked target. `label` is display-only, never identity. */
function targetId(el: unknown): string | null {
  if (!el || typeof el !== "object" || Array.isArray(el)) return null;
  const id = (el as Record<string, unknown>).id;
  return typeof id === "string" && id.trim().length > 0 ? id : null;
}

/**
 * Normalize a param slot to the id list the step should act on.
 *
 * - `undefined` / `null` → `[]`. ABSENT IS NOT A REFERENCE: the caller's own
 *   required-ness check owns that case, byte-identically to today
 *   (`entity_update` throws "requires entityId"; `channel_message` falls through
 *   to its default run channel, honouring "a targetless channel_message NEVER
 *   errors").
 * - a bare `string` → `[value]` VERBATIM, with no trim and no filtering. This is
 *   the additive guarantee: every rule authored before `reference` existed must
 *   behave exactly as it did, including the `""` that today reads as falsy.
 * - a tagged `{mode}` object → parsed, or thrown.
 * - anything else (array, number, object with no `mode`) → thrown. An array at
 *   this slot is the Windmill shape — a container the caller would iterate or
 *   stringify as data; rejecting it explicitly is the point.
 *
 * @param paramPath e.g. `entity_update.entityId` — appears verbatim in the error.
 */
export function resolveReferenceParam(
  raw: unknown,
  paramPath: string
): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") return [raw];

  if (Array.isArray(raw)) {
    throw new UnresolvableReferenceError(
      paramPath,
      "a bare array is not a reference value — a reference is " +
        '`{mode:"bound", refKind, value:[{id}]}`, whose targets live under ' +
        "`value`. Re-select the target on this automation."
    );
  }

  if (typeof raw !== "object") {
    throw new UnresolvableReferenceError(
      paramPath,
      `expected an object id or a reference value, got ${typeof raw}.`
    );
  }

  const rec = raw as Record<string, unknown>;
  const mode = rec.mode;

  if (mode === "ask") {
    const prompt = typeof rec.prompt === "string" ? rec.prompt : null;
    throw new UnresolvableReferenceError(
      paramPath,
      "this reference is UNBOUND — the rule stores the question " +
        (prompt ? `("${prompt}") ` : "") +
        "and expects to be asked which object to use when it runs. Nothing " +
        "can put that question to a human at execution time yet, so the rule " +
        "cannot fire. Bind the reference to a specific target on the " +
        "automation instead."
    );
  }

  if (mode === "bound") {
    const value = rec.value;
    if (!Array.isArray(value) || value.length === 0) {
      throw new UnresolvableReferenceError(
        paramPath,
        "a bound reference with no targets — `value` must hold at least one " +
          "`{id}`. Re-select the target on this automation."
      );
    }
    const ids = value.map(targetId);
    const badIndex = ids.findIndex((id) => id === null);
    if (badIndex !== -1) {
      throw new UnresolvableReferenceError(
        paramPath,
        `target #${badIndex + 1} of ${ids.length} carries no usable id. ` +
          "Every element of `value` must be `{id: string}`."
      );
    }
    return ids as string[];
  }

  throw new UnresolvableReferenceError(
    paramPath,
    `unknown reference mode ${JSON.stringify(mode)} — expected one of ` +
      `${RESOLVABLE_REFERENCE_MODES.map((m) => JSON.stringify(m)).join(", ")}.`
  );
}

/**
 * The single-valued form, for a config slot that holds exactly one id
 * (`entity_update.entityId`, `channel_message.channelId`).
 *
 * `undefined` when the slot is absent — the caller's existing required-ness
 * check is untouched.
 *
 * MORE THAN ONE TARGET THROWS. Silently taking `value[0]` would drop targets the
 * author picked and report success, which is the exact class of defect this
 * module exists to prevent; a `multiple`-cardinality reference wired into a
 * single-valued slot is an authoring fault and must be visible as one.
 */
export function resolveSingleReferenceParam(
  raw: unknown,
  paramPath: string
): string | undefined {
  const ids = resolveReferenceParam(raw, paramPath);
  if (ids.length === 0) return undefined;
  if (ids.length > 1) {
    throw new UnresolvableReferenceError(
      paramPath,
      `${ids.length} targets are bound but this action takes exactly one. ` +
        "Split it into one action per target, or bind a single object."
    );
  }
  return ids[0];
}
