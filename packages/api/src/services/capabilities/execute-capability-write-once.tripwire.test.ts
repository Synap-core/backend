import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

/**
 * TRIPWIRE — the DIRECT-run double-send gap stays closed (0219).
 *
 * `executeCapability`'s direct-run path (`decision === "run"` — owner-bypass or
 * governance-auto-granted, NO proposal) fires an irreversible external effect. A
 * client-perceived-failure retry must NOT double-send. This is guarded two ways:
 *
 *   Part A — the READ/WRITE classifier `capabilityVerbHasWriteEffect` correctly
 *     separates verbs that need the at-most-once receipt (writes/external) from
 *     those that must NOT (reads — a blocked repeated read would be a bug).
 *
 *   Part B — a source-shape guard: the direct-run WRITE path must CLAIM a receipt
 *     before the effect, RELEASE it on a definite failure, and COMPLETE it on
 *     success. A refactor that drops any of these silently reopens the gap.
 */

// ── Part A: the read/write classifier (pure) ───────────────────────────────────

import { capabilityVerbHasWriteEffect } from "./execute-capability.js";
import { READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";

describe("capabilityVerbHasWriteEffect — only WRITE/external verbs get a receipt", () => {
  it("builtin: a READ_ONLY builtin is NOT a write (no receipt, never blocks a repeat read)", () => {
    for (const name of READ_ONLY_BUILTIN_VERBS) {
      expect(
        capabilityVerbHasWriteEffect({
          kind: "builtin",
          name,
          providerSpec: null,
        })
      ).toBe(false);
    }
  });

  it("builtin: a WRITE builtin (not read-only) IS a write", () => {
    // entity.create / feed.post / graph.link are writes — absent from the set.
    for (const name of ["entity.create", "feed.post", "graph.link"]) {
      expect(READ_ONLY_BUILTIN_VERBS.has(name)).toBe(false);
      expect(
        capabilityVerbHasWriteEffect({
          kind: "builtin",
          name,
          providerSpec: null,
        })
      ).toBe(true);
    }
  });

  it("declarative: a GET/HEAD provider verb is a READ (no receipt)", () => {
    for (const method of ["GET", "get", "HEAD"]) {
      expect(
        capabilityVerbHasWriteEffect({
          kind: "declarative",
          name: "provider.read",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          providerSpec: { method } as any,
        })
      ).toBe(false);
    }
  });

  it("declarative: a POST/PUT/DELETE provider verb IS a write", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        capabilityVerbHasWriteEffect({
          kind: "declarative",
          name: "provider.write",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          providerSpec: { method } as any,
        })
      ).toBe(true);
    }
  });

  it("declarative: an unknown/absent method fails CLOSED (treated as a write)", () => {
    expect(
      capabilityVerbHasWriteEffect({
        kind: "declarative",
        name: "provider.mystery",
        providerSpec: null,
      })
    ).toBe(true);
  });

  it("code / instruction: always a potential external send → write", () => {
    for (const kind of ["code", "instruction", null]) {
      expect(
        capabilityVerbHasWriteEffect({
          kind,
          name: "some.skill",
          providerSpec: null,
        })
      ).toBe(true);
    }
  });
});

// ── Part B: the direct-run WRITE path claims + resolves a receipt ───────────────

describe("guard: the direct-run WRITE path persists an at-most-once receipt", () => {
  const src = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "execute-capability.ts"),
    "utf8"
  );

  it("routes write verbs through the receipt-guarded runner", () => {
    expect(src).toMatch(/capabilityVerbHasWriteEffect\(skillRow\)/);
    expect(src).toContain("runDirectWriteVerbOnce");
  });

  it("CLAIMS a receipt (CAS: insert … onConflictDoNothing) keyed on an idempotency key", () => {
    expect(src).toContain("resolveWriteIdempotencyKey");
    expect(src).toMatch(/insert\(capabilityRunReceipts\)/);
    expect(src).toContain("onConflictDoNothing()");
  });

  it("RELEASES the claim on a definite not-delivered outcome (retry can re-run)", () => {
    expect(src).toMatch(/delete\(capabilityRunReceipts\)/);
  });

  it("COMPLETES the claim + stores the result on delivery (retry replays it)", () => {
    expect(src).toMatch(/update\(capabilityRunReceipts\)/);
    expect(src).toContain('status: "completed"');
    expect(src).toContain('ackState: "duplicate-ignored"');
  });
});
