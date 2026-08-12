/**
 * T4 — facet-on-approval regression.
 *
 * FLAG under investigation: when `POST /api/hub/entities` with
 * `facets:[{slug:'client'}]` is GOVERNANCE-GATED (a proposal is filed, no
 * entity id yet), does the requested `facets[]` survive to approval, and does
 * approve actually attach them?
 *
 * VERIFIED (this test): yes — already fixed, tagged "R2" in both source
 * files. `entities.ts`'s `create` mutation carries `input.facets` onto the
 * `checkPermissionOrPropose` gate data AND onto the "proposed" response
 * (`outcome: "pending"`); `approve-executors.ts`'s `entity/create` executor
 * reads `innerData.facets` back off the stored proposal and attaches each via
 * the governed `entityCaller.attachFacet` door (merged with any approve-time
 * `input.facets`, later wins on slug collision) after the entity
 * materializes. Nothing here reimplements the facet write door — this only
 * locks the wiring so a future edit can't silently drop it again (the exact
 * regression the bridge fix flagged).
 *
 * Source-level contract (no DB), matching this suite's established style for
 * governance-wiring regressions (see workspace-create-executor.test.ts).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { readExecutorsSource } from "./read-executors-source.js";

const API_SRC = join(process.cwd(), "src");

function readSrc(relFromApiSrc: string): string {
  return readFileSync(join(API_SRC, relFromApiSrc), "utf8");
}

describe("entities.create — requested facets survive onto the create proposal", () => {
  const src = readSrc("routers/entities.ts");

  it("gate data carries input.facets (not dropped before propose)", () => {
    const permBlockStart = src.indexOf("checkPermissionOrPropose({");
    const permBlockEnd = src.indexOf('if ("denied" in perm', permBlockStart);
    expect(permBlockStart).toBeGreaterThan(-1);
    const permBlock = src.slice(permBlockStart, permBlockEnd);
    expect(permBlock).toContain("input.facets");
    expect(permBlock).toMatch(/facets:\s*input\.facets\.map/);
  });

  it('the "proposed" response echoes the requested facets as pending (not silently dropped)', () => {
    const proposedStart = src.indexOf('status: "proposed"');
    expect(proposedStart).toBeGreaterThan(-1);
    const proposedBlock = src.slice(proposedStart, proposedStart + 1200);
    expect(proposedBlock).toContain("facets: (input.facets ?? [])");
    expect(proposedBlock).toContain('outcome: "pending"');
  });
});

describe("entity/create approve executor — replays the proposal's requested facets", () => {
  const src = readExecutorsSource(API_SRC);

  it('registers key "entity/create"', () => {
    expect(src).toMatch(/key:\s*["']entity\/create["']/);
  });

  it("reads facets back off the stored proposal payload (innerData.facets)", () => {
    const start = src.indexOf('key: "entity/create"');
    const end = src.indexOf('key: "property_def/create"', start);
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, end > start ? end : start + 6000);
    expect(block).toMatch(/innerData\.facets/);
  });

  it("attaches each proposed facet via the governed attachFacet door after materializing", () => {
    const start = src.indexOf('key: "entity/create"');
    const end = src.indexOf('key: "property_def/create"', start);
    const block = src.slice(start, end > start ? end : start + 6000);
    // Attach happens on the same entityCaller the entity was created through
    // (the governed door), keyed by the entity's real id post-materialize —
    // never a second, ad hoc `entity_facets` insert.
    expect(block).toContain("createdEntity.id");
    expect(block).toContain("entityCaller.attachFacet");
    expect(block).toMatch(/profileSlug:\s*facet\.profileSlug/);
  });

  it("merges proposal-time facets with approve-time facets (later wins on slug)", () => {
    const start = src.indexOf('key: "entity/create"');
    const end = src.indexOf('key: "property_def/create"', start);
    const block = src.slice(start, end > start ? end : start + 6000);
    expect(block).toContain("proposedFacets");
    expect(block).toContain("approveFacets");
    expect(block).toMatch(/\[\.\.\.proposedFacets,\s*\.\.\.approveFacets\]/);
  });
});
