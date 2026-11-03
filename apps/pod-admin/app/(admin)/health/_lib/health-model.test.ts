/**
 * Pod health's page model: the wire narrowed (a malformed body is null), the
 * one state sentence, the readings with their marks (unavailable is never a
 * value), the actions that help only the current alerts, the host's answer,
 * and the thresholds form's rule (the pod's own, checked first).
 */
import { describe, expect, it } from "vitest";
import { catalogProblems, createT } from "@synap-core/types/i18n";
import { en, fr, HEALTH_CATALOGS } from "./copy";
import { at, GB, NOW, THRESHOLDS, wire } from "./health-fixture";
import {
  actionErrorText,
  actionResultLine,
  actionsFor,
  checkThresholdDraft,
  draftFrom,
  parsePodHealth,
  readingRows,
  stateSentence,
  type PodHealthView,
} from "./health-model";

const t = createT("en", HEALTH_CATALOGS);
const tf = createT("fr", HEALTH_CATALOGS);
const view = (over: Record<string, unknown> = {}): PodHealthView => {
  const v = parsePodHealth(wire(over));
  if (!v) throw new Error("fixture is not the contract");
  return v;
};

describe("the catalogs", () => {
  it("French holds every English key, with the same arguments", () => {
    expect(catalogProblems({ en, fr })).toEqual([]);
  });
});

describe("parsePodHealth", () => {
  // Catches: a proxy page or an older pod read as a calm, empty report.
  it("refuses a body that is not the contract", () => {
    expect(parsePodHealth(null)).toBeNull();
    expect(parsePodHealth({ error: "x" })).toBeNull();
    expect(parsePodHealth(wire({ thresholds: { memory: {} } }))).toBeNull();
    expect(parsePodHealth(wire({ level: "fine" }))).toBeNull();
  });

  it("keeps an unreadable host answer apart from no answer", () => {
    expect(
      view({ actions: { pending: null, last: { read: "junk" } } }).actions.last
    ).toEqual({ read: "unreadable" });
    expect(view().actions.last).toEqual({ read: "absent" });
  });
});

describe("the state sentence", () => {
  it("says All good when nothing is open", () => {
    expect(stateSentence(t, view(), "en", NOW)).toEqual({
      sentence: "All good",
      more: null,
    });
  });

  it("never vouches for memory and disks when the host reports nothing", () => {
    expect(
      stateSentence(t, view({ hostState: "absent" }), "en", NOW).sentence
    ).toMatch(/doesn’t report memory or disks yet/);
  });

  it("names the worst alert and since when, then counts the rest", () => {
    const v = view({
      level: "critical",
      alerts: [
        {
          metric: "memoryPressure",
          level: "warning",
          since: at(22, 40),
          value: 12,
        },
        { metric: "disk:data", level: "critical", since: at(21, 5), value: 96 },
      ],
    });
    expect(stateSentence(t, v, "en", NOW)).toEqual({
      sentence: "The data disk is nearly full since 21:05",
      more: "and 1 more alert",
    });
    expect(
      stateSentence(
        t,
        view({
          alerts: [
            {
              metric: "memoryPressure",
              level: "warning",
              since: at(22, 40),
              value: 12,
            },
          ],
        }),
        "en",
        NOW
      ).sentence
    ).toBe("Memory pressure is high since 22:40");
    expect(stateSentence(tf, v, "fr", NOW).sentence).toBe(
      "Le disque des données est presque plein depuis 21:05"
    );
  });

  it("readings stopped says when the last one came", () => {
    const v = view({
      hostState: "stale",
      hostSampledAt: at(22, 10),
      alerts: [
        {
          metric: "readings",
          level: "warning",
          since: at(22, 21),
          value: null,
        },
      ],
    });
    expect(stateSentence(t, v, "en", NOW).sentence).toBe(
      "The host stopped reporting its readings at 22:10"
    );
  });
});

describe("the readings", () => {
  it("each reading carries its mark, its value and one line of detail", () => {
    const rows = readingRows(t, view(), "en", NOW);
    const memory = rows.find((r) => r.key === "memory");
    expect(memory).toMatchObject({
      name: "Memory",
      value: "52%",
      detail: "8.0 GB available of 16 GB",
      markLabel: "OK",
      tone: "healthy",
    });
    expect(rows.find((r) => r.key === "disk:data")).toMatchObject({
      name: "The data disk",
      detail: "60 GB free of 100 GB",
    });
    expect(rows.find((r) => r.key === "postgresConnections")?.detail).toBe(
      "20 of 200 connections"
    );
    expect(rows.find((r) => r.key === "load")).toMatchObject({
      value: "0.5 per core",
      tone: null,
    });
  });

  // Catches: an unmeasured block printed as "0%".
  it("an unmeasured reading has no value and says Not measured", () => {
    const swap = readingRows(t, view(), "en", NOW).find(
      (r) => r.key === "swap"
    );
    expect(swap).toMatchObject({
      value: null,
      markLabel: "Not measured",
      tone: "unknown",
    });
  });

  it("puts what is wrong first, and hides the readings row while it is fine", () => {
    const rows = readingRows(
      t,
      view({
        readings: (wire().readings as Array<Record<string, unknown>>).map(
          (r) =>
            r.key === "postgresConnections"
              ? { ...r, mark: "critical", value: 95 }
              : r
        ),
      }),
      "en",
      NOW
    );
    expect(rows[0].key).toBe("postgresConnections");
    expect(rows.some((r) => r.key === "readings")).toBe(false);
  });

  it("formats in French with the French tables", () => {
    const memory = readingRows(tf, view(), "fr", NOW).find(
      (r) => r.key === "memory"
    );
    expect(memory?.value).toBe("52 %");
  });
});

