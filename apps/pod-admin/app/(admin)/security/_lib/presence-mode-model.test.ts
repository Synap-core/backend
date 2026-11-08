/**
 * The "Approvals need you in person" card's states: the mark in the shared
 * presence words, where the mode comes from (the operator's floor locks the
 * switch), what `report` let through as doors to the audit log, capped, and
 * when turning it on asks first.
 */
import { describe, expect, it } from "vitest";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import { PRESENCE_WORDS } from "@synap-core/types/presence";
import {
  MISSING_CAP,
  presenceModeView,
  turningOnAsks,
  warnsTwoWays,
  type PresenceModeRead,
} from "./presence-mode-model";
import { readPresenceMissingLens } from "../../audit/_lib/presence-missing-link";

const read = (over: Partial<PresenceModeRead> = {}): PresenceModeRead => ({
  mode: "report",
  source: "default",
  changedAt: null,
  changedBy: null,
  missingLast30d: { total: 0, byKind: [] },
  ...over,
});

/** The lens a row's door opens, read back by the audit page's own parser. */
const lensOf = (href: string) =>
  readPresenceMissingLens(new URL(href, "https://pod.test").searchParams);

describe("presenceModeView", () => {
  it("report: OFF in the shared words, switchable, and what ON would have refused", () => {
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
    expect(v.mark).toEqual({ kind: "stale", word: "presence.off" });
    expect(PRESENCE_WORDS.en[v.mark.word]).toBe("Off");
    expect(v.canSwitch).toBe(true);
    expect(v.source).toEqual({ word: "presence.source.default" });
    expect(v.missing.word).toBe("presence.missing.wouldRefuse");
    expect(v.missing.rows).toHaveLength(MISSING_CAP);
    // Each row is a door to the audit log filtered to ITS kind.
    for (const row of v.missing.rows) {
      expect(lensOf(row.href!)).toEqual({ kind: row.kind });
    }
    // The rest is one door: every kind, named by how many went through.
    expect(v.missing.showAll).not.toBeNull();
    expect(v.missing.showAll!.n).toBe(7);
    expect(lensOf(v.missing.showAll!.href)).toEqual({});
  });

  it("every kind on screen: no Show all", () => {
    const v = presenceModeView(
      read({
        missingLast30d: {
          total: 2,
          byKind: [{ kind: "skill", count: 2 }],
        },
      })
    );
    expect(v.missing.rows).toHaveLength(1);
    expect(v.missing.showAll).toBeNull();
  });

  it("a row with no kind is shown, with no door to open", () => {
    const v = presenceModeView(
      read({
        missingLast30d: { total: 1, byKind: [{ kind: "unknown", count: 1 }] },
      })
    );
    expect(v.missing.rows[0]!.href).toBeNull();
  });

  it("the operator's env floor holds it ON: the switch is locked and says why", () => {
    const v = presenceModeView(read({ mode: "enforce", source: "env" }));
    expect(v.on).toBe(true);
    expect(v.mark.word).toBe("presence.on");
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
      showAll: null,
    });
  });

  it("rows are named in words, never a raw token", () => {
    setAmbientCatalogLocale("en");
    const v = presenceModeView(
      read({
        missingLast30d: {
          total: 3,
          byKind: [
            { kind: "apiKeys.create", count: 1 },
            { kind: "agent/connect", count: 1 },
            { kind: "key_request", count: 1 },
          ],
        },
      })
    );
    expect(v.missing.rows[0]!.label).toBe("Create API key");
    for (const row of v.missing.rows) {
      expect(row.label, row.kind).not.toMatch(/[./_]/);
    }
  });
});

describe("turningOnAsks: ask first unless the person already has two ways in", () => {
  const f = (
    passkeys: number,
    deviceKeys: number,
    totp = false,
    recoveryCodes = 0
  ) => ({
    passkeys,
    enforce: true,
    deviceKeys,
    totp,
    recoveryCodes,
    waysIn:
      (passkeys > 0 ? 1 : 0) +
      deviceKeys +
      (totp ? 1 : 0) +
      (recoveryCodes > 0 ? 1 : 0),
  });

  it("two ways in: it turns on at once", () => {
    expect(turningOnAsks({ isError: false, data: f(1, 0, true) })).toBe(false);
    expect(turningOnAsks({ isError: false, data: f(1, 1) })).toBe(false);
    expect(turningOnAsks({ isError: false, data: f(0, 0, true, 10) })).toBe(
      false
    );
  });

  it("one way (every passkey counts as one), none, or unread: it asks first", () => {
    expect(turningOnAsks({ isError: false, data: f(3, 0) })).toBe(true);
    expect(turningOnAsks({ isError: false, data: f(0, 1) })).toBe(true);
    expect(turningOnAsks({ isError: false, data: f(0, 0) })).toBe(true);
    expect(turningOnAsks({ isError: true, data: undefined })).toBe(true);
    expect(turningOnAsks({ isError: false, data: undefined })).toBe(true);
  });
});

describe("warnsTwoWays: the card warns only on a READ count below two, while ON", () => {
  const one = {
    enforce: true,
    passkeys: 1,
    deviceKeys: 0,
    totp: false,
    recoveryCodes: 0,
    waysIn: 1,
  };
  const two = { ...one, totp: true, waysIn: 2 };
  it("ON with one way: warns", () => {
    expect(warnsTwoWays(true, { isError: false, data: one })).toBe(true);
  });
  it("ON with two, OFF, or unread: says nothing", () => {
    expect(warnsTwoWays(true, { isError: false, data: two })).toBe(false);
    expect(warnsTwoWays(false, { isError: false, data: one })).toBe(false);
    expect(warnsTwoWays(true, { isError: true, data: undefined })).toBe(false);
    expect(warnsTwoWays(true, { isError: false, data: undefined })).toBe(false);
  });
});
