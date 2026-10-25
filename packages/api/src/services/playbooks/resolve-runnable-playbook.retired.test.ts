/**
 * Ticket cdf608a8 — an archived playbook kept running: the archive missed its
 * cron teardown on one door, and the run door never read the status. The ONE
 * run door (`resolveRunnablePlaybook`, shared by scheduled, automated and
 * manual runs) refuses a retired playbook in words. A draft stays runnable
 * (the catalog installs some playbooks as drafts).
 */
import { describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: mockGetDb };
});

import { resolveRunnablePlaybook } from "./playbook-lifecycle.js";

const WS = "00000000-0000-4000-8000-00000000000a";
const PB_ID = "00000000-0000-4000-8000-000000000091";

function withStatus(status: string) {
  mockGetDb.mockResolvedValue({
    query: {
      playbooks: {
        findFirst: vi.fn().mockResolvedValue({
          id: PB_ID,
          name: "CRM Hygiene",
          workspaceId: WS,
          status,
        }),
      },
    },
  });
}

describe("resolveRunnablePlaybook refuses a retired playbook (cdf608a8)", () => {
  it.each(["archived", "paused"])("a %s playbook is refused", async (s) => {
    withStatus(s);
    await expect(
      resolveRunnablePlaybook({ playbookId: PB_ID, workspaceId: WS })
    ).rejects.toThrow(
      `Playbook "CRM Hygiene" is ${s}, so it does not run. Set it active to run it again.`
    );
  });

  it.each(["active", "draft"])("a %s playbook runs", async (s) => {
    withStatus(s);
    const pb = await resolveRunnablePlaybook({
      playbookId: PB_ID,
      workspaceId: WS,
    });
    expect(pb.id).toBe(PB_ID);
  });
});
