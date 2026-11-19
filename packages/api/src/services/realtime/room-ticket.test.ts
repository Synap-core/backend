/**
 * The room ticket door's ACCESS decision (`issueRoomTicket`, 0433).
 *
 * Real: the grant check (`grantDeniedKey`, governance-policy `permits`) on
 * real grants, the room naming. Mocked as tables: the document floor
 * (`resolveDocumentRoomAccess`, driven on PGlite in
 * `utils/document-edit-access.pglite.test.ts`; it reads through scopedDb, so
 * a document the grant does not read answers `none` there), the document and
 * view rows, and the ticket store (on PGlite in
 * `packages/database/src/realtime-room-tickets.pglite.test.ts`).
 *
 * Rows that rule out a wrong rule:
 *  - a grant pinned to ANOTHER space with document.update → read (a rule that
 *    checked only the verb would say edit);
 *  - a canvas whose view the grant may update but whose document it may not →
 *    edit (a rule that checked only document.update would say read), and a
 *    markdown document with the same grant → read (a rule that accepted the
 *    view permission for any document would say edit);
 *  - floor edit + no write scope → read; floor read + full grant → read;
 *  - asking for read caps an editor at read;
 *  - no grant (a person's own key with no scope) follows the floor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KeyGrant } from "@synap/database";

const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOC = "11111111-1111-4111-8111-111111111111";
const BOARD = "44444444-4444-4444-8444-444444444444";
const BOARD_VIEW = "66666666-6666-4666-8666-666666666666";

const h = vi.hoisted(() => ({
  floor: "edit" as "edit" | "read" | "none",
  grant: undefined as KeyGrant | undefined,
  minted: [] as Array<Record<string, unknown>>,
}));

const DOCS: Record<string, { id: string; type: string; workspaceId: string }> =
  {
    [DOC]: { id: DOC, type: "markdown", workspaceId: SPACE },
    [BOARD]: { id: BOARD, type: "whiteboard", workspaceId: SPACE },
  };

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    eq: (_col: unknown, value: unknown) => ({ value }),
    getRequestGrant: () => h.grant,
    db: {
      query: {
        documents: {
          findFirst: async ({ where }: { where: { value: string } }) =>
            DOCS[where.value],
        },
        views: {
          findFirst: async ({ where }: { where: { value: string } }) =>
            where.value === BOARD
              ? { id: BOARD_VIEW, workspaceId: SPACE, projectId: null }
              : undefined,
        },
      },
    },
  };
});
vi.mock("@synap/database/realtime-room-tickets", () => ({
  mintRoomTicket: async (_db: unknown, input: Record<string, unknown>) => {
    h.minted.push(input);
    return {
      ticket: `synap_rt_${"x".repeat(43)}`,
      expiresAt: new Date("2026-11-18T12:01:00Z"),
    };
  },
}));
vi.mock("../../utils/document-edit-access.js", () => ({
  resolveDocumentRoomAccess: async () => h.floor,
}));

import { issueRoomTicket, roomNameFor } from "./room-ticket.js";

const scope = (
  permissions: string[],
  workspaceIds: string[] | null = [SPACE]
): KeyGrant => ({ scopes: [{ permissions, workspaceIds }], clientId: "app_x" });

const ask = (
  documentId: string,
  over: { mayWrite?: boolean; access?: "read" | "edit" } = {}
) =>
  issueRoomTicket({
    userId: "person-1",
    apiKeyId: "key-1",
    documentId,
    mayWrite: over.mayWrite ?? true,
    access: over.access,
  });

beforeEach(() => {
  h.floor = "edit";
  h.grant = undefined;
  h.minted = [];
});

describe("issueRoomTicket — the access a ticket carries", () => {
  it("edit when the floor is edit and the grant permits document.update in its space", async () => {
    h.grant = scope(["document.read", "document.update"]);
    const out = await ask(DOC);
    expect(out).toMatchObject({ ok: true, access: "edit", room: DOC });
    expect(h.minted[0]).toMatchObject({
      userId: "person-1",
      documentId: DOC,
      access: "edit",
      apiKeyId: "key-1",
    });
  });

  it("read when the grant may update documents only in ANOTHER space", async () => {
    h.grant = scope(["document.read", "document.update"], [OTHER_SPACE]);
    await expect(ask(DOC)).resolves.toMatchObject({ access: "read" });
  });

  it("read when the grant only reads", async () => {
    h.grant = scope(["document.read"]);
    await expect(ask(DOC)).resolves.toMatchObject({ access: "read" });
    expect(h.minted[0]).toMatchObject({ access: "read" });
  });

  it("a canvas is written with view.update_content on the view that owns it", async () => {
    h.grant = scope(["view.read", "view.update_content"]);
    await expect(ask(BOARD)).resolves.toMatchObject({
      access: "edit",
      room: `whiteboard-${BOARD}`,
    });
  });

  it("view.update_content does not write a document that is not a canvas", async () => {
    h.grant = scope(["document.read", "view.update_content"]);
    await expect(ask(DOC)).resolves.toMatchObject({ access: "read" });
  });

  it("read when the key holds no write scope, whatever the grant", async () => {
    h.grant = scope(["*"]);
    await expect(ask(DOC, { mayWrite: false })).resolves.toMatchObject({
      access: "read",
    });
  });

  it("read when the floor is read, whatever the grant", async () => {
    h.floor = "read";
    h.grant = scope(["*"], null);
    await expect(ask(DOC)).resolves.toMatchObject({ access: "read" });
  });

  it("asking for read caps an editor at read", async () => {
    h.grant = scope(["document.update"]);
    await expect(ask(DOC, { access: "read" })).resolves.toMatchObject({
      access: "read",
    });
  });

  it("no grant follows the floor", async () => {
    await expect(ask(DOC)).resolves.toMatchObject({ access: "edit" });
  });

  it("not found when the floor (under the grant) does not admit, and mints nothing", async () => {
    h.floor = "none";
    await expect(ask(DOC)).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(h.minted).toHaveLength(0);
  });
});

describe("roomNameFor", () => {
  it.each([
    ["whiteboard", `whiteboard-${DOC}`],
    ["mindmap", `whiteboard-${DOC}`],
    ["markdown", DOC],
  ])("%s → %s", (type, room) => {
    expect(roomNameFor(DOC, type)).toBe(room);
  });
});
