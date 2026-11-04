/**
 * SYNAP_PROCESS_ROLE (plan P6): one parser, and the pg-boss a role builds.
 * The boss.ts half is behavioural: the real module is imported under each
 * role with pg-boss replaced by a constructor spy, so the test reads the
 * options the instance was actually built with, not a helper's return.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvalidProcessRoleError,
  parseProcessRole,
  pgBossProcessOptions,
} from "./process-role.js";

describe("parseProcessRole", () => {
  it("reads unset and blank as all, so every existing pod is unchanged", () => {
    expect(parseProcessRole(undefined)).toBe("all");
    expect(parseProcessRole("")).toBe("all");
    expect(parseProcessRole("  ")).toBe("all");
  });

  it("reads the three roles, case and spaces aside", () => {
    expect(parseProcessRole("all")).toBe("all");
    expect(parseProcessRole("api")).toBe("api");
    expect(parseProcessRole(" Worker ")).toBe("worker");
  });

  it("refuses anything else instead of guessing", () => {
    for (const bad of ["workers", "1", "true", "api,worker", "jobs"]) {
      expect(() => parseProcessRole(bad)).toThrow(InvalidProcessRoleError);
    }
  });
});

describe("pgBossProcessOptions", () => {
  it("turns maintenance and the cron clock off only for api", () => {
    expect(pgBossProcessOptions("api")).toEqual({
      supervise: false,
      schedule: false,
    });
    expect(pgBossProcessOptions("worker")).toEqual({
      supervise: true,
      schedule: true,
    });
    expect(pgBossProcessOptions("all")).toEqual({
      supervise: true,
      schedule: true,
    });
  });
});

describe("boss.ts builds its pg-boss for the process role", () => {
  const ctor = vi.fn();
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    delete (globalThis as Record<string, unknown>).__synap_pg_boss__;
    ctor.mockReset();
    vi.resetModules();
    vi.doUnmock("pg-boss");
  });

  async function constructedWith(role: string | undefined) {
    process.env.DATABASE_URL = "postgres://x:x@127.0.0.1:1/x";
    if (role === undefined) delete process.env.SYNAP_PROCESS_ROLE;
    else process.env.SYNAP_PROCESS_ROLE = role;
    delete (globalThis as Record<string, unknown>).__synap_pg_boss__;
    vi.resetModules();
    vi.doMock("pg-boss", () => ({
      default: class {
        constructor(opts: unknown) {
          ctor(opts);
        }
      },
    }));
    await import("./boss.js");
    expect(ctor).toHaveBeenCalledTimes(1);
    return ctor.mock.calls[0]![0] as Record<string, unknown>;
  }

  it("api: supervise and schedule off", async () => {
    const opts = await constructedWith("api");
    expect(opts.supervise).toBe(false);
    expect(opts.schedule).toBe(false);
  });

  it("worker, all and unset: both on (pg-boss's defaults, as before)", async () => {
    for (const role of ["worker", "all", undefined]) {
      const opts = await constructedWith(role);
      expect(opts.supervise, String(role)).toBe(true);
      expect(opts.schedule, String(role)).toBe(true);
      ctor.mockReset();
    }
  });
});
