import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATEGORY_LABEL,
  categorize,
  holderHref,
  holderName,
  keyHref,
  keyStatus,
  managedKeys,
  normalizeScopes,
  isPodAppAccessKey,
  keyAccessSentence,
  keyUsesOf,
  type UnifiedKey,
} from "./key-model";

const key = (over: Partial<UnifiedKey>): UnifiedKey => ({
  id: "k1",
  keyName: "k",
  keyPrefix: "synap_",
  isActive: true,
  ...over,
});

describe("categorize", () => {
  it.each([
    [{ keyType: "is_internal" }, "system"],
    [{ keyType: "service" }, "service"],
    [{ keyType: "hub_inbound", linkedUserId: "u1" }, "agent"],
    [
      {
        keyType: "hub_inbound",
        linkedUserId: "u1",
        hubId: "integration:cli:abc",
      },
      "cli",
    ],
    [{ keyType: "hub_inbound" }, "system"],
    [{ keyType: "system" }, "system"],
    [{ keyType: "user_pat" }, "operator"],
    [{ keyType: null }, "operator"],
    // A person's app sign-in token is held by the person, yet it is an app's.
    [{ keyType: "app_person", holder: { kind: "person", name: "Ada" } }, "app"],
  ] as const)("%o → %s", (over, expected) => {
    expect(categorize(key(over))).toBe(expected);
  });

  // App and computer keys are minted `user_pat` (app-connect.ts,
  // machine-connect.ts): only the holder keeps them out of "Operator".
  it.each([
    [{ keyType: "user_pat", holder: { kind: "app", name: "Invoicer" } }, "app"],
    [
      { keyType: "user_pat", holder: { kind: "computer", name: "Studio" } },
      "computer",
    ],
    [
      { keyType: "user_pat", holder: { kind: "agent", name: "Claude" } },
      "agent",
    ],
    [
      { keyType: "user_pat", holder: { kind: "person", name: "Ada" } },
      "operator",
    ],
    [{ keyType: "user_pat", holder: null }, "operator"],
    // keyType still wins where it is the real signal.
    [{ keyType: "service", holder: { kind: "agent", name: "x" } }, "service"],
    [
      { keyType: "is_internal", holder: { kind: "agent", name: "x" } },
      "system",
    ],
  ] as const)("holder %o → %s", (over, expected) => {
    expect(categorize(key(over))).toBe(expected);
  });

  it("labels app, computer and agent with the vocabulary's nouns", () => {
    expect(CATEGORY_LABEL.app).toBe("App");
    expect(CATEGORY_LABEL.computer).toBe("Computer");
    expect(CATEGORY_LABEL.agent).toBe("Agent");
  });
});

describe("holderName", () => {
  it("names the app, computer or agent that holds a key, never a person", () => {
    expect(holderName(key({ holder: { kind: "app", name: "Invoicer" } }))).toBe(
      "Invoicer"
    );
    expect(holderName(key({ holder: { kind: "person", name: "Ada" } }))).toBe(
      null
    );
    expect(holderName(key({ holder: { kind: "computer", name: "  " } }))).toBe(
      null
    );
    expect(holderName(key({}))).toBe(null);
  });
});

describe("holderHref", () => {
  it("opens an app's key on its app page; other holders have none here", () => {
    expect(
      holderHref(
        key({ holder: { kind: "app", name: "Invoicer", appId: "app_x" } })
      )
    ).toBe("/applications/key/app_x");
    // An older pod sends no id: no link rather than a broken one.
    expect(holderHref(key({ holder: { kind: "app", name: "Invoicer" } }))).toBe(
      null
    );
    expect(holderHref(key({ holder: { kind: "agent", name: "Claude" } }))).toBe(
      null
    );
  });
});

describe("keyStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("revoked wins over any expiry", () => {
    expect(
      keyStatus({ isActive: false, expiresAt: "2030-01-01T00:00:00Z" })
    ).toEqual({ kind: "down", label: "Revoked" });
  });

  it("past expiry is expired", () => {
    expect(
      keyStatus({ isActive: true, expiresAt: "2026-10-11T00:00:00Z" })
    ).toEqual({ kind: "stale", label: "Expired" });
  });

  it("within a week is expiring soon", () => {
    expect(
      keyStatus({ isActive: true, expiresAt: "2026-10-15T00:00:00Z" })
    ).toEqual({ kind: "stale", label: "Expiring soon" });
  });

  it("no expiry or a far one is active", () => {
    expect(keyStatus({ isActive: true })).toEqual({
      kind: "healthy",
      label: "Active",
    });
    expect(
      keyStatus({ isActive: true, expiresAt: "2027-01-01T00:00:00Z" })
    ).toEqual({ kind: "healthy", label: "Active" });
  });
});

