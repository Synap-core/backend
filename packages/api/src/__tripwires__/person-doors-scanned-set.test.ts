/**
 * TRIPWIRE — the person-doors check scans the real mutations, and its list
 * names only real ones (P2: every person-facing mutation has a person's door).
 *
 * `scripts/ci/person-doors.mjs` runs in "Dependent repos typecheck", before
 * any install, so it reads the scanned set from the committed bundle
 * packages/api-types/src/generated.d.ts instead of importing the routers. This
 * test proves that parse equals `coreRouter._def.procedures` (every procedure
 * whose type is mutation): a bundle format change that blinds the parser, or
 * a stale bundle, goes red here, in every PR that touches the api.
 *
 * It also holds the list (packages/api/src/routers/person-doors.json) honest
 * where the siblings are not needed: every row names a live mutation, an
 * agent-only row says why, and no path is in both maps.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coreRouter } from "../root.js";
import { mergeRouters, protectedProcedure, router } from "../trpc.js";
import {
  GENERATED_DTS,
  LIST_FILE,
  MIN_MUTATIONS,
  parseCoreMutations,
  parseList,
} from "../../../../scripts/ci/person-doors.mjs";

const BACKEND_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

type AnyRouter = {
  _def: {
    procedures: Record<string, { _def: { type?: string } }>;
    lazy?: Record<string, unknown>;
  };
};

const liveMutations = (r: unknown) =>
  Object.entries((r as AnyRouter)._def.procedures)
    .filter(([, p]) => p._def.type === "mutation")
    .map(([path]) => path)
    .sort();

/** Paths in one set and not the other, both ways. */
const drift = (live: string[], parsed: string[]) => ({
  notParsed: live.filter((p) => !parsed.includes(p)),
  notLive: parsed.filter((p) => !live.includes(p)),
});

const live = liveMutations(coreRouter);
const parsed = parseCoreMutations(
  readFileSync(join(BACKEND_ROOT, GENERATED_DTS), "utf8")
);
const list = parseList(readFileSync(join(BACKEND_ROOT, LIST_FILE), "utf8"));

describe("tripwire: person-doors scans the served mutations", () => {
  it("sees the served router (non-vacuity)", () => {
    expect(
      Object.keys((coreRouter as unknown as AnyRouter)._def.lazy ?? {})
    ).toEqual([]);
    // Measured 2026-11-13: 623.
    expect(live.length).toBeGreaterThanOrEqual(MIN_MUTATIONS);
    expect(live).toContain("shares.publishSite");
    expect(live).toContain("capabilities.containers.create");
  });

  it("the bundle parse equals coreRouter's mutations", () => {
    expect(
      drift(live, parsed),
      `Regenerate ${GENERATED_DTS} (pnpm --filter @synap/api gen-types), or, if it is current, fix parseCoreMutations in scripts/ci/person-doors.mjs`
    ).toEqual({ notParsed: [], notLive: [] });
  });

  it("defeat check: a mutation added to the router and not to the bundle is caught", () => {
    const fixture = mergeRouters(
      coreRouter,
      router({
        zzPersonDoorsFixture: router({
          probe: protectedProcedure.mutation(() => null),
        }),
      })
    );
    expect(drift(liveMutations(fixture), parsed).notParsed).toEqual([
      "zzPersonDoorsFixture.probe",
    ]);
  });
});

describe("tripwire: the person-doors list names real mutations", () => {
  const rows = [
    ...Object.keys(list.agentOnly),
    ...list.noPersonDoorYet,
  ] as string[];

  it("every row is a live mutation (remove the row of a mutation you removed or renamed)", () => {
    expect(rows.filter((p) => !live.includes(p))).toEqual([]);
  });

  it("an agent-only row says why no person should reach it", () => {
    expect(
      Object.entries(list.agentOnly as Record<string, unknown>)
        .filter(([, why]) => typeof why !== "string" || why.trim().length < 10)
        .map(([p]) => p)
    ).toEqual([]);
  });

  it("no path is both agent-only and owed a person's door, nor listed twice", () => {
    expect(
      (list.noPersonDoorYet as string[]).filter((p) =>
        Object.hasOwn(list.agentOnly, p)
      )
    ).toEqual([]);
    expect(new Set(list.noPersonDoorYet).size).toBe(
      list.noPersonDoorYet.length
    );
  });

  it("defeat check: a row naming no mutation is caught", () => {
    expect(
      ["shares.noSuchDoor", ...rows].filter((p) => !live.includes(p))
    ).toEqual(["shares.noSuchDoor"]);
  });
});
