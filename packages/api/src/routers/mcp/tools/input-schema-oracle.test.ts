/**
 * ORACLE: each tool's `input` (zod, the one source since the zod-first
 * conversion) derives the JSON Schema each tool advertised BEFORE it, modulo
 * key order. `__fixtures__/input-schemas.pre-zod.json` is a frozen copy of
 * every `inputSchema` in the committed manifest at origin/main 611a2ea4 (the
 * manifest is regenerated from the zod inputs afterwards, so comparing with
 * it would be a tautology).
 *
 * A difference fails unless `ACCEPTED` lists its path with the reason; an
 * accepted path that no longer differs fails too (the list cannot rot).
 * Canonicalised on both sides, because they carry no meaning: key order, the
 * order of `required`, and an empty `required`.
 *
 * Negative control: drop one `.describe(...)`, one `.optional()` or one
 * `.max(...)` from any tool in `tools/index.ts` and this goes red naming the
 * path; delete one ACCEPTED entry and it goes red naming that path.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { wireTools } from "../define-tool.js";

const FROZEN = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/input-schemas.pre-zod.json", import.meta.url),
    "utf8"
  )
) as Record<string, unknown>;

const VACUOUS_OPEN =
  "an open object's additionalProperties ({} or true) is JSON Schema's default";
const VACUOUS_KEYS =
  "propertyNames {type: string} holds for every JSON object key";
const NULLABLE =
  "a nullable is written type: [t, 'null'] (same meaning as the anyOf zod emits)";
const TEXT_EDITS =
  "textEdits added to the patch in ac87e604, after the manifest was frozen";

const LAUNCH =
  "synap_run_playbook folded into synap_start_session `launch: true` (review B2 F5): its inputs, and goal no longer required";

/**
 * `synap_run_playbook` is now an old name of `synap_start_session` with
 * `launch: true` (review B2 F5): it keeps its argument NAMES (a missing or an
 * added one is still a difference), each advertised with start_session's
 * schema of the input it maps to.
 */
const ALIAS_OF_START = (path: string) =>
  /^synap_run_playbook\.properties\.[^.]+\./.test(path);

const ACCEPTED: Record<string, string> = {
  ...Object.fromEntries(
    [
      "properties.launch",
      "properties.playbookName",
      "properties.handToAgentId",
      "properties.runner",
      "properties.stageRunners",
      "properties.startAnother",
      "properties.reasoning",
      "properties.goal.description",
      "properties.templateId.description",
      "required",
    ].map((p) => [`synap_start_session.${p}`, LAUNCH])
  ),
  "synap_start_session.properties.params.additionalProperties": VACUOUS_OPEN,
  "synap_update_session.properties.params.additionalProperties": VACUOUS_OPEN,
  "synap_set_track_params.properties.params.additionalProperties": VACUOUS_OPEN,
  "synap_create_playbook.properties.expectedOutputs.items.additionalProperties":
    VACUOUS_OPEN,
  "synap_create_playbook.properties.stages.items.properties.expectedOutputs.items.additionalProperties":
    VACUOUS_OPEN,
  "synap_update_playbook.properties.expectedOutputs.items.additionalProperties":
    VACUOUS_OPEN,
  "synap_update_playbook.properties.stages.items.properties.expectedOutputs.items.additionalProperties":
    VACUOUS_OPEN,
  "synap_run_capability.properties.parameters.additionalProperties":
    VACUOUS_OPEN,
  "synap_run_capability.properties.parameters.propertyNames": VACUOUS_KEYS,
  "synap_revise_proposal.properties.patch.description": TEXT_EDITS,
  "synap_revise_proposal.properties.patch.properties.textEdits": TEXT_EDITS,
  "synap_revise_proposal.properties.patch.required": TEXT_EDITS,
  ...Object.fromEntries(
    ["synap_create_rule", "synap_update_rule"].flatMap((tool) => {
      const s = `${tool}.properties.sentence.properties`;
      const config = `${s}.actions.items.properties.config`;
      const type = `${s}.actions.items.properties.type`;
      return [
        [`${config}.additionalProperties`, VACUOUS_OPEN],
        [`${config}.propertyNames`, VACUOUS_KEYS],
        ...["anyOf", "enum", "type"].map((k) => [`${type}.${k}`, NULLABLE]),
        ...["anyOf", "properties", "required", "type"].map((k) => [
          `${s}.trigger.${k}`,
          NULLABLE,
        ]),
      ];
    })
  ),
};

/** Key order, `required` order and an empty `required` carry no meaning. */
function canon(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(canon);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (k === "required") {
      if ((v as string[]).length) out[k] = [...(v as string[])].sort();
    } else out[k] = k === "enum" || k === "default" ? v : canon(v);
  }
  return out;
}

/** Every path where `a` and `b` differ (a leaf, or a key one side lacks). */
function differences(a: unknown, b: unknown, path: string): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObj = (n: unknown) =>
    !!n && typeof n === "object" && !Array.isArray(n);
  if (!isObj(a) || !isObj(b)) return [path];
  const keys = new Set([
    ...Object.keys(a as object),
    ...Object.keys(b as object),
  ]);
  return [...keys].flatMap((k) =>
    differences(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      `${path}.${k}`
    )
  );
}

describe("oracle: the zod inputs derive the JSON Schema the tools advertised", () => {
  const derived = new Map(wireTools().map((t) => [t.name, t.inputSchema]));

  it("NON-VACUITY: the frozen copy and the derivation both hold every tool, and a change is seen", () => {
    expect(Object.keys(FROZEN).length).toBeGreaterThan(130);
    expect(Object.keys(FROZEN).filter((n) => !derived.has(n))).toEqual([]);
    expect(
      differences(
        canon({ type: "object", properties: { a: { type: "string" } } }),
        canon({ properties: { a: { type: "number" } }, type: "object" }),
        "t"
      )
    ).toEqual(["t.properties.a.type"]);
  });

  it("every difference is accepted, with its reason, and every accepted one still differs", () => {
    const found = Object.entries(FROZEN).flatMap(([name, frozen]) =>
      differences(canon(frozen), canon(derived.get(name)), name)
    );
    expect(
      found.filter((p) => !(p in ACCEPTED) && !ALIAS_OF_START(p))
    ).toEqual([]);
    expect(found.some(ALIAS_OF_START)).toBe(true);
    expect(Object.keys(ACCEPTED).filter((p) => !found.includes(p))).toEqual([]);
  });
});
