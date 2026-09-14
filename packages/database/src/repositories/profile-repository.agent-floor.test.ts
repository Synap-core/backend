/**
 * D6 floor — `ProfileRepository.create` refuses to mint a kind or role while an
 * AGENT principal is acting (the request write context the three key-auth doors
 * enter). Every create door lands on this method, so a door that forgets
 * governance — the hub `POST /workspaces/from-definition` install was one —
 * still cannot mint a kind for an agent.
 *
 * Drives the REAL repository with a recording db handle and asserts on what
 * reached `insert().values()`:
 *  - agent scope → refused with AGENT_KIND_REQUIRES_PROPOSAL, nothing inserted;
 *  - no agent scope (a human door, or the human approving a proposal, which is
 *    how an approved define_kind / workspace install is materialised) → created;
 *  - a probe-only scope (no agent) → still created, stamped probe.
 */

import { describe, it, expect } from "vitest";
import { ProfileRepository } from "./profile-repository.js";
import {
  runWithActingAgent,
  runWithProbeWrites,
  AGENT_KIND_REQUIRES_PROPOSAL,
} from "../utils/request-write-context.js";

function recordingDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    // `create()` looks up a probe row holding the same seat (R2); none here.
    query: { profiles: { findFirst: async () => null } },
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(v);
          return [v];
        },
      }),
    }),
  };
  return { db: db as never, inserted };
}

const input = {
  slug: "podcast",
  displayName: "Podcast",
  origin: "template" as const,
  entityScope: "workspace" as const,
};

describe("ProfileRepository.create — acting-agent floor (D6)", () => {
  it("an agent principal is refused with AGENT_KIND_REQUIRES_PROPOSAL; nothing inserted", async () => {
    const { db, inserted } = recordingDb();
    await expect(
      runWithActingAgent("agent-1", () =>
        new ProfileRepository(db).create(input)
      )
    ).rejects.toMatchObject({
      code: AGENT_KIND_REQUIRES_PROPOSAL,
      message: expect.stringContaining("synap_define_kind"),
    });
    expect(inserted).toEqual([]);
  });

  it("roles are floored too (same door)", async () => {
    const { db, inserted } = recordingDb();
    await expect(
      runWithActingAgent("agent-1", () =>
        new ProfileRepository(db).create({
          ...input,
          slug: "sponsor",
          profileKind: "role",
          applicableKinds: ["company"],
        })
      )
    ).rejects.toMatchObject({ code: AGENT_KIND_REQUIRES_PROPOSAL });
    expect(inserted).toEqual([]);
  });

  it("no agent in scope (a human door / a human approving the proposal): created, unchanged", async () => {
    const { db, inserted } = recordingDb();
    await new ProfileRepository(db).create(input);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ slug: "podcast", origin: "template" });
  });

  it("a probe-only scope is not an agent: created, stamped probe", async () => {
    const { db, inserted } = recordingDb();
    await runWithProbeWrites(true, () =>
      new ProfileRepository(db).create(input)
    );
    expect(inserted[0]).toMatchObject({ origin: "probe" });
  });
});
