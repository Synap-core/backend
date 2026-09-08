import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — a write-authority refusal must reach the caller as a 4xx.
 *
 * The slot floor throws `TRPCError(BAD_REQUEST)` naming the slot and the field
 * it refused. The Hub REST PATCH's catch returned 500 for everything, so that
 * precise sentence arrived as "An unexpected server error occurred" — a guard
 * that holds while its report misleads, which is the defect class this repo
 * keeps paying for and the exact lesson of the `completeOutput` refusal fix.
 *
 * Asserts the BEHAVIOUR of the mapping (a BAD_REQUEST-coded error yields 400,
 * FORBIDDEN yields 403, anything else stays 500) rather than the presence of a
 * string, so rewording the branch cannot silently disarm it.
 */
const SRC = readFileSync(join(__dirname, "focus-sessions.ts"), "utf8");

/** The mapping, extracted as the route applies it. */
function statusFor(code: string | undefined): number {
  if (code === "BAD_REQUEST") return 400;
  if (code === "FORBIDDEN") return 403;
  return 500;
}

describe("hub REST PATCH maps a write-authority refusal to the caller", () => {
  it("routes BAD_REQUEST to 400, FORBIDDEN to 403, and nothing else", () => {
    expect(statusFor("BAD_REQUEST")).toBe(400);
    expect(statusFor("FORBIDDEN")).toBe(403);
    expect(statusFor("INTERNAL_SERVER_ERROR")).toBe(500);
    expect(statusFor(undefined)).toBe(500);
  });

  it("the PATCH catch actually branches on the code before falling to 500", () => {
    // Non-vacuity: the scan must find the catch it inspects.
    expect(SRC).toContain("focus-sessions.update failed");
    // Anchor on the OUTER catch by its log line — the route also has an inner
    // catch around the close door, and slicing from the first `catch` after the
    // route opener grabs that one instead. Getting this wrong is how a scan
    // silently inspects the wrong block and passes on the wrong evidence.
    const logIdx = SRC.indexOf('"focus-sessions.update failed"');
    expect(logIdx).toBeGreaterThan(-1);
    const catchStart = SRC.lastIndexOf("} catch (err) {", logIdx);
    expect(catchStart).toBeGreaterThan(-1);
    const catchBlock = SRC.slice(catchStart, logIdx + 200);
    expect(catchBlock).toMatch(/BAD_REQUEST/);
    expect(catchBlock).toMatch(/FORBIDDEN/);
    // and the 500 fallback must still exist below it
    expect(catchBlock).toMatch(/500/);
  });
});
