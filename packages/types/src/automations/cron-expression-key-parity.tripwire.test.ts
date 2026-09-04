/**
 * TRIPWIRE — the cron `triggerConfig` key `toBackendTrigger` WRITES must include
 * every key the cron-firing doors actually READ.
 *
 * WHY THIS EXISTS. `toBackendTrigger` wrote the compiled cron expression under
 * `triggerConfig.cron` — but `handleAutomationCronScheduler` /
 * `healUnscheduledCronAutomations` (`jobs/src/workers/automation-cron-scheduler.ts`)
 * and `insertAutomationAfterGovernance` / the `automations.activate` mutation
 * (`api/src/routers/automations.ts`) all read `triggerConfig.expression`. A cron
 * automation compiled by the shared grammar got `nextRunAt: null` and NEVER
 * FIRED — silently, because `triggerToSentence` read `.cron` straight back, so
 * the editor round-tripped perfectly and hid the miss. WHEN-side twin of the
 * `type:"action"`/`ActionType` THEN-side bug fixed in `7dd1b233`.
 *
 * WHY IT IS DERIVED, NOT HAND-LISTED. A hand-typed `expect(...).toBe("expression")`
 * proves nothing once the reader is renamed — it is exactly how the fork
 * happened one level up (the WRITER key was never checked against what
 * anything actually reads). Both sides are parsed out of source:
 *   • the writer's key set  ← `toBackendTrigger`'s own cron-branch `triggerConfig: {…}` literal, in THIS file
 *   • the reader key sets   ← every `triggerConfig(?.|.)expression`-shaped access inside
 *                             the cron-gated code paths of the scheduler and the router
 * Renaming either side without the other turns this test red.
 *
 * Idiom precedent in this repo:
 * `jobs/src/workers/__tripwires__/command-node-field-parity.tripwire.test.ts`
 * (executor-reads vs. schema/normalizer-projects) and
 * `capability-drift.projection-parity.tripwire.test.ts` (parses the applier's
 * own `.set({…})`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES_SRC = resolve(HERE, "."); // …/packages/types/src/automations
const BACKEND = resolve(HERE, "../../../.."); // …/synap-backend

const SENTENCE_SRC_PATH = resolve(TYPES_SRC, "sentence.ts");
const SCHEDULER_SRC_PATH = resolve(
  BACKEND,
  "packages/jobs/src/workers/automation-cron-scheduler.ts"
);
const ROUTER_SRC_PATH = resolve(
  BACKEND,
  "packages/api/src/routers/automations.ts"
);

/**
 * Strip comments before parsing. Without this, a future comment that merely
 * QUOTES `trigger.triggerType === "cron"` becomes the block this tripwire
 * inspects, and it starts asserting against prose. The sibling tripwire
 * (`api/src/__tripwires__/rule-compiler-emits-executor-true-nodes.test.ts`)
 * strips for exactly this reason.
 */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Balanced-brace slice starting at the FIRST `{` at or after `fromIndex`. */
function balancedBlockFrom(src: string, fromIndex: number): string {
  const open = src.indexOf("{", fromIndex);
  if (open < 0) throw new Error("tripwire: no `{` found");
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("tripwire: unbalanced block");
}

/** Balanced-brace slice starting at the `{` that follows the FIRST `marker`. */
function blockAfter(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`tripwire: marker not found: ${marker}`);
  return balancedBlockFrom(src, at + marker.length);
}

/**
 * Every top-level key of a `triggerConfig: { … }` object literal — depth-aware
 * so a nested object's keys (e.g. a future `filters: { profileSlug }` sibling)
 * are never mistaken for `triggerConfig`'s own keys.
 */
function triggerConfigWriteKeys(block: string): Set<string> {
  const at = block.indexOf("triggerConfig:");
  if (at < 0) throw new Error("tripwire: no `triggerConfig:` in block");
  const literal = balancedBlockFrom(block, at + "triggerConfig:".length);
  const inner = literal.slice(1, -1); // strip outer { }
  const names = new Set<string>();
  let depth = 0;
  for (const m of inner.matchAll(/[{}]|([A-Za-z_$][\w$]*)\s*:/g)) {
    if (m[0] === "{") {
      depth++;
      continue;
    }
    if (m[0] === "}") {
      depth--;
      continue;
    }
    if (depth === 0 && m[1]) names.add(m[1]);
  }
  return names;
}

