/**
 * Cal.com booking → CRM graph mapper (PURE function; no I/O).
 *
 * A booked call is a LEAD, not a deal (W15, 2026-10-11): a deal is created only
 * at hand-off, when a lead is won. So a BOOKING_CREATED becomes:
 *   person(attendee, email→identity) wearing the `lead` role at
 *   `leadStage: engaged` + company(corporate domain only, person `works_at` it)
 *   + event(startDate/endDate/calendarLink) `attended_by` the person, so the
 *   call sits on the lead's agenda.
 *
 * The lead role is attached with `advanceExisting`: a person who is not a lead
 * yet becomes one at `engaged`; a lead at an earlier stage (new, researching,
 * outreach) moves forward through the facet door; a lead already at or past
 * `engaged` (qualified, nurturing, converted, disqualified) keeps its stage —
 * the booking then only records the event.
 *
 * The `event` entity is shaped for event-sync's `normalizeEntity`
 * (startDate/endDate/calendarLink) so the same booking mirrors to a native
 * Discord scheduled event with NO dependency on Google Calendar.
 *
 * Output plugs straight into `submitCaptureGraph({ entities, relations })` — the
 * shared `/api/hub/capture/graph` door (within-batch dedup + email identity
 * resolution live there; we do NOT hand-roll an entity writer).
 */

import type {
  CaptureGraphEntity,
  CaptureGraphRelation,
} from "../../routers/hub-protocol/rest/_capture-graph-dedup.js";
import {
  emailDomain,
  isCorporateDomain,
  companyNameFromDomain,
} from "../../utils/email-domain.js";
import {
  RELATION_ATTENDED_BY,
  RELATION_WORKS_AT,
} from "../event-sync/sync-graph.js";

// ── Cal.com webhook / bookings-list payload (fields we consume) ────────────────
export interface CalBookingPayload {
  uid?: string;
  title?: string;
  /** RFC3339 — webhook uses startTime/endTime; the bookings list uses start/end. */
  startTime?: string;
  endTime?: string;
  start?: string;
  end?: string;
  location?: string;
  status?: string;
  /** Meet/video link when the booking is a video call. */
  videoCallData?: { url?: string } | null;
  meetingUrl?: string;
  attendees?: Array<{
    name?: string;
    email?: string;
    timeZone?: string;
  }> | null;
}

export interface BookingGraph {
  entities: CaptureGraphEntity[];
  relations: CaptureGraphRelation[];
}

/** The lead role and the stage a booked call puts it at (foundation `leadStage`). */
export const BOOKING_LEAD_ROLE = "lead";
export const BOOKING_LEAD_STAGE = "engaged";

/** Prefer the explicit video link, else a location that is itself a URL. */
export function meetLink(payload: CalBookingPayload): string | undefined {
  const v = payload.videoCallData?.url?.trim();
  if (v) return v;
  if (payload.meetingUrl?.trim()) return payload.meetingUrl.trim();
  const loc = payload.location?.trim();
  if (loc && /^https?:\/\//i.test(loc)) return loc;
  return undefined;
}

/**
 * Map ONE Cal.com booking to a CRM graph. Deterministic + pure. Always yields a
 * `person` wearing the `lead` role and an `event` (the call); a `company` only
 * for corporate email domains. Never a `deal`.
 */
export function mapBookingToGraph(payload: CalBookingPayload): BookingGraph {
  const attendee = (payload.attendees ?? [])[0] ?? {};
  const email = attendee.email?.trim() || undefined;
  const name =
    attendee.name?.trim() ||
    (email ? email.split("@")[0] : "") ||
    "Unknown contact";

  const startDate = (payload.startTime ?? payload.start)?.trim() || undefined;
  const endDate = (payload.endTime ?? payload.end)?.trim() || undefined;
  const calendarLink = meetLink(payload);
  const uid = payload.uid?.trim() || undefined;
  const physicalLocation =
    payload.location && !/^https?:\/\//i.test(payload.location)
      ? payload.location.trim()
      : undefined;

  const entities: CaptureGraphEntity[] = [];
  const relations: CaptureGraphRelation[] = [];

  // person — email drives global identity dedup (resolveIdentity in the door);
  // the lead role rides on it (attach, or move forward only).
  entities.push({
    ref: "person",
    profileSlug: "person",
    title: name,
    properties: {
      ...(email ? { email } : {}),
      source: "cal.com",
    },
    facets: [
      {
        profileSlug: BOOKING_LEAD_ROLE,
        status: BOOKING_LEAD_STAGE,
        properties: { leadStage: BOOKING_LEAD_STAGE },
        advanceExisting: true,
      },
    ],
  });

  // company — only for a corporate email domain (website drives its dedup).
  const domain = emailDomain(email);
  const hasCompany = isCorporateDomain(domain);
  if (hasCompany && domain) {
    entities.push({
      ref: "company",
      profileSlug: "company",
      title: companyNameFromDomain(domain),
      properties: {
        website: `https://${domain}`,
        source: "cal.com",
      },
    });
  }

  // event — the call itself; shaped for event-sync (startDate/endDate/calendarLink).
  entities.push({
    ref: "event",
    profileSlug: "event",
    title: payload.title?.trim() || `Call with ${name}`,
    properties: {
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(calendarLink ? { calendarLink } : {}),
      ...(physicalLocation ? { location: physicalLocation } : {}),
      source: "cal.com",
      ...(uid ? { calBookingUid: uid } : {}),
    },
  });

  // relations — the call is attended by the person (the lead's agenda), and
  // the person works at the company (best-effort: materialization keeps
  // entities even if a relation type fails to resolve).
  relations.push({
    sourceRef: "event",
    targetRef: "person",
    type: RELATION_ATTENDED_BY,
  });
  if (hasCompany) {
    relations.push({
      sourceRef: "person",
      targetRef: "company",
      type: RELATION_WORKS_AT,
    });
  }

  return { entities, relations };
}
