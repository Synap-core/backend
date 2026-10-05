/**
 * Dogfood 2026-10-05 (the founder's pod): "meta encountered an error" sat in
 * Needs you and the triage page listed it 9× — `agent.task_failed` rows from
 * nine failed runs, each with its OWN `sourceId` (the run), so the per-target
 * fold never merged them. Fixtures are the producer's real shape
 * (`hub-protocol/rest/events.ts` / `a2ai-response-trigger.ts`): sourceType
 * `agent`, sourceId = the run, `groupKey` = `pod:<user>:agent.task_failed:<agent>`.
 */
import { describe, it, expect } from "vitest";
import {
  countNeedsYou,
  unionNeedsYou,
  type NotificationSignalInput,
} from "../needs-you-union.js";

const failed = (i: number, agent = "meta"): NotificationSignalInput => ({
  id: `n-${agent}-${i}`,
  type: "agent.task_failed",
  title: `${agent} encountered an error`,
  category: "ai",
  sourceType: "agent",
  sourceId: `run-${agent}-${i}`,
  groupKey: `pod:user-1:agent.task_failed:${agent}`,
  createdAt: new Date(Date.UTC(2026, 8, 10 + i)),
});

const list = (notifications: NotificationSignalInput[]) =>
  unionNeedsYou({ clusters: [], owedSlots: [], notifications });
const count = (notifications: NotificationSignalInput[]) =>
  countNeedsYou({
    distinctClusters: 0,
    clustersTruncated: false,
    clusters: [],
    notifications,
    notificationsTruncated: false,
    owedSlots: [],
    owedTruncated: false,
  }).notifications;

describe("one agent's repeated failures fold into ONE row with a count", () => {
  const nine = Array.from({ length: 9 }, (_, i) => failed(i));

  it("lists ONE row ×9 carrying the newest run and its registry type", () => {
    const rows = list(nine);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "notification",
      repeatCount: 9,
      count: 9,
      notificationType: "agent.task_failed",
      target: { kind: "run", id: "run-meta-8" },
    });
    // The badge counts what the list shows.
    expect(count(nine)).toBe(1);
  });

  it("two different agents stay two rows", () => {
    expect(list([...nine, failed(0, "scout")])).toHaveLength(2);
  });

  it("a type WITHOUT foldBy keeps folding per target (distinct targets stay apart)", () => {
    const other = nine.slice(0, 2).map((r) => ({
      ...r,
      type: "agent.task_complete",
    }));
    expect(list(other)).toHaveLength(2);
  });
});
