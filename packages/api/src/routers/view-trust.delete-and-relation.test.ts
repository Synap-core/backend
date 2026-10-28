/**
 * Clients audit F2 (2026-10-28): a framed view's DELETE and RELATION writes
 * reach the view-trust gate.
 *
 * `entities.create` / `update` took the host-stamped `viewContext`, resolved
 * its trust server-side (`resolveViewTrust`) and passed `issuer` to the gate,
 * which proposes every write of an untrusted view. `entities.delete` and
 * `relations.create` took no view identity at all, so an agent-generated
 * view's delete landed as the person's own direct delete while its update
 * would have been held for review.
 *
 * Proved on the real procedures with the gate captured: the untrusted issuer
 * reaches `checkPermissionOrPropose` from both doors; a call with no view
 * keeps today's shape. (The dependency-edge branch of `relations.create`
 * hands the same issuer to `governedDependencyLink`'s gate; not driven here.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const SRC = "00000000-0000-4000-8000-000000000001";
  const TGT = "00000000-0000-4000-8000-000000000002";
  const WS = "00000000-0000-4000-8000-000000000010";
  const findFirst = vi.fn(async () => ({
    id: SRC,
    workspaceId: null,
    correlationId: null,
  }));
  const database = {
    query: {
      entities: {
        findMany: vi.fn(async () => [
          { id: SRC, workspaceId: WS },
          { id: TGT, workspaceId: WS },
        ]),
        findFirst,
      },
    },
  };
  return {
    database,
    getDb: vi.fn(async () => database),
    checkPermission: vi.fn(),
    resolveViewTrust: vi.fn(async () => ({ kind: "view", trusted: false })),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  // The real query BUILDER (the visibility filters build subqueries with it;
  // nothing executes), with only the row reads replaced.
  const db = Object.create(actual.db as object) as Record<string, unknown>;
  db.query = h.database.query;
  const database = Object.create(actual.db as object) as Record<
    string,
    unknown
  >;
  database.query = h.database.query;
  h.getDb.mockImplementation(async () => database as never);
  return {
    ...actual,
    db,
    getDb: h.getDb,
    eventRepository: { __shared: true },
  };
});
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: h.checkPermission,
}));
vi.mock("../services/view-trust-service.js", () => ({
  resolveViewTrust: h.resolveViewTrust,
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { relationsRouter } from "./relations.js";
import { entitiesRouter } from "./entities.js";

const USER = "00000000-0000-4000-8000-0000000000aa";
const SRC = "00000000-0000-4000-8000-000000000001";
const TGT = "00000000-0000-4000-8000-000000000002";
const WS = "00000000-0000-4000-8000-000000000010";
const VIEW = {
  viewId: "00000000-0000-4000-8000-0000000000f1",
  typeKey: "agent-made",
};
const UNTRUSTED = { kind: "view", trusted: false };

const ctx = { authenticated: true, userId: USER } as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.checkPermission.mockResolvedValue({ proposalId: "prop-1" });
});

describe("entities.delete", () => {
  it("an untrusted framed view's delete reaches the gate as that view", async () => {
    await entitiesRouter
      .createCaller(ctx)
      .delete({ id: SRC, source: "user", viewContext: VIEW });

    expect(h.resolveViewTrust).toHaveBeenCalledWith(VIEW, USER, null);
    expect(h.checkPermission).toHaveBeenCalledTimes(1);
    expect(h.checkPermission.mock.calls[0]![0]).toMatchObject({
      subjectType: "entity",
      action: "delete",
      issuer: UNTRUSTED,
    });
  });

  it("CONTROL: a call with no view sends no issuer (legacy behavior)", async () => {
    await entitiesRouter.createCaller(ctx).delete({ id: SRC, source: "user" });

    expect(h.resolveViewTrust).not.toHaveBeenCalled();
    expect(h.checkPermission.mock.calls[0]![0].issuer).toBeUndefined();
  });
});

describe("relations.create", () => {
  it("an untrusted framed view's edge reaches the gate as that view", async () => {
    await relationsRouter.createCaller(ctx).create({
      sourceEntityId: SRC,
      targetEntityId: TGT,
      type: "same_subject",
      workspaceId: WS,
      viewContext: VIEW,
    });

    expect(h.resolveViewTrust).toHaveBeenCalledWith(VIEW, USER, WS);
    expect(h.checkPermission.mock.calls[0]![0]).toMatchObject({
      subjectType: "relation",
      action: "create",
      issuer: UNTRUSTED,
    });
  });

  it("CONTROL: a call with no view sends no issuer", async () => {
    await relationsRouter.createCaller(ctx).create({
      sourceEntityId: SRC,
      targetEntityId: TGT,
      type: "same_subject",
      workspaceId: WS,
    });

    expect(h.resolveViewTrust).not.toHaveBeenCalled();
    expect(h.checkPermission.mock.calls[0]![0]).not.toHaveProperty("issuer");
  });
});
