/**
 * The Cal.com backfill files a missed booking the SAME way the webhook does —
 * the same graph door (`bookingGraphFor`: lead, call, attribution-event), the
 * same Capture governance, and the SAME capture idempotency key — so a booking
 * the webhook already filed never lands twice, nor its attribution-event:
 *   - seen by the webhook (seen-map) ⇒ skipped, nothing built or filed;
 *   - filed by the webhook but its seen-map write lost ⇒ the backfill files
 *     under the webhook's key, which `submitCaptureGraph` answers with the
 *     prior proposal (`findPriorCaptureGraphProposal`, its own suites).
 *
 * Stubbed: the capability run (the bookings list), the raw door, the submit
 * door and the tool row. The graph door is a recorder; its output is proven in
 * map-booking-to-graph.test.ts and booking-lands-governed.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  tool: null as null | {
    id: string;
    createdBy: string;
    workspaceId: string | null;
    metadata: unknown;
  },
  bookings: [] as Array<Record<string, unknown>>,
  submitted: [] as Array<Record<string, unknown>>,
  built: [] as Array<{ payload: unknown; ctx: unknown }>,
  seenWrites: 0,
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    update: () => ({
      set: () => ({
        where: () => {
          h.seenWrites += 1;
          return { catch: () => Promise.resolve() };
        },
      }),
    }),
  },
}));
vi.mock("../tools/resolve-tool.js", () => ({
  resolveTool: async () => h.tool,
}));
vi.mock("../capabilities/execute-capability.js", () => ({
  executeCapability: async () => ({
    kind: "run",
    result: { bookings: h.bookings },
  }),
}));
vi.mock("../connection-health/notify-connector-unhealthy.js", () => ({
  notifyConnectorUnhealthy: vi.fn(),
  isConnectionAuthError: () => false,
  capErrorMessage: () => undefined,
  resolveNoticeChannelId: () => undefined,
}));
vi.mock("../intake/record-structure-intake.js", () => ({
  stageCaptureSources: async () => ({
    sourceDocumentIds: ["raw-1"],
    attempted: 1,
    errors: [],
  }),
}));
vi.mock("../capture-agent/submit-capture-graph.js", () => ({
  submitCaptureGraph: async (input: Record<string, unknown>) => {
    h.submitted.push(input);
    return { proposalId: "p-1", applied: true };
  },
}));
vi.mock("../capture-agent/ensure-capture-agent.js", () => ({
  getCaptureAgentUserId: async () => "capture-agent",
}));
vi.mock("./booking-graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./booking-graph.js")>()),
  bookingGraphFor: async (payload: unknown, ctx: unknown) => {
    h.built.push({ payload, ctx });
    return {
      entities: [
        { ref: "person", profileSlug: "person", title: "Ada" },
        { ref: "attribution", profileSlug: "attribution-event", title: "x" },
      ],
      relations: [],
      attribution: true,
    };
  },
}));

import { runCalBackfill } from "./run-cal-backfill.js";
import { calBookingIdempotencyKey } from "./booking-graph.js";

beforeEach(() => {
  h.submitted.length = 0;
  h.built.length = 0;
  h.seenWrites = 0;
  h.tool = {
    id: "tool-cal",
    createdBy: "owner-1",
    workspaceId: "ws-1",
    metadata: {
      calcom: {
        backfill: { enabled: true },
        webhook: {
          workspaceId: "ws-1",
          seen: { "bk-seen:BOOKING_CREATED": "2026-11-26T10:00:00Z" },
        },
      },
    },
  };
  h.bookings = [
    { uid: "bk-seen", title: "Handled by the webhook" },
    { uid: "bk-new", title: "Missed", createdAt: "2026-11-26T09:00:00Z" },
  ];
});

describe("cal.com backfill: the webhook's dedupe, the webhook's graph", () => {
  it("skips a booking the webhook already handled: nothing built, nothing filed", async () => {
    const out = await runCalBackfill();
    expect(out).toMatchObject({ processed: 2, proposed: 1, alreadySeen: 1 });
    expect(h.built.map((b) => (b.payload as { uid: string }).uid)).toEqual([
      "bk-new",
    ]);
    expect(h.submitted).toHaveLength(1);
  });

  it("files a missed booking with its attribution-event, as Capture, under the webhook's key", async () => {
    await runCalBackfill();
    expect(h.built[0]!.ctx).toMatchObject({
      userId: "owner-1",
      workspaceId: "ws-1",
    });
    const filed = h.submitted[0]! as {
      agentUserId?: string;
      entities: Array<{ profileSlug: string }>;
      rawSource: { idempotencyKey?: string };
    };
    expect(filed.agentUserId).toBe("capture-agent");
    expect(filed.entities.map((e) => e.profileSlug)).toContain(
      "attribution-event"
    );
    expect(filed.rawSource.idempotencyKey).toBe(
      calBookingIdempotencyKey("tool-cal", "bk-new")
    );
    // ...which is the webhook's key for the same booking event.
    expect(filed.rawSource.idempotencyKey).toBe(
      "calcom:tool-cal:bk-new:BOOKING_CREATED"
    );
    expect(h.seenWrites).toBe(1);
  });

  it("a second run after the seen-map write files nothing again", async () => {
    await runCalBackfill();
    (
      h.tool!.metadata as { calcom: { webhook: { seen: object } } }
    ).calcom.webhook.seen = {
      "bk-seen:BOOKING_CREATED": "2026-11-26T10:00:00Z",
      "bk-new:BOOKING_CREATED": "2026-11-26T10:30:00Z",
    };
    h.submitted.length = 0;
    const again = await runCalBackfill();
    expect(again).toMatchObject({ proposed: 0, alreadySeen: 2 });
    expect(h.submitted).toHaveLength(0);
  });
});