describe("the actions: only where they help the current alert", () => {
  it("none when nothing is open", () => {
    expect(actionsFor(view())).toEqual([]);
  });

  it("a disk alert offers the build cache and old images, with what each frees", () => {
    expect(
      actionsFor(
        view({
          alerts: [
            { metric: "disk:docker", level: "warning", since: null, value: 85 },
          ],
        })
      )
    ).toEqual([
      // The host keeps 2 GiB of build cache: only what is above it is freed.
      {
        kind: "host",
        action: "prune-build-cache",
        freesBytes: 3 * GB - 2 * 1024 ** 3,
      },
      { kind: "host", action: "prune-old-images", freesBytes: 2 * GB },
    ]);
  });

  it("an action that would free nothing is not offered; an unmeasured one is", () => {
    const disk = [
      { metric: "disk:data", level: "warning", since: null, value: 85 },
    ];
    expect(
      actionsFor(
        view({
          alerts: disk,
          reclaimable: { buildCacheBytes: 1 * GB, imagesReclaimableBytes: 0 },
        })
      )
    ).toEqual([]);
    expect(actionsFor(view({ alerts: disk, reclaimable: null }))).toEqual([
      { kind: "host", action: "prune-build-cache", freesBytes: null },
      { kind: "host", action: "prune-old-images", freesBytes: null },
    ]);
  });

  it("memory pressure offers pausing and a restart, never a disk action", () => {
    expect(
      actionsFor(
        view({
          alerts: [
            {
              metric: "memoryPressure",
              level: "critical",
              since: null,
              value: 30,
            },
          ],
        })
      )
    ).toEqual([
      { kind: "pause" },
      { kind: "restart", services: ["backend", "realtime"] },
    ]);
  });

  it("readings stopped offers what to run on the host", () => {
    expect(
      actionsFor(
        view({
          alerts: [
            { metric: "readings", level: "warning", since: null, value: null },
          ],
        })
      )
    ).toEqual([{ kind: "readings" }]);
  });

  it("shows the host's answer for its own action only", () => {
    const v = view({
      actions: {
        pending: null,
        last: {
          read: "ok",
          result: {
            id: "r1",
            action: "prune-build-cache",
            status: "done",
            detail: null,
            freedBytes: 2.1 * GB,
            finishedAt: new Date(NOW - 5 * 60_000).toISOString(),
          },
        },
      },
    });
    expect(actionResultLine(t, "prune-build-cache", v, "en", NOW)).toEqual({
      text: "Done 5m ago, freed 2.1 GB",
      tone: "healthy",
    });
    expect(actionResultLine(t, "prune-old-images", v, "en", NOW)).toBeNull();
    const pending = view({
      actions: {
        pending: { id: "r2", action: "restart-service", service: "backend" },
        last: { read: "absent" },
      },
    });
    expect(
      actionResultLine(t, "restart-service", pending, "en", NOW)?.text
    ).toBe("Waiting for the host to take it");
  });

  it("words the door's refusals", () => {
    expect(actionErrorText(t, "busy")).toBe(
      "Another request is still waiting for the host."
    );
    expect(actionErrorText(t, "anything")).toBe(
      "The request wasn’t sent. Try again."
    );
  });
});

describe("the thresholds form", () => {
  it("round-trips the current thresholds", () => {
    expect(checkThresholdDraft(draftFrom(THRESHOLDS))).toEqual({
      ok: true,
      patch: THRESHOLDS,
    });
  });

  it("refuses per field: empty, out of 1-100, warn not below critical", () => {
    const d = draftFrom(THRESHOLDS);
    d.memory = { warn: "90", critical: "90" };
    d.swap = { warn: "", critical: "80" };
    d.disk = { warn: "80", critical: "101" };
    expect(checkThresholdDraft(d)).toEqual({
      ok: false,
      problems: {
        memory: "warn_not_below_critical",
        swap: "not_a_number",
        disk: "out_of_range",
      },
    });
  });
});
