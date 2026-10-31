import { describe, expect, it } from "vitest";
import { AGENT_CONNECT_COMMAND } from "../agents/index.js";
import {
  CONNECT_COMMAND,
  NEVER_SEEN_LABEL,
  NO_KEY_LABEL,
  RECONNECT_COMMAND,
  computerKeyRead,
  computerKeyState,
  daysLeft,
  days,
  isLiveKey,
  platformLabel,
  seenLine,
} from "./index.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const key = (
  state: "active" | "expiring" | "expired" | "revoked" | "none",
  expiresAt: Date | null = null
) => ({ state, expiresAt });

describe("computerKeyRead", () => {
  it("a live key is Active and says how long it has", () => {
    expect(
      computerKeyRead(key("active", new Date(NOW + 12 * DAY)), NOW)
    ).toEqual({ state: "active", label: "Active", detail: "12 days left" });
    expect(computerKeyRead(key("active"), NOW)).toEqual({
      state: "active",
      label: "Active",
      detail: "No expiry",
    });
  });

  it("an expiring key counts whole days, at least one", () => {
    expect(
      computerKeyRead(key("expiring", new Date(NOW + 2.5 * DAY)), NOW).label
    ).toBe("Expires in 3 days");
    expect(
      computerKeyRead(key("expiring", new Date(NOW + 1000)), NOW).label
    ).toBe("Expires in 1 day");
    expect(computerKeyRead(key("expiring"), NOW).label).toBe("Expiring");
  });

  it("expired, revoked and no key read as their own words", () => {
    expect(computerKeyRead(key("expired"), NOW).label).toBe("Expired");
    expect(computerKeyRead(key("revoked"), NOW).label).toBe("Revoked");
    expect(computerKeyRead(null, NOW)).toEqual({
      state: "none",
      label: NO_KEY_LABEL,
      detail: null,
    });
  });
});

describe("the small helpers", () => {
  it("daysLeft / days", () => {
    expect(daysLeft(new Date(NOW - DAY), NOW)).toBe(1);
    expect(days(1)).toBe("1 day");
    expect(days(30)).toBe("30 days");
  });

  it("computerKeyState and isLiveKey", () => {
    expect(computerKeyState({ key: null })).toBe("none");
    expect(computerKeyState({ key: key("expired") })).toBe("expired");
    expect(isLiveKey(key("expiring"))).toBe(true);
    expect(isLiveKey(key("expired"))).toBe(false);
    expect(isLiveKey(null)).toBe(false);
  });

  it("seenLine has ONE never-seen wording", () => {
    expect(seenLine(null, () => "x")).toBe(NEVER_SEEN_LABEL);
    expect(seenLine(undefined, () => "x")).toBe("Not seen yet");
    expect(seenLine("2026-10-31T11:57:00Z", () => "3m ago")).toBe(
      "Seen 3m ago"
    );
  });

  it("platformLabel names the OS a person knows", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("freebsd")).toBe("Freebsd");
    expect(platformLabel("  ")).toBeNull();
    expect(platformLabel(null)).toBeNull();
  });

  it("the commands spell from the ONE connect command", () => {
    expect(CONNECT_COMMAND).toBe(AGENT_CONNECT_COMMAND);
    expect(RECONNECT_COMMAND).toBe(
      AGENT_CONNECT_COMMAND.replace(/ init$/, " pods reconnect")
    );
    expect(RECONNECT_COMMAND).toMatch(/ pods reconnect$/);
  });
});
