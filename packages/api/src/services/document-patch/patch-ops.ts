/**
 * DOCUMENT PATCH OPS — the pure half of `applyDocumentPatch`: render a list of
 * ops against a document's markdown and enforce the floors, with no database,
 * storage or governance in sight.
 *
 * Four ops, applied in order to the evolving content:
 *   - `upsert_section {id, title, body}` — one `::::synap-section` block by id
 *     (replace in place, or append), the session-document door's op;
 *   - `replace_text {old, new}` — str_replace: `old` must occur EXACTLY ONCE,
 *     otherwise the edit is refused with the count so the writer can widen it;
 *   - `append {body}` — markdown at the end;
 *   - `replace_all {content}` — the whole body.
 *
 * FLOORS, checked against the RESULT of every op together (so no op order can
 * slip past them), and refused BEFORE anything is written or proposed:
 *   - an agent (or the pod writing on the owner's behalf) never changes a
 *     HUMAN-OWNED section — not by `upsert_section`, not by a `replace_text`
 *     that reaches into one, not by `replace_all`, and it cannot mint a new one
 *     either. Invariant: the set of human-owned sections (id → exact block
 *     text) is identical before and after an agent patch;
 *   - an embed (`synap-entity|view|cell`) present before must still be present
 *     after, unless the writer passed `allowRemovingEmbeds` — the Notion MCP
 *     #171 lesson: a full-replace tool that silently drops embeds;
 *   - the result must still be locatable: a patch that leaves a section
 *     unclosed or duplicated is refused.
 *
 * Every refusal is a TRPCError whose message tells the writer what to do next.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { parseMarkdown } from "@synap-core/markdown-core/processor";
import { readEmbed, type Embed } from "@synap-core/markdown-core/embeds";
import {
  parseSections,
  sectionOwner,
  upsertSectionInMarkdown,
  SectionBodyError,
  type ParsedSections,
  type SectionOwner,
} from "../session-document/sections.js";

export const SECTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ─── The op vocabulary (the one wire schema every door parses) ──────────────

export const DocumentPatchOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert_section"),
    id: z
      .string()
      .regex(
        SECTION_ID_RE,
        "section id must be lowercase letters, digits, '-' or '_' (max 64), starting with a letter or digit"
      ),
    title: z.string().min(1).max(200),
    body: z.string().max(100_000),
    status: z.string().max(40).optional(),
  }),
  z.object({
    op: z.literal("replace_text"),
    old: z.string().min(1).max(100_000),
    new: z.string().max(100_000),
  }),
  z.object({
    op: z.literal("append"),
    body: z.string().min(1).max(100_000),
  }),
  z.object({
    op: z.literal("replace_all"),
    content: z.string().max(1_000_000),
  }),
]);
export type DocumentPatchOp = z.infer<typeof DocumentPatchOpSchema>;

export const DocumentPatchOpsSchema = z
  .array(DocumentPatchOpSchema)
  .min(1)
  .max(50);

/** Who is writing — what the ownership floor keys on, and what gets stamped. */
export interface PatchWriter {
  /** An agent or the pod itself: the human-section floor applies. */
  isMachine: boolean;
  /** Stamped as `author` on a section this patch writes. */
  author: string;
  /** Stamped as `sessionState` on a section written into a session document. */
  sessionState?: string;
}

/** One affected region, before and after — what the reviewer is shown. */
export interface SectionPreview {
  /** The section's id, or null for text outside any section. */
  sectionId: string | null;
  /** The section's heading (after the patch, else before), or null. */
  title: string | null;
  before: string;
  after: string;
}

export interface RenderedPatch {
  markdown: string;
  previews: SectionPreview[];
  /** Section ids an `upsert_section` op replaced in place (vs appended). */
  replacedSections: string[];
}

// ─── Section extents ─────────────────────────────────────────────────────────

function refuseUnlocatable(
  parsed: ParsedSections,
  when: "before" | "after"
): void {
  if (!parsed.unterminatedId && parsed.duplicateIds.length === 0) return;
  const what = parsed.unterminatedId
    ? `section "${parsed.unterminatedId}" is never closed`
    : `section id "${parsed.duplicateIds[0]}" appears more than once`;
  throw new TRPCError(
    when === "before"
      ? {
          code: "PRECONDITION_FAILED",
          message: `In this document ${what}, so sections cannot be located safely. A person needs to fix the document first.`,
        }
      : {
          code: "BAD_REQUEST",
          message: `This edit would leave the document broken: ${what}. Keep every ::: fence balanced.`,
        }
  );
}

interface SectionBlock {
  id: string;
  owner: SectionOwner;
  title: string | null;
  text: string;
  /** Character offsets of the block in the document. */
  start: number;
  end: number;
}

