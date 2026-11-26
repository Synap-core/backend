/**
 * message-anchor — the shape and authority contract for an anchored comment.
 *
 * DB-FREE: the validator takes its `db`, and the proposal comment gate
 * (`assertProposalCommentableBy`, pglite-tested in `proposal-review-session-gate`)
 * is replaced (partially — `importOriginal` keeps every other export real) so
 * these observe what the ANCHOR check decides, not the membership lookup the
 * visibility gate owns (tested in its own suite).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const visibility = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./proposal-visibility.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertProposalCommentableBy: (...args: unknown[]) => visibility(...args),
  };
});

const {
  assertMessageAnchorAllowed,
  ChannelMessageMetadataInputSchema,
  EntityAnchorSchema,
  MessageAnchorSchema,
  ObjectCommentAnchorSchema,
} = await import("./message-anchor.js");

const USER = "0aaaaaaa-0000-4000-8000-000000000001";
const CHANNEL = "0bbbbbbb-0000-4000-8000-000000000002";
const PROPOSAL = "0ccccccc-0000-4000-8000-000000000003";
const SESSION = "0ddddddd-0000-4000-8000-000000000004";
const OTHER_SESSION = "0eeeeeee-0000-4000-8000-000000000005";

const state = {
  channelSessions: [] as Array<{ id: string }>,
  proposal: undefined as { sessionId: string | null } | undefined,
};
const fakeDb = {
  query: {
    focusSessions: { findMany: async () => state.channelSessions },
    proposals: { findFirst: async () => state.proposal },
  },
} as never;

beforeEach(() => {
  visibility.mockReset();
  visibility.mockImplementation(async () => {});
  state.channelSessions = [];
  state.proposal = undefined;
});

describe("anchor shape", () => {
  it("accepts a full anchor and a version-only anchor", () => {
    expect(
      MessageAnchorSchema.safeParse({
        proposalId: PROPOSAL,
        opRef: "$rel0",
        field: "title",
        contentVersion: 2,
      }).success
    ).toBe(true);
    expect(MessageAnchorSchema.safeParse({ contentVersion: 0 }).success).toBe(
      true
    );
  });

  it("refuses unknown keys at BOTH levels, bad versions, and unbounded strings", () => {
    // Only `anchor` is client-writable metadata; server-owned keys are refused.
    expect(
      ChannelMessageMetadataInputSchema.safeParse({
        anchor: { contentVersion: 0 },
        turnContext: { entries: [] },
      }).success
    ).toBe(false);
    expect(
      MessageAnchorSchema.safeParse({ contentVersion: 0, extra: true }).success
    ).toBe(false);
    expect(MessageAnchorSchema.safeParse({}).success).toBe(false);
    expect(MessageAnchorSchema.safeParse({ contentVersion: -1 }).success).toBe(
      false
    );
    expect(MessageAnchorSchema.safeParse({ contentVersion: 1.5 }).success).toBe(
      false
    );
    expect(
      MessageAnchorSchema.safeParse({
        contentVersion: 0,
        opRef: "x".repeat(201),
      }).success
    ).toBe(false);
    expect(
      MessageAnchorSchema.safeParse({ contentVersion: 0, field: "   " }).success
    ).toBe(false);
    expect(
      MessageAnchorSchema.safeParse({ contentVersion: 0, proposalId: "nope" })
        .success
    ).toBe(false);
  });
});

describe("entity comment locator (a pin's exact place, §10.1)", () => {
  const ENTITY = "0fffffff-0000-4000-8000-000000000006";
  const FILE = "0abcdef0-0000-4000-8000-000000000007";
  const designPin = {
    surface: "design",
    frameId: "frame-home",
    blockId: "block-hero",
    viewport: "desktop",
    point: { x: 0.25, y: 0.75 },
    contentVersion: "rev-12",
    screenshot: FILE,
  };
  const storyPin = {
    surface: "story",
    storyId: "components-button--primary",
    viewport: "phone",
    point: { x: 0, y: 1 },
    contentVersion: "sha256:abc123",
  };
  const anchor = (locator: unknown) => ({
    kind: "entity",
    entityId: ENTITY,
    locator,
  });
  /** Every refusal as `path: message` — what the doors hand back. */
  const refusal = (locator: unknown): string[] => {
    const parsed = ObjectCommentAnchorSchema.safeParse(anchor(locator));
    if (parsed.success) return [];
    return parsed.error.issues.map(
      (i) => `${i.path.map(String).join(".")}: ${i.message}`
    );
  };

  it("accepts a design pin and a story pin, and reads them back unchanged", () => {
    for (const locator of [designPin, storyPin]) {
      const parsed = ObjectCommentAnchorSchema.safeParse(anchor(locator));
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual(anchor(locator));
    }
    // A frame with no block is a pin on the frame itself.
    const { blockId: _b, screenshot: _s, ...framePin } = designPin;
    expect(EntityAnchorSchema.safeParse(anchor(framePin)).success).toBe(true);
    // No locator stays the whole-entity / one-field comment it always was.
    expect(
      EntityAnchorSchema.safeParse({
        kind: "entity",
        entityId: ENTITY,
        field: "title",
      }).success
    ).toBe(true);
  });

  it("refuses a point outside the frame (each axis a fraction 0..1)", () => {
    for (const point of [
      { x: -0.01, y: 0.5 },
      { x: 0.5, y: 1.01 },
      { x: 2, y: 2 },
    ]) {
      const issues = refusal({ ...designPin, point });
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((i) => i.startsWith("locator.point."))).toBe(true);
      expect(issues.join()).toMatch(/fraction of the frame, from 0 to 1/);
    }
    expect(refusal({ ...designPin, point: { x: 0.5 } })).toEqual([
      expect.stringMatching(/^locator\.point\.y: /),
    ]);
    expect(
      refusal({ ...designPin, point: { x: Number.POSITIVE_INFINITY, y: 0 } })
    ).toEqual([expect.stringMatching(/^locator\.point\.x: /)]);
  });

  it("refuses an unknown key in the locator and in its point", () => {
    expect(refusal({ ...designPin, zoom: 2 })).toEqual([
      expect.stringMatching(/^locator: .*zoom/),
    ]);
    expect(refusal({ ...designPin, point: { x: 0, y: 0, z: 0 } })).toEqual([
      expect.stringMatching(/^locator\.point: .*z/),
    ]);
  });

  it("refuses a pin on BOTH a frame and a story", () => {
    expect(
      refusal({ ...designPin, storyId: "components-button--primary" })
    ).toEqual([expect.stringMatching(/^locator: .*storyId/)]);
    expect(refusal({ ...storyPin, frameId: "frame-home" })).toEqual([
      expect.stringMatching(/^locator: .*frameId/),
    ]);
    // …and a pin on neither: a design names its frame, a story its story.
    const { frameId: _f, ...noFrame } = designPin;
    expect(refusal(noFrame)).toEqual([
      expect.stringMatching(/^locator\.frameId: /),
    ]);
    const { storyId: _st, ...noStory } = storyPin;
    expect(refusal(noStory)).toEqual([
      expect.stringMatching(/^locator\.storyId: /),
    ]);
  });

  it("refuses oversized or empty strings, and every bounded field by name", () => {
    const long = "x".repeat(201);
    expect(refusal({ ...designPin, frameId: long })).toEqual([
      "locator.frameId: frameId is longer than 200 characters",
    ]);
    expect(refusal({ ...designPin, blockId: long })).toEqual([
      "locator.blockId: blockId is longer than 200 characters",
    ]);
    expect(refusal({ ...storyPin, storyId: long })).toEqual([
      "locator.storyId: storyId is longer than 200 characters",
    ]);
    expect(refusal({ ...designPin, contentVersion: long })).toEqual([
      "locator.contentVersion: contentVersion is longer than 200 characters",
    ]);
    expect(refusal({ ...designPin, frameId: "   " })).toEqual([
      "locator.frameId: frameId is empty",
    ]);
    // 200 is the bound, not 199.
    expect(refusal({ ...designPin, frameId: "x".repeat(200) })).toEqual([]);
  });

  it("refuses an unknown surface or viewport, a missing place, and a screenshot that is not a file id", () => {
    expect(refusal({ ...designPin, surface: "whiteboard" })).toEqual([
      expect.stringMatching(/^locator\.surface: /),
    ]);
    expect(refusal({ ...designPin, viewport: "watch" })).toEqual([
      expect.stringMatching(/^locator\.viewport: /),
    ]);
    const { contentVersion: _c, ...noVersion } = designPin;
    expect(refusal(noVersion)).toEqual([
      expect.stringMatching(/^locator\.contentVersion: /),
    ]);
    const { point: _p, ...noPoint } = designPin;
    expect(refusal(noPoint)).toEqual([
      expect.stringMatching(/^locator\.point: /),
    ]);
    expect(refusal({ ...designPin, screenshot: "crop.png" })).toEqual([
      "locator.screenshot: screenshot is a pod file id (a uuid)",
    ]);
  });
});

