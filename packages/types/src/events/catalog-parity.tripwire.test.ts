/**
 * TRIPWIRE — every event the pod EMITS can be AUTHORED as a trigger.
 *
 * `validateEventPattern` is not a formatter, it is the AUTHORING GATE: the
 * automation create/update door (`api/src/routers/automations.ts`) runs it on
 * every incoming trigger, so a pattern it rejects can never be authored through
 * any door — not the workflows editor, not the browser's rule sentence, not the
 * rule compiler, not Hub REST. A gap between "what the system emits" and "what
 * this function accepts" therefore does not degrade gracefully; it makes those
 * events permanently unreachable, silently, while everything typechecks.
 *
 * That is not hypothetical. Measured before this test existed: **13 of the 26
 * event types declared in `@synap/events` were rejected** — half the catalog.
 * "When a proposal is approved", "when a notification is created", "when an
 * inbox item arrives" could not be written at all, and nothing anywhere said so.
 *
 * ── Why the catalog is read from SOURCE ────────────────────────────────────
 * `@synap-core/types` cannot import `@synap/events` (that package depends on
 * this one), so the catalog is parsed out of its file. That is also what makes
 * this test self-maintaining: there is no list here. Add an event with a new
 * subject or a new domain verb and this goes red until the vocabulary learns
 * it — which is the entire point, because the alternative is discovering it
 * when a user cannot build the rule they need.
 *
 * Guarded like the other source-scan tripwires: a missing file or an empty
 * parse FAILS rather than reporting green over nothing.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateEventPattern } from "./unified.js";

/** `src/events` → src → types → packages → synap-backend. */
const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const CATALOG = join(BACKEND_ROOT, "packages/events/src/event-types.ts");

function catalogEventTypes(): string[] {
  if (!existsSync(CATALOG)) {
    throw new Error(
      `Tripwire cannot read its subject: ${CATALOG}. A moved catalog must move this test, not silence it.`
    );
  }
  const src = readFileSync(CATALOG, "utf8")
    // Strip comments so a prose example can never be read as a declaration.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const found = [
    // `[A-Za-z_]`, not `[a-z_]`: `SUBJECT_TYPES` carries camelCase subjects
    // (`inboxItem`, `apiKey`, `agentRun`, `chatThread`, `workspaceMember`,
    // `projectMember`). A lowercase-only class silently SKIPS any catalog entry
    // using one — under-coverage that still reports green, which is the failure
    // mode a tripwire exists to prevent. No catalog entry is camelCase today;
    // this is so the first one is covered rather than invisible.
    ...src.matchAll(/type:\s*"([A-Za-z_]+\.[A-Za-z_]+(?:\.[A-Za-z_]+)?)"/g),
  ].map((m) => m[1]!);
  return [...new Set(found)].sort();
}

/**
 * Every literal `(subjectType, action)` pair at an `emitSideEffects(...)` call
 * site, as the pattern the REACTOR builds from it.
 *
 * This is the half that actually fires. Scoped to the emit door on purpose: a
 * looser scan that just paired nearby `subjectType:` / `action:` keys swept in
 * the GOVERNANCE vocabulary (`checkPermissionOrPropose`'s own subject/action
 * pairs, a different namespace entirely) and reported four times as many gaps as
 * exist. Read the call, not the neighbourhood.
 */
function emittedPatterns(): string[] {
  // EVERY root that emits, not the three I happened to think of. `apps` holds 4
  // emitting files — `apps/api/src/webhooks/{n8n,intelligence}.ts` emit
  // `inbox_item.received` / `.analyzed` — and `packages/events/src` 3 more. Both
  // validate today, so omitting them was green over a blind spot: the next
  // webhook emit with a new subject would have gone unnoticed. Under-coverage
  // that reports green is the exact failure this file's own header warns about.
  const roots = [
    "apps",
    "packages/api/src",
    "packages/jobs/src",
    "packages/database/src",
    "packages/events/src",
  ];
  const pairs = new Set<string>();
  let sites = 0;
  const walk = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
    }
    return out;
  };
  for (const root of roots) {
    for (const file of walk(join(BACKEND_ROOT, root))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/emitSideEffects\(/g)) {
        sites++;
        // Balanced-paren slice of the call, so a later call's fields cannot leak in.
        let depth = 0;
        let end = m.index! + m[0].length - 1;
        for (let i = end; i < Math.min(src.length, end + 3000); i++) {
          if (src[i] === "(") depth++;
          else if (src[i] === ")" && --depth === 0) {
            end = i;
            break;
          }
        }
        const call = src.slice(m.index!, end + 1);
        // Same reason as the catalog regex above — a camelCase subjectType at
        // an emit site must not be silently skipped.
        const st = call.match(/subjectType:\s*["'`]([A-Za-z_]+)["'`]/);
        const ac = call.match(/\baction:\s*["'`]([A-Za-z_]+)["'`]/);
        if (st && ac) pairs.add(`${st[1]}.${ac[1]}.completed`);
      }
    }
  }
  // A parse that finds no call sites at all must FAIL, not pass an empty set.
  expect(
    sites,
    "no emitSideEffects call sites found — the emit door has moved"
  ).toBeGreaterThan(20);
  return [...pairs].sort();
}

describe("every EMITTED (subjectType, action) is authorable as a trigger", () => {
  const emitted = emittedPatterns();

  it("parsed a non-empty set of emit sites", () => {
    expect(emitted.length).toBeGreaterThan(20);
  });

  it.each(emitted.map((t) => [t]))(
    "%s is accepted by validateEventPattern",
    (pattern) => {
      expect(
        () => validateEventPattern(pattern),
        `"${pattern}" is built by the reactor from a real emitSideEffects call (side-effects.ts constructs \`\${subjectType}.\${action}.completed\`) but the authoring gate rejects it — so no automation or rule can trigger on it. Teach DOMAIN_SUBJECT_TYPES / SUBJECT_EXTRA_ACTIONS in events/unified.ts.`
      ).not.toThrow();
    }
  );

  it("acknowledges the emit sites this scan CANNOT see", () => {
    // ~16 call sites pass a VARIABLE subjectType/action (api-keys.ts and
    // friends). A source scan cannot resolve those, and pretending otherwise
    // would make this tripwire claim coverage it does not have. Recorded so the
    // gap is visible rather than implied.
    expect(emitted.length).toBeGreaterThan(20);
  });
});

describe("every emitted event type is authorable as a trigger", () => {
  const types = catalogEventTypes();

  it("parsed the catalog (a non-empty set)", () => {
    // An empty parse would make every assertion below vacuously true — the
    // exact shape of a tripwire that guards nothing forever.
    expect(types.length).toBeGreaterThan(20);
  });

  it.each(types.map((t) => [t]))(
    "%s is accepted by validateEventPattern",
    (type) => {
      expect(
        () => validateEventPattern(type),
        `"${type}" is declared in packages/events/src/event-types.ts but the authoring gate rejects it, so no automation, rule or workflow can ever trigger on it. Teach the vocabulary (DOMAIN_SUBJECT_TYPES / SUBJECT_EXTRA_ACTIONS in events/unified.ts) — do NOT delete this case.`
      ).not.toThrow();
    }
  );

  it("still refuses a past-tense CRUD pattern no emitter produces", () => {
    // The widening above must not re-open the mood hole: `entity.created` is
    // what the sentence grammar's mood bridge exists to prevent, and nothing
    // emits it.
    expect(() => validateEventPattern("entity.created.completed")).toThrow();
    expect(() => validateEventPattern("nonsense.create.completed")).toThrow();
  });
});