function sectionBlocks(
  markdown: string,
  parsed: ParsedSections
): SectionBlock[] {
  const lines = markdown.split("\n");
  const lineStart: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStart.push(offset);
    offset += line.length + 1;
  }
  return parsed.sections.map((s) => {
    const blockLines = lines.slice(s.startLine, s.endLine + 1);
    const heading = blockLines.find((l) => /^#{1,6}\s/.test(l));
    const start = lineStart[s.startLine]!;
    const end = lineStart[s.endLine]! + lines[s.endLine]!.length;
    return {
      id: s.id,
      owner: sectionOwner(s),
      title: heading ? heading.replace(/^#{1,6}\s+/, "").trim() : null,
      text: blockLines.join("\n"),
      start,
      end,
    };
  });
}

// ─── Embeds ──────────────────────────────────────────────────────────────────

/** An embed together with the character range of its source. */
export interface LocatedEmbed {
  embed: Embed;
  start: number;
  end: number;
  /** The character range of its markdown fallback, when it has one. */
  fallbackRange: { start: number; end: number } | null;
}

/** Every `synap-*` reference embed in the document, in source order. */
export function locateEmbeds(markdown: string): LocatedEmbed[] {
  const out: LocatedEmbed[] = [];
  const walk = (node: {
    type: string;
    children?: unknown[];
    position?: { start: { offset?: number }; end: { offset?: number } };
  }) => {
    const embed = readEmbed(node as Parameters<typeof readEmbed>[0]);
    if (embed) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (typeof start === "number" && typeof end === "number") {
        const first = embed.fallback[0]?.position?.start.offset;
        const last =
          embed.fallback[embed.fallback.length - 1]?.position?.end.offset;
        out.push({
          embed,
          start,
          end,
          fallbackRange:
            typeof first === "number" && typeof last === "number"
              ? { start: first, end: last }
              : null,
        });
      }
      return; // an embed's fallback is prose, never another embed to count
    }
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(parseMarkdown(markdown) as unknown as Parameters<typeof walk>[0]);
  return out;
}

/** The identity of an embed for the removal floor: directive + references. */
function embedIdentity(embed: Embed): string {
  const ref = Object.keys(embed.ref)
    .sort()
    .map((k) => `${k}=${embed.ref[k]}`)
    .join("&");
  return `${embed.directive}{${ref}}`;
}

function embedCounts(markdown: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { embed } of locateEmbeds(markdown)) {
    const key = embedIdentity(embed);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Embeds present in `before` and missing (or fewer) in `after`. */
export function removedEmbeds(before: string, after: string): string[] {
  const was = embedCounts(before);
  const now = embedCounts(after);
  const removed: string[] = [];
  for (const [key, n] of was) {
    if ((now.get(key) ?? 0) < n) removed.push(key);
  }
  return removed;
}

// ─── Ops ─────────────────────────────────────────────────────────────────────

function occurrences(haystack: string, needle: string): number[] {
  const at: number[] = [];
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + 1)
  ) {
    at.push(i);
    if (at.length > 20) break;
  }
  return at;
}

function applyOp(
  content: string,
  op: DocumentPatchOp,
  writer: PatchWriter,
  now: string,
  replacedSections: string[]
): string {
  switch (op.op) {
    case "upsert_section": {
      const parsed = parseSections(content);
      refuseUnlocatable(parsed, "before");
      const existing = parsed.sections.find((s) => s.id === op.id);
      if (writer.isMachine && existing && sectionOwner(existing) === "human") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Section "${op.id}" belongs to a person, and the AI never rewrites a person's section. Write a new section instead.`,
        });
      }
      try {
        const written = upsertSectionInMarkdown(content, parsed, {
          id: op.id,
          title: op.title,
          body: op.body,
          attributes: {
            owner: writer.isMachine ? "ai" : "human",
            author: writer.author,
            writtenAt: now,
            ...(writer.sessionState
              ? { sessionState: writer.sessionState }
              : {}),
            ...(op.status ? { status: op.status } : {}),
          },
        });
        if (written.replaced) replacedSections.push(op.id);
        return written.markdown;
      } catch (err) {
        if (err instanceof SectionBodyError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }
    case "replace_text": {
      const at = occurrences(content, op.old);
      if (at.length !== 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            at.length === 0
              ? "replace_text: `old` was not found in the document. Read the document again (get_document) and copy the text exactly."
              : `replace_text: \`old\` matches ${at.length > 20 ? "more than 20" : at.length} times; it must match exactly once. Include more surrounding text to make it unique.`,
        });
      }
      // A machine writer reaching into a person's section is refused by the
      // human-section invariant over the whole result (renderDocumentPatch).
      const i = at[0]!;
      return content.slice(0, i) + op.new + content.slice(i + op.old.length);
    }
    case "append": {
      const head = content.replace(/\s+$/, "");
      const body = op.body.replace(/^\s*\n/, "").replace(/\s+$/, "");
      return head ? `${head}\n\n${body}\n` : `${body}\n`;
    }
    case "replace_all":
      return op.content;
  }
}

