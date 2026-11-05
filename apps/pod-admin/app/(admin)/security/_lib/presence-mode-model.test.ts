/**
 * The "Approvals need you in person" card's states (W3 slice 3): the mark,
 * where the mode comes from (the operator's floor locks the switch), and what
 * `report` let through, capped and in words.
 */
import { describe, expect, it } from "vitest";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import {
  MISSING_CAP,
  missingKindLabel,
  presenceModeView,
  type PresenceModeRead,
} from "./presence-mode-model";

const read = (over: Partial<PresenceModeRead> = {}): PresenceModeRead => ({
  mode: "report",
  source: "default",
  changedAt: null,
  changedBy: null,
  missingLast30d: { total: 0, byKind: [] },
  ...over,
});

describe("presenceModeView", () => {
  it("report: recording only, switchable, and what ON would have refused", () => {
    const v = presenceModeView(
      read({
        missingLast30d: {
          total: 7,
          byKind: [
            { kind: "governanceRules.create", count: 3 },
            { kind: "agent/connect", count: 2 },
            { kind: "skill", count: 1 },
            { kind: "apiKeys.rotate", count: 1 },
          ],
        },
      })
    );
    expect(v.on).toBe(false);
    expect(v.mark).toEqual({ kind: "stale", word: "presence.mark.off" });
    expect(v.canSwitch).toBe(true);
    expect(v.source).toEqual({ word: "presence.source.default" });
    expect(v.missing.word).toBe("presence.missing.wouldRefuse");
    expect(v.missing.rows).toHaveLength(MISSING_CAP);
    expect(v.missing.more).toBe(1);
    const missed = read({
      missingLast30d: {
        total: 4,
        byKind: ["a", "b", "c", "d"].map((kind) => ({ kind, count: 1 })),
      },
    });
    expect(presenceModeView(missed, { showAll: true }).missing).toMatchObject({
      more: 0,
    });
    expect(
      presenceModeView(missed, { showAll: true }).missing.rows
    ).toHaveLength(4);
  });

  it("the operator's env floor holds it ON: the switch is locked and says why", () => {
    const v = presenceModeView(read({ mode: "enforce", source: "env" }));
    expect(v.on).toBe(true);
    expect(v.mark.word).toBe("presence.mark.on");
    expect(v.canSwitch).toBe(false);
    expect(v.source).toEqual({ word: "presence.source.env" });
  });

  it("a pod admin's change says when; ON with older misses says they were before", () => {
    const v = presenceModeView(
      read({
        mode: "enforce",
        source: "setting",
        changedAt: "2026-11-05T10:00:00.000Z",
        missingLast30d: { total: 2, byKind: [{ kind: "skill", count: 2 }] },
      })
    );
    expect(v.canSwitch).toBe(true);
    expect(v.source).toEqual({
      word: "presence.source.changed",
      at: "2026-11-05T10:00:00.000Z",
    });
    expect(v.missing.word).toBe("presence.missing.before");
  });

  it("nothing missed: one sentence, no list", () => {
    const v = presenceModeView(read());
    expect(v.missing).toEqual({
      word: "presence.missing.none",
      total: 0,
      rows: [],
      more: 0,
    });
  });
});

describe("missingKindLabel: never a raw token", () => {
  it("names an action, a request and an approval in words", () => {
    setAmbientCatalogLocale("en");
    expect(missingKindLabel("apiKeys.create")).toBe("Create a key");
    for (const kind of [
      "apiKeys.create",
      "skill",
      "agent/connect",
      "unknown",
    ]) {
      const label = missingKindLabel(kind);
      expect(label, kind).not.toBe(kind);
      expect(label).not.toMatch(/[./_]/);
    }
  });
});
