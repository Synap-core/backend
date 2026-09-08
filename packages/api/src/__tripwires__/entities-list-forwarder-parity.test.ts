import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — the Hub forwarder must FORWARD every entity-list filter it declares.
 *
 * `entities.list` (routers/entities/read.ts) is the ONE door for listing
 * entities. Agents and MCP never call it directly: they go through
 * `hub-protocol/entities.ts`'s `getEntities`, which is a zod WHITELIST — and zod
 * strips every key it does not name. So a filter can be added to `list`, be
 * fully implemented in SQL, be typed end-to-end, and reach ZERO agents, with a
 * 200 on every call. That has already happened on this exact router: `content`
 * was missing from `createEntity`'s input, so every `POST /api/hub/entities`
 * silently dropped the body of the entity — 200 OK, `documentId` NULL, essay
 * gone.
 *
 * Declaring the key is only HALF of it. A param can be declared in the
 * forwarder's input and then simply not passed on to `caller.list({...})`, which
 * is the same silent drop one line later and looks identical from outside. So
 * this asserts the FORWARDING, not the declaration.
 *
 * DERIVED, not hand-listed: the checked set is the INTERSECTION of the two
 * declared inputs, so a filter added to both schemas joins this scan BY
 * EXISTING. A hand-written list of params would hold exactly the ones that were
 * already right.
 *
 * WHAT THIS DOES NOT COVER, measured:
 *   - It is a SOURCE scan of the forwarder body, not an execution. It proves the
 *     key is passed; it cannot prove the value is the right one.
 *   - It says nothing about params `list` declares that the forwarder does NOT —
 *     that set is large and deliberate (`edges`, `includeFacets`, …). The
 *     invariant is one-directional: what the forwarder ACCEPTS, it must PASS ON.
 *   - The REST layer above (`hub-protocol/rest/entities.ts`) is a third door with
 *     its own query schema; the `q`/Typesense branch there applies almost none of
 *     these filters. That drop is documented at the branch and is NOT covered
 *     here.
 */

const READ_DOOR = join(process.cwd(), "src", "routers", "entities", "read.ts");
const FORWARDER = join(
  process.cwd(),
  "src",
  "routers",
  "hub-protocol",
  "entities.ts"
);

/** Comments are prose; a `//` note mentioning a param name must never count as
 *  a declaration or a forward. Block comments too — a JSDoc naming a field is
 *  exactly how a scan in this repo came to read words out of prose. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** The keys of a `z.object({...})`-shaped input block, read as `name: z.…`. */
function zodKeys(src: string, startMarker: string): string[] {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const end = src.indexOf("\n    )\n", start);
  const block = src.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*z\./gm)].map(
    (m) => m[1]!
  );
}

describe("tripwire: the Hub entities forwarder passes on every filter it accepts", () => {
  const readSrc = stripComments(readFileSync(READ_DOOR, "utf8"));
  const fwdSrc = stripComments(readFileSync(FORWARDER, "utf8"));

  const listKeys = new Set(zodKeys(readSrc, "  list: podProcedure"));
  const fwdKeys = zodKeys(fwdSrc, "  getEntities: scopedProcedure");

  /** The body of the `caller.list({ … })` call inside `getEntities`. */
  const forwardedBody = (() => {
    const at = fwdSrc.indexOf("const result = await caller.list({");
    expect(at, "the forwarder no longer calls caller.list").toBeGreaterThan(-1);
    return fwdSrc.slice(at, fwdSrc.indexOf("});", at));
  })();

  /**
   * Keys the forwarder accepts that are deliberately NOT passed to `list` under
   * their own name. Both are structural, not filters:
   *   - `userId`      — the acting user; it builds the CALLER CONTEXT
   *                     (`createHubProtocolCallerContext`), it is not a list arg.
   *   - `workspaceId` — same: it pins the caller's lens, and `list` then reads it
   *                     from ctx.
   *   - `type`        — a deprecated ALIAS, coalesced into `profileSlug` before
   *                     the call (`input.profileSlug ?? input.type`).
   */
  const STRUCTURAL = new Set(["userId", "workspaceId", "type"]);

  it("the scan can see both inputs and their overlap (non-vacuity)", () => {
    // A marker that stopped matching, or a block boundary that collapsed, would
    // make every assertion below trivially true.
    expect(listKeys.size).toBeGreaterThanOrEqual(10);
    expect(fwdKeys.length).toBeGreaterThanOrEqual(8);
    // Self-check on a literal sample of what it hunts, in both directions.
    expect(listKeys.has("profileSlug")).toBe(true);
    expect(listKeys.has("createdAfter")).toBe(true);
    expect(fwdKeys).toContain("facetSlug");
    expect(fwdKeys).toContain("createdAfter");
    expect(forwardedBody).toContain("facetSlug");
  });

  it("every filter the forwarder accepts is actually passed to entities.list", () => {
    const shared = fwdKeys.filter((k) => listKeys.has(k) && !STRUCTURAL.has(k));
    // Non-vacuity: the shared set must be a real population, not empty.
    expect(shared.length).toBeGreaterThanOrEqual(5);

    const dropped = shared.filter(
      (k) => !new RegExp(`\\b${k}\\b`).test(forwardedBody)
    );
    expect(
      dropped,
      "These params are ACCEPTED by the Hub `getEntities` forwarder but never " +
        "passed on to `entities.list`, so every agent and MCP caller that sends " +
        "them gets a 200 with the filter silently dropped. Forward them in the " +
        "`caller.list({...})` call."
    ).toEqual([]);
  });

  it("the creation-date window reaches the one door under BOTH bound names", () => {
    // The window is only useful as a window: forwarding one bound and dropping
    // the other silently widens the query to open-ended, which reads as a
    // working filter and under-reports nothing — it OVER-reports, which is
    // harder to notice than an empty page.
    expect(forwardedBody).toContain("createdAfter");
    expect(forwardedBody).toContain("createdBefore");
    expect(listKeys.has("createdBefore")).toBe(true);
  });

  it("neither bound is named `since` — that token means replay-cursor here", () => {
    // `since` already means a replay cursor in this codebase. A read filter
    // reusing it would give one word two incompatible meanings on adjacent
    // doors, which is how the wrong one gets wired.
    expect([...listKeys]).not.toContain("since");
    expect(fwdKeys).not.toContain("since");
  });
});
