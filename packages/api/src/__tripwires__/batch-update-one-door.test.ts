/**
 * TRIPWIRE — the batch update (R1) has ONE way to write an entity, and its
 * approval half shares the single update's body.
 *
 *  1. `services/entities/update-entities.ts` writes a record ONLY through the
 *     `entities.update` procedure (a caller of the entities router). A direct
 *     `.update(entities)`, an `EntityRepository`, a raw insert or a second
 *     `checkPermissionOrPropose` pair would be a twin door: governance,
 *     receipts and side effects would fork from the single write.
 *  2. The `entity/update` and `entity/update_pack` executors both apply their
 *     patch through `applyApprovedEntityPatch`, and that helper is the ONE
 *     place in the file that calls `entities.update` as the approver.
 *
 * The behaviour is proven in `services/entities/__tests__/update-entities.pglite.test.ts`;
 * this guards the SHAPE a refactor could quietly break. Granularity: the file
 * (scan 1) and the executor block between two `key:` lines (scan 2) — a write
 * hidden in a helper in ANOTHER file is not seen here.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");
const service = readFileSync(
  join(SRC, "services/entities/update-entities.ts"),
  "utf8"
);
const executors = readFileSync(
  join(SRC, "routers/proposals/executors/entity.ts"),
  "utf8"
);

/** The source of one registered executor: from its `key:` to the next one. */
function executorBlock(key: string): string {
  const start = executors.indexOf(`key: "${key}"`);
  expect(start, `executor ${key} not found`).toBeGreaterThan(-1);
  const next = executors.indexOf(`key: "`, start + 1);
  return executors.slice(start, next === -1 ? undefined : next);
}

describe("tripwire: the batch update writes through entities.update only", () => {
  it("the service writes through an entities-router caller's `update`", () => {
    expect(service).toMatch(/entitiesRouter\.createCaller\(/);
    expect(service.match(/\bcaller\.update\(\{/g)?.length).toBe(1);
  });

  it("the service has no direct entity write and no second update gate", () => {
    const forbidden: Array<[string, RegExp]> = [
      ["direct update", /\.update\(\s*entities\s*\)/],
      ["direct insert", /\.insert\(\s*entities\s*\)/],
      ["repository write", /EntityRepository/],
    ];
    // Self-check: each pattern still sees a literal sample of what it hunts.
    expect(forbidden[0]![1].test("db.update(entities)")).toBe(true);
    expect(forbidden[2]![1].test("new EntityRepository(db)")).toBe(true);
    for (const [label, re] of forbidden) {
      expect(re.test(service), label).toBe(false);
    }
    // The ONLY gate the service commits through is the pack's.
    const gates = [
      ...service.matchAll(
        /checkPermissionOrPropose\(\{[\s\S]*?action:\s*"([a-z_]+)"/g
      ),
    ].map((m) => m[1]);
    expect(gates).toEqual(["update_pack"]);
  });
});

describe("tripwire: entity/update_pack shares entity/update's body", () => {
  it("both executors apply through applyApprovedEntityPatch", () => {
    expect(executorBlock("entity/update")).toMatch(
      /applyApprovedEntityPatch\(/
    );
    expect(executorBlock("entity/update_pack")).toMatch(
      /applyApprovedEntityPatch\(/
    );
  });

  it("the shared helper is the only place the file calls entities.update", () => {
    const calls = executors.match(/\bentityCaller\.update\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const helperStart = executors.indexOf(
      "export async function applyApprovedEntityPatch("
    );
    const callAt = executors.indexOf("entityCaller.update(");
    const helperEnd = executors.indexOf("\n}\n", helperStart);
    expect(callAt).toBeGreaterThan(helperStart);
    expect(callAt).toBeLessThan(helperEnd);
  });
});
