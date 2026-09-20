/**
 * A focus session's DISPLAY NAME — ONE resolver, platform-wide.
 *
 * A session carries two texts that answer different questions:
 *   - `title` — the short, optional one-line NAME ("Billing launch").
 *   - `goal`  — the OUTCOME, which may be a paragraph.
 *
 * Every list, card, tab and breadcrumb shows the title when there is one and
 * otherwise the goal's first line, clipped. Relay and the browser both render
 * sessions, so a per-surface copy of this rule is a fork the moment it exists —
 * the same reason `statuses.ts` lives here. Pure; its only import is the
 * package's own entity decoder.
 */

import { decodeHtmlEntities } from "../text/html-entities.js";

/** Stored bound of `focus_sessions.title` (varchar). Doors refuse longer. */
export const SESSION_TITLE_MAX = 200;

/** Default clip for the goal fallback — a list row, not a paragraph. */
export const SESSION_TITLE_FALLBACK_MAX = 80;

/** Collapse every whitespace run (newlines included) to one space, trimmed. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Canonical form of a caller-supplied title: HTML entities decoded (agents
 * sometimes XML-escape tool arguments, so `A &amp; B` must store as `A & B`),
 * one line, trimmed, and `null` when nothing is left. Every door that writes a
 * session title calls this, so the decode happens once. Does NOT clip — a title
 * over {@link SESSION_TITLE_MAX} is the door's to refuse, never silently
 * shortened. `goal` is NOT decoded here: it is the outcome text, not the name.
 */
export function normalizeSessionTitle(
  title: string | null | undefined
): string | null {
  if (typeof title !== "string") return null;
  const line = oneLine(decodeHtmlEntities(title));
  return line.length > 0 ? line : null;
}

