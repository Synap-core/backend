/**
 * `withConnectionFacts` — fixture = the live pod of 2026-09-25: two Google
 * connections (one `needs_reauth`), every lane failed `permission`, and the
 * enable request those failures offer already APPROVED.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rowsFor = vi.hoisted(() => ({
  secrets: [] as Array<{
    id: string;
    accountHint: string | null;
    connectionState: string | null;
  }>,
  proposals: [] as Array<{ id: string; status: string }>,
}));

vi.mock("@synap/database", () => ({
  inArray: () => undefined,
  db: {
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: async () =>
          "accountHint" in cols ? rowsFor.secrets : rowsFor.proposals,
      }),
    }),
  },
}));
vi.mock("@synap/database/schema", () => ({
  ProposalStatus: {
    PENDING: "pending",
    APPROVED: "approved",
    REJECTED: "rejected",
  },
  proposals: { id: "id", status: "status" },
  secrets: { id: "id", accountHint: "a", connectionState: "c" },
}));

import { withConnectionFacts } from "./sync-status-facts.js";

const failed = (connectionId: string) => ({
  provider: "google",
  workspaceId: null,
  kind: "event",
  enabled: true,
  profileSlugs: ["event"],
  openableProfileSlugs: ["event"],
  connectionId,
  phase: "failed" as const,
  error: "This capability is installed but not yet enabled.",
  failure: {
    errorClass: "permission" as const,
    enableProposalId: "req-1",
    next: {
      kind: "enable" as const,
      hint: "Enable verbs",
      url: "https://pod/open/capability/x",
    },
  },
});

beforeEach(() => {
  rowsFor.secrets = [
    { id: "a6d38626", accountHint: "8324e5aa", connectionState: null },
    {
      id: "c28bb7ba",
      accountHint: "2795fc15",
      connectionState: "needs_reauth",
    },
  ];
  rowsFor.proposals = [{ id: "req-1", status: "approved" }];
});

describe("withConnectionFacts", () => {
  it("names each row's broker connection and its dead credential", async () => {
    const [a, b] = await withConnectionFacts([
      failed("a6d38626"),
      failed("c28bb7ba"),
    ]);
    expect(a).toMatchObject({
      brokerConnectionId: "8324e5aa",
      connectionState: null,
    });
    expect(b).toMatchObject({
      brokerConnectionId: "2795fc15",
      connectionState: "needs_reauth",
    });
  });

  it("an APPROVED enable request is never offered again; the failure is resolved", async () => {
    const [a] = await withConnectionFacts([failed("a6d38626")]);
    expect(a!.failure).toEqual({
      errorClass: "permission",
      next: {
        kind: "enable",
        hint: "Enable verbs",
        url: "https://pod/open/capability/x",
      },
      resolved: true,
    });
  });

  it("a PENDING request stays the fix; a REJECTED one is dropped but not resolved", async () => {
    rowsFor.proposals = [{ id: "req-1", status: "pending" }];
    const [p] = await withConnectionFacts([failed("a6d38626")]);
    expect(p!.failure?.enableProposalId).toBe("req-1");
    rowsFor.proposals = [{ id: "req-1", status: "rejected" }];
    const [r] = await withConnectionFacts([failed("a6d38626")]);
    expect(r!.failure).not.toHaveProperty("enableProposalId");
    expect(r!.failure).not.toHaveProperty("resolved");
  });
});
