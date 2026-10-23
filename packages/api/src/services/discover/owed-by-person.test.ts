/**
 * `startHere.owedByPerson` — the fold, unit level. The reads are the shared
 * `listOwedSlots` lenses (seam: `draft-asks.pglite.test.ts`).
 *
 * The live case (2026-10-22): five older sessions owed the founder something,
 * and the NEWEST — an agent draft, "CRM app: spec", three `choose` decisions
 * owed since 13:29Z — was the one he could not find. It must lead, as ONE row,
 * saying it lives under "proposed" in his Inbox.
 */

import { describe, it, expect } from "vitest";
import type { OwedSlot } from "../focus-sessions/owed-outputs.js";
import { foldOwedByPerson } from "./owed-by-person.js";

const slot = (
  sessionId: string,
  label: string,
  owedSince: string,
  extra: Partial<OwedSlot> = {}
): OwedSlot => ({
  sessionId,
  sessionGoal: `goal ${sessionId}`,
  sessionTitle: `title ${sessionId}`,
  sessionStatus: "active",
  workspaceId: null,
  projectId: null,
  label,
  kind: "decision",
  owedSince,
  ...extra,
});

const CHOOSE = { mode: "choose", options: [{ label: "A" }] } as never;
const link = (id: string) => `https://pod.example/open/${id}`;

describe("foldOwedByPerson", () => {
  const older = ["s1", "s2", "s3", "s4", "s5"].map((id, i) =>
    slot(id, `older ${id}`, `2026-10-1${i}T13:0${i}:00.000Z`, { ask: CHOOSE })
  );
  const crmSpec = [
    slot("6fbc2b5c", "Q4", "2026-10-22T13:29:58.283Z", { ask: CHOOSE }),
    slot("6fbc2b5c", "Q5", "2026-10-22T13:29:58.284Z", { ask: CHOOSE }),
    slot("6fbc2b5c", "Q8", "2026-10-22T13:29:58.284Z", { ask: CHOOSE }),
  ];

  it("the newest owed session leads, as ONE row, under the inbox it lives in", () => {
    const r = foldOwedByPerson({
      needsYou: older,
      proposed: crmSpec,
      truncated: false,
      link,
    });
    expect(r.items[0]).toMatchObject({
      sessionId: "6fbc2b5c",
      owed: 3,
      asks: 3,
      newestOwedSince: "2026-10-22T13:29:58.284Z",
      inbox: "proposed",
      link: "https://pod.example/open/6fbc2b5c",
    });
    expect(r.items[0]!.labels).toHaveLength(3);
    // Deduped per session: three slots, one row.
    expect(r.items.filter((i) => i.sessionId === "6fbc2b5c")).toHaveLength(1);
    expect(r).toMatchObject({
      count: 8,
      sessions: 6,
      countIsLowerBound: false,
      lens: "owed-by-person",
    });
    // Capped at five rows, newest first; the oldest one falls off.
    expect(r.items.map((i) => i.sessionId)).toEqual([
      "6fbc2b5c",
      "s5",
      "s4",
      "s3",
      "s2",
    ]);
  });

  it("a Needs-you session says so; a slot without an ask still counts as owed", () => {
    const r = foldOwedByPerson({
      needsYou: [slot("h1", "Mint the key", "2026-10-22T09:00:00.000Z")],
      proposed: [],
      truncated: true,
      link,
    });
    expect(r.items[0]).toMatchObject({ inbox: "needs-you", owed: 1, asks: 0 });
    expect(r.countIsLowerBound).toBe(true);
  });

  it("nothing owed is an empty list, not unavailable", () => {
    const r = foldOwedByPerson({
      needsYou: [],
      proposed: [],
      truncated: false,
      link,
    });
    expect(r).toEqual({
      count: 0,
      sessions: 0,
      countIsLowerBound: false,
      lens: "owed-by-person",
      items: [],
    });
  });
});
