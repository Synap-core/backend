/**
 * FACET WRITE GATE — tripwire for who may update/detach an `entity_facets` row.
 *
 * DB-FREE: `@synap/database` is mocked with in-memory membership tables, so the
 * REAL predicate — including the REAL `isPodAdmin` it delegates to — runs
 * against fake rows (no Postgres). The assertions pin the authority model:
 *
 *   - pod-wide facet (`workspace_id IS NULL`) → author OR pod admin, where
 *     "pod admin" is owner/admin of the `pod-admin` SYSTEM workspace (the same
 *     notion `requirePodAdmin` gates every other pod-wide row with). `client` /
 *     `partner` role facets are attached pod-wide by design; before this gate
 *     widened, not even the pod owner could edit their status.
 *   - a `pod-admin` workspace editor/viewer, or anyone with no pod-admin
 *     membership → refused (fails CLOSED; a member request-access path is a
 *     separate wave). A missing `pod-admin` workspace also refuses.
 *   - workspace-scoped facet → UNCHANGED owner/admin/editor of that workspace,
 *     with NO pod-level inheritance.
 *
 * MUTATION-TESTED: deleting the pod-admin branch in `facet-write-gate.ts` turns
 * the "pod owner/admin writes a facet they did not author" cases red.
 */

import { describe, it, expect, vi } from "vitest";

const POD_ADMIN_WS = "ws-pod-admin";

const h = vi.hoisted(() => ({
  /** `${workspaceId}:${userId}` → workspace role. */
  wsRoles: new Map<string, string>([
    // Membership of the `pod-admin` SYSTEM workspace = pod-level authority.
    ["ws-pod-admin:pod-owner", "owner"],
    ["ws-pod-admin:pod-admin", "admin"],
    ["ws-pod-admin:pod-editor", "editor"], // NOT owner/admin → not a pod admin
    ["ws-pod-admin:pod-viewer", "viewer"],
    // An ordinary workspace, unrelated to pod authority.
    ["ws-1:ws-owner", "owner"],
    ["ws-1:ws-admin", "admin"],
    ["ws-1:ws-editor", "editor"],
    ["ws-1:ws-viewer", "viewer"],
  ]),
  /** Set false to simulate a pod with no `pod-admin` system workspace. */
  podAdminWorkspaceExists: true,
  /** Trace of the tables/workspaces queried, for the "which lookup" proofs. */
  lastQuery: [] as string[],
}));

vi.mock("@synap/database", () => {
  // The gate + isPodAdmin only need the SHAPE of eq/and/inArray results, not
  // real SQL — model them as descriptors the fake `findFirst` reads back.
  const eq = (col: { _name: string }, value: unknown) => ({
    col: col._name,
    value,
  });
  const inArray = (col: { _name: string }, values: unknown[]) => ({
    col: col._name,
    anyOf: values,
  });
  const and = (...parts: unknown[]) => ({ parts });

  type Term = {
    col: string;
    value?: unknown;
    anyOf?: unknown[];
    parts?: unknown[];
  };
  const flatten = (w: unknown): Term[] => {
    const node = w as Term;
    if (node.parts) return node.parts.flatMap(flatten);
    return [node];
  };
  const matches = (term: Term | undefined, actual: string) =>
    term?.anyOf ? term.anyOf.includes(actual) : term?.value === actual;

  return {
    eq,
    and,
    inArray,
    db: {
      query: {
        workspaces: {
          // isPodAdmin's first hop: resolve the `pod-admin` system workspace.
          findFirst: async ({ where }: { where: unknown }) => {
            const term = flatten(where).find((t) => t.col === "systemSlug");
            h.lastQuery.push(`workspaces:${String(term?.value)}`);
            if (term?.value !== "pod-admin") return undefined;
            return h.podAdminWorkspaceExists ? { id: POD_ADMIN_WS } : undefined;
          },
        },
        workspaceMembers: {
          findFirst: async ({ where }: { where: unknown }) => {
            const terms = flatten(where);
            const userId = terms.find((t) => t.col === "userId")
              ?.value as string;
            const workspaceId = terms.find((t) => t.col === "workspaceId")
              ?.value as string;
            h.lastQuery.push(`workspace_members:${workspaceId}`);
            const role = h.wsRoles.get(`${workspaceId}:${userId}`);
            if (!role) return undefined;
            // isPodAdmin ANDs `inArray(role, ["admin","owner"])` into the query;
            // honor it, or a pod-admin-workspace *viewer* would falsely pass.
            const roleTerm = terms.find((t) => t.col === "role");
            if (roleTerm && !matches(roleTerm, role)) return undefined;
            return { role };
          },
        },
      },
    },
  };
});

