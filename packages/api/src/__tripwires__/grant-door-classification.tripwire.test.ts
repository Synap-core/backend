/**
 * TRIPWIRE — every MCP READ tool is classified for scoped keys.
 *
 * The fence (`access/grant-door-fence.ts`) lets a fenced key through a read
 * tool only when MCP_READ_TOOL_DOORS says how the grant bounds it: SEAMED
 * (read through scopedDb / the grant hooks) or READS (an aggregate door that
 * declares its subjects; the key must read each one unnarrowed). The set is
 * DERIVED from the live tool list (`tools.list()`, `readOnlyHint: true`), so
 * a new read tool fails here until someone classifies it — and an entry for a
 * tool that is gone or is a write fails too.
 *
 * NOT COVERED (stated): whether a declared subject list is COMPLETE for its
 * door is a review question, not something this scan can see; a door that
 * reads one more subject than it declares is bounded too loosely. Hub REST
 * GET routes are not derived (the fence keeps its allow-list, fail closed).
 */
import { describe, expect, it } from "vitest";
import { tools } from "../routers/mcp/tools/index.js";
import { MCP_READ_TOOL_DOORS } from "../access/grant-door-fence.js";
import { GRANT_READ_SPECS } from "../access/grant-read.js";

describe("MCP read-tool classification (derived from the live tool list)", () => {
  it("classifies every read tool, and only read tools", async () => {
    const all = await tools.list();
    const reads = all
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name);
    // Non-vacuity: the scan sees the tool list and the doors it must cover.
    expect(all.length).toBeGreaterThan(60);
    expect(reads).toEqual(
      expect.arrayContaining(["synap_ask", "synap_orient", "synap_get_entity"])
    );
    expect(reads.length).toBeGreaterThanOrEqual(25);

    const classified = Object.keys(MCP_READ_TOOL_DOORS);
    expect(
      reads.filter((n) => !classified.includes(n)),
      "Classify the tool in MCP_READ_TOOL_DOORS (access/grant-door-fence.ts)."
    ).toEqual([]);
    expect(classified.filter((n) => !reads.includes(n))).toEqual([]);
  });

  it("declares only subjects the read hook knows", () => {
    const known = new Set([...GRANT_READ_SPECS.values()].map((s) => s.subject));
    const unknown = Object.entries(MCP_READ_TOOL_DOORS).flatMap(([n, d]) =>
      d.bound === "reads"
        ? d.subjects.filter((s) => !known.has(s)).map((s) => `${n}:${s}`)
        : []
    );
    expect(unknown).toEqual([]);
  });
});
