import { describe, it, expect } from "vitest";
import {
  mapTranscriptToMessage,
  firefliesDateToIso,
  type FirefliesTranscript,
} from "./map-transcript-to-message.js";

// 2026-07-16T15:30:00.000Z in epoch ms.
const DATE_MS = Date.UTC(2026, 6, 16, 15, 30, 0);

const base: FirefliesTranscript = {
  id: "M1",
  title: "The Arch — Wave 1 sync",
  date: DATE_MS,
  duration: 42.6,
  meeting_link: "https://meet.google.com/abc-defg-hij",
  transcript_url: "https://app.fireflies.ai/view/M1",
  meeting_attendees: [
    { name: "Sam", email: "sam@etik.com" },
    { name: "Jelle", email: "jelle@acme-corp.io" },
  ],
  summary: {
    overview: "Discussed the ingestion pipeline.",
    action_items: "Sam to wire the webhook\nJelle to test backfill",
  },
  sentences: [
    { speaker_name: "Sam", text: "Let's map transcripts to messages." },
    { speaker_name: "Jelle", text: "Sounds good." },
  ],
};

describe("firefliesDateToIso", () => {
  it("converts epoch-ms to ISO", () => {
    expect(firefliesDateToIso(DATE_MS)).toBe("2026-07-16T15:30:00.000Z");
  });
  it("accepts a numeric string", () => {
    expect(firefliesDateToIso(String(DATE_MS))).toBe(
      "2026-07-16T15:30:00.000Z"
    );
  });
  it("returns undefined for null/empty/invalid", () => {
    expect(firefliesDateToIso(null)).toBeUndefined();
    expect(firefliesDateToIso("")).toBeUndefined();
    expect(firefliesDateToIso(0)).toBeUndefined();
    expect(firefliesDateToIso("nope")).toBeUndefined();
  });
});

describe("mapTranscriptToMessage", () => {
  it("threads meetingId, title and sentAt", () => {
    const m = mapTranscriptToMessage(base, "M1");
    expect(m.meetingId).toBe("M1");
    expect(m.title).toBe("The Arch — Wave 1 sync");
    expect(m.sentAt).toBe("2026-07-16T15:30:00.000Z");
  });

  it("dedupes participants and picks a primary with an email", () => {
    const dup: FirefliesTranscript = {
      ...base,
      meeting_attendees: [
        { name: "Sam", email: "sam@etik.com" },
        { name: "Sam", email: "sam@etik.com" }, // exact dup
        { name: "NoEmail" },
      ],
    };
    const m = mapTranscriptToMessage(dup, "M1");
    expect(m.participants).toEqual([
      { name: "Sam", email: "sam@etik.com" },
      { name: "NoEmail" },
    ]);
    expect(m.primaryParticipant).toEqual({
      name: "Sam",
      email: "sam@etik.com",
    });
  });

  it("builds a header + summary + action items + transcript body", () => {
    const m = mapTranscriptToMessage(base, "M1");
    expect(m.text).toContain("Meeting: The Arch — Wave 1 sync");
    expect(m.text).toContain("Date: 2026-07-16T15:30:00.000Z");
    expect(m.text).toContain("Duration: 43 min");
    expect(m.text).toContain("Sam <sam@etik.com>");
    expect(m.text).toContain("Link: https://meet.google.com/abc-defg-hij");
    expect(m.text).toContain("Summary:\nDiscussed the ingestion pipeline.");
    expect(m.text).toContain("Action items:\nSam to wire the webhook");
    expect(m.text).toContain("Sam: Let's map transcripts to messages.");
    expect(m.text).toContain("Jelle: Sounds good.");
  });

  it("is defensive against a null transcript and missing fields", () => {
    const m = mapTranscriptToMessage(null, "M9");
    expect(m.meetingId).toBe("M9");
    expect(m.title).toBe("Untitled meeting");
    expect(m.sentAt).toBeUndefined();
    expect(m.participants).toEqual([]);
    expect(m.primaryParticipant).toBeUndefined();
    expect(m.text).toBe("Meeting: Untitled meeting");
  });

  it("omits empty transcript lines and speakerless prefixes", () => {
    const t: FirefliesTranscript = {
      id: "M2",
      title: "Quick",
      sentences: [
        { speaker_name: "", text: "anonymous line" },
        { speaker_name: "A", text: "   " }, // whitespace-only → dropped
        { speaker_name: "B", text: "real" },
      ],
      meeting_attendees: [],
    };
    const m = mapTranscriptToMessage(t, "M2");
    expect(m.text).toContain("Transcript:\nanonymous line\nB: real");
    expect(m.text).not.toContain("A:");
  });
});
