/**
 * TRIPWIRE — the MCP tools advertise ONE `blockedReason` set and ONE `ask`
 * shape, both DERIVED from their source.
 *
 * `blockedReason` was hand-listed THREE times in `routers/mcp/tools/index.ts`
 * (start_session items, update_session items, addOutput) while every other
 * door spread `BLOCKED_REASONS` from `@synap/playbooks`. A seventh blocker
 * would have been parseable everywhere and ADVERTISED nowhere — a model is only
 * ever told what the schema lists. The copies now spread the constant; this
 * pins that, and pins the new `ask` property to `z.toJSONSchema(AskSchema)`,
 * the schema the wire actually parses `ask` with.
 *
 * DERIVED BY WALKING both the live `tools.list()` and the COMMITTED manifest
 * (the artifact the Control Plane serves), so a fourth `blockedReason` or
 * `ask` on a fifth tool joins the audit by existing.
 *
 * WHAT IT DOES NOT COVER: whether the handler PARSES what is advertised — that
 * is `session-output-ref-tool-schema.test.ts` / `slot-ask.test.ts`. It also
 * compares the ask schema MINUS its prose `description` (prose is layered on
 * top and is not what drifts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { BLOCKED_REASONS } from "@synap/playbooks";
import {
  ASK_MODES,
  ASK_PROVIDE_KINDS,
  AskOptionSchema,
  AskSchema,
} from "@synap-core/types/ask";
import { tools } from "../routers/mcp/tools/index.js";
import { buildAskWireSchema } from "../routers/mcp/tools/ask-wire-schema.js";

const HUB_TYPES = resolve(
  import.meta.dirname,
  "../../../hub-rest-client/src/types.ts"
);

/**
 * The literals of one union in the hub-rest-client SOURCE, anchored at BOTH
 * ends (`export type <name> =` … the next `export`), so a scan cannot wander
 * into a neighbouring union in a large types file. That package is
 * dependency-free and api does not depend on it, so a type-level check is not
 * available — the same textual precedent `output-ref-kinds-parity` uses.
 */
function hubUnionLiterals(typeName: string, field: string): string[] {
  const src = readFileSync(HUB_TYPES, "utf8");
  const block = new RegExp(
    `export type ${typeName} =([\\s\\S]*?)\\nexport `
  ).exec(src);
  if (!block) return [];
  return [
    ...block[1]!.matchAll(new RegExp(`\\b${field}:\\s*"([a-z_]+)"`, "g")),
  ].map((m) => m[1]!);
}

const MANIFEST = resolve(
  import.meta.dirname,
  "../routers/mcp/tools/mcp-tools.manifest.json"
);

/** Every property NAMED `name` anywhere in a JSON Schema tree, with its path. */
function propertiesNamed(
  name: string,
  node: unknown,
  path = "$",
  out: Array<{ path: string; schema: Record<string, unknown> }> = []
): Array<{ path: string; schema: Record<string, unknown> }> {
  if (Array.isArray(node)) {
    node.forEach((v, i) => propertiesNamed(name, v, `${path}[${i}]`, out));
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const obj = node as Record<string, unknown>;
  const props = obj.properties as Record<string, unknown> | undefined;
  if (props && typeof props === "object" && props[name]) {
    out.push({
      path: `${path}.properties.${name}`,
      schema: props[name] as Record<string, unknown>,
    });
  }
  for (const [k, v] of Object.entries(obj)) {
    // Do not descend into the found property itself for the same name.
    propertiesNamed(name, v, `${path}.${k}`, out);
  }
  return out;
}

const withoutDescription = (s: Record<string, unknown>) => {
  const { description: _d, ...rest } = s;
  return rest;
};

const DERIVED_ASK = (() => {
  const j = z.toJSONSchema(AskSchema as unknown as z.ZodType<any, any, any>, {
    io: "input",
  }) as Record<string, unknown>;
  delete j.$schema;
  return j;
})();

const TOOL_LIST = (await tools.list()) as unknown as Array<
  Record<string, unknown>
>;
const MANIFEST_TOOLS = (
  JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    tools: Array<Record<string, unknown>>;
  }
).tools;

