/**
 * The WRITE operations a module frame may ask its host for, and the payload
 * each one may carry. The hard ceiling, like the read table (`read-ops.ts`):
 * a host never forwards an op outside this table, nor a field outside the
 * op's own list.
 *
 * Moved from synap-app `packages/web/src/cell-runtime/ViewFrame.tsx`
 * (`ALLOWED_MUTATE_OPS`) and the browser's `createViewFrameHandlers.ts`, which
 * each read the payload their own way. One shape now, typed and checked here.
 *
 * Being allowed here does NOT mean a write runs: the host sends it to the
 * pod's governed door (`entities.create` / `update` / `delete`,
 * `relations.create`), stamped with the frame's identity (`viewContext`) and
 * `source: "user"`. The pod re-resolves the view's trust server-side
 * (`checkPermissionOrPropose`): an untrusted view's write becomes a proposal.
 * Nothing is applied optimistically: the frame reads what the pod answered
 * (`CellBridgeMutateResult`).
 *
 * The frame never chooses its lens or its trust: `workspaceId`, `projectId`,
 * `viewContext`, `source` and `trusted` are in no list, so they are dropped.
 * A stored HTML PAGE refuses every write (`CELL_BRIDGE_WRITE_REFUSED`): only
 * a module frame with a type writes.
 */

import { CELL_BRIDGE_WRITE_REFUSED } from "./protocol.js";

/**
 * Op → field → rule. `!` = required. `uuid` an id, `slug64` a slug of at most
 * 64 characters, `object` a plain object of JSON values (`properties`),
 * `string|null` a string or an explicit null.
 */
export const CELL_BRIDGE_WRITE_OPS = {
  create_entity: {
    profileSlug: "string!",
    properties: "object",
    title: "string",
  },
  update_entity: {
    id: "uuid!",
    properties: "object!",
    expectedStatus: "string|null",
  },
  delete_entity: { id: "uuid!" },
  create_relation: {
    sourceEntityId: "uuid!",
    targetEntityId: "uuid!",
    type: "slug64!",
  },
} as const;

export type CellBridgeWriteOp = keyof typeof CELL_BRIDGE_WRITE_OPS;
type FieldRule =
  | "string!"
  | "string"
  | "uuid!"
  | "slug64!"
  | "object"
  | "object!"
  | "string|null";

/** Every allowed write op, in table order. */
export const CELL_BRIDGE_WRITE_OP_NAMES = Object.freeze(
  Object.keys(CELL_BRIDGE_WRITE_OPS)
) as readonly CellBridgeWriteOp[];

/** A JSON value, as `properties` may hold. */
export type CellBridgeJsonValue =
  | string
  | number
  | boolean
  | null
  | CellBridgeJsonValue[]
  | { [key: string]: CellBridgeJsonValue };

type ValueOf<R extends FieldRule> = R extends "object" | "object!"
  ? Record<string, CellBridgeJsonValue>
  : R extends "string|null"
    ? string | null
    : string;
/** A field spec's payload type: required fields as such, the rest optional. */
type PayloadOf<S> = {
  -readonly [K in keyof S as S[K] extends `${string}!` ? K : never]: ValueOf<
    S[K] & FieldRule
  >;
} & {
  -readonly [K in keyof S as S[K] extends `${string}!` ? never : K]?: ValueOf<
    S[K] & FieldRule
  >;
};

/** The checked payload of one write op. */
export type CellBridgeWritePayload<Op extends CellBridgeWriteOp> = PayloadOf<
  (typeof CELL_BRIDGE_WRITE_OPS)[Op]
>;

/** What the pod answered a frame's write. Never "applied" before it was. */
export type CellBridgeMutateResult = {
  status: "approved" | "proposed" | "denied";
  data?: unknown;
  proposalId?: string;
  error?: string;
};

/** `properties`: at most this many keys. */
export const CELL_BRIDGE_MAX_PROPERTY_KEYS = 50;
/** `properties`: at most this many characters of JSON. */
export const CELL_BRIDGE_MAX_PROPERTIES_CHARS = 32 * 1024;
/** A string field: at most this many characters. */
export const CELL_BRIDGE_MAX_WRITE_STRING = 500;
const MAX_DEPTH = 12;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG64 = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor"]);

/** True only for an op in the table (own keys only). */
export function isCellBridgeWriteOp(op: unknown): op is CellBridgeWriteOp {
  return (
    typeof op === "string" &&
    Object.prototype.hasOwnProperty.call(CELL_BRIDGE_WRITE_OPS, op)
  );
}

