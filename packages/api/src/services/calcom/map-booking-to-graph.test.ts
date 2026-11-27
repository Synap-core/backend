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

// ── The booking's attribution-event (founder, 26 Nov 2026) ───────────────────
// Driven from the REAL webhook shape: Cal.com puts the booker's answers in
// `payload.responses` as `{ label, value, isHidden }` (CalEventResponses,
// packages/types/Calendar.d.ts); a hidden question named `utm_source` is how
// a booking page carries a UTM. The bookings list (v2, the backfill) answers
// with plain values in `bookingFieldsResponses`.
describe("mapBookingToGraph — attribution-event", () => {
  const RECEIVED = "2026-11-26T10:00:05.000Z";
  const withUtm: CalBookingPayload = {
    ...base,
    createdAt: "2026-11-26T10:00:00.000Z",
    eventTypeId: 42,
    bookingId: 7,
    responses: {
      name: { label: "your_name", value: "Jelle Bets", isHidden: false },
      email: { label: "email_address", value: "jelle@acme-corp.io" },
      utm_source: { label: "utm_source", value: "linkedin", isHidden: true },
      utm_medium: { label: "utm_medium", value: "social", isHidden: true },
      utm_campaign: { label: "utm_campaign", value: "launch", isHidden: true },
      utm_content: { label: "utm_content", value: "post-3", isHidden: true },
      referrer: { label: "referrer", value: "https://www.linkedin.com/" },
    },
  };

  function attributionOf(payload: CalBookingPayload) {
    const graph = mapBookingToGraph(payload, {
      attribution: { receivedAt: RECEIVED },
    });
    const attribution = graph.entities.find(
      (e) => e.profileSlug === "attribution-event"
    );
    return { graph, attribution };
  }

  it("writes ONE attribution-event, eventtype booking, from the booker's hidden UTM answers", () => {
    const { graph, attribution } = attributionOf(withUtm);
    expect(
      graph.entities.filter((e) => e.profileSlug === "attribution-event")
    ).toHaveLength(1);
    expect(attribution!.properties).toEqual({
      source: "linkedin",
      medium: "social",
      campaign: "launch",
      timestamp: "2026-11-26T10:00:00.000Z",
      eventtype: "booking",
      referrer: "https://www.linkedin.com/",
      utmparams: {
        utm_source: "linkedin",
        utm_medium: "social",
        utm_campaign: "launch",
        utm_content: "post-3",
      },
      metadata: {
        provider: "cal.com",
        calBookingUid: "bk_123",
        eventTypeId: 42,
        bookingId: 7,
      },
    });
  });

  it("links the attribution-event to the person", () => {
    const { graph, attribution } = attributionOf(withUtm);
    expect(graph.relations).toContainEqual({
      sourceRef: attribution!.ref,
      targetRef: "person",
      type: "relates_to",
    });
  });

  it("falls back to cal.com / booking / (none) with no UTM, and to the receipt time with no createdAt", () => {
    const { attribution } = attributionOf(base);
    expect(attribution!.properties).toEqual({
      source: "cal.com",
      medium: "booking",
      campaign: "(none)",
      timestamp: RECEIVED,
      eventtype: "booking",
      metadata: { provider: "cal.com", calBookingUid: "bk_123" },
    });
  });

  it("falls back field by field: a lone utm_source keeps medium and campaign defaults", () => {
    const { attribution } = attributionOf({
      ...base,
      responses: { utm_source: { label: "utm_source", value: "newsletter" } },
    });
    expect(attribution!.properties).toMatchObject({
      source: "newsletter",
      medium: "booking",
      campaign: "(none)",
      utmparams: { utm_source: "newsletter" },
    });
  });

  it("reads the bookings list's flat answers, then booking metadata", () => {
    const { attribution } = attributionOf({
      ...base,
      bookingFieldsResponses: { utm_source: "x.com", utm_medium: "" },
      metadata: { utm_medium: "organic", utm_source: "ignored" },
    });
    expect(attribution!.properties).toMatchObject({
      source: "x.com",
      medium: "organic",
      campaign: "(none)",
    });
  });

  it("reads a UTM object on the payload (bare or utm_ keys), below the booker's answers and above metadata", () => {
    const { attribution } = attributionOf({
      ...base,
      responses: { utm_source: { label: "utm_source", value: "linkedin" } },
      tracking: { source: "ignored", medium: "cpc", utm_campaign: "q4" },
      metadata: { utm_medium: "ignored", utm_term: "crm" },
    });
    expect(attribution!.properties).toMatchObject({
      source: "linkedin",
      medium: "cpc",
      campaign: "q4",
      utmparams: {
        utm_source: "linkedin",
        utm_medium: "cpc",
        utm_campaign: "q4",
        utm_term: "crm",
      },
    });
  });

  it("an empty answer is no UTM (a blank hidden field is not a source)", () => {
    const { attribution } = attributionOf({
      ...base,
      responses: { utm_source: { label: "utm_source", value: "  " } },
    });
    expect(attribution!.properties?.source).toBe("cal.com");
    expect(attribution!.properties).not.toHaveProperty("utmparams");
  });

  it("titles it by the booking uid, so two bookings never share a title (the duplicate door matches exact titles)", () => {
    const a = attributionOf(withUtm).attribution!;
    const b = attributionOf({ ...withUtm, uid: "bk_456" }).attribution!;
    expect(a.title).toContain("bk_123");
    expect(a.title).not.toBe(b.title);
  });

  it("without the option the graph is unchanged: no attribution-event, no extra edge", () => {
    const plain = mapBookingToGraph(withUtm);
    expect(
      plain.entities.some((e) => e.profileSlug === "attribution-event")
    ).toBe(false);
    expect(plain.relations.some((r) => r.type === "relates_to")).toBe(false);
  });
});
