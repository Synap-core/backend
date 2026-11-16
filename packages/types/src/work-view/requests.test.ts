/**
 * requestsOf on REAL-SHAPED rows: the fields and id formats of a live
 * `GET /needs-you` `rows.needs_you` page (16 Nov 2026), content invented
 * (this repo is public). Each rule is asserted through what a reader gets
 * (how many requests, which rows each stands for), never through a helper.
 */
import { describe, expect, it } from "vitest";

import { needsYouBuckets } from "../needs-you/index.js";
import {
  REQUESTS_HEADLINE_CAP,
  isBookkeeping,
  requestActionOf,
  requestsOf,
  type RequestSignal,
} from "./requests.js";
import { parentOfGraph } from "./branches.js";

type Row = RequestSignal & {
  waitKind?: string;
  slotKind?: string;
  package?: string;
};

const S = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let at = Date.parse("2026-11-16T18:00:00.000Z");
const when = () => new Date((at -= 60_000)).toISOString();

function slot(session: number, title: string, extra: Partial<Row> = {}): Row {
  return {
    id: `slot:${S(session)}:${title.toLowerCase()}`,
    kind: "owed-slot",
    waitKind: "decide",
    title,
    count: 1,
    occurredAt: when(),
    target: { kind: "session", id: S(session) },
    blockedReason: "decision",
    slotKind: "decision",
    sessionTitle: `Job ${session}`,
    groupKey: `session:${S(session)}`,
    ageBucket: "recent",
    repeatCount: 1,
    package: "questions",
    ...extra,
  };
}

function cluster(session: number, action: string, title: string): Row {
  const proposal = S(9000 + session);
  return {
    id: `cluster:${action}\u0000capability\u0000id:${S(7000 + session)}@${proposal}`,
    kind: "proposal-cluster",
    waitKind: "approval",
    title,
    count: 1,
    occurredAt: when(),
    target: { kind: "proposal", id: proposal },
    groupKey: `session:${S(session)}`,
    ageBucket: "recent",
    repeatCount: 1,
    package: "data-changes",
  };
}

function review(session: number): Row {
  return {
    id: `review:${S(session)}`,
    kind: "session-review",
    waitKind: "try_it",
    title: `Job ${session} result`,
    count: 1,
    occurredAt: when(),
    target: { kind: "session", id: S(session) },
    groupKey: `session:${S(session)}`,
    ageBucket: "older",
    repeatCount: 1,
  };
}

function notification(session: number, repeats: number): Row {
  return {
    id: `notification:${S(8000 + session)}`,
    kind: "notification",
    title: `Job ${session} has been paused longer than planned`,
    count: repeats,
    occurredAt: when(),
    target: { kind: "session", id: S(session) },
    notificationType: "session.signal",
    groupKey: `session:${S(session)}`,
    ageBucket: "recent",
    repeatCount: repeats,
  };
}

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

