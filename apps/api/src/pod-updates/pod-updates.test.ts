/**
 * U3 setting + U4 outcome — the pure pieces and the one file read.
 * What each block would catch is named on it.
 */
import { describe, expect, it } from "vitest";
import {
  buildPodUpdatesStatus,
  DEFAULT_POD_UPDATE_SETTINGS,
  parseUpdateSettingsPatch,
  projectUpdateOutcome,
  readLastUpdate,
  resolvePodUpdateSettings,
} from "./index.js";

const ENGINE_RECORD = {
  ts: "2026-10-04T12:00:00Z",
  kind: "pod.update",
  status: "rolled_back",
  from: "v1.4.0",
  to: "v1.5.0",
  reason: "backend migration failed",
  dbRestored: true,
  backup: "/opt/synap/backups/pre-update-20261004.dump",
  pod: "perso.synap.live",
};

describe("U3 default — auto-update is ON (founder decision)", () => {
  // Catches: a default flipped to off/manual, or `undefined` read as false.
  it("a pod that never chose resolves to auto:true, stable, not explicit", () => {
    expect(resolvePodUpdateSettings(undefined)).toEqual({
      auto: true,
      channel: "stable",
      explicit: false,
    });
    expect(DEFAULT_POD_UPDATE_SETTINGS.auto).toBe(true);
  });

  it("a stored owner choice wins, and is marked explicit", () => {
    expect(resolvePodUpdateSettings({ auto: false, channel: "fast" })).toEqual({
      auto: false,
      channel: "fast",
      explicit: true,
    });
  });

  // Catches: a string "false" from a hand-edited row silently becoming truthy.
  it("malformed stored fields fall back per field", () => {
    expect(resolvePodUpdateSettings({ auto: "false", channel: "beta" })).toEqual({
      auto: true,
      channel: "stable",
      explicit: false,
    });
  });
});

describe("settings PUT body", () => {
  it("accepts a partial patch", () => {
    expect(parseUpdateSettingsPatch({ auto: false })).toEqual({ auto: false });
    expect(parseUpdateSettingsPatch({ channel: "fast" })).toEqual({
      channel: "fast",
    });
  });
  it("refuses empty, unknown keys and wrong types", () => {
    expect(parseUpdateSettingsPatch({})).toBeNull();
    expect(parseUpdateSettingsPatch({ auto: "yes" })).toBeNull();
    expect(parseUpdateSettingsPatch({ auto: true, pinned: "v1" })).toBeNull();
    expect(parseUpdateSettingsPatch(null)).toBeNull();
  });
});

describe("U4 outcome projection — metadata only", () => {
  // Catches: the host backup PATH or anything unlisted leaking to the public status.
  it("keeps exactly the metadata fields", () => {
    const o = projectUpdateOutcome(ENGINE_RECORD)!;
    expect(Object.keys(o).sort()).toEqual(
      ["at", "dbRestored", "from", "reason", "status", "to", "updateId"].sort()
    );
    expect(JSON.stringify(o)).not.toContain("/opt/synap/backups");
    expect(o.status).toBe("rolled_back");
    expect(o.dbRestored).toBe(true);
  });

  // Catches: an id that changes between reads (⇒ the CP emails every poll).
  it("derives a STABLE update id from the record when it carries none", () => {
    const a = projectUpdateOutcome(ENGINE_RECORD)!.updateId;
    const b = projectUpdateOutcome({ ...ENGINE_RECORD })!.updateId;
    const other = projectUpdateOutcome({ ...ENGINE_RECORD, ts: "2026-10-05T00:00:00Z" })!.updateId;
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(projectUpdateOutcome({ ...ENGINE_RECORD, id: "upd-1" })!.updateId).toBe("upd-1");
  });
});

describe("readLastUpdate — absent and failed are different facts", () => {
  it("ENOENT ⇒ absent", async () => {
    const r = await readLastUpdate("/x", async () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    });
    expect(r).toEqual({ read: "absent" });
  });
  // Catches: `catch { return absent }` — a broken mount reading as "never updated".
  it("EACCES ⇒ failed, not absent", async () => {
    const r = await readLastUpdate("/x", async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(r.read).toBe("failed");
  });
  it("garbage ⇒ failed", async () => {
    expect((await readLastUpdate("/x", async () => "{not json")).read).toBe("failed");
    expect((await readLastUpdate("/x", async () => "{}")).read).toBe("failed");
  });
  it("a record ⇒ ok with the projected outcome", async () => {
    const r = await readLastUpdate("/x", async () => JSON.stringify(ENGINE_RECORD));
    expect(r.read).toBe("ok");
  });
});

describe("buildPodUpdatesStatus — the section the CP reads", () => {
  // Catches: a failed settings read folded into the default (auto:true) —
  // the CP would then push to a pod whose owner turned updates off.
  it("a failed settings read is null + failed, never the default", async () => {
    const s = await buildPodUpdatesStatus({
      readSettingsRaw: async () => {
        throw new Error("db down");
      },
      readLastUpdate: async () => ({ read: "absent" }),
    });
    expect(s.settings).toBeNull();
    expect(s.settingsRead).toBe("failed");
  });

  it("a healthy pod reports its setting and outcome", async () => {
    const s = await buildPodUpdatesStatus({
      readSettingsRaw: async () => ({ auto: false, channel: "stable", updatedAt: "x" }),
      readLastUpdate: async () => ({
        read: "ok",
        outcome: projectUpdateOutcome(ENGINE_RECORD)!,
      }),
    });
    expect(s.settings).toEqual({ auto: false, channel: "stable", explicit: true });
    expect(s.settingsRead).toBe("ok");
    expect(s.lastUpdate.read).toBe("ok");
  });
});