// ─── Previews ────────────────────────────────────────────────────────────────

/** The document with every section block cut out (a stable placeholder left). */
function outsideSections(markdown: string, blocks: SectionBlock[]): string[] {
  let out = "";
  let cursor = 0;
  for (const b of blocks) {
    out += markdown.slice(cursor, b.start) + `\u0000section:${b.id}\u0000`;
    cursor = b.end;
  }
  return (out + markdown.slice(cursor)).split("\n");
}

/** The one changed run of lines between two line lists (common prefix/suffix trimmed). */
function changedHunk(
  a: string[],
  b: string[]
): { before: string; after: string } | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  if (head === a.length && head === b.length) return null;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const clean = (lines: string[]) =>
    lines
      .join("\n")
      .replace(/\u0000section:[^\u0000]*\u0000/g, "")
      .trim();
  return {
    before: clean(a.slice(head, a.length - tail)),
    after: clean(b.slice(head, b.length - tail)),
  };
}

/**
 * What changed, per section: every section whose block text differs, plus one
 * hunk for the text outside sections. Derived from the whole before/after, so
 * every op kind (and any mix of them) previews the same way.
 */
export function previewPatch(before: string, after: string): SectionPreview[] {
  const was = sectionBlocks(before, parseSections(before));
  const now = sectionBlocks(after, parseSections(after));
  const previews: SectionPreview[] = [];
  const seen = new Set<string>();
  for (const b of now) {
    seen.add(b.id);
    const old = was.find((w) => w.id === b.id);
    if (old?.text === b.text) continue;
    previews.push({
      sectionId: b.id,
      title: b.title ?? old?.title ?? null,
      before: old?.text ?? "",
      after: b.text,
    });
  }
  for (const w of was) {
    if (seen.has(w.id)) continue;
    previews.push({
      sectionId: w.id,
      title: w.title,
      before: w.text,
      after: "",
    });
  }
  const outside = changedHunk(
    outsideSections(before, was),
    outsideSections(after, now)
  );
  if (outside && (outside.before || outside.after)) {
    previews.push({ sectionId: null, title: null, ...outside });
  }
  return previews;
}

// ─── The renderer ────────────────────────────────────────────────────────────

export interface RenderPatchOptions {
  writer: PatchWriter;
  allowRemovingEmbeds?: boolean;
  /** Stamped as `writtenAt`; injected so tests are deterministic. */
  now?: string;
}

/**
 * Apply `ops` to `content` and enforce every floor. Pure: the caller decides
 * whether the result is written, proposed or refused by governance.
 */
export function renderDocumentPatch(
  content: string,
  ops: readonly DocumentPatchOp[],
  options: RenderPatchOptions
): RenderedPatch {
  const { writer } = options;
  const now = options.now ?? new Date().toISOString();
  const before = parseSections(content);
  // A machine writer's floor must locate every human section first.
  if (writer.isMachine) refuseUnlocatable(before, "before");

  const replacedSections: string[] = [];
  let markdown = content;
  for (const op of ops) {
    markdown = applyOp(markdown, op, writer, now, replacedSections);
  }

  const after = parseSections(markdown);
  // A patch may not break what was locatable before it.
  if (!before.unterminatedId && before.duplicateIds.length === 0) {
    refuseUnlocatable(after, "after");
  }

  if (writer.isMachine) {
    const humanBefore = sectionBlocks(content, before).filter(
      (b) => b.owner === "human"
    );
    const humanAfter = sectionBlocks(markdown, after).filter(
      (b) => b.owner === "human"
    );
    for (const b of humanBefore) {
      if (!humanAfter.some((a) => a.id === b.id && a.text === b.text)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `This edit changes or removes section "${b.id}", which belongs to a person. The AI never rewrites a person's section — leave it byte-for-byte as it is.`,
        });
      }
    }
    const forged = humanAfter.find(
      (a) => !humanBefore.some((b) => b.id === a.id)
    );
    if (forged) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `This edit adds section "${forged.id}" as a person's section. An agent's sections are written with owner="ai" (use upsert_section).`,
      });
    }
  }

  if (!options.allowRemovingEmbeds) {
    const removed = removedEmbeds(content, markdown);
    if (removed.length > 0) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `This edit removes ${removed.length === 1 ? "an embed" : `${removed.length} embeds`} (${removed.slice(0, 3).join(", ")}${removed.length > 3 ? ", …" : ""}). Keep them, or pass allow_removing_embeds: true if removing them is the point.`,
      });
    }
  }

  return {
    markdown,
    previews: previewPatch(content, markdown),
    replacedSections,
  };
}

/** Is every op a section write? Governance files those under the section keys. */
export function isSectionOnlyPatch(ops: readonly DocumentPatchOp[]): boolean {
  return ops.every((op) => op.op === "upsert_section");
}