/** Clip at a word boundary, ending in an ellipsis. */
function clip(line: string, max: number): string {
  if (line.length <= max) return line;
  let cut = line.slice(0, Math.max(1, max - 1));
  const lastSpace = cut.lastIndexOf(" ");
  // Only back off to a word boundary when it keeps most of the budget; a single
  // very long first word is cut mid-word rather than reduced to nothing.
  if (lastSpace >= Math.floor(max / 2)) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/**
 * The name to show for a session: the trimmed `title` when non-empty, else the
 * goal's first non-empty line clipped to `maxLength` at a word boundary.
 * Returns `""` only when both are empty — the surface owns its empty copy.
 */
export function resolveSessionTitle(
  session: { title?: string | null; goal?: string | null },
  opts: { maxLength?: number } = {}
): string {
  const title = normalizeSessionTitle(session.title);
  if (title) return title;
  const max = opts.maxLength ?? SESSION_TITLE_FALLBACK_MAX;
  const firstLine =
    (session.goal ?? "")
      .split(/\r?\n/)
      .map(oneLine)
      .find((l) => l.length > 0) ?? "";
  return clip(firstLine, max);
}

// ── Title provenance + derived names ────────────────────────────────────────
//
// WHO wrote a session's title decides whether automation may replace it. A
// title a person or the working agent chose is never overwritten; a name the
// pod derived from its creator (a run's playbook, a capture's first line) or
// generated in the background may be improved later. Stored at
// `focus_sessions.metadata.titleSource`.

export const SESSION_TITLE_SOURCES = [
  "human",
  "agent",
  "generated",
  "derived",
] as const;
export type SessionTitleSource = (typeof SESSION_TITLE_SOURCES)[number];

/** Bound for a generated or derived name — a list row, not a sentence. */
export const GENERATED_TITLE_MAX = 60;

/**
 * The stored provenance, or — for rows written before it existed — the
 * safe reading: an untitled row was never named by anyone (`derived`), a
 * titled one was named by whoever created it (`agent`), so it is kept.
 */
export function readTitleSource(session: {
  title?: string | null;
  metadata?: unknown;
}): SessionTitleSource {
  const stored = (session.metadata as { titleSource?: unknown } | null)
    ?.titleSource;
  if (
    typeof stored === "string" &&
    (SESSION_TITLE_SOURCES as readonly string[]).includes(stored)
  ) {
    return stored as SessionTitleSource;
  }
  return normalizeSessionTitle(session.title) ? "agent" : "derived";
}

/** True when automation may (re)name this session. */
export function canAutoRetitle(session: {
  title?: string | null;
  metadata?: unknown;
}): boolean {
  const source = readTitleSource(session);
  return source === "generated" || source === "derived";
}

/** A bare id: 8+ hex chars with at least one digit (a uuid or its short form). */
const UUID_RE = /\b(?=[0-9a-f-]*\d)[0-9a-f]{8,}(?:-[0-9a-f]{4,})*\b/gi;
/** Graph-edge notation left behind once ids are gone (`--references-->`). */
const EDGE_RE = /-{1,2}[a-z_]*-{1,2}>/gi;
const URL_RE = /\bhttps?:\/\/\S+/gi;

/** A URL as a readable label: its host, never its query string. */
function urlLabel(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Clean a model-generated title: drop reasoning blocks, wrapping quotes and
 * trailing punctuation; one line; bounded. Returns `null` when nothing
 * usable is left or the model answered with an id or a link — the caller
 * keeps the name it already has rather than store a worse one.
 */
export function sanitizeGeneratedTitle(
  raw: string | null | undefined
): string | null {
  if (typeof raw !== "string") return null;
  let line = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<\/?think>/gi, " ")
    .split(/\r?\n/)
    .map(oneLine)
    .find((l) => l.length > 0);
  if (!line) return null;
  line = line
    .replace(/^(title|name)\s*:\s*/i, "")
    .replace(/^["'“”‘’`*_#\s]+|["'“”‘’`*_\s]+$/g, "")
    .replace(/[.!?;:,]+$/, "")
    .trim();
  if (!line) return null;
  URL_RE.lastIndex = 0;
  UUID_RE.lastIndex = 0;
  if (URL_RE.test(line) || UUID_RE.test(line)) return null;
  return clip(line, GENERATED_TITLE_MAX);
}

/**
 * Markdown BLOCK syntax a captured first line carries when its source was a
 * document: a heading's `#`, a blockquote's `>`. Anchored at the START only —
 * mid-string, `#` is a person's own word ("#1 priority", a hashtag) and `>` is
 * a comparison, so a loose match would eat their text.
 *
 * Live on 2026-09-20 a session on the pod was named
 * "## Design Philosophy: The Spine and the Flow". The GENERATED path already
 * stripped these ({@link sanitizeGeneratedTitle} trims `#`/`*`/`_`/backticks at
 * both edges); the DERIVED path did not, so the same text read as prose when a
 * model named it and as raw markup when the pod did.
 */
const MD_BLOCK_RE = /^(?:\s*(?:#{1,6}|>)\s*)+/;
/** Emphasis wrapping the whole label (`**Bold thing**`, `_note_`, `` `x` ``). */
const MD_EDGE_RE = /^[*_`]+|[*_`]+$/g;

/** Strip links (kept as their host) and bare ids from a derived label. */
function readableLabel(label: string | null | undefined): string {
  const line =
    (label ?? "")
      .split(/\r?\n/)
      .map(oneLine)
      .find((l) => l.length > 0) ?? "";
  const withoutLinks = line.replace(URL_RE, (url) => {
    const host = urlLabel(url);
    return host ? `Link from ${host}` : "";
  });
  return oneLine(
    withoutLinks
      .replace(UUID_RE, "")
      .replace(EDGE_RE, "")
      .replace(/(["'“”])\s*\1/g, "")
      .replace(MD_BLOCK_RE, "")
      .replace(MD_EDGE_RE, "")
  ).replace(/^[\s·:,-]+|[\s·:,-]+$/g, "");
}

/**
 * The MACHINE VERB a creator already wrote into the text this builder is about
 * to name from, by kind. Stripped so the name is the CONTENT, never a second
 * copy of the verb.
 *
 * Live on 2026-09-20: 12 of 50 sessions carried a derived title byte-identical
 * to their own goal, because intake stores `goal` as `Capture · <content>` and
 * the backfill passed that whole string as the capture's label — so the "name"
 * added nothing a reader did not already have. The `Enrich `/`Import ` forms
 * are the same hazard one step earlier: this builder PREPENDS those verbs, so a
 * label that already carries one would read "Enrich Enrich the dossier".
 *
 * Matched case-sensitively and anchored, because these are the exact strings
 * the creators write — a loose match would eat a person's own words ("Import
 * duties", "Capture the flag").
 */
const DERIVED_LABEL_PREFIX = {
  capture: /^Capture\s*·\s*/,
  enrich: /^Enrich\s+/,
  import: /^Import\s+/,
} as const;

export type DerivedSessionTitleInput =
  /** A playbook or automation execution, optionally about one subject. */
  | { kind: "run"; name: string; subject?: string | null }
  /** Intake: the captured content's own label (an entity title, a first line, a URL). */
  | { kind: "capture"; label: string | null | undefined }
  /** Enrichment / import of one object, named by that object. */
  | { kind: "enrich" | "import"; label: string | null | undefined }
  /** An agent's writes packaged without a session: what it was doing, else who. */
  | { kind: "receipt"; doing?: string | null; agentLabel?: string | null };

/**
 * The ONE builder for names the pod derives at creation. Every creator that
 * is not given a title by a person or agent calls this, so a run, a capture
 * and a receipt are named by the same rules: human words, no ids, no raw
 * links, bounded. Stored with `titleSource: "derived"`, so the background
 * titler may improve it later.
 */
export function buildDerivedSessionTitle(
  input: DerivedSessionTitleInput
): string {
  switch (input.kind) {
    case "run": {
      const base = readableLabel(input.name) || "Playbook run";
      const subject = readableLabel(input.subject);
      return clip(subject ? `${base} · ${subject}` : base, GENERATED_TITLE_MAX);
    }
    case "capture": {
      const label = readableLabel(input.label)
        .replace(DERIVED_LABEL_PREFIX.capture, "")
        .trim();
      return clip(label || "Capture", GENERATED_TITLE_MAX);
    }
    case "enrich":
    case "import": {
      const verb = input.kind === "enrich" ? "Enrich" : "Import";
      const label = readableLabel(input.label)
        .replace(DERIVED_LABEL_PREFIX[input.kind], "")
        .trim();
      return clip(label ? `${verb} ${label}` : verb, GENERATED_TITLE_MAX);
    }
    case "receipt": {
      const doing = readableLabel(input.doing);
      if (doing) return clip(doing, GENERATED_TITLE_MAX);
      const agent = readableLabel(input.agentLabel);
      return clip(
        agent ? `Changes by ${agent}` : "Agent changes",
        GENERATED_TITLE_MAX
      );
    }
  }
}

/**
 * The `metadata` patch a door merges when a PERSON or the WORKING AGENT writes
 * a session's title — so the background titler never replaces it. A door that
 * CLEARS the title passes `"derived"` to hand the name back to automation.
 * Merge it (JSONB `||`), never assign it over `metadata`.
 */
export function titleSourcePatch(source: "human" | "agent" | "derived"): {
  titleSource: SessionTitleSource;
} {
  return { titleSource: source };
}
