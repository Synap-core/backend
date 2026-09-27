/**
 * `resolveExposurePolicy` fails CLOSED on a present-but-unreadable value and
 * keeps the documented default only when the value is ABSENT.
 *
 * Each row names the rule it rules out: "unreadable falls back to the default"
 * (the default opens guest and link reads, so a corrupted cell used to WIDEN),
 * and "any irregularity denies everything" (an absent policy must keep the
 * default, or every workspace without a stored policy would lose sharing).
 */

import { describe, it, expect } from "vitest";
import { resolveExposurePolicy, SHARE_KINDS } from "../exposure-policy.js";

const DEFAULT_GUEST = { read: "direct", create: "proposal" };
const DEFAULT_PUBLIC = { read: "denied", create: "denied", fields: [] };
const DENIED = { read: "denied", create: "denied" };

describe("resolveExposurePolicy: absent keeps the default", () => {
  it.each([
    ["no settings", undefined],
    ["empty settings", {}],
    ["null policy", { exposurePolicy: null }],
    ["policy without kinds", { exposurePolicy: { version: 1 } }],
    ["kinds without this kind", { exposurePolicy: { kinds: {} } }],
    [
      "kind without this audience",
      { exposurePolicy: { kinds: { entity: {} } } },
    ],
  ])("%s ⇒ guest/link read, public denied", (_label, settings) => {
    const p = resolveExposurePolicy(settings);
    for (const kind of SHARE_KINDS) {
      expect(p[kind].guest).toEqual(DEFAULT_GUEST);
      expect(p[kind].link).toEqual(DEFAULT_GUEST);
      expect(p[kind].public).toEqual(DEFAULT_PUBLIC);
    }
  });
});

describe("resolveExposurePolicy: present but unreadable is DENIED", () => {
  it("an unknown mode denies that cell only (rules out: fall back to the default)", () => {
    const p = resolveExposurePolicy({
      exposurePolicy: {
        kinds: { entity: { guest: { read: "everyone", create: "proposal" } } },
      },
    });
    expect(p.entity.guest).toEqual(DENIED);
    // Neighbours are unaffected (rules out: one bad cell blanks the policy).
    expect(p.entity.link).toEqual(DEFAULT_GUEST);
    expect(p.document.guest).toEqual(DEFAULT_GUEST);
  });

  it("a cell missing a mode is incomplete, so denied", () => {
    const p = resolveExposurePolicy({
      exposurePolicy: { kinds: { view: { link: { create: "proposal" } } } },
    });
    expect(p.view.link).toEqual(DENIED);
  });

  it("a cell that is not an object is denied", () => {
    const p = resolveExposurePolicy({
      exposurePolicy: { kinds: { project: { guest: "direct" } } },
    });
    expect(p.project.guest).toEqual(DENIED);
  });

  it("a kind that is not an object denies every cell of that kind", () => {
    const p = resolveExposurePolicy({
      exposurePolicy: { kinds: { entity: ["guest"] } },
    });
    expect(p.entity.guest).toEqual(DENIED);
    expect(p.entity.link).toEqual(DENIED);
    expect(p.entity.public).toEqual({ ...DENIED, fields: [] });
    expect(p.document.guest).toEqual(DEFAULT_GUEST);
  });

  it("a policy that is not an object denies everything", () => {
    const p = resolveExposurePolicy({ exposurePolicy: "open" });
    for (const kind of SHARE_KINDS) {
      expect(p[kind].guest).toEqual(DENIED);
      expect(p[kind].link).toEqual(DENIED);
    }
  });

  it("a readable cell is served as stored (positive control), clamped by the ceiling", () => {
    const p = resolveExposurePolicy({
      exposurePolicy: {
        kinds: {
          entity: {
            guest: { read: "denied", create: "denied" },
            link: { read: "direct", create: "direct" },
            public: { read: "direct", create: "direct", fields: ["title"] },
          },
        },
      },
    });
    expect(p.entity.guest).toEqual(DENIED);
    expect(p.entity.link).toEqual({ read: "direct", create: "direct" });
    expect(p.entity.public).toEqual({
      read: "direct",
      create: "proposal",
      fields: ["title"],
    });
  });
});
