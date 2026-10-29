"use client";

/**
 * The parts of a REVIEW page (page grammar: Review), shared by every receiver
 * that asks a person to judge something: a proposal (`/proposal/[id]`, the
 * Review drawer) and a key a computer asked for (`/keys/requests/[id]`).
 * Moved out of `ProposalReviewCard.tsx`, where they were private, so the key
 * request page is drawn with the same parts instead of growing its own look
 * (finding da59b051, key pages plan 447800fe §2).
 *
 *   `DisclosedMark`    — a state as ONE mark, its sentence on press;
 *   `ReviewProvenance` — who asks, for whom, where, when: one line of chips;
 *   `ReviewSection`    — the one block shape ("What it asks for");
 *   `RequesterNote`    — the requester's own words, labelled as theirs;
 *   `Outcome`          — a decided review: its status, from the vocabulary.
 *
 * The decision bar's parts are `./decision-bar.tsx`; the card header is
 * `./review-header.tsx`.
 */

import { useState, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { Check, Clock, X, type LucideIcon } from "lucide-react";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";

import type { ReviewMark, ReviewTone } from "./review-mark";

const MARK_TONE: Record<ReviewTone, string> = {
  warning: "bg-warning/10 text-warning ring-warning/25",
  primary: "bg-primary/10 text-primary ring-primary/25",
  success: "bg-success/10 text-success ring-success/25",
  default: "bg-foreground/[0.05] text-foreground/75 ring-foreground/15",
};

/**
 * A state as ONE mark: colour + icon + a few words. Its sentence is disclosed
 * on press (a popover, so it reaches touch and keyboard, not only hover) —
 * never a chip with a paragraph beside it.
 */
export function DisclosedMark({
  mark,
  icon: Icon,
}: {
  mark: ReviewMark;
  icon: LucideIcon;
}) {
  return (
    <Popover placement="bottom-start">
      <PopoverTrigger>
        <button
          type="button"
          data-review-mark={mark.label}
          aria-label={`${mark.label}: why`}
          className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium ring-1 ring-inset transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${MARK_TONE[mark.tone]}`}
        >
          <Icon aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
          {mark.label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-w-[300px] px-3 py-2">
        <p className="text-[12.5px] leading-relaxed text-foreground/80">
          {mark.sentence}
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * WHO is asking, FOR whom, WHERE and WHEN, as one line of chips (`Pill`,
 * `../object/provenance-chips`), each a door when it names an object. A part
 * the pod did not resolve is absent, never guessed and never an id.
 * `fallback` sits under the line (one "get the app" line, not one per chip).
 */
export function ReviewProvenance({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="group"
        aria-label="Who is asking"
        data-review-provenance=""
        className="flex flex-wrap items-center gap-1.5"
      >
        {children}
      </div>
      {fallback}
    </div>
  );
}

/** The one block shape of a review ("What it asks for", "What changes"). */
export function ReviewSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-3 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10"
    >
      {children}
    </section>
  );
}

/** A note past this length (or this many lines) clamps, with "Show more". */
const NOTE_CLAMP_CHARS = 220;
const NOTE_CLAMP_LINES = 3;

/**
 * The requester's own words — theirs, not the system's: labelled with who
 * wrote them, quiet, clamped to three lines.
 */
export function RequesterNote({
  who,
  text,
}: {
  who: string | null;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  const long =
    text.length > NOTE_CLAMP_CHARS ||
    text.split("\n").length > NOTE_CLAMP_LINES;
  return (
    <figure data-review-note="" className="flex flex-col gap-1">
      <figcaption className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/55">
        {who ? `Note from ${who}` : "Their note"}
      </figcaption>
      <blockquote
        className={`whitespace-pre-line border-l-2 border-foreground/10 pl-3 text-[12.5px] leading-relaxed text-foreground/65 ${
          long && !open ? "line-clamp-3" : ""
        }`}
      >
        {text}
      </blockquote>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="self-start pl-3 text-[12px] text-foreground/55 underline decoration-foreground/20 underline-offset-2 hover:text-foreground"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </figure>
  );
}

type OutcomeTone = "success" | "danger" | "muted";

/** A decided status's tone and glyph: one rule for every review. */
export function outcomeTone(status: string): {
  tone: OutcomeTone;
  icon: ReactNode;
} {
  switch (status) {
    case "approved":
    case "auto_approved":
      return {
        tone: "success",
        icon: <Check className="h-6 w-6" strokeWidth={2.2} />,
      };
    case "rejected":
    case "denied":
      return {
        tone: "danger",
        icon: <X className="h-6 w-6" strokeWidth={2.2} />,
      };
    case "expired":
      return {
        tone: "muted",
        icon: <Clock className="h-6 w-6" strokeWidth={2.2} />,
      };
    default:
      return {
        tone: "muted",
        icon: <X className="h-6 w-6" strokeWidth={2.2} />,
      };
  }
}

const OUTCOME_TONE: Record<
  OutcomeTone,
  { ring: string; bg: string; text: string }
> = {
  success: {
    ring: "ring-success/25",
    bg: "bg-success/10",
    text: "text-success",
  },
  danger: { ring: "ring-danger/25", bg: "bg-danger/10", text: "text-danger" },
  muted: {
    ring: "ring-foreground/15",
    bg: "bg-foreground/[0.05]",
    text: "text-foreground/60",
  },
};

/**
 * A decided review: its mark, its status in the vocabulary's words
 * (`resolveStatusLabel`, so "denied" reads "Rejected" like a proposal), and
 * one sentence on what that means here.
 */
export function Outcome({
  status,
  message,
}: {
  status: string;
  message: ReactNode;
}) {
  const o = outcomeTone(status);
  const tone = OUTCOME_TONE[o.tone];
  return (
    <div aria-live="polite" className="flex items-center gap-3">
      <span
        aria-hidden
        className={`flex h-10 w-10 items-center justify-center rounded-full ring-1 ring-inset ${tone.bg} ${tone.ring} ${tone.text}`}
      >
        {o.icon}
      </span>
      <div className="flex flex-col">
        <span className="text-[15px] font-medium text-foreground">
          {resolveStatusLabel(status)}
        </span>
        <span className="text-[13px] leading-relaxed text-foreground/60">
          {message}
        </span>
      </div>
    </div>
  );
}
