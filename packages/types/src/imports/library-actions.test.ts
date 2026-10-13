import { describe, it, expect } from "vitest";
import {
  carryRunLibraryActions,
  detectLibraryActions,
  libraryActionLabel,
  mergeLibraryActions,
  normalizeLibraryActions,
  parseLibraryAmount,
} from "./library-actions.js";

const NOW = new Date("2026-10-13T09:00:00.000Z");
const kinds = (a: Array<{ kind: string }>) => a.map((x) => x.kind);

describe("detectLibraryActions — dates", () => {
  it("an appointment with a time is a calendar chip", () => {
    const [a] = detectLibraryActions({
      title: "Dentist",
      text: "Your appointment is confirmed for 14 November 2026 at 3:30 pm.",
      now: NOW,
    });
    expect(a).toMatchObject({
      kind: "date",
      source: "rule",
      value: { date: "2026-11-14", time: "15:30", title: "Dentist" },
      label: "Add 14 Nov to calendar",
    });
    expect(a!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("a year-less date that already passed this year is next year's", () => {
    const [a] = detectLibraryActions({
      text: "Team meeting on March 3 at 10:00",
      now: NOW,
    });
    expect(a?.value.date).toBe("2027-03-03");
  });

  it("a past date, or a bare date with no event word or time, is no chip", () => {
    expect(
      detectLibraryActions({
        text: "Meeting held on 2025-01-05 at 10:00",
        now: NOW,
      })
    ).toEqual([]);
    expect(
      detectLibraryActions({
        text: "Published 2026-12-01 by the editors",
        now: NOW,
      })
    ).toEqual([]);
  });

  it("reads French and ISO dates", () => {
    const fr = detectLibraryActions({
      text: "Rendez-vous le 2 décembre à 14h30",
      now: NOW,
    });
    expect(fr[0]?.value).toMatchObject({ date: "2026-12-02", time: "14:30" });
    const isoHit = detectLibraryActions({
      text: "Webinar 2026-11-20T18:00",
      now: NOW,
    });
    expect(isoHit[0]?.value).toMatchObject({
      date: "2026-11-20",
      time: "18:00",
    });
  });
});

describe("detectLibraryActions — receipts", () => {
  it("takes the TOTAL line, the currency and the merchant", () => {
    const [a] = detectLibraryActions({
      title: "Your receipt from Monoprix",
      text: "Subtotal €40.00\nTotal €42.50\nPaid by card on 2026-10-01",
      now: NOW,
    }).filter((x) => x.kind === "receipt");
    expect(a?.value).toEqual({
      amount: 42.5,
      currency: "EUR",
      merchant: "Monoprix",
      date: "2026-10-01",
    });
    expect(a?.label).toBe("Keep receipt · 42.50 EUR · Monoprix");
  });

  it("an amount with no receipt word is no receipt", () => {
    expect(
      kinds(
        detectLibraryActions({
          text: "The phone costs $999 in the US.",
          now: NOW,
        })
      )
    ).not.toContain("receipt");
  });

  it("parses European and US amounts", () => {
    expect(parseLibraryAmount("1.234,56")).toBe(1234.56);
    expect(parseLibraryAmount("1,234.56")).toBe(1234.56);
    expect(parseLibraryAmount("12,50")).toBe(12.5);
    expect(parseLibraryAmount("1 200")).toBe(1200);
  });
});

describe("detectLibraryActions — contacts", () => {
  it("an email with its name and a nearby phone is ONE contact", () => {
    const got = detectLibraryActions({
      text: "Reach Ada Lovelace <ada@analytical.org>, mobile +44 20 7946 0958.",
      now: NOW,
    }).filter((a) => a.kind === "contact");
    expect(got).toHaveLength(1);
    expect(got[0]!.value).toEqual({
      email: "ada@analytical.org",
      name: "Ada Lovelace",
      phone: "+44 20 7946 0958",
    });
  });

  it("robot senders and order numbers are not contacts", () => {
    expect(
      kinds(
        detectLibraryActions({
          text: "From no-reply@shop.com. Order 123456789012 shipped.",
          now: NOW,
        })
      )
    ).not.toContain("contact");
  });
});

describe("detectLibraryActions — tasks", () => {
  it("checkbox and todo lines, and 'I need to' phrases", () => {
    const got = detectLibraryActions({
      text: "- [ ] renew passport by 2026-12-01\nTODO: call the bank\nI need to book the venue.",
      now: NOW,
    }).filter((a) => a.kind === "task");
    expect(got.map((a) => a.value.title)).toEqual([
      "Renew passport by 2026-12-01",
      "Call the bank",
      "Book the venue",
    ]);
    expect(got[0]!.value.dueDate).toBe("2026-12-01");
  });
});

describe("ids, merge and AI normalisation", () => {
  it("the same chip keeps the same id across reads", () => {
    const input = { text: "TODO: call the bank", now: NOW };
    expect(detectLibraryActions(input)[0]!.id).toBe(
      detectLibraryActions(input)[0]!.id
    );
  });

  it("an AI suggestion that repeats a rule hit is dropped; caps hold", () => {
    const rule = detectLibraryActions({
      text: "TODO: call the bank",
      now: NOW,
    });
    const ai = normalizeLibraryActions([
      { kind: "task", value: { title: "call the bank" }, confidence: 0.9 },
      { kind: "task", value: { title: "Pay rent" }, confidence: 0.7 },
      { kind: "date", value: { date: "not a date" } },
      { kind: "expense", value: { amount: 3 } },
      { kind: "contact", value: { name: "Nobody" } },
    ]);
    expect(ai.map((a) => a.value.title ?? a.kind)).toEqual([
      "Call the bank",
      "Pay rent",
    ]);
    const merged = mergeLibraryActions(rule, ai);
    expect(merged.map((a) => [a.source, a.value.title])).toEqual([
      ["rule", "Call the bank"],
      ["ai", "Pay rent"],
    ]);
  });

  it("a chip that was run survives a re-read with its proposal", () => {
    const [first] = detectLibraryActions({
      text: "TODO: call the bank",
      now: NOW,
    });
    const run = { ...first!, proposalId: "p-1" };
    const again = carryRunLibraryActions(
      [run],
      detectLibraryActions({ text: "TODO: call the bank", now: NOW })
    );
    expect(again).toEqual([run]);
    // And when the re-read no longer finds it, it is still listed.
    expect(carryRunLibraryActions([run], [])).toEqual([run]);
  });

  it("labels come from the value", () => {
    expect(libraryActionLabel("contact", { phone: "+33 6 12 34 56 78" })).toBe(
      "Save contact · +33 6 12 34 56 78"
    );
    expect(libraryActionLabel("date", {})).toBe("Add to calendar");
  });
});
