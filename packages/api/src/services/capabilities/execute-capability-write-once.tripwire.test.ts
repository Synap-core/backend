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

import { capabilityVerbHasExternalEffect } from "./execute-capability.js";
import { READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";

describe("capabilityVerbHasExternalEffect — only EXTERNAL-send verbs get a receipt", () => {
  it("builtin: NO builtin is an external send — reads AND local writes → false", () => {
    // A local builtin write (entity.create/feed.post/graph.link) must NOT get the
    // receipt: content-hash windowing would collapse two legitimately-identical
    // local writes into one (silent data loss). Read-only builtins are false too.
    for (const name of [
      ...READ_ONLY_BUILTIN_VERBS,
      "entity.create",
      "feed.post",
      "graph.link",
      "document.create",
    ]) {
      expect(
        capabilityVerbHasExternalEffect({
          kind: "builtin",
          name,
          providerSpec: null,
        })
      ).toBe(false);
    }
  });

  it("declarative: a GET/HEAD provider verb is a READ (no receipt)", () => {
    for (const method of ["GET", "get", "HEAD"]) {
      expect(
        capabilityVerbHasExternalEffect({
          kind: "declarative",
          name: "provider.read",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          providerSpec: { method } as any,
        })
      ).toBe(false);
    }
  });

  it("declarative: a POST/PUT/DELETE provider verb IS an external send", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        capabilityVerbHasExternalEffect({
          kind: "declarative",
          name: "provider.write",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          providerSpec: { method } as any,
        })
      ).toBe(true);
    }
  });

  it("declarative: an unknown/absent method fails CLOSED (treated as external)", () => {
    expect(
      capabilityVerbHasExternalEffect({
        kind: "declarative",
        name: "provider.mystery",
        providerSpec: null,
      })
    ).toBe(true);
  });

  it("code / instruction: may send externally → external", () => {
    for (const kind of ["code", "instruction", null]) {
      expect(
        capabilityVerbHasExternalEffect({
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

  it("routes external-send verbs through the receipt-guarded runner", () => {
    expect(src).toMatch(/capabilityVerbHasExternalEffect\(skillRow\)/);
    expect(src).toContain("runDirectWriteVerbOnce");
  });

  it("CLAIMS a receipt (CAS: insert … onConflictDoNothing) keyed on an idempotency key", () => {
    expect(src).toContain("resolveWriteIdempotencyKey");
    expect(src).toMatch(/insert\(capabilityRunReceipts\)/);
    expect(src).toContain("onConflictDoNothing()");
  });

  it("pins an EXPLICIT idempotency key to a strict (permanent) claim bucket", () => {
    // D: a derived content-hash key stays windowed; an explicit key must be
    // immune to the bucket-boundary straddle → dedupBucket pinned to 0.
    expect(src).toContain("hasExplicitKey");
    expect(src).toMatch(/hasExplicitKey\s*\?\s*\{\s*dedupBucket:\s*0\s*\}/);
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
