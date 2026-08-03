/**
 * Fireflies transcript → inbound-message mapper (PURE function; no I/O).
 *
 * A completed Fireflies meeting is NOT a new entity kind — per Wave 1 of The Arch
 * it lands in the pod's channel/message substrate as ONE channel MESSAGE (so the
 * AI can query it via getThreadContext). This function turns the GraphQL
 * `transcript` object (fetched by the `fireflies_get_transcript` declarative verb)
 * into the exact shape `recordInboundMessage` consumes — a header + the full
 * transcript body as text, plus the participant/identity binding.
 *
 * Deterministic + pure (mirrors calcom/map-booking-to-graph.ts): all fetch,
 * dedup, channel-resolve and side-effects live in the caller (run-fireflies-ingest
 * + the shared inbound-recorder), never here.
 */

// ── Fireflies GraphQL `transcript` shape (fields we consume) ───────────────────
export interface FirefliesAttendee {
  name?: string | null;
  email?: string | null;
  displayName?: string | null;
}

export interface FirefliesSentence {
  speaker_name?: string | null;
  text?: string | null;
}

export interface FirefliesTranscript {
  id?: string | null;
  title?: string | null;
  /** Fireflies `date` is a Unix epoch in MILLISECONDS (number). */
  date?: number | string | null;
  /** Duration in minutes (float). */
  duration?: number | string | null;
  meeting_link?: string | null;
  transcript_url?: string | null;
  meeting_attendees?: FirefliesAttendee[] | null;
  summary?: {
    overview?: string | null;
    action_items?: string | null;
    keywords?: string[] | string | null;
  } | null;
  sentences?: FirefliesSentence[] | null;
}

export interface MappedTranscriptMessage {
  meetingId: string;
  title: string;
  /** ISO timestamp derived from the Fireflies epoch-ms `date`, when present. */
  sentAt?: string;
  /** De-duped attendees with at least a name or an email. */
  participants: { name: string; email?: string }[];
  /** The external contact this thread should bind to (first attendee w/ an email). */
  primaryParticipant?: { name: string; email?: string };
  /** Header + full transcript body — the message content stored on the channel. */
  text: string;
}

/** Fireflies epoch-ms → ISO string; null/NaN/out-of-range → undefined. */
export function firefliesDateToIso(
  date: number | string | null | undefined
): string | undefined {
  if (date === null || date === undefined || date === "") return undefined;
  const ms = Number(date);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  const iso = d.toISOString();
  return Number.isNaN(d.getTime()) ? undefined : iso;
}

/**
 * Map ONE Fireflies transcript to an inbound-message shape.
 *
 * `meetingId` is threaded explicitly (the webhook keys everything on it) so the
 * mapping never depends on the transcript object echoing its own id.
 */
export function mapTranscriptToMessage(
  transcript: FirefliesTranscript | null | undefined,
  meetingId: string
): MappedTranscriptMessage {
  const t = transcript ?? {};
  const title = String(t.title ?? "").trim() || "Untitled meeting";
  const sentAt = firefliesDateToIso(t.date);

  // Attendees → deduped participants (email first, then lowercased name).
  const rawAttendees = Array.isArray(t.meeting_attendees)
    ? t.meeting_attendees
    : [];
  const participants: { name: string; email?: string }[] = [];
  const seen = new Set<string>();
  for (const a of rawAttendees) {
    const email = (a?.email ?? "").toString().trim();
    const name =
      (a?.name ?? "").toString().trim() ||
      (a?.displayName ?? "").toString().trim() ||
      (email ? email.split("@")[0]! : "");
    if (!email && !name) continue;
    const key = (email || name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    participants.push(email ? { name: name || email, email } : { name });
  }
  const primaryParticipant =
    participants.find((p) => p.email) ?? participants[0];

  // ── Compose the message body: a compact header, then the transcript. ─────────
  const summary = t.summary ?? {};
  const overview = String(summary.overview ?? "").trim();
  const actionItems = String(summary.action_items ?? "").trim();

  const durationNum = Number(t.duration);
  const header: string[] = [`Meeting: ${title}`];
  if (sentAt) header.push(`Date: ${sentAt}`);
  if (Number.isFinite(durationNum) && durationNum > 0)
    header.push(`Duration: ${Math.round(durationNum)} min`);
  if (participants.length)
    header.push(
      `Participants: ${participants
        .map((p) => (p.email ? `${p.name} <${p.email}>` : p.name))
        .join(", ")}`
    );
  const meetingLink = String(t.meeting_link ?? "").trim();
  if (meetingLink) header.push(`Link: ${meetingLink}`);
  const transcriptUrl = String(t.transcript_url ?? "").trim();
  if (transcriptUrl) header.push(`Transcript: ${transcriptUrl}`);

  const sentences = Array.isArray(t.sentences) ? t.sentences : [];
  const body = sentences
    .map((s) => {
      const speaker = String(s?.speaker_name ?? "").trim();
      const line = String(s?.text ?? "").trim();
      if (!line) return "";
      return speaker ? `${speaker}: ${line}` : line;
    })
    .filter(Boolean)
    .join("\n");

  const parts: string[] = [header.join("\n")];
  if (overview) parts.push(`Summary:\n${overview}`);
  if (actionItems) parts.push(`Action items:\n${actionItems}`);
  if (body) parts.push(`Transcript:\n${body}`);

  return {
    meetingId,
    title,
    sentAt,
    participants,
    primaryParticipant,
    text: parts.join("\n\n"),
  };
}
