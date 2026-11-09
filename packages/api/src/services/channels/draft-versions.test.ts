/**
 * `deriveDraftVersions` on the shapes `mergeProposalRevision` records
 * (`computeRevisedEnvelope`: `{at, by, actingAgentUserId?, before, patch}`).
 * The route test (channel-conversations.pglite.test.ts) drives the real revise
 * core; these rows rule out what it cannot reach cheaply: an agent's own
 * revision labelled as the person's, a summary-only revision shown as a
 * version, a subject change lost, and a history that does not end at the
 * draft's words shown as if it did.
 */
import { describe, expect, it } from "vitest";
import {
  DraftHistoryInconsistentError,
  deriveDraftVersions,
} from "./draft-versions.js";

const AGENT = "agent-1";
const PERSON = "person-1";
const base = {
  agentUserId: AGENT,
  proposedByUserId: null,
  createdBy: AGENT,
  createdAt: new Date("2026-11-01T10:00:00.000Z"),
};

describe("deriveDraftVersions", () => {
  it("the agent's revision of its own draft is 'ai'; a summary-only revision is no version; a subject change is", () => {
    const { revision, versions } = deriveDraftVersions({
      ...base,
      data: { body: "Person's words", subject: "Re: Tuesday" },
      revisionHistory: [
        {
          at: "2026-11-01T10:01:00.000Z",
          by: PERSON,
          actingAgentUserId: AGENT,
          before: { body: "AI first" },
          patch: { body: "AI second" },
        },
        {
          at: "2026-11-01T10:02:00.000Z",
          by: PERSON,
          before: { _summary: "old" },
          patch: { _summary: "new" },
        },
        {
          at: "2026-11-01T10:03:00.000Z",
          by: PERSON,
          before: { body: "AI second" },
          patch: { body: "Person's words" },
        },
        {
          at: "2026-11-01T10:04:00.000Z",
          by: PERSON,
          before: { body: "Person's words" },
          patch: { body: "Person's words", subject: "Re: Tuesday" },
        },
      ],
    });
    expect(revision).toBe(4);
    expect(versions).toEqual([
      {
        version: 1,
        author: "ai",
        authorId: AGENT,
        at: "2026-11-01T10:00:00.000Z",
        text: "AI first",
      },
      {
        version: 2,
        author: "ai",
        authorId: AGENT,
        at: "2026-11-01T10:01:00.000Z",
        text: "AI second",
      },
      {
        version: 3,
        author: "person",
        authorId: PERSON,
        at: "2026-11-01T10:03:00.000Z",
        text: "Person's words",
      },
      {
        version: 4,
        author: "person",
        authorId: PERSON,
        at: "2026-11-01T10:04:00.000Z",
        text: "Person's words",
        subject: "Re: Tuesday",
      },
    ]);
  });

  it("a draft with no agent is the person's from version 1 (`draftedBy` without an agent)", () => {
    const { versions } = deriveDraftVersions({
      agentUserId: null,
      proposedByUserId: PERSON,
      createdBy: PERSON,
      createdAt: "2026-11-01T10:00:00.000Z",
      data: {
        body: "Typed",
        draftedBy: { agentUserId: null, appClientId: "crm-app" },
      },
      revisionHistory: [],
    });
    expect(versions).toEqual([
      {
        version: 1,
        author: "person",
        authorId: PERSON,
        at: "2026-11-01T10:00:00.000Z",
        text: "Typed",
      },
    ]);
  });

  it("refuses a history that does not end at the draft's words", () => {
    expect(() =>
      deriveDraftVersions({
        ...base,
        data: { body: "Written outside any revision" },
        revisionHistory: [
          {
            at: "2026-11-01T10:01:00.000Z",
            by: PERSON,
            before: { body: "AI first" },
            patch: { body: "Person's words" },
          },
        ],
      })
    ).toThrow(DraftHistoryInconsistentError);
  });
});