/** What a frame reads when it asks for a write outside the table. */
export function cellBridgeUnknownWrite(operation: string): string {
  return `"${operation}" is not a change a view can ask for.`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Why `value` is not a JSON value a property may hold, or null. */
function jsonProblem(
  value: unknown,
  path: string,
  depth: number
): string | null {
  if (depth > MAX_DEPTH) return `${path} is nested too deeply.`;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return null;
  if (typeof value === "number")
    return Number.isFinite(value) ? null : `${path} is not a finite number.`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const p = jsonProblem(value[i], `${path}[${i}]`, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) return `${path} has a "${key}" key.`;
      const p = jsonProblem(value[key], `${path}.${key}`, depth + 1);
      if (p) return p;
    }
    return null;
  }
  return `${path} is not a JSON value.`;
}

function checkProperties(
  value: unknown
):
  | { ok: true; value: Record<string, CellBridgeJsonValue> }
  | { ok: false; error: string } {
  if (!isPlainObject(value))
    return { ok: false, error: "properties must be an object." };
  const keys = Object.keys(value);
  if (keys.length > CELL_BRIDGE_MAX_PROPERTY_KEYS)
    return {
      ok: false,
      error: `properties has ${keys.length} keys; at most ${CELL_BRIDGE_MAX_PROPERTY_KEYS}.`,
    };
  const problem = jsonProblem(value, "properties", 0);
  if (problem) return { ok: false, error: problem };
  const json = JSON.stringify(value);
  if (json.length > CELL_BRIDGE_MAX_PROPERTIES_CHARS)
    return {
      ok: false,
      error: `properties is too large (${json.length} characters; at most ${CELL_BRIDGE_MAX_PROPERTIES_CHARS}).`,
    };
  return {
    ok: true,
    value: JSON.parse(json) as Record<string, CellBridgeJsonValue>,
  };
}

/**
 * The frame's payload narrowed to the op's own fields and checked, or why it
 * is refused. Unknown fields (the lens, `viewContext`, `source`, `trusted`)
 * are dropped; a field that breaks its rule refuses the whole write, never a
 * partial one.
 */
export function pickBridgeWritePayload<Op extends CellBridgeWriteOp>(
  op: Op,
  payload: unknown
):
  | { ok: true; payload: CellBridgeWritePayload<Op> }
  | { ok: false; error: string } {
  if (!isCellBridgeWriteOp(op))
    return { ok: false, error: cellBridgeUnknownWrite(String(op)) };
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return { ok: false, error: `"${op}" needs a payload object.` };
  const given = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const rules = CELL_BRIDGE_WRITE_OPS[op] as Readonly<
    Record<string, FieldRule>
  >;
  for (const [field, rule] of Object.entries(rules)) {
    const present =
      Object.prototype.hasOwnProperty.call(given, field) &&
      given[field] !== undefined;
    if (!present) {
      if (rule.endsWith("!"))
        return { ok: false, error: `"${op}" needs ${field}.` };
      continue;
    }
    const value = given[field];
    switch (rule) {
      case "uuid!":
        if (typeof value !== "string" || !UUID.test(value))
          return { ok: false, error: `${field} must be an id.` };
        out[field] = value;
        break;
      case "slug64!":
        if (typeof value !== "string" || !SLUG64.test(value))
          return {
            ok: false,
            error: `${field} must be a slug of at most 64 characters.`,
          };
        out[field] = value;
        break;
      case "string!":
      case "string":
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > CELL_BRIDGE_MAX_WRITE_STRING
        )
          return {
            ok: false,
            error: `${field} must be text of 1 to ${CELL_BRIDGE_MAX_WRITE_STRING} characters.`,
          };
        out[field] = value;
        break;
      case "string|null":
        if (
          value !== null &&
          (typeof value !== "string" ||
            value.length > CELL_BRIDGE_MAX_WRITE_STRING)
        )
          return { ok: false, error: `${field} must be text or null.` };
        out[field] = value;
        break;
      case "object":
      case "object!": {
        const checked = checkProperties(value);
        if (!checked.ok) return checked;
        out[field] = checked.value;
        break;
      }
    }
  }
  return { ok: true, payload: out as unknown as CellBridgeWritePayload<Op> };
}

/** What a module frame without a type reads when it asks for a change. */
export const CELL_BRIDGE_WRITE_NEEDS_TYPE =
  "This view has no type, so it cannot make changes.";

/**
 * Why a frame may not write at all, or null when it may. A stored HTML page
 * refuses every write (`CELL_BRIDGE_WRITE_REFUSED`, unchanged); a module
 * frame without a `typeKey` too: the pod resolves a write's trust from the
 * frame's type, and a frame with none has nothing to resolve.
 */
export function cellBridgeWriteRefusal(
  op: string,
  frame: {
    mechanism: "module" | "page";
    identity: { typeKey?: string; viewId?: string };
  }
): string | null {
  if (frame.mechanism !== "module") return CELL_BRIDGE_WRITE_REFUSED;
  if (!isCellBridgeWriteOp(op)) return cellBridgeUnknownWrite(op);
  if (!frame.identity.typeKey) return CELL_BRIDGE_WRITE_NEEDS_TYPE;
  return null;
}
