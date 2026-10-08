import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { OperationalEventTypes, getEventCatalog } from "../event-types.js";

/**
 * "Status changed FROM x" is authorable only if the catalogue ADVERTISES the
 * `previous.<fieldName>` key: the automation router hands `filterKeys` to the
 * pickers and the text-rule builder (`rule-text-sentence.ts` drops a clause on
 * a key the event does not list). The emitter (`entities/mutate.ts`) writes
 * the prior value as a FLAT `previous.<k>` key beside `changed.<k>`, which the
 * matcher's literal-first `getNestedValue` reads (pinned in jobs'
 * `changed-key-filter-is-live.test.ts` for the same flat-key shape).
 *
 * Read the emitter's source rather than trusting a fixture: if the payload key
 * is renamed, advertising `previous.<fieldName>` would promise a filter that
 * narrows every rule to never.
 */
describe("entity.update advertises `previous.<fieldName>`", () => {
  const MUTATE = path.resolve(
    __dirname,
    "../../../api/src/routers/entities/mutate.ts"
  );

  it("can see the emitter it pins", () => {
    expect(fs.existsSync(MUTATE), `not found: ${MUTATE}`).toBe(true);
  });

  it("the emitter writes `previous.<k>` flat into the event data", () => {
    const src = fs.readFileSync(MUTATE, "utf8");
    expect(/`previous\.\$\{k\}`/.test(src)).toBe(true);
  });

  it("the catalogue lists it on ENTITY_UPDATED", () => {
    expect(OperationalEventTypes.ENTITY_UPDATED.filterKeys).toContain(
      "previous.<fieldName>"
    );
  });

  it("the served catalogue (what the router reads) carries it", () => {
    const def = getEventCatalog().find(
      (d) => d.type === "entity.update.completed"
    );
    expect(def?.filterKeys).toContain("previous.<fieldName>");
  });
});
