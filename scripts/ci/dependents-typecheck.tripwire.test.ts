/**
 * dependents-typecheck.mjs decides the required check "Dependent repos
 * typecheck": a dependent fails it only with errors THIS change introduces.
 * The 9 Nov case (backend#967, #969) is the fixture: an exhaustive floor in
 * app-bases headless turned red against the new types.
 */
import { describe, expect, it } from "vitest";

import {
  TARGETS,
  decide,
  newErrors,
  parseTscErrors,
  // @ts-expect-error plain .mjs
} from "./dependents-typecheck.mjs";

const FLOOR =
  "src/connectors/model.ts(423,7): error TS2322: Type 'true' is not assignable to type 'never'.";
const OLD =
  "src/sample-world/commitment.ts(15,42): error TS2339: Property 'signals' does not exist on type 'unknown'.";

const green = () =>
  Object.fromEntries(
    TARGETS.map((t: { key: string }) => [t.key, { exit: 0, errors: [] }])
  );
const withHeadless = (exit: number, ...lines: string[]) => ({
  ...green(),
  "app-bases-headless": { exit, errors: parseTscErrors(lines.join("\n")) },
});

describe("dependents-typecheck", () => {
  it("reads tsc error lines, with or without a pnpm prefix or colour", () => {
    const out = parseTscErrors(
      [
        "> @synap-core/headless@0.0.0 type-check",
        FLOOR,
        `packages/headless type-check: ${OLD}`,
        "\x1b[31msrc/a.ts(1,2): error TS2307: Cannot find module 'x'.\x1b[0m",
        "Found 3 errors.",
      ].join("\n")
    );
    expect(
      out.map((e: { file: string; code: string }) => `${e.file} ${e.code}`)
    ).toEqual([
      "src/connectors/model.ts TS2322",
      "src/sample-world/commitment.ts TS2339",
      "src/a.ts TS2307",
    ]);
    expect(out[0]).toMatchObject({ line: 423, col: 7 });
  });

  it("all green: passes, no baseline needed", () => {
    expect(decide(green()).ok).toBe(true);
  });

  it("a new floor error (backend#967): fails, and names it", () => {
    const v = decide(withHeadless(2, FLOOR, OLD), withHeadless(2, OLD));
    expect(v.ok).toBe(false);
    const t = v.targets.find(
      (x: { key: string }) => x.key === "app-bases-headless"
    );
    expect(t.state).toBe("new");
    expect(t.fresh).toHaveLength(1);
    expect(t.fresh[0].file).toBe("src/connectors/model.ts");
    expect(t.preexisting).toBe(1);
  });

  it("a dependent red on its own (the same errors at the base): passes", () => {
    const v = decide(withHeadless(2, OLD), withHeadless(2, OLD));
    expect(v.ok).toBe(true);
    expect(v.targets[0].state).toBe("preexisting");
  });

  // The comparison itself (lead, 9 Nov): a base already red with N errors.
  // Head = base + 1 must fail with exactly that one; head = base must pass.
  // Removing the comparison either way turns one of these two red: reading
  // every head error as new fails "head = base"; ignoring head when a base
  // exists fails "base + 1".
  describe("head vs a base that already has N errors", () => {
    const BASE = [
      OLD,
      "src/a.ts(3,1): error TS2307: Cannot find module 'x'.",
      "src/b.ts(9,4): error TS7006: Parameter 'p' implicitly has an 'any' type.",
    ];
    for (const n of [1, 3]) {
      const base = BASE.slice(0, n);
      it(`N=${n}, head adds one: fails, naming only the new one`, () => {
        const v = decide(
          withHeadless(2, ...base, FLOOR),
          withHeadless(2, ...base)
        );
        expect(v.ok).toBe(false);
        const t = v.targets[0];
        expect(t.state).toBe("new");
        expect(t.fresh.map((e: { file: string }) => e.file)).toEqual([
          "src/connectors/model.ts",
        ]);
        expect(t.preexisting).toBe(n);
      });
      it(`N=${n}, head equals base: passes`, () => {
        const v = decide(withHeadless(2, ...base), withHeadless(2, ...base));
        expect(v.ok).toBe(true);
        expect(v.targets[0]).toMatchObject({
          state: "preexisting",
          preexisting: n,
        });
      });
    }
  });

  it("an error that only moved lines is not new; one more of the same is", () => {
    const moved = OLD.replace("(15,42)", "(19,42)");
    expect(newErrors(parseTscErrors(moved), parseTscErrors(OLD))).toHaveLength(
      0
    );
    expect(
      newErrors(parseTscErrors(`${OLD}\n${moved}`), parseTscErrors(OLD))
    ).toHaveLength(1);
  });

  it("a red head with no baseline reads every error as new", () => {
    expect(decide(withHeadless(2, OLD)).ok).toBe(false);
  });

  it("a target that exits non-zero with no error line did not typecheck: fails", () => {
    const v = decide(withHeadless(1), withHeadless(1));
    expect(v.ok).toBe(false);
    expect(v.targets[0].state).toBe("broken");
  });

  it("a target with no head result did not run: fails", () => {
    const head = green();
    delete head["relay-app"];
    const v = decide(head);
    expect(v.ok).toBe(false);
    expect(
      v.targets.find((x: { key: string }) => x.key === "relay-app").state
    ).toBe("missing");
  });

  it("checks app-bases (headless, hooks, web), browser and relay-app", () => {
    expect(TARGETS.map((t: { key: string }) => t.key)).toEqual([
      "app-bases-headless",
      "app-bases-hooks",
      "app-bases-web",
      "browser",
      "relay-app",
    ]);
  });
});
