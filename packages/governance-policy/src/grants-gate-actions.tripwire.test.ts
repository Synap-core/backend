/**
 * `GRANT_GATE_ACTIONS` (grants.ts) decides how `entity.<x>` parses: a listed
 * verb is "x on every kind" (`entity.merge`), anything else is the kind x.
 * The entity subject's gate verbs are DERIVED here from the governed-write
 * doors (`entity/<verb>`) and `DESTRUCTIVE_ACTIONS`, so a new entity verb that
 * is not listed fails this file instead of silently parsing as a kind (a grant
 * on nothing — fail closed, but the person's intent lost).
 *
 * What this does NOT cover: verbs of other subjects (they never need the list:
 * only `entity` is kind-qualified), and dotted door verbs (`renderer.set`,
 * `capture.graph`) — the grammar cannot spell them, so only `*` grants them.
 * It does not prove a listed verb is not some pod's kind slug; the types-side
 * grammar test checks the list against the known kinds.
 */
import { describe, expect, it } from "vitest";
import { DESTRUCTIVE_ACTIONS, GOVERNED_WRITE_DOORS } from "./index.js";
import {
  GRANT_ACTIONS,
  GRANT_GATE_ACTIONS,
  parsePermission,
} from "./grants.js";

const SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;
const crud = GRANT_ACTIONS as readonly string[];

const entityDoorVerbs = Object.keys(GOVERNED_WRITE_DOORS)
  .filter((k) => k.startsWith("entity/"))
  .map((k) => k.slice("entity/".length));

const derived = [
  ...new Set(
    [...entityDoorVerbs, ...DESTRUCTIVE_ACTIONS].filter(
      (v) => SEGMENT.test(v) && !crud.includes(v)
    )
  ),
];

describe("entity gate verbs parse as verbs", () => {
  it("still sees the entity doors (non-vacuity)", () => {
    expect(entityDoorVerbs).toEqual(
      expect.arrayContaining(["create", "update", "delete", "merge"])
    );
    expect(derived).toEqual(expect.arrayContaining(["merge", "archive"]));
  });

  it.each(derived)("entity.%s parses as that verb on every kind", (verb) => {
    expect(GRANT_GATE_ACTIONS as readonly string[]).toContain(verb);
    expect(parsePermission(`entity.${verb}`)).toEqual(["entity", "*", verb]);
  });

  it("no gate verb is a catalog action", () => {
    for (const v of GRANT_GATE_ACTIONS) expect(crud).not.toContain(v);
  });
});
