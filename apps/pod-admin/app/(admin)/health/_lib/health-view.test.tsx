/**
 * Pod health's body, rendered (react-dom/server) in each state it answers:
 * loading, a failed read (error + Retry, never an empty healthy page), an
 * unreadable answer, all good (no actions), and alerts whose actions are the
 * ones that help them.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));

import { HealthBody, type HealthHandlers } from "./health-view";
import { parsePodHealth, type PodHealthView } from "./health-model";
import { at, NOW, wire } from "./health-fixture";

const handlers: HealthHandlers = {
  onHostAction: () => {},
  sendingAction: null,
  onSaveThresholds: () => {},
  savingThresholds: false,
};

const view = (over: Record<string, unknown> = {}): PodHealthView => {
  const v = parsePodHealth(wire(over));
  if (!v) throw new Error("fixture");
  return v;
};

const render = (state: Parameters<typeof HealthBody>[0]["state"]) =>
  renderToStaticMarkup(
    <HealthBody state={state} handlers={handlers} now={NOW} />
  );

describe("HealthBody states", () => {
  it("loading draws the readings card's skeleton", () => {
    const out = render({ kind: "loading" });
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("Readings");
    expect(out).not.toContain("All good");
  });

  // Catches: a 500 rendered as a calm page with no readings.
  it("a failed read is an error with Retry, never All good", () => {
    const out = render({ kind: "failed", onRetry: () => {} });
    expect(out).toContain("Couldn’t read this pod’s health.");
    expect(out).toContain(">Retry<");
    expect(out).not.toContain("All good");
  });

  it("an answer it cannot read says so, with Retry", () => {
    const out = render({ kind: "unreadable", onRetry: () => {} });
    expect(out).toContain("The pod sent an answer this page can’t read.");
    expect(out).toContain(">Retry<");
  });

  it("all good: the sentence, the readings, no actions, thresholds behind a disclosure", () => {
    const out = render({ kind: "ready", view: view() });
    expect(out).toContain("All good");
    expect(out).toContain("Memory");
    expect(out).toContain("52% · 8.0 GB available of 16 GB");
    expect(out).toContain("Not measured");
    expect(out).not.toContain("What frees room");
    expect(out).toContain("Change thresholds");
    expect(out).not.toContain("Save thresholds");
  });

  it("a disk alert: the mark and sentence first, then what frees room", () => {
    const out = render({
      kind: "ready",
      view: view({
        level: "critical",
        alerts: [
          {
            metric: "disk:data",
            level: "critical",
            since: at(21, 5),
            value: 96,
          },
        ],
      }),
    });
    expect(out).toContain("Critical");
    expect(out).toContain("The data disk is nearly full since 21:05");
    expect(out).toContain("What frees room");
    expect(out).toContain("Frees about 3.0 GB. Docker rebuilds it");
    expect(out).toContain("Keeps the current and the previous release");
    expect(out).toContain(">Trim<");
    expect(out).not.toContain("Restart a service");
  });

  it("memory pressure: pause doors and a restart, never a disk action", () => {
    const out = render({
      kind: "ready",
      view: view({
        level: "warning",
        alerts: [
          {
            metric: "memoryPressure",
            level: "warning",
            since: at(22, 40),
            value: 12,
          },
        ],
      }),
    });
    expect(out).toContain("Memory pressure is high since 22:40");
    expect(out).toContain('href="/runs"');
    expect(out).toContain('href="/rules"');
    expect(out).toContain('href="/agents"');
    expect(out).toContain("Restart a service");
    expect(out).toContain("The database is never restarted from here.");
    expect(out).not.toContain("Trim the build cache");
  });
});