vi.mock("@synap/database/schema", () => ({
  workspaces: {
    id: { _name: "id" },
    systemSlug: { _name: "systemSlug" },
  },
  workspaceMembers: {
    userId: { _name: "userId" },
    workspaceId: { _name: "workspaceId" },
    role: { _name: "role" },
  },
}));

const { canWriteFacet } = await import("./facet-write-gate.js");

/** A `client` role facet as the Operations pickup attaches it: POD-WIDE. */
const podWideFacet = { userId: "author", workspaceId: null };
/** A workspace-scoped facet authored by someone else. */
const workspaceFacet = { userId: "author", workspaceId: "ws-1" };

describe("canWriteFacet — pod-wide facets (widened to pod admins)", () => {
  it.each([
    ["pod-owner", true], // owner of the pod-admin workspace
    ["pod-admin", true], // admin of the pod-admin workspace — the RISK-1 case
    ["pod-editor", false], // editor there is NOT pod authority
    ["pod-viewer", false],
    ["ws-owner", false], // owner of an ORDINARY workspace ≠ pod admin
    ["stranger", false], // no membership anywhere
  ] as const)(
    "%s writing a pod-wide facet they did NOT author → %s",
    async (userId, expected) => {
      await expect(canWriteFacet(podWideFacet, userId)).resolves.toBe(expected);
    }
  );

  it("REFUSES everyone when the pod-admin workspace is missing (fails closed)", async () => {
    h.podAdminWorkspaceExists = false;
    try {
      await expect(canWriteFacet(podWideFacet, "pod-owner")).resolves.toBe(
        false
      );
    } finally {
      h.podAdminWorkspaceExists = true;
    }
  });

  it("still lets the AUTHOR write — without any membership lookup", async () => {
    h.lastQuery.length = 0;
    await expect(canWriteFacet(podWideFacet, "author")).resolves.toBe(true);
    expect(h.lastQuery).toEqual([]);
  });

  it("resolves authority via the pod-admin SYSTEM workspace", async () => {
    h.lastQuery.length = 0;
    await canWriteFacet(podWideFacet, "pod-admin");
    expect(h.lastQuery).toEqual([
      "workspaces:pod-admin",
      `workspace_members:${POD_ADMIN_WS}`,
    ]);
  });
});

describe("canWriteFacet — workspace-scoped facets (UNCHANGED)", () => {
  it.each([
    ["ws-owner", true],
    ["ws-admin", true],
    ["ws-editor", true],
    ["ws-viewer", false],
    ["stranger", false],
  ] as const)("workspace role of %s → %s", async (userId, expected) => {
    await expect(canWriteFacet(workspaceFacet, userId)).resolves.toBe(expected);
  });

  it("does NOT let pod-admin-ness leak into the workspace branch", async () => {
    // `pod-owner` is a pod admin but has no ws-1 membership. The workspace
    // branch must stay byte-identical: workspace membership decides, alone —
    // and it must never consult the pod-admin workspace.
    h.lastQuery.length = 0;
    await expect(canWriteFacet(workspaceFacet, "pod-owner")).resolves.toBe(
      false
    );
    expect(h.lastQuery).toEqual(["workspace_members:ws-1"]);
  });

  it("still lets the AUTHOR write their own workspace facet", async () => {
    await expect(canWriteFacet(workspaceFacet, "author")).resolves.toBe(true);
  });
});
