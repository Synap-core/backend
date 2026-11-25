/**
 * person-doors.mjs decides whether a change ships a mutation no person can
 * reach (P2: "the backend has a door, a person has no door to it"). The
 * positive case it exists for: `shares.publishSite` had no surface until
 * browser 8e8d1219. These are fixture checks of the pure parts; the scan of
 * the real routers is proven in
 * packages/api/src/__tripwires__/person-doors-scanned-set.test.ts.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MIN_MUTATIONS,
  decide,
  dottedPaths,
  parseCoreMutations,
  parseList,
  scanSurfaces,
} from "./person-doors.mjs";

const PROC = (type: string, name: string, tabs: number) =>
  `${"\t".repeat(tabs)}${name}: import("@trpc/server").TRPC${type}Procedure<{`;
const ROUTER = (name: string, tabs: number) =>
  `${"\t".repeat(tabs)}${name}: import("@trpc/server").TRPCBuiltRouter<{`;

const BUNDLE = [
  'declare const other: import("@trpc/server").TRPCBuiltRouter<{',
  PROC("Mutation", "notCore", 1),
  "}>>;",
  'export declare const coreRouter: import("@trpc/server").TRPCBuiltRouter<{',
  "\tctx: Context;",
  '}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{',
  ROUTER("shares", 1),
  "\t\tctx: Context;",
  PROC("Query", "siteStatus", 2),
  PROC("Mutation", "publishSite", 2),
  PROC("Mutation", "configureSite", 2),
  ROUTER("capabilities", 1),
  ROUTER("containers", 2),
  PROC("Mutation", "create", 3),
  PROC("Mutation", "applyUpdates", 2),
  "}>>;",
  PROC("Mutation", "afterTheEnd", 1),
].join("\n");

/** A head/base pair big enough to clear the blind-parse floor. */
function sides(
  headExtra: string[],
  opts: {
    headList?: { agentOnly?: object; noPersonDoorYet?: string[] };
    baseList?: { agentOnly?: object; noPersonDoorYet?: string[] };
    baseExtra?: string[];
  } = {}
) {
  const common = Array.from({ length: MIN_MUTATIONS }, (_, i) => `r.m${i}`);
  const list = (l?: { agentOnly?: object; noPersonDoorYet?: string[] }) => ({
    agentOnly: l?.agentOnly ?? {},
    noPersonDoorYet: l?.noPersonDoorYet ?? [],
  });
  return {
    head: { mutations: [...common, ...headExtra], list: list(opts.headList) },
    base: {
      mutations: [...common, ...(opts.baseExtra ?? [])],
      list: list(opts.baseList),
    },
    reached: new Set(common),
  };
}

describe("person-doors: the scanned set", () => {
  it("reads every coreRouter mutation, nested routers included, and nothing else", () => {
    expect(parseCoreMutations(BUNDLE)).toEqual([
      "capabilities.applyUpdates",
      "capabilities.containers.create",
      "shares.configureSite",
      "shares.publishSite",
    ]);
  });

  it("refuses a bundle with no coreRouter (a failed read, never an empty set)", () => {
    expect(() => parseCoreMutations("export type X = 1;")).toThrow(
      /coreRouter/
    );
  });
});

describe("person-doors: what counts as a person's door", () => {
  const reaches = (src: string, path: string) => dottedPaths(src).has(path);

  it("a tRPC call reaches its path, however it is written", () => {
    const calls = [
      "trpc.shares.publishSite.useMutation({ onSuccess })",
      "await client.shares.publishSite.mutate(input)",
      "useConnectionStore.getState().trpc?.shares.publishSite.mutate(x)",
      "trpc.shares\n      .publishSite.useMutation()",
      'const PATHS = ["shares.publishSite"];',
    ];
    for (const src of calls)
      expect(reaches(src, "shares.publishSite"), src).toBe(true);
  });

  it("a comment, a longer name or a shorter one is not a door", () => {
    const notCalls = [
      "// No surface called shares.publishSite until now",
      "/** `shares.publishSite` is owed a UI */ const x = 1;",
      "trpc.shares.publishSiteNow.useMutation()",
      "trpc.myshares.publishSite.useMutation()",
      "trpc.shares.useQuery()",
    ];
    for (const src of notCalls)
      expect(reaches(src, "shares.publishSite"), src).toBe(false);
  });

  it("a nested router's path is reached", () => {
    expect(
      reaches(
        "trpc.capabilities.containers.create.useMutation()",
        "capabilities.containers.create"
      )
    ).toBe(true);
  });
});

