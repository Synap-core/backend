/**
 * The find WIRE conforms to what every client's projection reads.
 *
 * `@synap-core/types/find` declares `FindWire`: only the fields `toFindRows`
 * reads. Clients (browser, relay, Raycast) compile against that, not against
 * this package. So a rename here that `FindWire` reads must fail THIS build,
 * not a client's: the assignment below is the check (`pnpm typecheck` of
 * @synap/api compiles this file; vitest does not typecheck).
 *
 * Plus, at run time: the object catalogs this door searches are exactly the
 * ones the row projection knows (a catalog added here and not there would be
 * searched and never drawn), and one real answer, built by the real door,
 * projects to rows (the seam, not a hand-built wire).
 *
 * NOT COVERED, measured: an OPTIONAL field the backend stops sending still
 * type-checks (optional on both sides); the catalog list check covers the
 * object blocks, the playbook fields are pinned by `match-session-template`'s
 * own tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  FIND_WIRE_OBJECT_CATALOGS,
  toFindRows,
  type FindWire,
} from "@synap-core/types/find";
import type { FindByIntentResult } from "./find-intent.js";
import { OBJECT_CATALOGS } from "./find-objects.js";

// TYPE-LEVEL CONFORMANCE: the backend's answer IS a FindWire.
const conforms = (r: FindByIntentResult): FindWire => r;
void conforms;
// And the catalog vocabularies are the same set, both ways.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const sameCatalogs: Same<
  (typeof OBJECT_CATALOGS)[number],
  (typeof FIND_WIRE_OBJECT_CATALOGS)[number]
> = true;
void sameCatalogs;

vi.mock("./capability-registry.js", () => ({
  listCapabilities: async () => [
    {
      id: "cap-google",
      name: "Google",
      kind: "source-provider",
      description: null,
      inputSchema: {},
      executor: "provider",
      governance: "auto",
      enabled: true,
      verbs: [
        {
          id: "gmail_search",
          label: "Search email",
          kind: "read",
          granted: true,
          govDefault: "auto",
          effectiveExecMode: "auto",
          backingSkillExecutable: true,
        },
      ],
    },
  ],
}));
vi.mock("./intent-registry.js", () => ({
  listIntentSlugs: async () => [],
  listIntentRows: async () => [],
}));

describe("find wire ↔ @synap-core/types/find", () => {
  it("searches exactly the object catalogs the row projection draws, in the same order", () => {
    expect([...OBJECT_CATALOGS]).toEqual([...FIND_WIRE_OBJECT_CATALOGS]);
  });

  it("a real answer of the door projects to a typed, tiered row (the seam)", async () => {
    const { findByIntent } = await import("./find-intent.js");
    const result = await findByIntent({
      intent: "search email",
      workspaceId: null,
      userId: "u1",
      catalogs: ["capabilities"],
    });
    const { rows } = toFindRows(result, {
      catalogs: ["capabilities"],
      max: 5,
      query: "search email",
    });
    expect(rows[0]).toMatchObject({
      role: "action",
      id: "gmail_search",
      tier: "read-only",
      run: { verbId: "gmail_search" },
    });
  });
});