describe("anchor authority", () => {
  it("an anchor without a proposal needs no proposal check", async () => {
    await assertMessageAnchorAllowed({
      anchor: { contentVersion: 0, field: "title" },
      channelId: CHANNEL,
      userId: USER,
      roster: true,
      db: fakeDb,
    });
    expect(visibility).not.toHaveBeenCalled();
  });

  it("an anchor naming a proposal the caller cannot see is refused", async () => {
    visibility.mockImplementation(async () => {
      throw new TRPCError({ code: "FORBIDDEN", message: "no" });
    });
    await expect(
      assertMessageAnchorAllowed({
        anchor: { proposalId: PROPOSAL, contentVersion: 0 },
        channelId: CHANNEL,
        userId: USER,
        roster: true,
        db: fakeDb,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(visibility).toHaveBeenCalledWith(
      PROPOSAL,
      { userId: USER, roster: true },
      { db: fakeDb }
    );
  });

  it("on a session channel, a proposal of ANOTHER run is refused", async () => {
    state.channelSessions = [{ id: SESSION }];
    state.proposal = { sessionId: OTHER_SESSION };
    await expect(
      assertMessageAnchorAllowed({
        anchor: { proposalId: PROPOSAL, contentVersion: 0 },
        channelId: CHANNEL,
        userId: USER,
        roster: true,
        db: fakeDb,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("on a session channel, a proposal with NO session is refused", async () => {
    state.channelSessions = [{ id: SESSION }];
    state.proposal = { sessionId: null };
    await expect(
      assertMessageAnchorAllowed({
        anchor: { proposalId: PROPOSAL, contentVersion: 0 },
        channelId: CHANNEL,
        userId: USER,
        roster: true,
        db: fakeDb,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("on a session channel, the session's own visible proposal is allowed", async () => {
    state.channelSessions = [{ id: SESSION }];
    state.proposal = { sessionId: SESSION };
    await expect(
      assertMessageAnchorAllowed({
        anchor: { proposalId: PROPOSAL, contentVersion: 3 },
        channelId: CHANNEL,
        userId: USER,
        roster: true,
        db: fakeDb,
      })
    ).resolves.toBeUndefined();
  });

  it("on a non-session channel, a visible proposal is allowed", async () => {
    state.channelSessions = [];
    await expect(
      assertMessageAnchorAllowed({
        anchor: { proposalId: PROPOSAL, contentVersion: 0 },
        channelId: CHANNEL,
        userId: USER,
        roster: true,
        db: fakeDb,
      })
    ).resolves.toBeUndefined();
  });
});
