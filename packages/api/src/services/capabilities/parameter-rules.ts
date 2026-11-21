/**
 * A verb's CONDITIONAL input rules, checked before a person is asked to approve.
 *
 * THE DEFECT (agent report 8a0b5606, 17 Nov 2026): `fal_generate_image` with
 * `model: "fal-ai/flux-pro/kontext/max"` and `aspectRatio: "4:5"` was proposed,
 * the founder approved it, and fal refused it AFTER the yes ("body.aspect_ratio:
 * Input should be '21:9', '16:9', …"). The verb's type map (`skills.parameters`)
 * can say "aspectRatio is a string"; it cannot say "for THIS model, only these
 * ratios", so nothing between the agent and the review queue knew.
 *
 * THE RULE LIVES IN THE CATALOG, never as a model name in the pod: a skill's
 * `metadata.parameterRules` (copied verbatim by the definition applier, like
 * `metadata.readOnly`), each rule
 *
 *   { when:  { <param>: [values…] },                 every named param equals one
 *     allow: { <param>: [values…] },                 a present param must be one of
 *     count: { fields: [<param>…], min?, max? },     items across these list params
 *     why?:  "one sentence that says how to fix it" }
 *
 * A rule only REFUSES calls (it never widens what runs), so changing it needs no
 * re-approval. A rule this module cannot read is skipped, never a refusal: the
 * same honest-unknown as `validate-verb-parameters.ts` ("a false rejection is
 * worse than the miss it fixes"). Pure and dependency-free.
 */

/** The key a skill's metadata declares its rules under. */
export const PARAMETER_RULES_KEY = "parameterRules" as const;

interface ParameterRule {
  when: Record<string, string[]>;
  allow?: Record<string, string[]>;
  count?: { fields: string[]; min?: number; max?: number };
  why?: string;
}

function isStringList(v: unknown): v is string[] {
  return (
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")
  );
}

function isListMap(v: unknown): v is Record<string, string[]> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v).length > 0 &&
    Object.values(v as Record<string, unknown>).every(isStringList)
  );
}

function isCount(v: unknown): v is NonNullable<ParameterRule["count"]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  const bound = (b: unknown) =>
    b === undefined || (Number.isInteger(b) && (b as number) >= 0);
  return (
    isStringList(c.fields) &&
    bound(c.min) &&
    bound(c.max) &&
    (c.min !== undefined || c.max !== undefined)
  );
}

/** The rules a skill declares that this module can read; the rest are skipped. */
export function readParameterRules(metadata: unknown): ParameterRule[] {
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>)[PARAMETER_RULES_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is ParameterRule => {
    if (!r || typeof r !== "object") return false;
    const rule = r as Record<string, unknown>;
    if (!isListMap(rule.when)) return false;
    if (rule.allow !== undefined && !isListMap(rule.allow)) return false;
    if (rule.count !== undefined && !isCount(rule.count)) return false;
    if (rule.why !== undefined && typeof rule.why !== "string") return false;
    return rule.allow !== undefined || rule.count !== undefined;
  });
}

/** A value as the rule compares it: strings and numbers as text, else none. */
function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function itemCount(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return Array.isArray(value) ? value.length : 1;
}

/**
 * One sentence per broken rule, the call's own values in it; empty when the
 * call keeps every rule that applies to it.
 */
export function parameterRuleViolations(
  metadata: unknown,
  params: Record<string, unknown>
): string[] {
  const out: string[] = [];
  for (const rule of readParameterRules(metadata)) {
    const applies = Object.entries(rule.when).every(([field, values]) => {
      const v = asText(params[field]);
      return v !== null && values.includes(v);
    });
    if (!applies) continue;
    const context = Object.keys(rule.when)
      .map((field) => `${field} ${asText(params[field])}`)
      .join(", ");
    const broken: string[] = [];
    for (const [field, values] of Object.entries(rule.allow ?? {})) {
      if (params[field] === undefined || params[field] === null) continue;
      const v = asText(params[field]);
      if (v === null || !values.includes(v)) {
        broken.push(
          `${field} ${v === null ? "must be text" : `"${v}" is not accepted`}; use one of ${values.join(", ")}`
        );
      }
    }
    if (rule.count) {
      const { fields, min, max } = rule.count;
      const n = fields.reduce((sum, f) => sum + itemCount(params[f]), 0);
      const what = fields.join(" and ");
      if (min !== undefined && n < min) {
        broken.push(
          `${what} must carry at least ${min} item${min === 1 ? "" : "s"} (got ${n})`
        );
      } else if (max !== undefined && n > max) {
        broken.push(
          `${what} take at most ${max} item${max === 1 ? "" : "s"} together (got ${n})`
        );
      }
    }
    if (broken.length === 0) continue;
    out.push(
      `with ${context}: ${broken.join("; ")}${rule.why ? `. ${rule.why}` : ""}`
    );
  }
  return out;
}
