import { describe, expect, it } from "vitest";
import { findPodKeyed, rekeyPodRecord } from "./index";

/**
 * Self-healing pod-keyed records (wave 1 step 4). Sessions and credentials were
 * stored under whatever spelling of the pod URL each surface used; once the key
 * sites read through podUrlKey, a record still keyed by an older spelling must
 * heal onto the origin, or the person is signed out.
 */
const POD = "https://pod.example.com";

const LEGACY_SPELLINGS: Array<[string, string]> = [
  ["trailing slash", "https://pod.example.com/"],
  ["many trailing slashes", "https://pod.example.com///"],
  ["mixed-case host", "https://Pod.Example.COM"],
  ["explicit default port", "https://pod.example.com:443"],
  ["a path", "https://pod.example.com/api/hub/"],
];

describe("rekeyPodRecord: a record keyed by old spellings heals onto the origin", () => {
  it.each(LEGACY_SPELLINGS)(
    "%s: the session is found again under the origin",
    (_label, legacy) => {
      const { record, changed, unparseable } = rekeyPodRecord({
        [legacy]: { token: "t1" },
      });
      expect(record).toEqual({ [POD]: { token: "t1" } });
      expect(changed).toBe(true);
      expect(unparseable).toEqual([]);
    }
  );

  it("every legacy spelling at once merges into ONE entry, the first in insertion order", () => {
    const input = Object.fromEntries(
      LEGACY_SPELLINGS.map(([, k], i) => [k, `v${i}`])
    );
    const { record, changed } = rekeyPodRecord(input);
    expect(record).toEqual({ [POD]: "v0" });
    expect(changed).toBe(true);
  });

  it("the entry already under the canonical key wins over a legacy duplicate, before or after it", () => {
    expect(
      rekeyPodRecord({ [`${POD}/`]: "old", [POD]: "current" }).record
    ).toEqual({ [POD]: "current" });
    expect(
      rekeyPodRecord({ [POD]: "current", [`${POD}/`]: "old" }).record
    ).toEqual({ [POD]: "current" });
  });

  it("the canonical entry wins even when prefer would pick the legacy one", () => {
    const prefer = (a: number, b: number) => Math.max(a, b);
    expect(rekeyPodRecord({ [`${POD}/`]: 9, [POD]: 1 }, prefer).record).toEqual(
      { [POD]: 1 }
    );
  });

  it("prefer decides between legacy duplicates, folding in insertion order", () => {
    const newest = (a: { at: number }, b: { at: number }) =>
      b.at > a.at ? b : a;
    const { record } = rekeyPodRecord(
      {
        [`${POD}/`]: { at: 1 },
        "https://POD.example.com": { at: 3 },
        "https://pod.example.com:443": { at: 2 },
      },
      newest
    );
    expect(record).toEqual({ [POD]: { at: 3 } });
  });

  it("other pods keep their own entries; a non-default port and http are other origins", () => {
    const { record } = rekeyPodRecord({
      [`${POD}/`]: "a",
      "https://other.example.com/": "b",
      "http://localhost:4000/": "c",
      "https://pod.example.com:8443": "d",
      "http://pod.example.com": "e",
    });
    expect(record).toEqual({
      [POD]: "a",
      "https://other.example.com": "b",
      "http://localhost:4000": "c",
      "https://pod.example.com:8443": "d",
      "http://pod.example.com": "e",
    });
  });

  it("is idempotent: a second run changes nothing", () => {
    const first = rekeyPodRecord({
      [`${POD}///`]: "a",
      "https://Other.example.com/x": "b",
      "not a url": "c",
    });
    expect(first.changed).toBe(true);
    const second = rekeyPodRecord(first.record);
    expect(second.changed).toBe(false);
    expect(second.record).toEqual(first.record);
  });

  it("a record already canonical reports changed: false", () => {
    const { record, changed } = rekeyPodRecord({ [POD]: "a" });
    expect(changed).toBe(false);
    expect(record).toEqual({ [POD]: "a" });
  });

  it("an unparseable key is kept as is and reported, never dropped", () => {
    const { record, changed, unparseable } = rekeyPodRecord({
      "pod.example.com": "bare host",
      "": "empty",
      [`${POD}/`]: "a",
    });
    expect(record).toEqual({
      "pod.example.com": "bare host",
      "": "empty",
      [POD]: "a",
    });
    expect(unparseable).toEqual(["pod.example.com", ""]);
    expect(changed).toBe(true);
  });

  it("never mutates its input", () => {
    const input = { [`${POD}/`]: "a" };
    rekeyPodRecord(input);
    expect(input).toEqual({ [`${POD}/`]: "a" });
  });
});

describe("findPodKeyed: the value for a pod under any spelling, and what to rewrite", () => {
  it.each(LEGACY_SPELLINGS)(
    "%s stored: found, and reported stale",
    (_label, legacy) => {
      expect(findPodKeyed({ [legacy]: "t1" }, POD)).toEqual({
        key: POD,
        value: "t1",
        staleKeys: [legacy],
      });
    }
  );

  it("looked up by any spelling of the URL", () => {
    expect(
      findPodKeyed({ [POD]: "t1" }, "https://Pod.Example.com:443/trpc/")
    ).toEqual({ key: POD, value: "t1", staleKeys: [] });
  });

  it("lists every legacy spelling present; the canonical entry's value wins", () => {
    const record = {
      "https://pod.example.com/": "old1",
      [POD]: "current",
      "https://POD.example.com": "old2",
      "https://other.example.com/": "other",
    };
    expect(findPodKeyed(record, POD)).toEqual({
      key: POD,
      value: "current",
      staleKeys: ["https://pod.example.com/", "https://POD.example.com"],
    });
  });

  it("no canonical entry: the first legacy spelling's value", () => {
    expect(
      findPodKeyed({ [`${POD}/`]: "first", [`${POD}//`]: "second" }, POD)
    ).toEqual({
      key: POD,
      value: "first",
      staleKeys: [`${POD}/`, `${POD}//`],
    });
  });

  it("not stored under any spelling: the key, no value, no stale keys", () => {
    expect(findPodKeyed({ "https://other.example.com": "x" }, POD)).toEqual({
      key: POD,
      value: undefined,
      staleKeys: [],
    });
  });

  it.each([
    ["a bare host", "pod.example.com"],
    ["empty", ""],
    ["not a URL", "not a url"],
    ["another scheme", "ftp://pod.example.com"],
  ])("%s → null: not a pod URL, never a guess", (_label, url) => {
    expect(findPodKeyed({ [POD]: "t1" }, url)).toBeNull();
  });
});
