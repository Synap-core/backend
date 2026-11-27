/**
 * The zod side of an MCP tool's input (`defineTool({ input })`): the JSON
 * Schema a zod input is ADVERTISED as, and the input pieces whose parse does
 * more than check (a JSON string read as an object, a page size clamped).
 * Imports nothing of the tool registry, so any schema module may use it.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { noteLimitClamped } from "./call-notices.js";

/**
 * An object argument some MCP clients send JSON-ENCODED AS A STRING (live
 * 2026-09-21: `synap_start_session` lost its `params` through such a client).
 * The string is parsed; "" reads as absent; a string that is not a JSON
 * object is refused saying so, never read as "nobody supplied it".
 */
export function jsonObjectInput(name: string) {
  return z.preprocess(
    (v, ctx) => {
      if (typeof v !== "string") return v;
      if (v.trim() === "") return undefined;
      try {
        const parsed: unknown = JSON.parse(v);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
        ctx.addIssue({
          code: "custom",
          message: `\`${name}\` must be a JSON OBJECT of answers keyed by param name, not ${Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`}.`,
        });
      } catch {
        ctx.addIssue({
          code: "custom",
          message: `\`${name}\` was sent as a string that is not JSON. Send it as a JSON object, e.g. {"clientName": "Acme"}.`,
        });
      }
      return z.NEVER;
    },
    z.record(z.string(), z.unknown()).optional()
  );
}

/**
 * A page size with advertised bounds (and default): one out of them is
 * CLAMPED, never refused, and the reply says so (`limitClamped`,
 * call-notices.ts).
 */
export function clampedLimit(min: number, max: number, fallback: number) {
  return z
    .number()
    .meta({ minimum: min, maximum: max, default: fallback })
    .transform((asked) => {
      const used = Math.min(Math.max(Math.trunc(asked), min), max);
      if (used !== asked) noteLimitClamped(asked, used);
      return used;
    });
}

const UNBOUNDED = "x-synap-unbounded";
const BOUND_KEYS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "pattern",
];

/**
 * Advertised without its bounds (lengths, counts, patterns), still parsed
 * with them: the shape is what a caller needs, the parse refuses what is out
 * of bounds (playbook `activators`, a token-budget choice).
 */
export function withoutAdvertisedBounds<T extends z.ZodType>(schema: T): T {
  return schema.meta({ [UNBOUNDED]: true }) as T;
}

const isEmptyObject = (n: unknown) =>
  !!n && typeof n === "object" && !Array.isArray(n) && !Object.keys(n).length;
const isTypeOnly = (n: unknown, type: string) =>
  JSON.stringify(n) === JSON.stringify({ type });
/** Values that are data, not sub-schemas. */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "required"]);

/**
 * zod's JSON Schema in the shape MCP clients have always been sent: no
 * vacuous keywords (an open object's `additionalProperties: {}`, a record's
 * string `propertyNames`, an array's `items: {}`, an integer's safe-integer
 * bounds), and a nullable written `type: [t, "null"]`, not an `anyOf`.
 */
function wireNode(node: unknown, unbounded = false): unknown {
  if (Array.isArray(node)) return node.map((n) => wireNode(n, unbounded));
  if (!node || typeof node !== "object") return node;
  const strip = unbounded || UNBOUNDED in node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema" || k === UNBOUNDED) continue;
    if (strip && BOUND_KEYS.includes(k)) continue;
    out[k] =
      k === "properties"
        ? Object.fromEntries(
            Object.entries(v as object).map(([p, s]) => [
              p,
              wireNode(s, strip),
            ])
          )
        : DATA_KEYWORDS.has(k)
          ? v
          : wireNode(v, strip);
  }
  const ap = out.additionalProperties;
  if (ap === true || isEmptyObject(ap)) delete out.additionalProperties;
  if (isTypeOnly(out.propertyNames, "string")) delete out.propertyNames;
  if (isEmptyObject(out.items)) delete out.items;
  if (out.type === "integer") {
    if (out.minimum === -Number.MAX_SAFE_INTEGER) delete out.minimum;
    if (out.maximum === Number.MAX_SAFE_INTEGER) delete out.maximum;
  }
  const anyOf = out.anyOf as Record<string, unknown>[] | undefined;
  const nullAt =
    anyOf?.length === 2 ? anyOf.findIndex((s) => isTypeOnly(s, "null")) : -1;
  const other = anyOf?.[1 - nullAt];
  if (nullAt >= 0 && typeof other?.type === "string") {
    const { anyOf: _anyOf, ...rest } = out;
    return {
      ...other,
      ...rest,
      type: [other.type, "null"],
      ...(Array.isArray(other.enum) ? { enum: [...other.enum, null] } : {}),
    };
  }
  return out;
}

/** The JSON Schema a zod input is advertised as (`tools/list`, manifest). */
export function wireInputSchema(input: z.ZodType): Tool["inputSchema"] {
  return wireNode(
    z.toJSONSchema(input, { io: "input" })
  ) as Tool["inputSchema"];
}
