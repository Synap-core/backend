/**
 * The title hard cap lives on the CANONICAL entity doors, so every caller —
 * MCP, Hub REST, the IS, the browser — is refused the same way: a title over
 * `TITLE_HARD_MAX` (200) is rejected, never stored and never clipped. The MCP
 * doors also pre-check (to name the length); this pins the floor under them.
 *
 * Reads the procedures' own input parsers, so a schema that drops the cap
 * fails here whichever door is used.
 */
import { describe, it, expect } from "vitest";
import { TITLE_HARD_MAX } from "@synap-core/types/titles";
import { entitiesRouter } from "../entities.js";

type Parser = {
  safeParse: (v: unknown) => {
    success: boolean;
    error?: { issues: Array<{ message: string }> };
  };
};
const procs = (
  entitiesRouter as unknown as { _def: { procedures: Record<string, unknown> } }
)._def.procedures;
const parserOf = (name: string): Parser =>
  (procs[name] as { _def: { inputs: Parser[] } })._def.inputs[0]!;

const atCap = "a".repeat(TITLE_HARD_MAX);
const overCap = "a".repeat(TITLE_HARD_MAX + 1);
const ID = "eeeeeeee-1111-4111-8111-111111111111";

describe("entity title hard cap", () => {
  it.each([
    [
      "create",
      parserOf("create"),
      (title: string) => ({ profileSlug: "note", title }),
    ],
    ["update", parserOf("update"), (title: string) => ({ id: ID, title })],
    [
      "batchCreate",
      parserOf("batchCreate"),
      (title: string) => ({
        entities: [{ refKey: "r1", profileSlug: "note", title }],
      }),
    ],
  ])(
    "%s accepts 200 characters and refuses 201 with the reason",
    (_, parser, input) => {
      expect(parser.safeParse(input(atCap)).success).toBe(true);
      const refused = parser.safeParse(input(overCap));
      expect(refused.success).toBe(false);
      expect(refused.error!.issues.map((i) => i.message).join(" ")).toMatch(
        /limit is 200.*Put the full text in the body/
      );
    }
  );
});
