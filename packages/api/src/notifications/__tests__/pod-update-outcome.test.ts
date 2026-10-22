/**
 * U4 pod-side: the owner hears about an update that did not land, once per
 * update id per admin, through NotificationService.create.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
  and: vi.fn(),
  eq: vi.fn(),
  notifications: {},
}));
vi.mock("../NotificationService.js", () => ({
  NotificationService: { create: vi.fn() },
}));
vi.mock("../../services/capabilities/pod-owner.js", () => ({
  resolvePodAdminUserIds: vi.fn(),
}));

const {
  notifyPodUpdateOutcome,
  POD_UPDATE_ROLLBACK_FAILED_NOTIFICATION_TYPE,
  describePodUpdateOutcome,
  humanizePodVersion,
  POD_UPDATE_FAILED_NOTIFICATION_TYPE,
} = await import("../pod-update-outcome.js");
const { getNotificationDef, needsYouRole } = await import("../registry.js");
const { countNeedsYou } =
  await import("../../services/signals/needs-you-union.js");

const ROLLED_BACK = {
  updateId: "u-1",
  status: "rolled_back",
  from: "v1",
  to: "v2",
  reason: "backend migration failed",
  dbRestored: true,
};

function fakeDeps(admins: string[]) {
  const rows: Array<{ userId: string; sourceId: string }> = [];
  return {
    rows,
    deps: {
      recipients: async () => admins,
      alreadyNotified: async (sourceId: string) =>
        new Set(
          rows.filter((r) => r.sourceId === sourceId).map((r) => r.userId)
        ),
      markNotified: async () => undefined,
      create: async (input: { userId: string; sourceId?: string }) => {
        rows.push({ userId: input.userId, sourceId: input.sourceId! });
        return `n-${rows.length}`;
      },
    },
  };
}

describe("pod.update_failed", () => {
  // Catches: a producer whose type the registry does not know — create() would skip it.
  it("is a registered type", () => {
    expect(
      getNotificationDef(POD_UPDATE_FAILED_NOTIFICATION_TYPE)
    ).toBeTruthy();
  });

  it("notifies every admin once per update id", async () => {
    const { rows, deps } = fakeDeps(["owner", "admin"]);
    expect(await notifyPodUpdateOutcome(ROLLED_BACK, deps as never)).toBe(2);
    // Re-boot reading the same file: nothing new.
    expect(await notifyPodUpdateOutcome(ROLLED_BACK, deps as never)).toBe(0);
    expect(rows).toHaveLength(2);
    // A different update id is news again.
    expect(
      await notifyPodUpdateOutcome(
        { ...ROLLED_BACK, updateId: "u-2" },
        deps as never
      )
    ).toBe(2);
  });

  // Catches: the bell ringing for a good update.
  it("is silent on success and on an aborted (nothing-changed) run", async () => {
    const { rows, deps } = fakeDeps(["owner"]);
    await notifyPodUpdateOutcome(
      { ...ROLLED_BACK, status: "succeeded" },
      deps as never
    );
    await notifyPodUpdateOutcome(
      { ...ROLLED_BACK, status: "aborted" },
      deps as never
    );
    expect(rows).toHaveLength(0);
  });

  // Catches: a host build tag leaking into the bell ("Update to
  // local-b88d021b7d74 was rolled back", dogfood 2026-10-19).
  it("names a local build in words, never by its tag", async () => {
    const sent: Array<{ data?: Record<string, unknown> }> = [];
    const { deps } = fakeDeps(["owner"]);
    await notifyPodUpdateOutcome(
      { ...ROLLED_BACK, from: "local-0a1b2c3d4e5f", to: "local-b88d021b7d74" },
      {
        ...deps,
        create: async (input: { data?: Record<string, unknown> }) => {
          sent.push(input);
          return "n-1";
        },
      } as never
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data!.version).toBe("a local build");
    expect(String(sent[0]!.data!.detail)).toContain(
      "running a local build again"
    );
    expect(JSON.stringify(sent)).not.toMatch(/local-[0-9a-f]/);
    // A release keeps its own name (the discriminator).
    expect(humanizePodVersion("v1.4.0", "x")).toBe("v1.4.0");
    expect(humanizePodVersion(null, "the new release")).toBe("the new release");
  });

  it("says a failed rollback needs attention, and never claims the data is safe", () => {
    const d = describePodUpdateOutcome({
      ...ROLLED_BACK,
      status: "rollback_failed",
    })!;
    expect(d.headline).toMatch(/needs attention/);
    expect(d.detail).not.toMatch(/restored|safe/);
    expect(describePodUpdateOutcome(ROLLED_BACK)!.detail).toMatch(/restored/);
  });

  it("a run the engine stopped (unit-recorded `failed`) may have changed the pod — never 'still on'", () => {
    const d = describePodUpdateOutcome({ ...ROLLED_BACK, status: "failed" })!;
    expect(d.headline).toBe("stopped before it finished");
    expect(d.detail).toContain("Your pod may have changed");
    expect(d.detail).toContain("`synap doctor`");
    expect(d.detail).not.toMatch(/still on/);
  });
});

/**
 * A failed ROLLBACK is an ask ("needs attention · run synap doctor"): the pod
 * may be half-upgraded. It must count in needs-you and never expire, while a
 * rolled-back or plain failed update stays news. The discriminator is the
 * rolled-back row: one rule for the whole type passes either half alone.
 */
describe("a failed rollback asks; a rolled-back update is news", () => {
  async function sentFor(status: string) {
    const sent: Array<{ type: string }> = [];
    const { deps } = fakeDeps(["owner"]);
    await notifyPodUpdateOutcome({ ...ROLLED_BACK, status }, {
      ...deps,
      create: async (input: { type: string }) => {
        sent.push(input);
        return "n-1";
      },
    } as never);
    expect(sent).toHaveLength(1);
    return sent[0]!.type;
  }
  const counted = (type: string) =>
    countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      clusters: [],
      notifications: [
        {
          id: "n-1",
          type,
          title: "Update to v2",
          category: "system",
          sourceType: "system",
          sourceId: "pod-update:u-1",
          createdAt: new Date("2026-10-19T10:00:00Z"),
        },
      ],
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
      openQuestionSessionIds: new Set(),
    }).needsYou;

  it("rollback_failed → its own type: counted, never expires", async () => {
    const type = await sentFor("rollback_failed");
    expect(type).toBe(POD_UPDATE_ROLLBACK_FAILED_NOTIFICATION_TYPE);
    expect(getNotificationDef(type)).toBeTruthy(); // create() would skip it
    expect(needsYouRole(type)).toBe("item");
    expect(getNotificationDef(type)!.expiresAfterMs).toBeUndefined();
    expect(counted(type)).toBe(1);
  });

  it("rolled_back and failed stay news: not counted, they expire", async () => {
    for (const status of ["rolled_back", "failed"]) {
      const type = await sentFor(status);
      expect(type).toBe(POD_UPDATE_FAILED_NOTIFICATION_TYPE);
      expect(counted(type)).toBe(0);
      expect(getNotificationDef(type)!.expiresAfterMs).toBeGreaterThan(0);
    }
  });
});
