/**
 * THE RECEIPT'S PROJECT AXIS MUST MATCH THE ROW IT FILED.
 *
 * Live dogfood: `synap_capture({ sessionId })` on a session scoped to project
 * d4b84ad8… returned `scope: { projectId: null }` — while the proposal row it
 * filed carried the right project, because `insertPendingProposal` derives
 * `projectId` from the session at the SSOT insert (Wave A). The write knew; the
 * receipt did not.
 *
 * The cause was that every receipt echoed `captureProjectId`, which is ONLY the
 * caller's explicit pin (rung 1). The fix routes the echo through the same one
 * door the write path uses — `resolveProjectPlacement` — so the two can never
 * fork again.
 *
 * Behaviour is asserted on that resolver directly (rung 1 wins, rung 2 fills a
 * gap, no session leaves it null). The WIRING — that the handler's four receipt
 * lanes read the derived value and no lane echoes the bare pin — is asserted
 * against the source, because driving the MCP capture handler end to end needs
 * Postgres, an LLM structurer, and a channel.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sessionRows: [] as { projectId: string | null }[],
  sessionQueries: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual };
});

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { resolveProjectPlacement } from "@synap/database";

const USER = "user-owner";
const SESSION_ID = "d4b84ad8-1111-4111-8111-111111111111";
const SESSION_PROJECT = "d4b84ad8-2222-4222-8222-222222222222";
const PINNED_PROJECT = "eeeeeeee-3333-4333-8333-333333333333";

/** Minimal `db.query.focusSessions.findFirst` seam the rung-2 lookup uses. */
const fakeDb = {
  query: {
    focusSessions: {
      findFirst: async () => {
        h.sessionQueries += 1;
        return h.sessionRows[0];
      },
    },
    channels: { findFirst: async () => undefined },
    relations: { findMany: async () => [] },
  },
} as unknown as Parameters<typeof resolveProjectPlacement>[0];

beforeEach(() => {
  h.sessionRows = [];
  h.sessionQueries = 0;
});

describe("the derivation the receipt now shares with the write", () => {
  it("fills the project from the session when the caller pinned none (the live bug)", async () => {
    h.sessionRows = [{ projectId: SESSION_PROJECT }];
    const out = await resolveProjectPlacement(fakeDb, {
      userId: USER,
      explicitProjectId: null,
      sessionId: SESSION_ID,
    });
    expect(out).toMatchObject({ projectId: SESSION_PROJECT, rung: 2 });
  });

  it("an explicit pin still wins, and costs no session round-trip", async () => {
    h.sessionRows = [{ projectId: SESSION_PROJECT }];
    const out = await resolveProjectPlacement(fakeDb, {
      userId: USER,
      explicitProjectId: PINNED_PROJECT,
      sessionId: SESSION_ID,
    });
    expect(out).toMatchObject({ projectId: PINNED_PROJECT, rung: 1 });
    expect(h.sessionQueries).toBe(0);
  });

  it("a session with no project leaves it null rather than inventing one", async () => {
    h.sessionRows = [{ projectId: null }];
    const out = await resolveProjectPlacement(fakeDb, {
      userId: USER,
      explicitProjectId: null,
      sessionId: SESSION_ID,
    });
    expect(out.projectId).toBeNull();
  });

  it("no session and no pin queries nothing", async () => {
    const out = await resolveProjectPlacement(fakeDb, { userId: USER });
    expect(out.projectId).toBeNull();
    expect(h.sessionQueries).toBe(0);
  });
});

describe("every MCP capture receipt reports the DERIVED project", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "capture.ts"),
    "utf8"
  );

  it("derives the receipt scope through the one door, not a second helper", () => {
    expect(src).toContain("const scopeProjectId =");
    expect(src).toContain("resolveProjectPlacement(db, {");
    expect(src).toContain("explicitProjectId: captureProjectId");
  });

  it("every receipt lane echoes it — graph, text, global, proposed, applied", () => {
    // graphScope / textScope / the global-lane receipt / the `proposed` early
    // return, plus the landed echo asserted separately below.
    expect(src.match(/projectId: scopeProjectId/g) ?? []).toHaveLength(4);
    expect(src).toContain(
      'ex.project?.status === "linked" ? ex.project.projectId : scopeProjectId'
    );
  });

  it("no receipt echoes the bare caller pin any more", () => {
    // `captureProjectId` survives ONLY as what is FORWARDED to the write
    // (`...(captureProjectId ? { projectId: captureProjectId } : {})`, which
    // keeps placement unchanged); it must never be a receipt's own field.
    const receiptEchoes = src
      .split("\n")
      .filter((l) => /^\s*projectId: captureProjectId,/.test(l));
    expect(receiptEchoes).toEqual([]);
  });

  it("placement itself is untouched — the pin is still what the write receives", () => {
    expect(src).toContain(
      "...(captureProjectId ? { projectId: captureProjectId } : {})"
    );
    expect(src).toContain(
      "...(args.projectId ? { projectId: args.projectId as string } : {})"
    );
  });
});
