/**
 * D8 probe marker — the classification, the async scope, and the two
 * PROFILE floors that consume it:
 *  - `ProfileRepository.create` stamps `origin='probe'` + `experimental` inside a
 *    TEST-key scope, and stamps the caller's origin (untouched) outside it;
 *  - `ProfileRepository.getAccessibleProfiles` (the ONE listing floor) drops
 *    probe rows, while `getById` still returns them.
 *
 * Driven through the REAL repository with a recording fake db handle: the
 * assertion is on the row the repository hands to `insert().values()` and on
 * what the listing method returns — not on a hand-built object downstream.
 */

import { describe, it, expect } from "vitest";
import {
  isProbeApiKey,
  runWithProbeWrites,
  isProbeWriteContext,
  stampProbeMarker,
  excludeProbeProfiles,
  runWithActingAgent,
  getActingAgentUserId,
  AgentKindRequiresProposalError,
  AGENT_KIND_REQUIRES_PROPOSAL,
} from "./request-write-context.js";
import { KEY_PREFIXES, PROBE_KEY_SCOPE } from "../schema/api-keys.js";
import { ProfileRepository } from "../repositories/profile-repository.js";

/** A db handle that records inserts and serves canned listing / by-id rows. */
function fakeDb(listRows: Array<Record<string, unknown>> = []) {
  const inserted: Array<Record<string, unknown>> = [];
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: async () => listRows.map((p) => ({ p })),
  };
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(v);
          return [v];
        },
      }),
    }),
    selectDistinctOn: () => chain,
    query: {
      profiles: {
        findFirst: async () =>
          listRows.find((r) => r.origin === "probe") ?? null,
      },
    },
  };
  return { db: db as never, inserted };
}

const row = (slug: string, origin: string) => ({
  id: `id-${slug}`,
  slug,
  origin,
  displayName: slug,
});

describe("probe-write-context — classification + scope", () => {
  it("a probe key is one carrying the explicit probe scope — never the TEST prefix or a dev/test hubId", () => {
    // The minter hands the TEST prefix to any hubId containing "dev"/"test";
    // such a real agent key must NOT have its writes hidden.
    expect(
      isProbeApiKey({
        keyPrefix: KEY_PREFIXES.HUB_TEST,
        hubId: "devplane",
        scope: ["hub-protocol.read", "hub-protocol.write"],
      } as never)
    ).toBe(false);
    expect(
      isProbeApiKey({ scope: ["hub-protocol.write", PROBE_KEY_SCOPE] })
    ).toBe(true);
    expect(isProbeApiKey({ scope: null })).toBe(false);
    expect(isProbeApiKey(null)).toBe(false);
  });

  it("the scope is visible across awaits inside it, and absent outside it", async () => {
    expect(isProbeWriteContext()).toBe(false);
    const inside = await runWithProbeWrites(true, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return isProbeWriteContext();
    });
    expect(inside).toBe(true);
    expect(isProbeWriteContext()).toBe(false);
    expect(
      await runWithProbeWrites(false, async () => isProbeWriteContext())
    ).toBe(false);
  });

  it("stampProbeMarker marks a bag only inside the scope", () => {
    expect(stampProbeMarker({ a: 1 })).toEqual({ a: 1 });
    runWithProbeWrites(true, () => {
      expect(stampProbeMarker({ a: 1 })).toEqual({ a: 1, probe: true });
    });
  });

  it("the probe and acting-agent facts compose in either nesting order", async () => {
    await runWithProbeWrites(true, () =>
      runWithActingAgent("agent-1", async () => {
        await new Promise((r) => setTimeout(r, 1));
        expect(isProbeWriteContext()).toBe(true);
        expect(getActingAgentUserId()).toBe("agent-1");
      })
    );
    await runWithActingAgent("agent-2", () =>
      runWithProbeWrites(true, async () => {
        expect(getActingAgentUserId()).toBe("agent-2");
        expect(isProbeWriteContext()).toBe(true);
      })
    );
    expect(getActingAgentUserId()).toBeUndefined();
    expect(
      await runWithActingAgent(undefined, async () => getActingAgentUserId())
    ).toBeUndefined();
  });

  it("the refusal carries the machine-readable reason code", () => {
    const err = new AgentKindRequiresProposalError("podcast");
    expect(err.code).toBe(AGENT_KIND_REQUIRES_PROPOSAL);
    expect(err.message).toContain("synap_define_kind");
  });

  it("excludeProbeProfiles drops only origin=probe", () => {
    expect(
      excludeProbeProfiles([
        row("a", "agent"),
        row("b", "probe"),
        row("c", "unknown"),
      ]).map((r) => r.slug)
    ).toEqual(["a", "c"]);
  });
});

