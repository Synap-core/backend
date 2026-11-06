import { describe, expect, it } from "vitest";
import {
  presenceKindWords,
  presenceMissingHref,
  presenceMissingQuery,
  readPresenceMissingLens,
} from "./presence-missing-link";

/** What the audit page reads from an href the card built. */
function roundTrip(href: string) {
  return readPresenceMissingLens(
    new URL(href, "https://pod.example").searchParams
  );
}

describe("presence-missing lens address", () => {
  it("every kind: the href carries the lens and no kind", () => {
    expect(presenceMissingHref()).toBe("/audit?presence=missing");
    expect(roundTrip(presenceMissingHref())).toEqual({});
  });

  it.each(["agent/connect", "apiKeys.create", "key_request", "a b&c=d"])(
    "a kind survives the round trip: %s",
    (kind) => {
      const href = presenceMissingHref(kind);
      expect(href.startsWith("/audit?presence=missing&kind=")).toBe(true);
      expect(roundTrip(href)).toEqual({ kind });
    }
  );

  it("a slash in a kind is encoded, so the path stays /audit", () => {
    const href = presenceMissingHref("agent/connect");
    expect(href).toBe("/audit?presence=missing&kind=agent%2Fconnect");
    expect(new URL(href, "https://pod.example").pathname).toBe("/audit");
  });

  it("the plain audit log, or another value, is no lens", () => {
    expect(roundTrip("/audit")).toBeNull();
    expect(roundTrip("/audit?kind=agent%2Fconnect")).toBeNull();
    expect(roundTrip("/audit?presence=other")).toBeNull();
    expect(readPresenceMissingLens(null)).toBeNull();
  });

  it("an empty kind means every kind", () => {
    expect(roundTrip("/audit?presence=missing&kind=")).toEqual({});
    expect(roundTrip("/audit?presence=missing&kind=%20")).toEqual({});
  });
});

describe("presence-missing lens → listAuditLogs input", () => {
  it("no lens sends nothing; every kind sends {}; one kind sends it", () => {
    expect(presenceMissingQuery(null)).toBeUndefined();
    expect(presenceMissingQuery({})).toEqual({});
    expect(presenceMissingQuery({ kind: "apiKeys.create" })).toEqual({
      kind: "apiKeys.create",
    });
  });

  it("drives the query straight from an address", () => {
    expect(
      presenceMissingQuery(roundTrip(presenceMissingHref("agent/connect")))
    ).toEqual({ kind: "agent/connect" });
    expect(presenceMissingQuery(roundTrip("/audit"))).toBeUndefined();
  });
});

describe("presenceKindWords", () => {
  it("reads an approval kind as the action on the object", () => {
    const words = presenceKindWords("agent/connect");
    expect(words).toMatch(/connect/i);
    expect(words).toMatch(/agent/i);
    expect(words).not.toContain("/");
  });

  it("never shows a raw token", () => {
    for (const kind of ["key_request", "apiKeys.create"]) {
      const words = presenceKindWords(kind);
      expect(words).not.toBe(kind);
      expect(words).not.toContain("_");
    }
  });
});