describe("normalizeScopes", () => {
  it("accepts an array, a comma list, or nothing", () => {
    expect(normalizeScopes(["a", "b"])).toEqual(["a", "b"]);
    expect(normalizeScopes("a, b,,c ")).toEqual(["a", "b", "c"]);
    expect(normalizeScopes(null)).toEqual([]);
    expect(normalizeScopes("")).toEqual([]);
  });
});

describe("holderHref", () => {
  it("opens a computer's key on its computer (the key's holder id)", () => {
    expect(
      holderHref(
        key({ userId: "c 1", holder: { kind: "computer", name: "devbox" } })
      )
    ).toBe("/computers/c%201");
  });

  it("is null for every other holder, and for a computer key with no holder id", () => {
    for (const kind of ["app", "agent", "person"] as const)
      expect(
        holderHref(key({ userId: "u", holder: { kind, name: "x" } }))
      ).toBeNull();
    expect(
      holderHref(key({ holder: { kind: "computer", name: "devbox" } }))
    ).toBeNull();
    expect(holderHref(key({ userId: "u", holder: null }))).toBeNull();
  });
});

describe("keyHref", () => {
  it("opens the holder's page first, even for a space key", () => {
    expect(
      keyHref(
        key({
          userId: "c1",
          workspaceId: "ws1",
          holder: { kind: "computer", name: "devbox" },
        })
      )
    ).toBe("/computers/c1");
  });

  // Rules out: a key row that opens nothing (finding d99517f7), and a space
  // key sent to its space's tab instead of its own page.
  it("opens every other key on its own page", () => {
    expect(
      keyHref(
        key({
          id: "k 1",
          workspaceId: "ws1",
          holder: { kind: "person", name: "x" },
        })
      )
    ).toBe("/keys/k%201");
    expect(keyHref(key({ id: "k2", workspaceId: null, holder: null }))).toBe(
      "/keys/k2"
    );
  });
});

describe("a pod app's access key is the app's, not a key to manage", () => {
  const podAppKey = key({
    id: "pod",
    keyType: "hub_inbound",
    linkedUserId: "me",
    holder: { kind: "app", name: "Studio", appId: "app_1" },
  });
  const appConnectKey = key({
    id: "ac",
    keyType: "user_pat",
    holder: { kind: "app", name: "My app", appId: "app_2" },
  });
  const signIn = key({
    id: "si",
    keyType: "app_person",
    holder: { kind: "person", name: "Ada" },
  });
  const cli = key({
    id: "cli",
    keyType: "hub_inbound",
    linkedUserId: "me",
    hubId: "integration:cli:1",
    holder: { kind: "person", name: "Ada" },
  });

  it("recognises only the pod app's hourly key", () => {
    expect(isPodAppAccessKey(podAppKey)).toBe(true);
    expect(isPodAppAccessKey(appConnectKey)).toBe(false);
    expect(isPodAppAccessKey(signIn)).toBe(false);
    expect(isPodAppAccessKey(cli)).toBe(false);
  });

  it("leaves it out of the keys list, live or revoked, and keeps the rest", () => {
    const revokedPod = { ...podAppKey, id: "pod-old", isActive: false };
    expect(
      managedKeys([podAppKey, appConnectKey, signIn, cli, revokedPod]).map(
        (k) => k.id
      )
    ).toEqual(["ac", "si", "cli"]);
  });

  it("a sign-in token keeps its App badge", () => {
    expect(CATEGORY_LABEL[categorize(signIn)]).toBe(CATEGORY_LABEL.app);
  });
});

describe("keyAccessSentence — what a key can do, in words", () => {
  // Rules out: a row that prints `hub-protocol.read, hub-protocol.write +1`
  // (finding 3b57ddca) — the words come from the key's grants.
  it("says what its grants allow, never a scope token", () => {
    const line = keyAccessSentence(
      key({
        scope: ["hub-protocol.read", "hub-protocol.write"],
        access: "granted",
        grants: [{ permissions: ["event.create"], expiresAt: null }],
      })
    );
    expect(line).toContain("Create Activity");
    expect(line).not.toContain("hub-protocol");
  });

  it("says a key that can touch nothing so", () => {
    expect(keyAccessSentence(key({ access: "ungranted", grants: [] }))).toMatch(
      /^Can touch nothing/
    );
  });

  // Rules out: a list that does not carry access read as "touches nothing".
  it("is null when the list did not carry it", () => {
    expect(keyAccessSentence(key({}))).toBeNull();
  });
});

describe("keyUsesOf — a live key's doors, from its scopes", () => {
  it("reads a use from its read or its write scope", () => {
    expect(
      keyUsesOf({ scope: ["hub-protocol.write", "mcp.read", "data.read"] })
    ).toEqual(["hub", "mcp"]);
    expect(keyUsesOf({ scope: "realtime:observe" })).toEqual(["realtime"]);
    expect(keyUsesOf({ scope: null })).toEqual([]);
  });
});
