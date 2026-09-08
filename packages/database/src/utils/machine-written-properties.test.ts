/**
 * Guard for the machine-written read-only declaration.
 *
 * Two halves, because either alone passes on a real defect:
 *
 *  1. BEHAVIOURAL — drive the real pass over a fake repo modelling an EXISTING
 *     pod (defs already created, `uiHints` carrying user config and no
 *     `readOnly`). Asserts the VALUE arrives on the stored row, not that a key
 *     is declared somewhere. This is the half that would go red if the hint were
 *     only added to the seed literals, which reach no existing pod.
 *
 *  2. REACHABILITY SCAN — every seeder function that DECLARES one of these
 *     property defs must also CALL the pass. A slug added to the constant and to
 *     a third seeder, without the call, is a hint that converges nowhere; that is
 *     precisely the shape this codebase keeps shipping.
 *
 * What the scan does NOT cover, measured: granularity is the top-level
 * `export async function` block, not the call site — it cannot see that the call
 * sits AFTER the create-or-resolve loop that fills the map, nor that the map
 * passed in is the right one. Half 1 covers the pass's own behaviour; the
 * ordering inside the seeder is covered only by reading it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PropertyDef } from "../schema/property-defs.js";
import type { PropertyDefRepository } from "../repositories/property-def-repository.js";
import {
  MACHINE_WRITTEN_PROPERTY_SLUGS,
  ensureMachineWrittenPropertiesReadOnly,
} from "./machine-written-properties.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Minimal in-memory stand-in for the property_defs table. */
function makeFakeRepo(rows: Record<string, Record<string, unknown>>): {
  repo: Pick<PropertyDefRepository, "getById" | "update">;
  stored: Map<string, Record<string, unknown>>;
  updateCalls: string[];
} {
  const stored = new Map<string, Record<string, unknown>>(
    Object.entries(rows).map(([id, hints]) => [id, hints])
  );
  const updateCalls: string[] = [];
  const repo = {
    async getById(id: string) {
      const uiHints = stored.get(id);
      return uiHints === undefined
        ? null
        : ({ id, uiHints } as unknown as PropertyDef);
    },
    async update(id: string, input: { uiHints?: Record<string, unknown> }) {
      updateCalls.push(id);
      // Mirrors the real repo: the whole jsonb column is REPLACED.
      if (input.uiHints !== undefined) stored.set(id, input.uiHints);
      return { id, uiHints: stored.get(id) } as unknown as PropertyDef;
    },
  } as unknown as Pick<PropertyDefRepository, "getById" | "update">;
  return { repo, stored, updateCalls };
}

/** slug → id, the shape the seeder's create-or-resolve loop produces. */
function idsFor(slugs: readonly string[]): Map<string, string> {
  return new Map(slugs.map((slug) => [slug, `id-${slug}`]));
}

