import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — the two SESSION containers consult the project ladder.
 *
 * WHY A SOURCE SCAN: `openRunSession` lives in `@synap/database`, whose vitest
 * config opens Postgres in a package-global `setupFiles`, so every test there is
 * unrunnable while the local DB is down — a pin over there would be permanently
 * skipped, which looks like coverage and is worse than none. `createFocusSession`
 * sits behind a governance membrane + a transaction and cannot be driven without
 * a database either. The sibling pin
 * `proposal-project-lens-derivation.test.ts` exists for exactly this reason and
 * this file follows it. The BEHAVIOUR of the ladder-through-a-producer is proved
 * for real in `utils/resolve-or-create-channel.project-lens.test.ts`.
 *
 * WHAT IT PROTECTS: measured live, `project_id` was populated on 10% of
 * `focus_sessions`. Not built-but-severed — the column, the producer and the
 * consumer all existed. The severance was upstream: **every producer waited to
 * be handed a project and nothing derived one.** Deleting the derivation is
 * INVISIBLE to `tsc` (the field is optional on every input) and turns no other
 * test red, so `rg` is the only thing that can see it.
 */

const RUN_DOOR = join(
  process.cwd(),
  "../database/src/utils/open-run-session.ts"
);
const HELPER = join(
  process.cwd(),
  "../database/src/utils/resolve-session-project.ts"
);
const START_DOOR = join(
  process.cwd(),
  "src/services/focus-sessions/create-session.ts"
);

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

describe("session containers derive their project from the ladder", () => {
  it("can see the three files it pins", () => {
    for (const p of [RUN_DOOR, HELPER, START_DOOR]) {
      expect(
        existsSync(p),
        `${p} moved — fix this path, do not delete the pin`
      ).toBe(true);
    }
  });

  it("the gather-then-resolve shape is ONE shared helper, not two copies", () => {
    const helper = read(HELPER);
    expect(
      /resolveProjectPlacement\(/.test(helper),
      "the helper must consume the ONE deterministic ladder, not re-implement it"
    ).toBe(true);
    // Two producers, one gather. A second copy is how the four rungs drift apart.
    for (const [name, src] of [
      ["open-run-session", read(RUN_DOOR)],
      ["create-session", read(START_DOOR)],
    ] as const) {
      expect(
        /resolveSessionProjectPlacement\(/.test(src),
        `${name} stopped consulting the shared ladder helper — it is back to ` +
          "waiting to be handed a project, which is the 10% fill rate"
      ).toBe(true);
    }
  });

  it("openRunSession writes the RESOLVED value, not the raw input", () => {
    const src = read(RUN_DOOR);
    // The bug shape: resolve into a local, then still spread `input.projectId`
    // into `.values()` — work done and discarded. tsc cannot see that.
    expect(
      /projectId:\s*placement\.projectId/.test(src),
      "the insert is not using the resolved placement"
    ).toBe(true);
    expect(
      /projectId:\s*input\.projectId\s*\?\?\s*null/.test(src),
      "the raw caller value is back in the insert — the derivation is inert"
    ).toBe(false);
  });

  it("createFocusSession writes the RESOLVED value, not the raw input", () => {
    const src = read(START_DOOR);
    expect(
      /const projectId = \(\s*await resolveSessionProjectPlacement\(/.test(src),
      "the derived project is no longer what the rest of the door calls `projectId`"
    ).toBe(true);
    // The caller's own value is destructured under a DIFFERENT name precisely so
    // an explicit pin can only reach the row THROUGH the ladder's rung 1.
    expect(
      /projectId:\s*explicitProjectId\s*=\s*null/.test(src),
      "the caller's raw projectId is bound to the door-local name again — an " +
        "explicit pin must enter through rung 1, not bypass the ladder"
    ).toBe(true);
  });

  it("no rung invents a project when the ladder abstains", () => {
    // The constraint most likely to be 'helpfully' broken later. `workspace` may
    // default; `project` may NOT — filing into a project is an exposure decision
    // (`belongs_to_project` unions project-member visibility ACROSS workspaces),
    // so NONE must reach the row as NULL.
    const forbidden =
      /projectId[^;\n]*\?\?\s*(?!null)(?:input\.|ctx\.|params\.|["'])/;
    for (const [name, src] of [
      ["open-run-session", read(RUN_DOOR)],
      ["resolve-session-project", read(HELPER)],
    ] as const) {
      const insertRegion = src.slice(src.indexOf("resolveProjectPlacement"));
      expect(
        forbidden.test(insertRegion),
        `${name} has a fallback after the ladder — there is no default project, ` +
          "and there is deliberately no AI rung"
      ).toBe(false);
    }
  });
});