describe("tripwire: MCP slot schemas derive from their one source", () => {
  it("NON-VACUITY: both scans find the three declare doors", () => {
    expect(TOOL_LIST.length).toBeGreaterThan(20);
    expect(MANIFEST_TOOLS.length).toBeGreaterThan(20);
    // start_session items, update_session items, update_session addOutput.
    expect(
      propertiesNamed("blockedReason", TOOL_LIST).length
    ).toBeGreaterThanOrEqual(3);
    expect(
      propertiesNamed("blockedReason", MANIFEST_TOOLS).length
    ).toBeGreaterThanOrEqual(3);
    expect(propertiesNamed("ask", TOOL_LIST).length).toBeGreaterThanOrEqual(3);
    expect(
      propertiesNamed("ask", MANIFEST_TOOLS).length
    ).toBeGreaterThanOrEqual(3);
    // SELF-CHECK: the walker still sees a literal sample.
    expect(
      propertiesNamed("x", { properties: { x: { enum: ["a"] } } })
    ).toHaveLength(1);
  });

  it.each([
    ["live tools.list()", TOOL_LIST],
    ["committed manifest", MANIFEST_TOOLS],
  ])(
    "every advertised blockedReason enum IS BLOCKED_REASONS (%s)",
    (_, tree) => {
      const drifted = propertiesNamed("blockedReason", tree).filter(
        (p) =>
          JSON.stringify(p.schema.enum) !== JSON.stringify([...BLOCKED_REASONS])
      );
      expect(drifted.map((d) => d.path)).toEqual([]);
    }
  );

  it.each([
    ["live tools.list()", TOOL_LIST],
    ["committed manifest", MANIFEST_TOOLS],
  ])("every advertised ask IS the ONE compact wire ask (%s)", (_, tree) => {
    const found = propertiesNamed("ask", tree);
    // Prose may differ per door; the structure is the one shared definition.
    const WIRE = withoutDescription(buildAskWireSchema());
    for (const p of found) {
      expect(withoutDescription(p.schema), p.path).toEqual(WIRE);
      expect(typeof p.schema.description, p.path).toBe("string");
    }
  });

  it("the compact wire ask offers every field the strict AskSchema accepts, and the same enums", () => {
    // Loose on the wire, strict on the server: the wire may not lag the parse.
    const branches = (DERIVED_ASK.oneOf ?? []) as Array<{
      properties: Record<string, Record<string, unknown>>;
    }>;
    expect(branches.length).toBe(ASK_MODES.length);
    const strictKeys = new Set(
      branches.flatMap((b) => Object.keys(b.properties))
    );
    const wire = buildAskWireSchema() as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect([...strictKeys].sort()).toEqual(Object.keys(wire.properties).sort());
    expect(wire.properties.mode!.enum).toEqual([...ASK_MODES]);
    for (const k of ["risk", "stakes", "urgency"]) {
      const strictEnum = branches[0]!.properties[k]!.enum;
      expect(wire.properties[k]!.enum, k).toEqual(strictEnum);
    }
    // The provide kinds are taught in the description: none may be missing.
    for (const kind of ASK_PROVIDE_KINDS) {
      expect(String(wire.properties.provide!.description)).toContain(kind);
    }
  });

  it("the hub-rest-client mirror carries exactly the ask modes and provide kinds", () => {
    // Non-vacuity lives in the equality itself: an empty scan is not equal.
    expect(hubUnionLiterals("HubSlotAsk", "mode")).toEqual([...ASK_MODES]);
    expect(hubUnionLiterals("HubSlotAsk", "kind")).toEqual([
      ...ASK_PROVIDE_KINDS,
    ]);
  });

  it("the option mirrors (playbooks SlotAskOption, hub HubSlotAskOption) carry every AskOption field", () => {
    const optionKeys = Object.keys(AskOptionSchema.shape).sort();
    expect(optionKeys).toContain("media");
    expect(optionKeys).toContain("caution");
    const mirrors: Array<[string, string, RegExp]> = [
      [
        "hub-rest-client HubSlotAskOption",
        readFileSync(HUB_TYPES, "utf8"),
        /export interface HubSlotAskOption \{([\s\S]*?)\n\}/,
      ],
      [
        "playbooks SlotAskOption",
        readFileSync(
          resolve(import.meta.dirname, "../../../playbooks/src/index.ts"),
          "utf8"
        ),
        /export interface SlotAskOption \{([\s\S]*?)\n\}/,
      ],
    ];
    for (const [name, src, re] of mirrors) {
      const body = re.exec(src)?.[1] ?? "";
      const declared = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
      expect(declared.sort(), name).toEqual(optionKeys);
    }
  });
});
