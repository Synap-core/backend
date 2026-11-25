import { describe, expect, it, vi } from "vitest";
import { runConversionsCli } from "./cli.js";

// The runner's refusals happen before any connection is opened, so they need
// no database: a bad flag or a missing DATABASE_URL is exit 1, never a connect.
describe("runConversionsCli refusals", () => {
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("refuses --destructive-tail without --apply", async () => {
    const err = quiet();
    expect(
      await runConversionsCli(["--destructive-tail"], { DATABASE_URL: "x" })
    ).toBe(1);
    expect(err.mock.calls.flat().join(" ")).toContain("requires --apply");
    err.mockRestore();
  });

  it("refuses an --only that names no op", async () => {
    const err = quiet();
    expect(
      await runConversionsCli(["--only", "no.such.op"], { DATABASE_URL: "x" })
    ).toBe(1);
    err.mockRestore();
  });

  it("refuses to run without DATABASE_URL", async () => {
    const err = quiet();
    expect(await runConversionsCli([], {})).toBe(1);
    expect(err.mock.calls.flat().join(" ")).toContain("DATABASE_URL");
    err.mockRestore();
  });
});
