/**
 * Pins the exact failure the founder saw when starting a playbook from Relay.
 *
 * `playbooks.run` (tRPC) used to pass the ambient `X-Workspace-Id` header down
 * as `runPlaybook({ workspaceId })`. Relay lists playbooks pod-wide
 * (`playbooks.list`'s predicate is lens-free), so a playbook living in
 * workspace A launched while the header said B arrived here mismatched and
 * `resolveRunnablePlaybook`'s cross-workspace IDOR floor threw.
 *
 * The floor itself is CORRECT and stays — the fix is that the caller now
 * resolves the run workspace FROM the playbook (`resolvePlaybookRunWriteWorkspace`,
 * the same ladder the Hub/MCP door uses), so the two can no longer disagree.
 */
import { describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: mockGetDb };
});

import { resolveRunnablePlaybook } from "./playbook-lifecycle.js";

const WS_A = "00000000-0000-4000-8000-00000000000a";
const WS_B = "00000000-0000-4000-8000-00000000000b";
const PB_ID = "00000000-0000-4000-8000-000000000091";

function dbReturning(playbook: unknown) {
  return {
    query: { playbooks: { findFirst: vi.fn().mockResolvedValue(playbook) } },
  };
}

describe("resolveRunnablePlaybook cross-workspace floor", () => {
  it("throws the founder's error when the run workspace disagrees with the playbook's home", async () => {
    mockGetDb.mockResolvedValue(
      dbReturning({ id: PB_ID, name: "Weekly review", workspaceId: WS_A })
    );

    await expect(
      resolveRunnablePlaybook({ playbookId: PB_ID, workspaceId: WS_B })
    ).rejects.toThrow(
      `resolveRunnablePlaybook: playbook ${PB_ID} not visible in workspace ${WS_B}`
    );
  });

  it("accepts the run when the workspace was derived FROM the playbook", async () => {
    mockGetDb.mockResolvedValue(
      dbReturning({ id: PB_ID, name: "Weekly review", workspaceId: WS_A })
    );

    const pb = await resolveRunnablePlaybook({
      playbookId: PB_ID,
      workspaceId: WS_A,
    });
    expect(pb.id).toBe(PB_ID);
  });

  it("a pod-wide (NULL workspace) playbook passes the floor for any workspace", async () => {
    mockGetDb.mockResolvedValue(
      dbReturning({ id: PB_ID, name: "Pod-wide", workspaceId: null })
    );

    const pb = await resolveRunnablePlaybook({
      playbookId: PB_ID,
      workspaceId: WS_B,
    });
    expect(pb.id).toBe(PB_ID);
  });
});