describe("requestsOf", () => {
  it("keeps every row in exactly one request (nothing dropped)", () => {
    const rows = [
      notification(1, 23),
      slot(2, "Rotate the deploy token", {
        blockedReason: "credential",
        slotKind: "credential",
      }),
      slot(3, "Rotate the backup key", {
        blockedReason: "credential",
        slotKind: "output",
      }),
      slot(4, "Pick the pricing tier"),
      slot(4, "Approve the copy"),
      review(5),
    ];
    const out = requestsOf(rows);
    const all = [...out.headline, ...out.waiting].flatMap((r) => ids(r.items));
    expect(all.sort()).toEqual(ids(rows).sort());
    expect(out.counts.rows).toBe(6);
    expect(out.counts.copies).toBe(23 + 5);
  });

  it("merges a twin: the same ask on the same subject, asked twice", () => {
    const lead = S(500);
    const rows = [
      slot(10, "Proposed first message", { subjectEntityId: lead }),
      slot(11, "Proposed first message", { subjectEntityId: lead }),
      slot(12, "Proposed first message", { subjectEntityId: S(501) }),
    ];
    const out = requestsOf(rows);
    const reqs = [...out.headline, ...out.waiting];
    const twin = reqs
      .flatMap((r) => r.items)
      .filter((s) => s.subjectEntityId === lead);
    expect(twin).toHaveLength(2);
    // The twin rides one request, counted as a twin; the other lead is its own ask.
    const holding = reqs.find((r) =>
      r.items.some((s) => s.id === rows[1]!.id)
    )!;
    expect(holding.items.map((s) => s.id)).toContain(rows[0]!.id);
    expect(reqs.reduce((n, r) => n + r.twins, 0)).toBe(1);
  });

  it("does not merge the same title on two different subjects into one ask", () => {
    const rows = [
      slot(10, "Pick the pricing tier", { subjectEntityId: S(600) }),
      slot(11, "Pick the pricing tier", { subjectEntityId: S(601) }),
    ];
    const out = requestsOf(rows);
    expect(out.headline.reduce((n, r) => n + r.twins, 0)).toBe(0);
  });

  it("rolls a child job's asks up to its parent job: one job request", () => {
    const graph = {
      edges: [
        { kind: "spawned_from", from: S(21), to: S(20) },
        { kind: "spawned_from", from: S(22), to: S(21) },
      ],
    };
    const rows = [
      slot(21, "Pick the pricing tier"),
      slot(22, "Approve the landing copy"),
      slot(30, "Deploy the api"),
    ];
    const without = requestsOf(rows);
    expect(without.counts.requests).toBe(3);
    const out = requestsOf(rows, { parentOf: parentOfGraph(graph) });
    expect(out.counts.requests).toBe(2);
    const job = out.headline.find((r) => r.kind === "job")!;
    expect(job.jobId).toBe(S(20));
    expect(ids(job.items).sort()).toEqual(ids(rows.slice(0, 2)).sort());
  });

  it("folds a job's bookkeeping into the job, and batches the jobs' own reviews", () => {
    const rows = [
      slot(40, "Pick the pricing tier"),
      cluster(40, "playbook.stage_gate", "Approve stage: Approve for Template"),
      review(41),
      review(42),
      slot(43, "Check: typecheck passes", { slotKind: "criterion" }),
    ];
    const out = requestsOf(rows);
    const reqs = [...out.headline, ...out.waiting];
    // Job 40: its ask and its stage gate are ONE request.
    const job = reqs.find((r) => r.jobId === S(40))!;
    expect(job.kind).toBe("job");
    expect(job.items).toHaveLength(2);
    // The other jobs' bookkeeping is ONE batch, never three asks.
    const books = reqs.find((r) => r.batchKey === "bookkeeping")!;
    expect(books.kind).toBe("batch");
    expect(books.bookkeeping).toBe(true);
    expect(books.items).toHaveLength(3);
    expect(reqs).toHaveLength(2);
  });

  it("batches the same kind across jobs: a title, a thing to provide, a request action", () => {
    const rows = [
      slot(50, "Proposed first message", { subjectEntityId: S(700) }),
      slot(51, "Proposed first message", {
        subjectEntityId: S(701),
        blockedReason: "capability",
        slotKind: "messaging",
      }),
      slot(52, "A key with installation.read", {
        blockedReason: "credential",
        slotKind: "output",
      }),
      slot(53, "Fill the off-site backup credentials", {
        blockedReason: "credential",
        slotKind: "output",
      }),
      cluster(54, "capability.run", "Run Tool"),
      cluster(55, "capability.run", "Run Tool"),
      slot(56, "Choose the launch date"),
    ];
    const out = requestsOf(rows, { cap: 10 });
    const keys = out.headline
      .map((r) => r.batchKey)
      .filter(Boolean)
      .sort();
    expect(keys).toEqual([
      "request:capability.run",
      "slot-title:proposed first message",
      "slot:credential",
    ]);
    expect(out.counts.requests).toBe(4);
    // A batch of outward acts is never approvable at once.
    expect(out.headline.every((r) => r.routine === false)).toBe(true);
  });

  it("caps the headline at 5 and keeps the rest waiting, in order", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      slot(60 + i, `Distinct decision ${i}`)
    );
    const out = requestsOf(rows);
    expect(REQUESTS_HEADLINE_CAP).toBe(5);
    expect(out.headline).toHaveLength(5);
    expect(out.waiting).toHaveLength(3);
    expect([...out.headline, ...out.waiting].map((r) => r.lead.id)).toEqual(
      needsYouBuckets(rows).rows.map((r) => r.signal.id)
    );
  });

  it("follows the Inbox triage order: a P0 leads, ahead of a failure", () => {
    const failed: Row = {
      ...notification(70, 1),
      id: "notification:failed",
      notificationType: "automation.broken",
    };
    const urgent = slot(71, "Sign today", { priority: "P0" });
    const out = requestsOf([slot(72, "Later thing"), failed, urgent]);
    expect(out.headline[0]!.lead.id).toBe(urgent.id);
  });

  it("leaves the rows the pod classed out of the headline out", () => {
    const out = requestsOf([
      slot(80, "Now"),
      slot(81, "Old", { needsYouClass: "review_later", reviewLater: true }),
    ]);
    expect(out.counts.rows).toBe(1);
    expect(out.counts.outOfHeadline).toBe(1);
    expect(out.headline).toHaveLength(1);
  });
});

describe("request helpers", () => {
  it("reads the action from a cluster id, and nothing from another kind", () => {
    expect(requestActionOf(cluster(1, "capability.run", "Run Tool"))).toBe(
      "capability.run"
    );
    expect(requestActionOf(slot(1, "x"))).toBeNull();
  });
  it("calls a review, a stage gate and a criterion bookkeeping, and an ask not", () => {
    expect(isBookkeeping(review(1))).toBe(true);
    expect(
      isBookkeeping(cluster(1, "playbook.stage_gate", "Approve stage"))
    ).toBe(true);
    expect(isBookkeeping(slot(1, "Check: x", { slotKind: "criterion" }))).toBe(
      true
    );
    expect(isBookkeeping(slot(1, "Pick one"))).toBe(false);
  });
});
