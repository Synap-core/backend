import { describe, expect, it, vi } from "vitest";

/**
 * Mock @synap/database so importing the archiver module never opens a DB
 * connection — the selection logic under test is pure and uses none of it.
 */
vi.mock("@synap/database", () => ({
  db: {},
  projects: {},
  projectMembers: {},
  relations: {},
  proposals: {},
  insertPendingProposal: vi.fn(async () => ({
    proposal: { id: "proposal-1" },
    deduped: false,
  })),
  BELONGS_TO_PROJECT: "belongs_to_project",
  ProposalStatus: { PENDING: "pending" },
  eq: vi.fn(),
  and: vi.fn(),
  lt: vi.fn(),
  inArray: vi.fn(),
  drizzleSql: vi.fn(),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));

import {
  isArchiveEligible,
  selectArchiveCandidates,
  ARCHIVE_MIN_AGE_DAYS,
  type ArchiveCandidateProject,
} from "../librarian-archiver.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-18T00:00:00.000Z");

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS);
}

function project(
  id: string,
  overrides: Partial<ArchiveCandidateProject> = {}
): ArchiveCandidateProject {
  return {
    id,
    name: `Project ${id}`,
    userId: "user-1",
    workspaceId: null,
    createdAt: daysAgo(ARCHIVE_MIN_AGE_DAYS + 5),
    ...overrides,
  };
}

describe("isArchiveEligible", () => {
  it("is true for projects older than the age floor", () => {
    expect(
      isArchiveEligible(
        { createdAt: daysAgo(ARCHIVE_MIN_AGE_DAYS + 1) },
        { now: NOW, minAgeDays: ARCHIVE_MIN_AGE_DAYS }
      )
    ).toBe(true);
  });

  it("is false for projects newer than the age floor", () => {
    expect(
      isArchiveEligible(
        { createdAt: daysAgo(ARCHIVE_MIN_AGE_DAYS - 1) },
        { now: NOW, minAgeDays: ARCHIVE_MIN_AGE_DAYS }
      )
    ).toBe(false);
  });
});

describe("selectArchiveCandidates", () => {
  const opts = { now: NOW, minAgeDays: ARCHIVE_MIN_AGE_DAYS };

  it("selects old projects with zero links and zero members", () => {
    const projects = [project("a")];
    const selected = selectArchiveCandidates(
      projects,
      new Map(),
      new Map(),
      opts
    );
    expect(selected.map((p) => p.id)).toEqual(["a"]);
  });

  it("excludes projects that are too new", () => {
    const projects = [
      project("recent", { createdAt: daysAgo(ARCHIVE_MIN_AGE_DAYS - 3) }),
    ];
    expect(
      selectArchiveCandidates(projects, new Map(), new Map(), opts)
    ).toHaveLength(0);
  });

  it("excludes projects that have belongs_to_project members", () => {
    const projects = [project("has-links")];
    const linkCounts = new Map([["has-links", 3]]);
    expect(
      selectArchiveCandidates(projects, linkCounts, new Map(), opts)
    ).toHaveLength(0);
  });

  it("excludes projects that have explicit members", () => {
    const projects = [project("has-members")];
    const memberCounts = new Map([["has-members", 1]]);
    expect(
      selectArchiveCandidates(projects, new Map(), memberCounts, opts)
    ).toHaveLength(0);
  });

  it("selects only the eligible subset from a mixed batch", () => {
    const projects = [
      project("eligible"),
      project("young", { createdAt: daysAgo(1) }),
      project("linked"),
      project("membered"),
    ];
    const linkCounts = new Map([["linked", 2]]);
    const memberCounts = new Map([["membered", 1]]);
    const selected = selectArchiveCandidates(
      projects,
      linkCounts,
      memberCounts,
      opts
    );
    expect(selected.map((p) => p.id)).toEqual(["eligible"]);
  });
});
