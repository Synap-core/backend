import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateFlowDefinition } from "./validate-flow.js";

/**
 * Author-time gate for the config automations that SHADOW/REPLACE bespoke
 * workers (mail-feed, proactive-digest). These live as capability-template seeds
 * in the sibling CP repo; this test reads their JSON, runs the SAME pure
 * `validateFlowDefinition` the persist doors run, and asserts each flow is
 * author-valid with the new node/verb vocabulary (transform `not-in`/`to_ms`,
 * `set_state`, `compute`, `condition`, `capability` verbs, targetless
 * `channel_message`) — no DB required.
 *
 * Also asserts each seeded cron automation is `status:"active"` — a `draft` cron
 * gets a null nextRunAt and NEVER fires (the exact gotcha these seeds must avoid).
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

const SEED_FILES = [
  "mail-feed.capability.json",
  "proactive-digest.capability.json",
] as const;

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

          it('cron automation is seeded status:"active" (a draft never fires)', () => {
            expect(automation.triggerType).toBe("cron");
            expect(automation.status).toBe("active");
          });
        });
      }
    });
  }
});
