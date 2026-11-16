/**
 * The sibling roll registry (scripts/ci/roll.mjs, plan b5820982 §2 step 1):
 * which siblings can roll, what regenerates their mirrors, and that a pin never
 * moves without them. Pins: the registry agrees with the real
 * sibling-pins.json and the real mirror file; a pinned sibling without a row
 * (or a row without a pin) is named; `apply` refuses a checkout that is not at
 * the target, runs regenerate then check, and writes the pin only after both;
 * a failing step leaves the pins file alone; `plan` writes nothing.
 * NOT COVERED: the real GitHub API call and the real regenerate commands
 * (they need the private sibling checkout; the CP-pinned freshness tripwire
 * and preflight cover the generated table).
 * Named `*.tripwire.test.ts` so `pnpm tripwires` (CI) runs it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SIBLINGS,
  apply,
  parseArgs,
  plan,
  registryProblems,
  render,
  selectSiblings,
  withPin,
} from "./roll.mjs";
import { CHECKS } from "../preflight.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const DIR = "synap-control-plane-api";
const PINS = new Map([[DIR, OLD]]);
const pinsText = (ref: string) =>
  `${JSON.stringify(
    {
      $note: "n",
      repos: [{ dir: DIR, repo: "Synap-core/control-plane-api", ref }],
    },
    null,
    2
  )}\n`;

type Call = { argv: string[]; cwd: string };
function fakeIo(
  over: {
    head?: string | undefined;
    failOn?: string;
    target?: string;
    checkFails?: boolean;
  } = {}
) {
  const calls: Call[] = [];
  const writes: Array<[string, string]> = [];
  const io = {
    root: "/r",
    read: () => pinsText(OLD),
    write: (p: string, t: string) => void writes.push([p, t]),
    exists: () => true,
    head: () => ("head" in over ? over.head : (over.target ?? NEW)),
    resolveRef: async () => over.target ?? NEW,
    run: (argv: string[], cwd: string) => {
      calls.push({ argv, cwd });
      const bad =
        (over.failOn && argv.join(" ").includes(over.failOn)) ||
        (over.checkFails && argv.includes("--check"));
      return { code: bad ? 1 : 0, out: bad ? "boom" : "" };
    },
  };
  return { io, calls, writes };
}

describe("the registry agrees with the repo", () => {
  it("has no problem against the real pins file and real mirror outputs", () => {
    const pins = new Map(
      (
        JSON.parse(readFileSync(join(REPO, "sibling-pins.json"), "utf8")) as {
          repos: Array<{ dir: string; ref: string }>;
        }
      ).repos.map((r) => [r.dir, r.ref])
    );
    expect(
      registryProblems(SIBLINGS, pins, {
        exists: (o: string) => existsSync(join(REPO, o)),
      })
    ).toEqual([]);
  });

  it("registers door-tool-names with the generator, prettier, then --check", () => {
    const m = SIBLINGS[0].mirrors[0];
    expect(
      m.regenerate.map((s: { argv: string[] }) => s.argv.join(" "))
    ).toEqual([
      "npx tsx src/routers/mcp/gen-door-tool-names.ts",
      "npx prettier --write packages/api/src/routers/mcp/door-tool-names.generated.ts",
    ]);
    expect(m.check[0].argv.at(-1)).toBe("--check");
  });

  it("names a pinned sibling with no registry row", () => {
    const p = registryProblems([], new Map([[DIR, OLD]]));
    expect(p.join()).toContain(`pins ${DIR}`);
    expect(p.join()).toContain("no registry row");
  });

  it("names a registry row with no pin, and a row with no regenerate or check", () => {
    const row = {
      ...SIBLINGS[0],
      mirrors: [{ id: "m", outputs: ["x"], regenerate: [], check: [] }],
    };
    const p = registryProblems([row], new Map()).join("\n");
    expect(p).toContain("has no pin");
    expect(p).toContain("no regenerate command");
    expect(p).toContain("no check command");
  });

  it("names a mirror whose output file is missing", () => {
    expect(
      registryProblems(SIBLINGS, PINS, { exists: () => false }).join()
    ).toContain("does not exist");
  });

  it("preflight carries the check and it passes on this tree, fails on an unregistered pin", async () => {
    const check = CHECKS.find(
      (c: { id: string }) => c.id === "sibling-registry"
    );
    expect(check).toBeTruthy();
    expect((await check.run({ env: {} })).verdict).toBe("PASS");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "pins-"));
    const file = join(dir, "pins.json");
    writeFileSync(
      file,
      JSON.stringify({
        repos: [
          {
            dir: "synap-control-plane-api",
            repo: "Synap-core/control-plane-api",
            ref: OLD,
          },
          { dir: "synap-app", repo: "Synap-core/app-bases", ref: NEW },
        ],
      })
    );
    const r = await check.run({ env: {}, pinsFile: file });
    expect(r.verdict).toBe("FAIL");
    expect(r.detail).toContain("synap-app");
    expect(r.detail).toContain("no registry row");
  });
});

describe("withPin", () => {
  it("changes only the ref and keeps the note", () => {
    const out = withPin(pinsText(OLD), DIR, NEW);
    expect(out).toBe(pinsText(NEW));
  });
  it("refuses a branch, a short sha and an unpinned dir", () => {
    expect(() => withPin(pinsText(OLD), DIR, "main")).toThrow(/40-character/);
    expect(() => withPin(pinsText(OLD), DIR, "abc1234")).toThrow(
      /40-character/
    );
    expect(() => withPin(pinsText(OLD), "app-bases", NEW)).toThrow(/pins no/);
  });
});

describe("apply", () => {
  it("regenerates, checks, then writes the pin, in that order", async () => {
    const { io, calls, writes } = fakeIo();
    const done = await apply(io, {});
    expect(done).toEqual([{ dir: DIR, from: OLD, to: NEW }]);
    expect(calls.map((c) => c.argv.join(" "))).toEqual([
      "npx tsx src/routers/mcp/gen-door-tool-names.ts",
      "npx prettier --write packages/api/src/routers/mcp/door-tool-names.generated.ts",
      "npx tsx src/routers/mcp/gen-door-tool-names.ts --check",
    ]);
    expect(calls[0].cwd).toBe("/r/packages/api");
    expect(writes).toEqual([["sibling-pins.json", pinsText(NEW)]]);
  });

  it("refuses when the sibling checkout is not at the target, writing nothing", async () => {
    for (const head of ["c".repeat(40), undefined]) {
      const { io, calls, writes } = fakeIo({ head });
      await expect(apply(io, {})).rejects.toThrow(/not at/);
      expect(calls).toEqual([]);
      expect(writes).toEqual([]);
    }
  });

  it("a failing regenerate or check leaves the pins file alone", async () => {
    for (const failOn of ["prettier", "--check", "gen-door-tool-names"]) {
      const { io, writes } = fakeIo({ failOn });
      await expect(apply(io, {})).rejects.toThrow(/exited 1/);
      expect(writes).toEqual([]);
    }
  });

  it("refuses to run while the registry and pins disagree", async () => {
    const { io, calls, writes } = fakeIo();
    await expect(apply(io, {}, [])).rejects.toThrow(/no registry row/);
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("plan", () => {
  it("writes nothing and says the mirrors are stale when the check fails", async () => {
    const { io, writes } = fakeIo({ checkFails: true });
    const [p] = await plan(io, {});
    expect(writes).toEqual([]);
    expect(p).toMatchObject({
      pin: OLD,
      target: NEW,
      pinMoves: true,
      mirrorsChanged: true,
    });
    expect(render([p])).toContain("STALE");
  });
  it("says unchanged when the check passes at the target", async () => {
    const { io } = fakeIo();
    const [p] = await plan(io, {});
    expect(p.mirrorsChanged).toBe(false);
  });
  it("does not guess when the checkout is elsewhere, and runs no command", async () => {
    const { io, calls } = fakeIo({ head: "c".repeat(40) });
    const [p] = await plan(io, {});
    expect(p.mirrorsChanged).toBeNull();
    expect(calls).toEqual([]);
    expect(render([p])).toContain("unknown");
  });
  it("uses --ref over the default head", async () => {
    const asked: Array<string | undefined> = [];
    const { io } = fakeIo();
    io.resolveRef = async (_r: string, ref?: string) => (asked.push(ref), NEW);
    await plan(io, { ref: OLD });
    await plan(io, {});
    expect(asked).toEqual([OLD, "HEAD"]);
  });
});

describe("the CLI surface", () => {
  it("parses --sibling and --ref, rejects the unknown", () => {
    expect(parseArgs(["plan", "--sibling", DIR, "--ref=" + NEW])).toEqual({
      command: "plan",
      opts: { sibling: DIR, ref: NEW },
    });
    expect(() => parseArgs(["plan", "--nope"])).toThrow(/unknown argument/);
  });
  it("selects one registered sibling and refuses an unregistered one", () => {
    expect(selectSiblings(SIBLINGS, DIR)).toHaveLength(1);
    expect(() => selectSiblings(SIBLINGS, "app-bases")).toThrow(/not rollable/);
  });
});
