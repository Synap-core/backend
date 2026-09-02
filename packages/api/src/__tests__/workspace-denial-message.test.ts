/**
 * Pins the payload shape of the tRPC workspace-membership denial
 * (`workspaceProcedure` / `podProcedure` in `trpc.ts`).
 *
 * The denial used to be a bare `"Access denied to workspace"` — a real external
 * agent hit it, could not tell what it had done wrong (it had passed a POD id
 * where a WORKSPACE id belonged; both are bare UUIDs), and the run failed.
 *
 * These assertions are on the pure builder only: no db, no PG.
 */
import { describe, it, expect } from "vitest";
import { buildWorkspaceDenialMessage } from "../trpc.js";

const REJECTED = "11111111-1111-1111-1111-111111111111";

describe("buildWorkspaceDenialMessage", () => {
  it("names the rejected id so the caller can see which id lost", () => {
    expect(buildWorkspaceDenialMessage(REJECTED, [])).toContain(REJECTED);
  });

  it("says so plainly when the caller has no memberships at all", () => {
    const msg = buildWorkspaceDenialMessage(REJECTED, []);
    expect(msg).toContain("not a member of any workspace yet");
    // No empty candidate list dangling in the message.
    expect(msg).not.toContain("Pass one of your workspaces");
  });

  it("names each candidate as 'Name (id)' so it can be passed back verbatim", () => {
    const msg = buildWorkspaceDenialMessage(REJECTED, [
      { id: "ws-a", name: "Builder" },
      { id: "ws-b", name: "Marketing" },
    ]);
    expect(msg).toContain("Builder (ws-a)");
    expect(msg).toContain("Marketing (ws-b)");
    expect(msg).toContain("X-Workspace-Id");
  });

  it("carries the pod-id hint — the failure this exists for", () => {
    const msg = buildWorkspaceDenialMessage(REJECTED, [
      { id: "ws-a", name: "Builder" },
    ]);
    expect(msg).toContain("POD id");
  });

  it("elides past 8 candidates instead of dumping an unbounded list", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      id: `ws-${i}`,
      name: `W${i}`,
    }));
    const msg = buildWorkspaceDenialMessage(REJECTED, many);
    expect(msg).toContain("W7 (ws-7)");
    expect(msg).not.toContain("W8 (ws-8)");
    expect(msg).toContain("+3 more");
  });
});
