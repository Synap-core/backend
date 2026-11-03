/**
 * G7b: the backend reads the host self-heal's record (deploy/state/events.jsonl)
 * — its tail, `pod.heal` lines only, projected — and hands it to the notice.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHealEvents,
  projectHealEvent,
  readHealEvents,
  startHealNoticeWatch,
} from "./heal-events.js";

/**
 * A line exactly as `synap heal` writes it (deploy/__tests__/prune-heal.test.sh
 * (e2), the stuck backend's restart), including the fields the projection must
 * NOT carry on (health log, probe, eventLoop numbers).
 */
const SHELL_LINE = JSON.stringify({
  ts: "2026-11-03T23:23:20Z",
  kind: "pod.heal",
  status: "restarted",
  service: "backend",
  reason:
    "backend was stuck (running, not answering its health check in time) — restarted after 2 more tick(s)",
  restartsInWindow: 1,
  why: {
    class: "stuck",
    pidAlive: true,
    health: [
      {
        at: "2026-11-03T09:59:40Z",
        exitCode: -1,
        output: "Health check exceeded timeout (10s)",
      },
    ],
    probe: "timeout",
    eventLoop: null,
    lastStall: {
      at: "2026-11-03T09:59:20.000Z",
      blockedMs: 95000,
      inFlight: 2,
      requests: [
        {
          method: "GET",
          path: "/api/hub/documents/doc-1/content",
          runningMs: 95010,
          ended: true,
        },
      ],
    },
    waitedTicks: 2,
  },
  pod: "pod.example.com",
});

describe("projectHealEvent", () => {
  it("projects the shell's line to the notice's fields, and nothing else", () => {
    expect(projectHealEvent(JSON.parse(SHELL_LINE))).toEqual({
      ts: "2026-11-03T23:23:20Z",
      status: "restarted",
      service: "backend",
      restartsInWindow: 1,
      class: "stuck",
      waitedTicks: 2,
      stall: {
        blockedMs: 95000,
        method: "GET",
        path: "/api/hub/documents/doc-1/content",
      },
    });
  });
  it("a line from before `why` still reads, with nulls; other kinds are not heal events", () => {
    expect(
      projectHealEvent({
        ts: "t",
        kind: "pod.heal",
        status: "budget_exhausted",
        service: "realtime",
        restartsInWindow: 3,
      })
    ).toEqual({
      ts: "t",
      status: "budget_exhausted",
      service: "realtime",
      restartsInWindow: 3,
      class: null,
      waitedTicks: null,
      stall: null,
    });
    expect(
      projectHealEvent({ ts: "t", kind: "heal", status: "rolled_back" })
    ).toBeNull();
    expect(
      projectHealEvent({ ts: "t", kind: "pod.heal", status: "restarted" })
    ).toBeNull();
  });
});

describe("parseHealEvents", () => {
  it("keeps heal lines, skips others, counts malformed ones, drops a cut first line", () => {
    const text = [
      SHELL_LINE.slice(40), // the tail read started mid-line
      JSON.stringify({ ts: "a", kind: "update", status: "ok" }),
      SHELL_LINE,
      '{"kind":"pod.heal", broken',
      "",
    ].join("\n");
    const out = parseHealEvents(text, true);
    expect(out.events).toHaveLength(1);
    expect(out.skipped).toBe(1);
  });
});

describe("readHealEvents", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-events-"));
  it("absent file ⇒ absent, never a failure", async () => {
    expect(await readHealEvents(join(dir, "none.jsonl"))).toEqual({
      read: "absent",
    });
  });
  it("an unreadable path ⇒ failed, never empty", async () => {
    mkdirSync(join(dir, "a-dir.jsonl"));
    const r = await readHealEvents(join(dir, "a-dir.jsonl"));
    expect(r.read).toBe("failed");
  });
  it("reads only the tail of a long file", async () => {
    const p = join(dir, "events.jsonl");
    const old = JSON.stringify({
      ...JSON.parse(SHELL_LINE),
      ts: "2026-01-01T00:00:00Z",
    });
    writeFileSync(p, `${old}\n`.repeat(200) + `${SHELL_LINE}\n`);
    const r = await readHealEvents(p, SHELL_LINE.length + 10);
    expect(r).toMatchObject({ read: "ok", skipped: 0 });
    expect(r.read === "ok" && r.events.map((e) => e.ts)).toEqual([
      "2026-11-03T23:23:20Z",
    ]);
  });
});

describe("startHealNoticeWatch", () => {
  it("reads at once; ok ⇒ notify with the events; failed ⇒ a warning, nobody told", async () => {
    const notify = vi.fn(async () => 0);
    const warn = vi.fn();
    const events = [projectHealEvent(JSON.parse(SHELL_LINE))!];
    const stop1 = startHealNoticeWatch({
      notify,
      warn,
      read: async () => ({ read: "ok", events, skipped: 0 }),
    });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(events));
    stop1();
    notify.mockClear();
    const stop2 = startHealNoticeWatch({
      notify,
      warn,
      read: async () => ({ read: "failed", error: "EACCES" }),
    });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        { error: "EACCES" },
        "Could not read the heal events"
      )
    );
    expect(notify).not.toHaveBeenCalled();
    stop2();
  });
});

describe("the contract with the host", () => {
  it("synap writes heal events as kind pod.heal into state/events.jsonl, with `why`", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const synap = readFileSync(
      join(here, "..", "..", "..", "..", "synap"),
      "utf-8"
    );
    expect(synap).toContain(
      `'{kind:"pod.heal", status:$st, service:$svc, reason:$r, restartsInWindow:$n} + (if $why == null then {} else {why:$why} end)'`
    );
    expect(synap).toContain("printf '%s\\n' \"$ev\" >> state/events.jsonl");
  });
});
