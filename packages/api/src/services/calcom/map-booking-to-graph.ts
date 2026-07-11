/**
 * Cal.com booking → CRM graph mapper (PURE function; no I/O).
 *
 * A booked call is a LEAD. Per the CRM model (crm.md): ONE identity entity per
 * real thing, relationship state is a `deal` (never a duplicate/status entity).
 * So a BOOKING_CREATED becomes a composite graph:
 *   person(attendee, email→dedup) + company(corporate domain only)
 *   + deal(dealStage:"lead") + event(startDate/endDate/calendarLink)
 * linked person→deal and company→deal via the CRM `linked_to_deal` relation.
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

// The CRM `linked_to_deal` relation def (crmData.ts CRM_RELATION_TYPES.LINKED_TO_DEAL).
// Workspace-scoped; resolves when the proposal is scoped to the CRM workspace.
const LINKED_TO_DEAL = "linked_to_deal";

// Consumer mailbox domains — an attendee on one of these is an individual, NOT a
// company, so we do NOT mint a company entity from the email domain.
const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "aol.com",
  "zoho.com",
  "yandex.com",
  "mail.com",
]);

/** Domain part of an email, lowercased; null when absent/malformed. */
export function emailDomain(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.includes(".") ? domain : null;
}

/** A corporate domain is any real domain that isn't a known consumer mailbox. */
export function isCorporateDomain(domain: string | null): boolean {
  return !!domain && !CONSUMER_EMAIL_DOMAINS.has(domain);
}

/** "acme-corp.io" → "Acme Corp" (best-effort display name from a domain). */
export function companyNameFromDomain(domain: string): string {
  const base = domain.split(".")[0] || domain;
  return base
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

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
 * `deal` (the lead) and an `event` (the call); a `person` when we have any
 * attendee identity, and a `company` only for corporate email domains.
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

  // person — email drives global identity dedup (resolveIdentity in the door).
  entities.push({
    ref: "person",
    profileSlug: "person",
    title: name,
    properties: {
      ...(email ? { email } : {}),
      source: "cal.com",
    },
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

  // deal — the booked call IS the lead (dealStage:"lead", not a status/facet).
  entities.push({
    ref: "deal",
    profileSlug: "deal",
    title: `Intro call — ${name}`,
    properties: {
      dealStage: "lead",
      source: "cal.com",
      ...(uid ? { calBookingUid: uid } : {}),
    },
  });

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

  // relations — contact + company anchored to the lead deal (best-effort:
  // materialization keeps entities even if a relation type fails to resolve).
  relations.push({
    sourceRef: "person",
    targetRef: "deal",
    type: LINKED_TO_DEAL,
  });
  if (hasCompany) {
    relations.push({
      sourceRef: "company",
      targetRef: "deal",
      type: LINKED_TO_DEAL,
    });
  }

  return { entities, relations };
}