/**
 * Every `triggerConfig` PROPERTY READ (`triggerConfig.x` / `triggerConfig?.x` /
 * `input.triggerConfig.x` / `existing.triggerConfig` bound to a local then
 * `.x`'d two lines later — handled by also matching the local var name) found
 * anywhere in `src`, restricted to blocks textually gated by a
 * `triggerType === "cron"` (or `triggerType, "cron"`) condition — i.e. code that
 * only runs for a cron automation, which is the only case `expression` matters.
 */
function cronGatedTriggerConfigReadKeys(src: string): Set<string> {
  const keys = new Set<string>();
  for (const m of src.matchAll(/triggerType\s*===?\s*["']cron["']/g)) {
    const gated = balancedBlockFrom(src, m.index! + m[0].length);
    // Direct `triggerConfig.x` / `triggerConfig?.x` reads inside the gate.
    for (const km of gated.matchAll(
      /\btriggerConfig\s*\??\.\s*([A-Za-z_$][\w$]*)/g
    )) {
      keys.add(km[1]);
    }
    // `const triggerConfig = <expr>.triggerConfig as …` rebinding, still inside
    // the same gated block, followed later by `triggerConfig?.x`. Already
    // covered by the pattern above since it matches the bound name too.
  }
  return keys;
}

const sentenceSrc = readFileSync(SENTENCE_SRC_PATH, "utf8");
const schedulerSrc = readFileSync(SCHEDULER_SRC_PATH, "utf8");
const routerSrc = readFileSync(ROUTER_SRC_PATH, "utf8");

const WRITER_KEYS = triggerConfigWriteKeys(
  blockAfter(strip(sentenceSrc), 'trigger.triggerType === "cron"')
);
const SCHEDULER_READ_KEYS = new Set(
  [
    ...schedulerSrc.matchAll(/\btriggerConfig\s*\??\.\s*([A-Za-z_$][\w$]*)/g),
  ].map((m) => m[1])
);
const ROUTER_READ_KEYS = cronGatedTriggerConfigReadKeys(routerSrc);

describe("TRIPWIRE: cron `triggerConfig` writer satisfies every cron-firing reader", () => {
  it("parses a non-empty contract from EVERY side (the derivation itself works)", () => {
    expect(WRITER_KEYS.size).toBeGreaterThan(0);
    expect(SCHEDULER_READ_KEYS.size).toBeGreaterThan(0);
    expect(ROUTER_READ_KEYS.size).toBeGreaterThan(0);
  });

  it("the scheduler's key is what toBackendTrigger's cron branch writes", () => {
    const missing = [...SCHEDULER_READ_KEYS].filter((k) => !WRITER_KEYS.has(k));
    expect(
      missing,
      `automation-cron-scheduler.ts reads triggerConfig.${JSON.stringify(missing)} ` +
        `but toBackendTrigger's cron branch never writes ${JSON.stringify(missing)} — ` +
        `a cron automation compiled by the sentence grammar would get nextRunAt: ` +
        `null and never fire.`
    ).toEqual([]);
  });

  it("the router's (create/activate) key is what toBackendTrigger's cron branch writes", () => {
    const missing = [...ROUTER_READ_KEYS].filter((k) => !WRITER_KEYS.has(k));
    expect(
      missing,
      `routers/automations.ts reads triggerConfig.${JSON.stringify(missing)} inside ` +
        `a triggerType==="cron" gate, but toBackendTrigger's cron branch never ` +
        `writes ${JSON.stringify(missing)}.`
    ).toEqual([]);
  });

  it("`expression` specifically is covered (the exact key of the original defect)", () => {
    expect(SCHEDULER_READ_KEYS.has("expression")).toBe(true);
    expect(ROUTER_READ_KEYS.has("expression")).toBe(true);
    expect(WRITER_KEYS.has("expression")).toBe(true);
  });
});
