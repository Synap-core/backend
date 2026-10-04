/**
 * Recovery + security copy: shared words, fixed sentences, raw detail only
 * behind "Copy details".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import {
  RECOVERY_NO_DOORS_COPY,
  operatorResetCommand,
} from "@synap-core/types/account-recovery";
import { NoDoors } from "./RecoveryView";
import { RECOVERED_COPY, securityCardOrder } from "../settings/security/SecurityView";
import { recoveryCallDetail, redeemFailureMessage } from "../../lib/account-recovery";

const APP = join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("no doors → EXPLAIN with the shared copy and a copyable message", () => {
  const html = renderToString(<NoDoors />);
  it("uses the shared title and body", () => {
    expect(html).toContain(RECOVERY_NO_DOORS_COPY.title);
    expect(html).toContain("Ask whoever runs your pod to reset it.");
  });
  it("offers the message and the command as copy actions", () => {
    expect(html).toContain("Copy message for them");
    expect(html).toContain("Copy reset command");
    expect(html).toContain(operatorResetCommand("").replace("<", "&lt;").replace(">", "&gt;"));
  });
});

describe("just recovered → the password card leads", () => {
  it("orders password first only when recovered", () => {
    expect(securityCardOrder(true)[0]).toBe("password");
    expect(securityCardOrder(false)[0]).toBe("codes");
  });
  it("says what to do and by when", () => {
    expect(RECOVERED_COPY).toBe("You're back in. Set a new password within 15 minutes.");
  });
});

describe("failures read as fixed sentences", () => {
  it("a 503 redeem never shows the pod's raw message", () => {
    const v = redeemFailureMessage("recovery_unavailable");
    expect(v.message).not.toMatch(/HTTP|\d{3}|answered/);
    expect(v.failed).toBe(true);
  });
  it("wrong code never says which part was wrong", () => {
    expect(redeemFailureMessage("invalid_code").message).not.toMatch(/email is|unknown/i);
  });
  it("the detail keeps status, code and message for Copy details", () => {
    expect(
      recoveryCallDetail({ status: 503, error: "recovery_unavailable", message: "This pod answered 503." })
    ).toBe("503 · recovery_unavailable · This pod answered 503.");
  });
});

/**
 * Tripwire: neither view puts a caught error's or a failed call's own
 * `.message` on screen (`err.message`, `r.message`, `r.error.message`). Locals
 * that hold OUR fixed sentences (`doorError.message`) are fine. Granularity is
 * the file; it cannot see a raw message laundered through another name.
 */
describe("no raw err.message in recovery/security views", () => {
  const RAW = /\b(?:err|r|r\.error)\.message\b/;
  it("self-check: the pattern still sees the defect", () => {
    expect(RAW.test("err instanceof Error ? err.message : x")).toBe(true);
    expect(RAW.test("`Couldn't load. ${r.message}`")).toBe(true);
    expect(RAW.test("setError(r.error.message ?? 'x')")).toBe(true);
    expect(RAW.test("flow.ui.messages")).toBe(false);
    expect(RAW.test("doorError.message")).toBe(false);
  });
  for (const rel of ["recovery/RecoveryView.tsx", "settings/security/SecurityView.tsx"]) {
    it(rel, () => {
      const src = readFileSync(join(APP, rel), "utf8");
      expect(src.length).toBeGreaterThan(5000); // non-vacuity: we read the real view
      const hits = src.split("\n").filter((l) => RAW.test(l));
      expect(hits).toEqual([]);
    });
  }
});
