import { describe, it, expect } from "vitest";
import {
  computeWriteContentHash,
  resolveWriteIdempotencyKey,
  deterministicUuidFromKey,
} from "./write-door-idempotency.js";

describe("computeWriteContentHash", () => {
  it("is order-independent over field keys", () => {
    const a = computeWriteContentHash("d", { x: 1, y: 2, z: { b: 1, a: 2 } });
    const b = computeWriteContentHash("d", { z: { a: 2, b: 1 }, y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("changes when ANY content field changes — two writes can't collide", () => {
    const base = { title: "Launch", content: "ship it", ws: "w1" };
    const key = computeWriteContentHash("create_document", base);
    expect(key).not.toBe(
      computeWriteContentHash("create_document", { ...base, content: "ship" })
    );
    expect(key).not.toBe(
      computeWriteContentHash("create_document", { ...base, title: "Launch " })
    );
    expect(key).not.toBe(
      computeWriteContentHash("create_document", { ...base, ws: "w2" })
    );
  });

  it("separates doors — same fields, different door → different key", () => {
    const fields = { userId: "u", text: "hi" };
    expect(computeWriteContentHash("post_message", fields)).not.toBe(
      computeWriteContentHash("remember_fact", fields)
    );
  });

  it("treats absent / null / empty-string fields as not-present (stable)", () => {
    const withAbsent = computeWriteContentHash("d", { a: "x" });
    const withEmpty = computeWriteContentHash("d", {
      a: "x",
      b: undefined,
      c: null,
      e: "",
    });
    expect(withAbsent).toBe(withEmpty);
  });

  it("is a stable 64-char hex digest — survives retries", () => {
    const k = computeWriteContentHash("d", { a: 1 });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).toBe(computeWriteContentHash("d", { a: 1 }));
  });
});

describe("resolveWriteIdempotencyKey", () => {
  it("prefers a trimmed explicit key", () => {
    expect(resolveWriteIdempotencyKey("  key-1 ", "d", { a: 1 })).toBe("key-1");
  });

  it("falls back to the content hash when explicit is missing/blank", () => {
    const hash = computeWriteContentHash("d", { a: 1 });
    expect(resolveWriteIdempotencyKey(undefined, "d", { a: 1 })).toBe(hash);
    expect(resolveWriteIdempotencyKey("   ", "d", { a: 1 })).toBe(hash);
  });
});

describe("deterministicUuidFromKey", () => {
  it("is deterministic and a well-formed UUID", () => {
    const u = deterministicUuidFromKey("abc");
    expect(u).toBe(deterministicUuidFromKey("abc"));
    expect(u).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("maps distinct keys to distinct uuids", () => {
    expect(deterministicUuidFromKey("a")).not.toBe(
      deterministicUuidFromKey("b")
    );
  });
});