describe("person-doors: the verdict (negative control included)", () => {
  it("NEGATIVE CONTROL: a new mutation no surface calls, with no row, fails", () => {
    const v = decide(sides(["shares.fakeUnsurfacedDoor"]));
    expect(v.ok).toBe(false);
    expect(v.added).toEqual(["shares.fakeUnsurfacedDoor"]);
  });

  it("the same mutation passes once a surface calls it", () => {
    const s = sides(["shares.fakeUnsurfacedDoor"]);
    s.reached.add("shares.fakeUnsurfacedDoor");
    expect(decide(s).ok).toBe(true);
  });

  it("…or once it is written down (agent-only with a reason, or owed a UI)", () => {
    expect(
      decide(
        sides(["shares.fakeUnsurfacedDoor"], {
          headList: { noPersonDoorYet: ["shares.fakeUnsurfacedDoor"] },
        })
      ).ok
    ).toBe(true);
    expect(
      decide(
        sides(["shares.fakeUnsurfacedDoor"], {
          headList: {
            agentOnly: { "shares.fakeUnsurfacedDoor": "the IS calls it" },
          },
        })
      ).ok
    ).toBe(true);
  });

  it("removing a row while the door is still missing fails", () => {
    const v = decide(
      sides(["shares.old"], {
        baseExtra: ["shares.old"],
        baseList: { noPersonDoorYet: ["shares.old"] },
      })
    );
    expect(v.ok).toBe(false);
    expect(v.delisted).toEqual(["shares.old"]);
  });

  it("an unlisted gap the change did not make only warns (a surface's own state never blocks a backend PR)", () => {
    const v = decide(sides(["shares.old"], { baseExtra: ["shares.old"] }));
    expect(v.ok).toBe(true);
    expect(v.notMine).toEqual(["shares.old"]);
  });

  it("a listed path that gained a door is reported for removal, not failed", () => {
    const s = sides(["shares.old"], {
      baseExtra: ["shares.old"],
      headList: { noPersonDoorYet: ["shares.old"] },
      baseList: { noPersonDoorYet: ["shares.old"] },
    });
    s.reached.add("shares.old");
    const v = decide(s);
    expect(v.ok).toBe(true);
    expect(v.nowReached).toEqual(["shares.old"]);
  });

  it("a blind parse (almost no mutation) is broken, never green", () => {
    const v = decide({
      head: { mutations: ["a.b"], list: parseList("{}") },
      base: { mutations: [], list: parseList("{}") },
      reached: new Set(),
    });
    expect(v.ok).toBe(false);
    expect(v.broken).toMatch(/blind/);
  });
});

describe("person-doors: the surfaces are read or the check fails", () => {
  const root = mkdtempSync(join(tmpdir(), "person-doors-"));
  mkdirSync(join(root, "browser", "electron", "__tests__"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "browser", "electron", "a.ts"),
    "trpc.shares.publishSite.useMutation()"
  );
  writeFileSync(
    join(root, "browser", "electron", "a.test.ts"),
    "trpc.shares.fromATest.useMutation()"
  );
  writeFileSync(
    join(root, "browser", "electron", "__tests__", "b.ts"),
    "trpc.shares.fromATestDir.useMutation()"
  );
  const browser = { repo: "browser", dirs: ["electron"], minFiles: 1 };

  it("reads source files and skips tests", () => {
    const { paths, files } = scanSurfaces(root, [browser]);
    expect(files).toEqual({ browser: 1 });
    expect(paths.has("shares.publishSite")).toBe(true);
    expect(paths.has("shares.fromATest")).toBe(false);
    expect(paths.has("shares.fromATestDir")).toBe(false);
  });

  it("a surface that is not checked out throws", () => {
    expect(() =>
      scanSurfaces(root, [{ repo: "relay-app", dirs: ["src"], minFiles: 1 }])
    ).toThrow(/not checked out/);
  });

  it("a surface under its file floor throws", () => {
    expect(() => scanSurfaces(root, [{ ...browser, minFiles: 2 }])).toThrow(
      /source files/
    );
  });
});
