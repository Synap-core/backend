import { describe, it, expect } from "vitest";
import {
  composeKnownUrls,
  pickClientStatus,
  pickGrantSubmissionStage,
  projectDealsFromConnections,
  type ConnectionLike,
} from "../context-card.js";

const openLink = (id: string) => `https://pod.example/open/${id}`;

describe("projectDealsFromConnections", () => {
  it("filters to deal neighbours and projects the pinned shape", () => {
    const conns: ConnectionLike[] = [
      {
        entity: {
          id: "d1",
          type: "deal",
          title: "Big Deal",
          properties: { dealStage: "negotiation" },
        },
      },
      { entity: { id: "p1", type: "person", title: "Alice" } },
    ];
    expect(projectDealsFromConnections(conns, openLink)).toEqual([
      {
        id: "d1",
        title: "Big Deal",
        stage: "negotiation",
        openUrl: "https://pod.example/open/d1",
      },
    ]);
  });

  it("tolerates the live 3-way stage fork (dealStage ?? stage ?? deal-stage)", () => {
    const conns: ConnectionLike[] = [
      {
        entity: {
          id: "a",
          type: "deal",
          title: "A",
          properties: { stage: "lead" },
        },
      },
      {
        entity: {
          id: "b",
          type: "deal",
          title: "B",
          properties: { "deal-stage": "won" },
        },
      },
      { entity: { id: "c", type: "deal", title: "C", properties: {} } },
    ];
    const deals = projectDealsFromConnections(conns, openLink);
    expect(deals.map((d) => d.stage)).toEqual(["lead", "won", null]);
  });

  it("excludes connections with no entity (soft-deleted rows getConnections dropped)", () => {
    const conns: ConnectionLike[] = [
      { entity: null },
      { entity: { id: "ch1", type: undefined } }, // channel/session connection
      { entity: { id: "d1", type: "deal", title: "Live", properties: {} } },
    ];
    const deals = projectDealsFromConnections(conns, openLink);
    expect(deals).toHaveLength(1);
    expect(deals[0]!.id).toBe("d1");
  });

  it("is empty-safe for a hollow company (no connections)", () => {
    expect(projectDealsFromConnections([], openLink)).toEqual([]);
  });
});

describe("pickGrantSubmissionStage", () => {
  it("returns the linked grant_submission stage when present", () => {
    const conns: ConnectionLike[] = [
      {
        entity: {
          id: "g1",
          type: "grant_submission",
          properties: { stage: "under_review" },
        },
      },
    ];
    expect(pickGrantSubmissionStage(conns)).toBe("under_review");
  });

  it("returns null when no grant_submission is linked", () => {
    expect(
      pickGrantSubmissionStage([
        { entity: { id: "d", type: "deal", properties: {} } },
      ])
    ).toBeNull();
  });
});

describe("composeKnownUrls", () => {
  it("unions website with signals and dedupes case-insensitively", () => {
    const urls = composeKnownUrls("https://Acme.com", [
      "https://acme.com",
      "https://linkedin.com/company/acme",
      "",
      "https://linkedin.com/company/acme",
    ]);
    expect(urls).toEqual([
      "https://Acme.com",
      "https://linkedin.com/company/acme",
    ]);
  });

  it("is empty-safe (no website, no signals)", () => {
    expect(composeKnownUrls(null, [])).toEqual([]);
    expect(composeKnownUrls(undefined, [])).toEqual([]);
  });
});

describe("pickClientStatus", () => {
  it("prefers a linked grant_submission stage above all else", () => {
    expect(
      pickClientStatus({
        grantSubmissionStage: "awarded",
        facetStatuses: [{ slug: "client", status: "active" }],
        companyStatus: "prospect",
      })
    ).toBe("awarded");
  });

  it("falls back to the client role facet status", () => {
    expect(
      pickClientStatus({
        grantSubmissionStage: null,
        facetStatuses: [
          { slug: "partner", status: "warm" },
          { slug: "client", status: "onboarding" },
        ],
        companyStatus: "prospect",
      })
    ).toBe("onboarding");
  });

  it("falls back to any facet status, then the company property, then null", () => {
    expect(
      pickClientStatus({
        grantSubmissionStage: null,
        facetStatuses: [{ slug: "partner", status: "warm" }],
        companyStatus: "prospect",
      })
    ).toBe("warm");
    expect(
      pickClientStatus({
        grantSubmissionStage: null,
        facetStatuses: [],
        companyStatus: "prospect",
      })
    ).toBe("prospect");
    expect(
      pickClientStatus({
        grantSubmissionStage: null,
        facetStatuses: [],
        companyStatus: undefined,
      })
    ).toBeNull();
  });
});