describe("ProfileRepository floors — D8 + origin stamp", () => {
  it("a TEST-key create is stamped probe + experimental, whatever the caller claimed", async () => {
    const { db, inserted } = fakeDb();
    await runWithProbeWrites(true, () =>
      new ProfileRepository(db).create({
        slug: "dogfood-probe-x",
        displayName: "Probe",
        origin: "authored",
        entityScope: "workspace",
      })
    );
    expect(inserted[0]).toMatchObject({
      origin: "probe",
      lifecycle: "experimental",
    });
  });

  it("a normal-key create keeps the writer's origin and lifecycle active (not stamped)", async () => {
    const { db, inserted } = fakeDb();
    await new ProfileRepository(db).create({
      slug: "podcast",
      displayName: "Podcast",
      origin: "authored",
      entityScope: "workspace",
    });
    expect(inserted[0]).toMatchObject({
      origin: "authored",
      lifecycle: "active",
      ownerKind: null,
      ownerId: null,
    });
  });

  it("a half owner reference is refused at the floor", async () => {
    const { db } = fakeDb();
    await expect(
      new ProfileRepository(db).create({
        slug: "campaign",
        displayName: "Campaign",
        origin: "template",
        ownerKind: "workspace",
        entityScope: "workspace",
      })
    ).rejects.toThrow(/together/);
  });

  it("the listing floor excludes probe rows; getById still reads them", async () => {
    const { db } = fakeDb([
      row("person", "core"),
      row("dogfood-probe-x", "probe"),
    ]);
    const repo = new ProfileRepository(db);
    const listed = await repo.getAccessibleProfiles(
      "e418d146-e495-4b8a-8e8b-985f9f885431",
      "808939d1-86b3-4c52-a153-ae06ece2c54e"
    );
    expect(listed.map((p) => p.slug)).toEqual(["person"]);
    expect((await repo.getById("id-dogfood-probe-x"))?.slug).toBe(
      "dogfood-probe-x"
    );
  });

  it("the composed floor still excludes RESERVED slugs — default and explicit selection", async () => {
    // The probe floor composes INSIDE `excludeReservedProfiles(...)`; this
    // proves reachability, not just the `return excludeReservedProfiles(`
    // shape the api tripwire pins. The fake db ignores `filters`, so an
    // explicit selection naming `project` still returns the reserved row from
    // the query — only the floor can drop it.
    const rows = [
      row("person", "core"),
      row("project", "unknown"),
      row("dogfood-probe-x", "probe"),
    ];
    const repo = new ProfileRepository(fakeDb(rows).db);
    const U = "e418d146-e495-4b8a-8e8b-985f9f885431";
    const WS = "808939d1-86b3-4c52-a153-ae06ece2c54e";
    expect(
      (await repo.getAccessibleProfiles(U, WS)).map((p) => p.slug)
    ).toEqual(["person"]);
    expect(
      (
        await repo.getAccessibleProfiles(U, WS, {
          slugs: ["project", "person", "dogfood-probe-x"],
        })
      ).map((p) => p.slug)
    ).toEqual(["person"]);
    // Explicit EMPTY selection short-circuits to [] — nothing to advertise.
    expect(await repo.getAccessibleProfiles(U, WS, { slugs: [] })).toEqual([]);
  });
});
// Nesting composition (probe × derived session) is owned by W1's
// `request-write-context.test.ts` — not duplicated here.
