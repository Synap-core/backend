import { describe, expect, it } from "vitest";
import type { PushDeviceRow } from "@synap-core/types/push";
import {
  categoryRows,
  phonePill,
  phoneSecondary,
  phoneViews,
  phonesSummary,
  turnOffCopy,
} from "./devices-model";

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const row = (over: Partial<PushDeviceRow> = {}): PushDeviceRow => ({
  id: "p1",
  name: "Ada's iPhone",
  platform: "ios",
  appVersion: "1.4.0",
  status: "connected",
  lastSeenAt: ago(2),
  createdAt: ago(100),
  revokedAt: null,
  isThisDevice: false,
  ...over,
});

describe("phoneViews", () => {
  it("is empty without rows", () => {
    expect(phoneViews(undefined)).toEqual([]);
  });

  it("lists phones that get pushes before the ones that are off", () => {
    const ids = phoneViews([
      row({ id: "revoked", status: "revoked" }),
      row({ id: "off", status: "disconnected" }),
      row({ id: "on" }),
    ]).map((v) => v.id);
    expect(ids).toEqual(["on", "off", "revoked"]);
  });
});

describe("phoneSecondary", () => {
  it("says platform, app version and when it was last used", () => {
    const [v] = phoneViews([row()]);
    expect(phoneSecondary(v!)).toBe("iOS · app 1.4.0 · seen 2d ago");
  });

  it("says when it was added when the app does not report each launch", () => {
    const [v] = phoneViews([row({ lastSeenAt: null, appVersion: null })]);
    expect(phoneSecondary(v!)).toBe("iOS · added 3mo ago");
  });

  it("leads with the state when the phone is not plainly on", () => {
    const [v] = phoneViews([row({ status: "revoked" })]);
    expect(phoneSecondary(v!)).toMatch(/^Turned off · iOS/);
  });
});

describe("phonePill", () => {
  it("is quiet for a phone that gets its pushes", () => {
    expect(phonePill(phoneViews([row()])[0]!)).toBeUndefined();
  });

  it("marks a phone not used lately as stale, and off ones as grey", () => {
    expect(phonePill(phoneViews([row({ lastSeenAt: ago(40) })])[0]!)).toEqual({
      kind: "stale",
      label: "Not seen lately",
    });
    expect(
      phonePill(phoneViews([row({ status: "disconnected" })])[0]!)
    ).toEqual({ kind: "unknown", label: "Off" });
  });
});

describe("phonesSummary", () => {
  it("counts the phones that still get pushes, unused ones included", () => {
    expect(
      phonesSummary(
        phoneViews([
          row({ id: "a" }),
          row({ id: "b", lastSeenAt: ago(40) }),
          row({ id: "c", status: "revoked" }),
        ])
      )
    ).toBe("2 phones get your notifications. 1 not used lately.");
    expect(phonesSummary(phoneViews([row()]))).toBe(
      "1 phone gets your notifications."
    );
    expect(phonesSummary(phoneViews([row({ status: "revoked" })]))).toBe(
      "No phone gets your notifications right now."
    );
  });
});

describe("turnOffCopy", () => {
  it("names the phone and says it stays off until that phone turns it on", () => {
    const copy = turnOffCopy(phoneViews([row()])[0]!);
    expect(copy.title).toBe("Stop notifications to Ada's iPhone?");
    expect(copy.consequence).toMatch(/turn notifications on from that phone/);
    expect(copy.confirmLabel).toBe("Stop notifications");
  });
});

describe("categoryRows", () => {
  it("labels each category with its one wording", () => {
    expect(categoryRows([{ category: "mention", enabled: false }])).toEqual([
      {
        category: "mention",
        name: "When you're mentioned",
        hint: "Someone names you or invites you to a space",
        enabled: false,
      },
    ]);
  });

  it("humanizes a category a newer pod sends", () => {
    expect(
      categoryRows([{ category: "morning-brief", enabled: true }])[0]
    ).toMatchObject({ name: expect.not.stringContaining("-") });
  });
});
