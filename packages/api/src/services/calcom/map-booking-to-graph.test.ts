import { describe, it, expect } from "vitest";
import {
  mapBookingToGraph,
  meetLink,
  type CalBookingPayload,
} from "./map-booking-to-graph.js";
import {
  emailDomain,
  isCorporateDomain,
  companyNameFromDomain,
} from "../../utils/email-domain.js";

const base: CalBookingPayload = {
  uid: "bk_123",
  title: "Meet The Arch",
  startTime: "2026-07-16T15:30:00Z",
  endTime: "2026-07-16T16:15:00Z",
  videoCallData: { url: "https://meet.google.com/abc-defg-hij" },
  attendees: [{ name: "Jelle Bets", email: "jelle@acme-corp.io" }],
};

describe("helpers", () => {
  it("extracts + validates email domains", () => {
    expect(emailDomain("jelle@acme-corp.io")).toBe("acme-corp.io");
    expect(emailDomain("no-at-sign")).toBeNull();
    expect(emailDomain(undefined)).toBeNull();
  });

  it("treats consumer mailboxes as non-corporate", () => {
    expect(isCorporateDomain("acme-corp.io")).toBe(true);
    expect(isCorporateDomain("gmail.com")).toBe(false);
    expect(isCorporateDomain(null)).toBe(false);
  });

  it("derives a display name from a domain", () => {
    expect(companyNameFromDomain("acme-corp.io")).toBe("Acme Corp");
    expect(companyNameFromDomain("weexbusiness.com")).toBe("Weexbusiness");
  });

  it("prefers the video link, then a URL location", () => {
    expect(meetLink(base)).toBe("https://meet.google.com/abc-defg-hij");
    expect(meetLink({ location: "https://zoom.us/j/999" })).toBe(
      "https://zoom.us/j/999"
    );
    expect(meetLink({ location: "Paris office" })).toBeUndefined();
  });
});

describe("mapBookingToGraph — corporate attendee", () => {
  const { entities, relations } = mapBookingToGraph(base);
  const byRef = Object.fromEntries(entities.map((e) => [e.ref, e]));

  it("creates person + company + event — never a deal (W15)", () => {
    expect(entities.map((e) => e.profileSlug).sort()).toEqual([
      "company",
      "event",
      "person",
    ]);
  });

  it("puts the attendee email on the person (drives dedup)", () => {
    expect(byRef.person.title).toBe("Jelle Bets");
    expect(byRef.person.properties?.email).toBe("jelle@acme-corp.io");
  });

  it("mints the company from the corporate domain with a website (dedup key)", () => {
    expect(byRef.company.title).toBe("Acme Corp");
    expect(byRef.company.properties?.website).toBe("https://acme-corp.io");
  });

  it("makes the attendee a lead at leadStage 'engaged', forward-only", () => {
    expect(byRef.person.facets).toEqual([
      {
        profileSlug: "lead",
        status: "engaged",
        properties: { leadStage: "engaged" },
        advanceExisting: true,
      },
    ]);
    expect(byRef.company.facets).toBeUndefined();
  });

  it("shapes the event for event-sync (startDate/endDate/calendarLink)", () => {
    expect(byRef.event.properties?.startDate).toBe("2026-07-16T15:30:00Z");
    expect(byRef.event.properties?.endDate).toBe("2026-07-16T16:15:00Z");
    expect(byRef.event.properties?.calendarLink).toBe(
      "https://meet.google.com/abc-defg-hij"
    );
    expect(byRef.event.properties?.calBookingUid).toBe("bk_123");
  });

  it("puts the call on the person (attended_by) and the person at the company (works_at)", () => {
    expect(relations).toEqual([
      { sourceRef: "event", targetRef: "person", type: "attended_by" },
      { sourceRef: "person", targetRef: "company", type: "works_at" },
    ]);
  });

  it("emits no placeholder/summary entities", () => {
    expect(
      entities.some((e) =>
        ["note", "summary", "document"].includes(e.profileSlug)
      )
    ).toBe(false);
  });
});

describe("mapBookingToGraph — consumer attendee (gmail)", () => {
  const { entities, relations } = mapBookingToGraph({
    ...base,
    attendees: [{ name: "Sam Doe", email: "sam@gmail.com" }],
  });
  const refs = entities.map((e) => e.ref);

  it("does NOT mint a company for a consumer mailbox", () => {
    expect(refs).not.toContain("company");
    expect(refs.sort()).toEqual(["event", "person"]);
  });

  it("still links the call to the person (only)", () => {
    expect(relations).toEqual([
      { sourceRef: "event", targetRef: "person", type: "attended_by" },
    ]);
  });
});

describe("mapBookingToGraph — degenerate payloads", () => {
  it("falls back to an email local-part when no name is given", () => {
    const { entities } = mapBookingToGraph({
      attendees: [{ email: "founder@startup.xyz" }],
    });
    const person = entities.find((e) => e.ref === "person")!;
    expect(person.title).toBe("founder");
  });

  it("still yields a person + event (and no deal) with no attendee at all", () => {
    const { entities } = mapBookingToGraph({
      uid: "x",
      startTime: "2026-01-01T00:00:00Z",
    });
    const refs = entities.map((e) => e.ref);
    expect(refs).not.toContain("deal");
    expect(refs).toContain("event");
    expect(refs).toContain("person"); // "Unknown contact" fallback
  });

  it("omits calendarLink/startDate cleanly when absent", () => {
    const { entities } = mapBookingToGraph({
      attendees: [{ name: "No Times" }],
    });
    const event = entities.find((e) => e.ref === "event")!;
    expect(event.properties?.startDate).toBeUndefined();
    expect(event.properties?.calendarLink).toBeUndefined();
  });
});