describe("ensureMachineWrittenPropertiesReadOnly — behaviour", () => {
  it("declares readOnly on an ALREADY-SEEDED pod's defs", async () => {
    // An existing pod: every def exists, none carries the hint, and each carries
    // configuration a user (or an older seed) put there.
    const { repo, stored } = makeFakeRepo(
      Object.fromEntries(
        MACHINE_WRITTEN_PROPERTY_SLUGS.map((slug) => [
          `id-${slug}`,
          { label: `My ${slug}`, inputType: "select", displayAs: "status" },
        ])
      )
    );

    const updated = await ensureMachineWrittenPropertiesReadOnly(
      repo,
      idsFor(MACHINE_WRITTEN_PROPERTY_SLUGS)
    );

    expect(updated.sort()).toEqual([...MACHINE_WRITTEN_PROPERTY_SLUGS].sort());
    for (const slug of MACHINE_WRITTEN_PROPERTY_SLUGS) {
      expect(stored.get(`id-${slug}`)).toEqual({
        label: `My ${slug}`,
        inputType: "select",
        displayAs: "status",
        readOnly: true,
      });
    }
  });

  it("merges rather than replaces, and is idempotent on a second run", async () => {
    const { repo, stored, updateCalls } = makeFakeRepo({
      "id-runStatus": { label: "Renamed by the user", helpText: "mine" },
    });
    const ids = idsFor(["runStatus"]);

    await ensureMachineWrittenPropertiesReadOnly(repo, ids);
    expect(stored.get("id-runStatus")).toEqual({
      label: "Renamed by the user",
      helpText: "mine",
      readOnly: true,
    });

    const second = await ensureMachineWrittenPropertiesReadOnly(repo, ids);
    expect(second).toEqual([]);
    expect(updateCalls).toEqual(["id-runStatus"]); // no rewrite on pass two
  });

  it("skips slugs this seeder does not own and ids with no row", async () => {
    const { repo, updateCalls } = makeFakeRepo({ "id-runStatus": {} });

    // Map holds only ONE of the machine-written slugs (the devplane seeder's
    // situation) plus one whose row was deleted underneath us.
    const updated = await ensureMachineWrittenPropertiesReadOnly(
      repo,
      new Map([
        ["runStatus", "id-runStatus"],
        ["sentiment", "id-vanished"],
      ])
    );

    expect(updated).toEqual(["runStatus"]);
    expect(updateCalls).toEqual(["id-runStatus"]);
  });
});

describe("machine-written slugs are reachable from the seeders", () => {
  const SEEDER_SOURCE = readFileSync(
    path.join(HERE, "ensure-system-profiles.ts"),
    "utf8"
  );
  const CALL = "ensureMachineWrittenPropertiesReadOnly(";

  /**
   * Split the seeder into its top-level exported functions. Derived by parsing,
   * never hand-listed — a new seeder joins the scan by existing.
   */
  const functionBlocks = (() => {
    const marker = /^export async function (\w+)/gm;
    const starts: Array<{ name: string; index: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = marker.exec(SEEDER_SOURCE)) !== null) {
      starts.push({ name: m[1]!, index: m.index });
    }
    return starts.map((s, i) => ({
      name: s.name,
      body: SEEDER_SOURCE.slice(
        s.index,
        i + 1 < starts.length ? starts[i + 1]!.index : SEEDER_SOURCE.length
      ),
    }));
  })();

  /**
   * A property-def DECLARATION, not a profile link row: `slug:` immediately
   * followed by `valueType:`. Both ends pinned. It cannot see a def built by
   * spread/loop rather than an object literal — none exists in this file today.
   */
  const declaresSlug = (body: string, slug: string) =>
    new RegExp(`slug:\\s*"${slug}",\\s*\\n\\s*valueType:`).test(body);

  it("the scan is not vacuous", () => {
    expect(functionBlocks.length).toBeGreaterThanOrEqual(3);
    expect(SEEDER_SOURCE).toContain(CALL);
    // Self-check: the declaration regex can still see a literal sample of what
    // it hunts — a def that is deliberately NOT machine-written.
    expect(
      functionBlocks.some((f) => declaresSlug(f.body, "questionStatus"))
    ).toBe(true);
  });

  it("every machine-written slug is declared by at least one seeder", () => {
    for (const slug of MACHINE_WRITTEN_PROPERTY_SLUGS) {
      const owners = functionBlocks
        .filter((f) => declaresSlug(f.body, slug))
        .map((f) => f.name);
      expect(owners, `no seeder declares a property def '${slug}'`).not.toEqual(
        []
      );
    }
  });

  it("every seeder that declares one also calls the convergence pass", () => {
    const owners = functionBlocks.filter((f) =>
      MACHINE_WRITTEN_PROPERTY_SLUGS.some((slug) => declaresSlug(f.body, slug))
    );
    // Non-vacuity: today two functions own these slugs.
    expect(owners.map((f) => f.name).sort()).toEqual([
      "ensureDevplaneProfiles",
      "ensureSystemProfiles",
    ]);
    for (const owner of owners) {
      expect(
        owner.body.includes(CALL),
        `${owner.name} declares a machine-written property def but never calls ${CALL}`
      ).toBe(true);
    }
  });
});
