import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — `LinkEndpointType` has THREE copies (schema union, playbooks
 * mirror, hub-REST z.enum array) that must stay in lockstep. They already
 * drifted once silently: the REST `LINK_ENDPOINT_TYPES` array (rest/links.ts)
 * was missing "automation" / "project" / "secret" / "capability" that the
 * schema union had gained, which meant an agent could never create those edge
 * kinds over the Hub Protocol even though the schema allowed them.
 *
 * This test parses the source of the schema union and the REST array and
 * fails the moment either list gains/loses a member the other doesn't have —
 * catching the drift class at CI time instead of at "why can't I link a
 * capability" debugging time.
 *
 * Longer-term SSOT follow-up (not done here): derive `LINK_ENDPOINT_TYPES` in
 * rest/links.ts directly from the schema union (e.g. `z.enum` built off a
 * `satisfies readonly LinkEndpointType[]` array) so this can't drift again by
 * construction. Filed in WORKSPACE-RESOLUTION-PLAN.md Wave 4.
 */

/** Strip `// ...` line comments so a comment's punctuation (e.g. a stray
 * `;`) can never be mistaken for source syntax when scanning for block
 * boundaries below. None of the string literals this file cares about
 * ("playbook", "workspace", ...) contain `//`, so this is safe. */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function extractUnionMembers(src: string, typeName: string): string[] {
  const clean = stripLineComments(src);
  const start = clean.indexOf(`export type ${typeName} =`);
  if (start === -1) throw new Error(`${typeName} not found`);
  const end = clean.indexOf(";", start);
  const block = clean.slice(start, end);
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

function extractArrayMembers(src: string, constName: string): string[] {
  const clean = stripLineComments(src);
  const start = clean.indexOf(`const ${constName} = [`);
  if (start === -1) throw new Error(`${constName} not found`);
  const end = clean.indexOf("] as const", start);
  const block = clean.slice(start, end);
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("tripwire: LinkEndpointType SSOT (schema union vs hub-REST enum)", () => {
  it("rest/links.ts LINK_ENDPOINT_TYPES matches the schema union exactly", () => {
    const schemaSrc = readFileSync(
      join(process.cwd(), "..", "database", "src", "schema", "links.ts"),
      "utf8"
    );
    const restSrc = readFileSync(
      join(process.cwd(), "src", "routers", "hub-protocol", "rest", "links.ts"),
      "utf8"
    );

    const schemaTypes = new Set(
      extractUnionMembers(schemaSrc, "LinkEndpointType")
    );
    const restTypes = new Set(
      extractArrayMembers(restSrc, "LINK_ENDPOINT_TYPES")
    );

    const missingFromRest = [...schemaTypes].filter((t) => !restTypes.has(t));
    const extraInRest = [...restTypes].filter((t) => !schemaTypes.has(t));

    expect({ missingFromRest, extraInRest }).toEqual({
      missingFromRest: [],
      extraInRest: [],
    });
  });

  it("playbooks/index.ts LinkEndpointType mirror matches the schema union exactly", () => {
    const schemaSrc = readFileSync(
      join(process.cwd(), "..", "database", "src", "schema", "links.ts"),
      "utf8"
    );
    const playbooksSrc = readFileSync(
      join(process.cwd(), "..", "playbooks", "src", "index.ts"),
      "utf8"
    );

    const schemaTypes = new Set(
      extractUnionMembers(schemaSrc, "LinkEndpointType")
    );
    const playbooksTypes = new Set(
      extractUnionMembers(playbooksSrc, "LinkEndpointType")
    );

    const missingFromPlaybooks = [...schemaTypes].filter(
      (t) => !playbooksTypes.has(t)
    );
    const extraInPlaybooks = [...playbooksTypes].filter(
      (t) => !schemaTypes.has(t)
    );

    expect({ missingFromPlaybooks, extraInPlaybooks }).toEqual({
      missingFromPlaybooks: [],
      extraInPlaybooks: [],
    });
  });
});
