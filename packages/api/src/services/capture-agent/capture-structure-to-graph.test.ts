import { describe, expect, it } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  shouldPersistCapturePlan,
  captureStructureToGraph,
} from "./capture-structure-to-graph.js";
import { captureGraphEventKeys } from "./capture-graph-policy.js";

describe("shouldPersistCapturePlan (confirm-mode guard)", () => {
  it("does NOT persist a degraded plan (create-nothing fallback)", () => {
    expect(
      shouldPersistCapturePlan({ degraded: true, proposals: [{ tempId: "a" }] })
    ).toBe(false);
  });

  it("does NOT persist when the model asked a clarifying followUp", () => {
    expect(
      shouldPersistCapturePlan({
        followUp: { question: "Which project?" },
        proposals: [{ tempId: "a" }],
      })
    ).toBe(false);
  });

  it("does NOT persist an empty plan", () => {
    expect(shouldPersistCapturePlan({ proposals: [] })).toBe(false);
    expect(shouldPersistCapturePlan({})).toBe(false);
  });

  it("persists a real, non-degraded plan with entities", () => {
    expect(
      shouldPersistCapturePlan({
        degraded: false,
        followUp: null,
        proposals: [{ tempId: "a", profileSlug: "note" }],
      })
    ).toBe(true);
  });
});

describe("captureStructureToGraph (tempId → ref bridge)", () => {
  it("maps entities (tempId→ref) and facets (contextTempId→contextRef)", () => {
    const { entities } = captureStructureToGraph({
      proposals: [
        {
          tempId: "p1",
          profileSlug: "person",
          title: "Ada",
          description: "hi",
          content: "long body",
          properties: { email: "ada@acme.com" },
          facets: [
            {
              profileSlug: "client",
              status: "active",
              properties: { tier: "gold" },
              contextTempId: "p2",
            },
          ],
        },
        { tempId: "p2", profileSlug: "company", title: "Acme" },
      ],
    });
    expect(entities).toHaveLength(2);
    expect(entities[0]).toMatchObject({
      ref: "p1",
      profileSlug: "person",
      title: "Ada",
      description: "hi",
      content: "long body",
      properties: { email: "ada@acme.com" },
      facets: [
        {
          profileSlug: "client",
          status: "active",
          properties: { tier: "gold" },
          contextRef: "p2",
        },
      ],
    });
  });

  it("maps relations (sourceTempId/targetTempId/relationType) and drops dangling ones", () => {
    const { relations } = captureStructureToGraph({
      proposals: [
        { tempId: "p1", profileSlug: "person" },
        { tempId: "p2", profileSlug: "company" },
      ],
      relations: [
        { sourceTempId: "p1", targetTempId: "p2", relationType: "works_at" },
        // dangling — p3 is not in the entity set → dropped
        { sourceTempId: "p1", targetTempId: "p3", relationType: "knows" },
      ],
    });
    expect(relations).toEqual([
      { sourceRef: "p1", targetRef: "p2", type: "works_at" },
    ]);
  });

  it("synthesizes a ref when a proposal has no tempId", () => {
    const { entities } = captureStructureToGraph({
      proposals: [{ profileSlug: "note", title: "loose" }],
    });
    expect(entities[0].ref).toBe("e0");
  });
});

describe("captureGraphEventKeys (all-or-nothing policy keys)", () => {
  const entityOp = (facets?: unknown): CompositeProposalOperation =>
    ({
      op: "create_entity",
      ref: "e0",
      profileSlug: "note",
      title: "x",
      properties: {},
      ...(facets ? { facets } : {}),
    }) as unknown as CompositeProposalOperation;
  const relOp: CompositeProposalOperation = {
    op: "create_relation",
    sourceRef: "e0",
    targetRef: "e1",
    type: "rel",
  } as unknown as CompositeProposalOperation;

  it("an entity-only graph exercises just entity.create, carrying the slug", () => {
    expect(captureGraphEventKeys([entityOp()])).toEqual([
      { subjectType: "entity", action: "create", subjectProfileSlug: "note" },
    ]);
  });

  it("adds relation.create when the graph has relations, deduped", () => {
    const keys = captureGraphEventKeys([entityOp(), entityOp(), relOp]);
    expect(keys).toEqual([
      { subjectType: "entity", action: "create", subjectProfileSlug: "note" },
      { subjectType: "relation", action: "create" },
    ]);
  });

  it("adds facet.attach when an entity declares facets", () => {
    const keys = captureGraphEventKeys([entityOp([{ profileSlug: "client" }])]);
    expect(keys).toEqual([
      { subjectType: "entity", action: "create", subjectProfileSlug: "note" },
      { subjectType: "facet", action: "attach" },
    ]);
  });

  it("carries per-op profileSlug + uo_validated so a user_observation is scored by kind", () => {
    const uoInference = {
      op: "create_entity",
      ref: "u0",
      profileSlug: "user_observation",
      title: "prefers async",
      properties: {},
    } as unknown as CompositeProposalOperation;
    const uoValidated = {
      op: "create_entity",
      ref: "u1",
      profileSlug: "user_observation",
      title: "stated async",
      properties: { uo_validated: true },
    } as unknown as CompositeProposalOperation;
    // A plain note + an unvalidated user_observation are DISTINCT keys — the
    // slug is no longer dropped, so the inference can force propose on its own.
    expect(
      captureGraphEventKeys([entityOp(), uoInference, uoValidated])
    ).toEqual([
      { subjectType: "entity", action: "create", subjectProfileSlug: "note" },
      {
        subjectType: "entity",
        action: "create",
        subjectProfileSlug: "user_observation",
      },
      {
        subjectType: "entity",
        action: "create",
        subjectProfileSlug: "user_observation",
        subjectUoValidated: true,
      },
    ]);
  });
});
