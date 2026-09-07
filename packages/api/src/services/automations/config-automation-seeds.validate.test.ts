import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateFlowDefinition } from "./validate-flow.js";

/**
 * Author-time gate for EVERY config automation seeded from the CP repo —
 * including the ones that SHADOW/REPLACE bespoke workers (mail-feed,
 * proactive-digest). These live as capability-template seeds
 * in the sibling CP repo; this test reads their JSON, runs the SAME pure
 * `validateFlowDefinition` the persist doors run, and asserts each flow is
 * author-valid with the new node/verb vocabulary (transform `not-in`/`to_ms`,
 * `set_state`, `compute`, `condition`, `capability` verbs, targetless
 * `channel_message`) — no DB required.
 *
 * Also asserts each seeded cron automation is `status:"active"` — a `draft` cron
 * gets a null nextRunAt and NEVER fires (the exact gotcha these seeds must avoid).
 *
 * ...UNLESS the draft is DOCUMENTED. A cron can be deliberately quiet: seeding it
 * `active` starts that cron in EVERY pod that installs the template, so a job
 * nobody is doing (the Stellar grant seeds, 2026-09-07) is correctly left draft.
 * The defect the assertion exists to catch is an UNDECLARED draft — a cron that
 * silently never fires and nothing says why. So the rule is: a cron seed may be
 * draft ONLY when it carries a `_note` stating that it is deliberate and what
 * would have to be true to activate it. An undocumented draft cron still FAILS,
 * and `active` is always fine.
 */

// From this dir (packages/api/src/services/automations) up to the monorepo root
// (Code/synap), then into the CP repo's capability-templates directory.
const CP_TEMPLATES_DIR = join(
  import.meta.dirname,
  "../../../../../../synap-control-plane-api/src/seeds/capability-templates"
);

interface SeededAutomation {
  name: string;
  status?: string;
  triggerType?: string;
  /** Author-time justification for a deliberately-quiet seed. */
  _note?: string;
  flowDefinition: unknown;
}
interface SeededCapability {
  key: string;
  automations?: SeededAutomation[];
}

function loadSeed(file: string): SeededCapability {
  return JSON.parse(
    readFileSync(join(CP_TEMPLATES_DIR, file), "utf8")
  ) as SeededCapability;
}

/**
 * GLOB, never a hardcoded list. The list used to name two files while five CP
 * seeds carried `automations[]` — so three seeds shipped with zero author-time
 * coverage, and every new seed inherited that hole by default. Reading the
 * directory means a seed is covered the moment it exists.
 */
const SEED_FILES = readdirSync(CP_TEMPLATES_DIR)
  .filter((f) => f.endsWith(".capability.json"))
  .filter((f) => (loadSeed(f).automations?.length ?? 0) > 0)
  .sort();

describe("config automation seeds — author-valid flows", () => {
  for (const file of SEED_FILES) {
    describe(file, () => {
      const seed = loadSeed(file);

      it("has at least one automation", () => {
        expect(seed.automations?.length ?? 0).toBeGreaterThan(0);
      });

      for (const automation of seed.automations ?? []) {
        describe(automation.name, () => {
          it("flowDefinition passes validateFlowDefinition (valid, no errors)", () => {
            const result = validateFlowDefinition(automation.flowDefinition);
            // Surface the actual errors if this ever regresses.
            expect(result.errors).toEqual([]);
            expect(result.valid).toBe(true);
          });

          // Only CRON seeds carry the never-fires gotcha (a draft cron gets a
          // null nextRunAt). Event/manual seeds are legitimately draft, so the
          // assertion is scoped to the trigger type it is actually about —
          // globbing the directory brought both kinds into view.
          it.skipIf(automation.triggerType !== "cron")(
            'cron automation is seeded status:"active", or "draft" WITH a `_note` saying why',
            () => {
              if (automation.status === "active") return;
              // Not active — the only other acceptable state is a DOCUMENTED
              // draft. Anything else (or a draft with no `_note`) is the
              // never-fires gotcha with nothing declaring it.
              expect(automation.status).toBe("draft");
              expect(
                (automation._note ?? "").trim().length,
                `"${automation.name}" is a DRAFT cron, so it gets a null nextRunAt and will NEVER fire. ` +
                  `That can be deliberate — but it must be written down: add a "_note" to this automation ` +
                  `saying it is deliberately draft, why, and what would have to be true to activate it.`
              ).toBeGreaterThan(0);
            }
          );
        });
      }
    });
  }
});
