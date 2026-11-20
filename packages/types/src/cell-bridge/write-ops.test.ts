/**
 * The typed writes a module frame may ask for (`write-ops.ts`): the table,
 * the payload check, and who may write at all.
 */
import { describe, expect, it } from "vitest";
import {
  CELL_BRIDGE_MAX_PROPERTIES_CHARS,
  CELL_BRIDGE_WRITE_NEEDS_TYPE,
  CELL_BRIDGE_WRITE_OPS,
  CELL_BRIDGE_WRITE_OP_NAMES,
  CELL_BRIDGE_WRITE_REFUSED,
  cellBridgeWriteRefusal,
  isCellBridgeWriteOp,
  pickBridgeWritePayload,
} from "./index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

describe("the write table", () => {
  it("is the four governed writes, nothing more", () => {
    expect([...CELL_BRIDGE_WRITE_OP_NAMES].sort()).toEqual(
      [
        "create_entity",
        "create_relation",
        "delete_entity",
        "update_entity",
      ].sort()
    );
    for (const op of ["entities.create", "toString", "__proto__", "", 1, null])
      expect(isCellBridgeWriteOp(op)).toBe(false);
  });

  it("no op lets the frame choose its lens or its trust", () => {
    for (const fields of Object.values(CELL_BRIDGE_WRITE_OPS))
      for (const banned of [
        "workspaceId",
        "projectId",
        "viewContext",
        "source",
        "trusted",
      ])
        expect(Object.keys(fields)).not.toContain(banned);
  });
});

describe("pickBridgeWritePayload", () => {
  it("keeps the op's own fields and drops the lens, the trust and the rest", () => {
    expect(
      pickBridgeWritePayload("create_entity", {
        profileSlug: "task",
        title: "Call Ada",
        properties: { priority: "high", tags: ["a"], due: null },
        workspaceId: ID,
        projectId: ID2,
        viewContext: { typeKey: "forged" },
        source: "agent",
        trusted: true,
        extra: 1,
      })
    ).toEqual({
      ok: true,
      payload: {
        profileSlug: "task",
        title: "Call Ada",
        properties: { priority: "high", tags: ["a"], due: null },
      },
    });
  });

  it("an update needs an id and properties; expectedStatus may be null", () => {
    expect(
      pickBridgeWritePayload("update_entity", {
        id: ID,
        properties: { status: "done" },
        expectedStatus: null,
      })
    ).toEqual({
      ok: true,
      payload: { id: ID, properties: { status: "done" }, expectedStatus: null },
    });
    expect(pickBridgeWritePayload("update_entity", { id: ID })).toEqual({
      ok: false,
      error: '"update_entity" needs properties.',
    });
  });

  it("ids must be UUIDs; a relation type is a short slug", () => {
    expect(pickBridgeWritePayload("delete_entity", { id: "e1" })).toEqual({
      ok: false,
      error: "id must be an id.",
    });
    expect(
      pickBridgeWritePayload("create_relation", {
        sourceEntityId: ID,
        targetEntityId: ID2,
        type: "works_at",
      })
    ).toEqual({
      ok: true,
      payload: { sourceEntityId: ID, targetEntityId: ID2, type: "works_at" },
    });
    for (const type of ["", "a b", "x".repeat(65), "-x", 3])
      expect(
        pickBridgeWritePayload("create_relation", {
          sourceEntityId: ID,
          targetEntityId: ID2,
          type,
        }).ok,
        String(type)
      ).toBe(false);
  });

  it("refuses prototype keys at any depth", () => {
    const top = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    const deep = JSON.parse(
      '{"a": {"b": [{"constructor": {"x": 1}}]}}'
    ) as unknown;
    for (const properties of [top, deep, { constructor: "x" }]) {
      const out = pickBridgeWritePayload("update_entity", {
        id: ID,
        properties,
      });
      expect(out.ok).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses more than 50 keys and more than 32 KB", () => {
    const many = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`k${i}`, i])
    );
    expect(
      pickBridgeWritePayload("update_entity", { id: ID, properties: many })
    ).toEqual({
      ok: false,
      error: "properties has 51 keys; at most 50.",
    });
    const fifty = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`k${i}`, i])
    );
    expect(
      pickBridgeWritePayload("update_entity", { id: ID, properties: fifty }).ok
    ).toBe(true);
    const big = { notes: "x".repeat(CELL_BRIDGE_MAX_PROPERTIES_CHARS) };
    const out = pickBridgeWritePayload("update_entity", {
      id: ID,
      properties: big,
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/too large/);
  });

  it("refuses values that are not JSON", () => {
    for (const value of [
      Number.NaN,
      Infinity,
      () => 1,
      new Date(0),
      new Map(),
      Symbol("s"),
    ]) {
      expect(
        pickBridgeWritePayload("update_entity", {
          id: ID,
          properties: { v: value },
        }).ok,
        String(value)
      ).toBe(false);
    }
    expect(
      pickBridgeWritePayload("update_entity", { id: ID, properties: [] }).ok
    ).toBe(false);
  });

  it("the checked payload is a copy: the frame's object is not what is sent", () => {
    const properties = { a: { b: 1 } };
    const out = pickBridgeWritePayload("update_entity", { id: ID, properties });
    expect(out.ok && out.payload.properties).toEqual(properties);
    expect(out.ok && out.payload.properties).not.toBe(properties);
  });

  it("a payload that is not an object is refused", () => {
    for (const payload of [null, "x", [], 1])
      expect(pickBridgeWritePayload("delete_entity", payload).ok).toBe(false);
  });
});

describe("who may write", () => {
  it("a page never writes; a module frame without a type does not either", () => {
    expect(
      cellBridgeWriteRefusal("create_entity", {
        mechanism: "page",
        identity: { typeKey: "cell:acme:board" },
      })
    ).toBe(CELL_BRIDGE_WRITE_REFUSED);
    expect(
      cellBridgeWriteRefusal("create_entity", {
        mechanism: "module",
        identity: { viewId: ID },
      })
    ).toBe(CELL_BRIDGE_WRITE_NEEDS_TYPE);
    expect(
      cellBridgeWriteRefusal("create_entity", {
        mechanism: "module",
        identity: { typeKey: "cell:acme:board", viewId: ID },
      })
    ).toBe(null);
    expect(
      cellBridgeWriteRefusal("documents.update", {
        mechanism: "module",
        identity: { typeKey: "cell:acme:board" },
      })
    ).toMatch(/not a change a view can ask for/);
  });
});
