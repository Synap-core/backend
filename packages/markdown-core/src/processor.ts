/**
 * THE markdown pipeline — one factory, used by every reader.
 *
 * Before this, three pipelines parsed the same documents with three different
 * plugin lists: the web renderer (gfm + directive, NO prose restore — "Meet at
 * 10:30" rendered as "Meet at 10"), the native renderer (gfm + directive +
 * restore) and the section walker (directive only, no gfm). A construct one of
 * them understood could be one another silently dropped.
 *
 * Now every reader either calls `parseMarkdown` / `createMarkdownProcessor`, or
 * — when a host owns the processor, like `react-markdown` — passes
 * `synapRemarkPlugins` as its plugin list. The one-pipeline tripwires fail on
 * any other `unified()` / `remark-directive` use: `pipeline.test.ts` in this
 * package, `renderer/one-pipeline.test.ts` in markdown-engine (which also
 * renders "10:30" through the web renderer).
 *
 * The plugins, in order:
 *   1. `remark-gfm` + `remark-directive` — syntax (tables, `:::name{…}`).
 *   2. `remarkInlineFormat` — `:u[…]` / `:color[…]{tone}` become `underline` /
 *      `textColor` nodes (inline-format.ts), before the restore below.
 *   2b. `remarkRestoreProse` — a non-`synap-*` TEXT directive is prose, put back
 *      byte-for-byte ("10:30", "ratio:high", the id inside `[[entity:id|x]]`).
 *   3. `remarkRepairEmbeds` — an UNTERMINATED embed (closed only by its
 *      parent's fence or the end of the document) keeps its props block and
 *      hands every other child back to its parent as following siblings, with
 *      an `unterminated-embed` diagnostic. Only then can an embed's body MEAN
 *      something (props + fallback) without an unclosed `:::synap-cell{…}`
 *      swallowing the rest of a report.
 *   4. `remarkGithubAlerts` — `> [!NOTE]` becomes a marked blockquote.
 *   5. `remarkHighlight` — `==x==` becomes a `mark` node (the editor's highlight),
 *      `==x=={tone=info}` a toned one.
 *   6. `remark-math` (`singleDollarTextMath: false`, D-math: inline `$…$` is
 *      OFF, so "$5 and $10" is prose) + `remarkDisplayMath` — a `$$…$$` alone
 *      in its paragraph is a display `math` block, like a `$$` fence.
 */

import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import remarkMath from "remark-math";
import type {
  Blockquote,
  Data,
  Literal,
  Paragraph,
  Parent,
  PhrasingContent,
  Root,
  RootContent,
  Text,
} from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
// Side-effect import: augments mdast RootContent / PhrasingContent unions with directive node types.
import type {} from "mdast-util-directive";
import { VFile } from "vfile";
import { closerColons, splitLines } from "./scan.js";
import type { Diagnostic } from "./diagnostics.js";
import {
  highlightProperties,
  isTextTone,
  readHighlightTone,
  remarkInlineFormat,
  unknownToneDiagnostic,
} from "./inline-format.js";

type AnyNode = {
  type: string;
  name?: string;
  value?: string;
  lang?: string | null;
  tone?: string | null;
  children?: AnyNode[];
  data?: Record<string, unknown>;
  position?: {
    start: { line: number; offset?: number };
    end: { line: number; offset?: number };
  };
};

/** Where plugins record what they found, on the VFile, for `collectDiagnostics`. */
export interface SynapFileData {
  synapDiagnostics?: Diagnostic[];
}

function pushDiagnostic(file: VFile | undefined, d: Diagnostic): void {
  if (!file) return;
  const data = file.data as SynapFileData;
  (data.synapDiagnostics ??= []).push(d);
}

// ─── 2. Prose is not a directive ────────────────────────────────────────────

/**
 * `remark-directive` reads ANY `:word` in running text as a text directive, so
 * prose loses words: the `:3f2a91c4-…` inside an `[[entity:3f2a…|Label]]`
 * marker became a directive named after the id, "ratio:high" lost "high" and
 * "Meet at 10:30" lost ":30". The renderers draw only `synap-*` directives.
 *
 * So a text directive whose name is not `synap-*` is put back as the exact
 * source it was parsed from, and adjacent text is re-merged so a marker is one
 * run again. `synap-*` directives, blocks and code are untouched.
 */
function restoreProseDirectives(node: AnyNode, source: string): void {
  if (!node.children) return;
  const next: AnyNode[] = [];
  for (const child of node.children) {
    let current = child;
    if (
      child.type === "textDirective" &&
      !child.name?.startsWith("synap-") &&
      child.position?.start.offset != null &&
      child.position.end.offset != null
    ) {
      current = {
        type: "text",
        value: source.slice(
          child.position.start.offset,
          child.position.end.offset
        ),
      };
    } else {
      restoreProseDirectives(child, source);
    }
    const previous = next[next.length - 1];
    if (current.type === "text" && previous?.type === "text") {
      previous.value = (previous.value ?? "") + (current.value ?? "");
    } else {
      next.push(current);
    }
  }
  node.children = next;
}

export function remarkRestoreProse() {
  return (tree: Root, file: VFile) => {
    restoreProseDirectives(
      tree as unknown as AnyNode,
      String(file.value ?? "")
    );
  };
}

// ─── 2b. Display math ───────────────────────────────────────────────────────

/**
 * D-math: math is a BLOCK — a `$$` fence, a ```math fence, or `$$…$$` written
 * on one line (what the probe doc and most authors write). micromark reads the
 * one-line form as double-dollar TEXT math inside a paragraph; a paragraph
 * holding only that becomes the same `math` block a fence produces. Single
 * `$` never opens math (`singleDollarTextMath: false`), so prices stay prose.
 * A `$$x$$` inside a sentence is PROSE too, put back as its exact source: one
 * rule — math is a block — and no reader ever meets an `inlineMath` node.
 */
function displayMathData(value: string): Record<string, unknown> {
  // The hast shape mdast-util-math gives a `math` block, so hosts draw it alike.
  return {
    hName: "pre",
    hChildren: [
      {
        type: "element",
        tagName: "code",
        properties: { className: ["language-math", "math-display"] },
        children: [{ type: "text", value }],
      },
    ],
  };
}

/** Put every remaining `inlineMath` back as its source text, re-merging runs. */
function inlineMathToProse(node: AnyNode, source: string): void {
  if (!node.children) return;
  const next: AnyNode[] = [];
  for (const child of node.children) {
    let current = child;
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (child.type === "inlineMath" && start != null && end != null) {
      current = { type: "text", value: source.slice(start, end) };
    } else {
      inlineMathToProse(child, source);
    }
    const previous = next[next.length - 1];
    if (current.type === "text" && previous?.type === "text") {
      previous.value = (previous.value ?? "") + (current.value ?? "");
    } else {
      next.push(current);
    }
  }
  node.children = next;
}

function promoteDisplayMath(node: AnyNode): void {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    const only =
      child.type === "paragraph" && child.children?.length === 1
        ? child.children[0]
        : null;
    if (only?.type === "inlineMath") {
      return {
        type: "math",
        value: only.value ?? "",
        data: displayMathData(only.value ?? ""),
        position: child.position,
      };
    }
    promoteDisplayMath(child);
    return child;
  });
}

export function remarkDisplayMath() {
  return (tree: Root, file: VFile) => {
    promoteDisplayMath(tree as unknown as AnyNode);
    // Everything left (sentences, headings, table cells) is prose.
    inlineMathToProse(tree as unknown as AnyNode, String(file.value ?? ""));
  };
}

/** remark-math with D-math: `$$` only; a single `$` is always prose. */
function remarkMathBlocks(this: unknown) {
  return (remarkMath as (this: unknown, o: object) => void).call(this, {
    singleDollarTextMath: false,
  });
}

// ─── 3. Unterminated-embed repair ───────────────────────────────────────────

/** Container directives whose children are CONTENT, never an embed body. */
const PROSE_CONTAINERS = new Set(["synap-section"]);

function isEmbedContainer(node: AnyNode): boolean {
  return (
    node.type === "containerDirective" &&
    !!node.name?.startsWith("synap-") &&
    !PROSE_CONTAINERS.has(node.name)
  );
}

/**
 * Did this container close on its OWN fence? micromark gives an implicitly
 * closed container the extent of whatever closed it, so read the source: the
 * last line must be a colon-only line at least as long as the opener, and it
 * must not also be the parent's last line — closers are matched outermost
 * first, so a line that ends the parent belongs to the parent.
 */
function closedOnOwnFence(
  node: AnyNode,
  parent: AnyNode | null,
  lines: string[]
): boolean {
  const start = node.position?.start.line;
  const end = node.position?.end.line;
  if (start == null || end == null || end <= start) return false;
  const close = closerColons(lines[end - 1] ?? "");
  const open = /^ {0,3}(:{3,})/.exec(lines[start - 1] ?? "")?.[1]?.length ?? 3;
  if (!close || close < open) return false;
  if (
    parent?.type === "containerDirective" &&
    parent.position?.end.line === end
  )
    return false;
  return true;
}

function isPropsBlock(node: AnyNode | undefined): boolean {
  return node?.type === "code" && (node.lang ?? "").toLowerCase() === "json";
}

function isDirectiveLabel(node: AnyNode | undefined): boolean {
  return (
    node?.type === "paragraph" &&
    (node.data as { directiveLabel?: boolean } | undefined)?.directiveLabel ===
      true
  );
}

function repairEmbeds(
  node: AnyNode,
  lines: string[],
  file: VFile | undefined
): void {
  if (!node.children) return;
  const next: AnyNode[] = [];
  for (const child of node.children) {
    repairEmbeds(child, lines, file);
    next.push(child);
    if (!isEmbedContainer(child) || closedOnOwnFence(child, node, lines))
      continue;
    const body = child.children ?? [];
    let keep = 0;
    if (isDirectiveLabel(body[keep])) keep++;
    if (isPropsBlock(body[keep])) keep++;
    const hoisted = body.slice(keep);
    child.children = body.slice(0, keep);
    (child.data ??= {}).synapUnterminated = true;
    next.push(...hoisted);
    pushDiagnostic(file, {
      code: "unterminated-embed",
      severity: "warning",
      message: `\`:::${child.name}\` is never closed, so it would swallow what follows it. Add a closing \`:::\` line after it.`,
      line: child.position?.start.line,
      directive: child.name,
    });
  }
  node.children = next;
}

export function remarkRepairEmbeds() {
  return (tree: Root, file: VFile) => {
    repairEmbeds(
      tree as unknown as AnyNode,
      splitLines(String(file.value ?? "")),
      file
    );
  };
}

// ─── 4. GitHub alerts ───────────────────────────────────────────────────────

export const ALERT_KINDS = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

/**
 * THE alert-marker rule: the `[!KIND]` line at the start of a quote's first
 * text, with its length (marker + trailing blanks + line break). Shared by the
 * reader transform below and the editor's callout decorations, so the two can
 * never disagree about what is an alert.
 */
export function readAlertMarker(
  text: string
): { kind: AlertKind; length: number } | null {
  const m = ALERT_RE.exec(text);
  return m
    ? { kind: m[1]!.toLowerCase() as AlertKind, length: m[0].length }
    : null;
}

/**
 * `> [!NOTE]` (the GitHub form) becomes a blockquote carrying `data.alert` and
 * a `synap-alert synap-alert--<kind>` class, with the marker removed. Any
 * reader that ignores the mark still shows a plain blockquote — the form
 * degrades everywhere by construction.
 */
export function remarkGithubAlerts() {
  return (tree: Root) => {
    const visitNode = (node: AnyNode) => {
      for (const child of node.children ?? []) visitNode(child);
      if (node.type !== "blockquote") return;
      const quote = node as unknown as Blockquote;
      const first = quote.children[0];
      if (first?.type !== "paragraph") return;
      const head = (first as Paragraph).children[0];
      if (head?.type !== "text") return;
      const marker = readAlertMarker((head as Text).value);
      if (!marker) return;
      const kind = marker.kind;
      (head as Text).value = (head as Text).value.slice(marker.length);
      if (!(head as Text).value) (first as Paragraph).children.shift();
      if ((first as Paragraph).children.length === 0) quote.children.shift();
      const data = (quote.data ??= {}) as Record<string, unknown>;
      data.alert = kind;
      data.hProperties = {
        ...((data.hProperties as Record<string, unknown>) ?? {}),
        className: ["synap-alert", `synap-alert--${kind}`],
        "data-alert": kind,
      };
    };
    visitNode(tree as unknown as AnyNode);
  };
}

// ─── 5. Highlight (`==x==`) ─────────────────────────────────────────────────

/**
 * An `==x==` highlight: the editor's one highlight mark (D-fmt), which no
 * markdown standard defines. Readers drew it as raw `==` until this plugin.
 *
 * `data.hName = "mark"` makes any mdast→hast host (react-markdown) draw a
 * `<mark>` without a handler; native and plain-text readers handle `mark`
 * explicitly and MUST fall back to its text — never drop it.
 */
export interface MarkData extends Data {
  hName?: string;
}
export interface Mark extends Parent {
  type: "mark";
  /** `==x=={tone=<tone>}`: the tone as written (may be unknown); absent = default. */
  tone?: string | null;
  children: PhrasingContent[];
  data?: MarkData & { hProperties?: Record<string, unknown> };
}

/**
 * A display-math block (D-math: math is a block; there is no inline math
 * node after this pipeline). Declared here so consumers typecheck without
 * resolving mdast-util-math from this package's dist types.
 */
export interface MathBlock extends Literal {
  type: "math";
  meta?: string | null;
}

declare module "mdast" {
  interface PhrasingContentMap {
    mark: Mark;
  }
  interface BlockContentMap {
    math: MathBlock;
  }
  interface RootContentMap {
    mark: Mark;
    math: MathBlock;
  }
}

/**
 * The delimiter rules, CommonMark-flanking in spirit:
 *   - an opener `==` is not part of a longer `=` run and is followed by a
 *     non-space character (`a == b == c` stays prose);
 *   - a closer `==` is preceded by a non-space character and not part of a
 *     longer `=` run (`===` stays prose);
 *   - opener and closer live in text nodes of the SAME parent, so a highlight
 *     never crosses a paragraph, and code / URLs (not text nodes) are never
 *     read at all;
 *   - an opener at the END of a text node counts only when the next sibling
 *     is not text (`==**b**==`, `==:u[x]==`), and a closer at the START of one
 *     only when the previous sibling is not text — the source rule
 *     (`readHighlightAt`) sees the `*` / `]` there as the non-space neighbour.
 */
const OPENER_RE = /(?<!=)==(?=[^\s=]|$)/g;
const CLOSER_RE = /(?:(?<=[^\s=])|^)==(?!=)/g;

function findDelimiter(re: RegExp, value: string, from: number): number {
  re.lastIndex = from;
  const m = re.exec(value);
  return m ? m.index : -1;
}

/**
 * Source offsets of text fragments, kept OFF the tree (a field on the node
 * would reach every consumer's deep-equal). A micromark text node is tracked
 * only when its value is its source verbatim (no escape, no entity), so an
 * offset is never a guess.
 */
const textOffsets = new WeakMap<AnyNode, number>();
/** Where a toned highlight's `{tone=…}` suffix sits in the source, when known. */
const toneSuffixRanges = new WeakMap<object, { start: number; end: number }>();

/**
 * The source range of a toned `mark`'s `{tone=…}` suffix (readable export
 * strips it), or null when the text around it was not verbatim source.
 */
export function highlightToneSuffixRange(
  mark: object
): { start: number; end: number } | null {
  return toneSuffixRanges.get(mark) ?? null;
}

function textNode(value: string, offset?: number): AnyNode {
  const node: AnyNode = { type: "text", value };
  if (offset != null) textOffsets.set(node, offset);
  return node;
}

function offsetOf(node: AnyNode, source: string): number | undefined {
  const known = textOffsets.get(node);
  if (known != null) return known;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start == null || end == null) return undefined;
  return source.slice(start, end) === node.value ? start : undefined;
}

const plus = (base: number | undefined, n: number) =>
  base == null ? undefined : base + n;

type Report = (d: Diagnostic) => void;

/**
 * The mark just closed; `rest` is the text after its closer. A leading
 * `{tone=…}` belongs to the mark: record it and return what follows it.
 */
function takeTone(
  mark: AnyNode,
  rest: string,
  restOffset: number | undefined,
  report: Report,
  line: number | undefined
): string {
  const suffix = readHighlightTone(rest);
  if (!suffix) return rest;
  mark.tone = suffix.tone;
  if (restOffset != null)
    toneSuffixRanges.set(mark, {
      start: restOffset,
      end: restOffset + suffix.length,
    });
  const props = highlightProperties(suffix.tone);
  if (props) (mark.data ??= {}).hProperties = props;
  if (!isTextTone(suffix.tone))
    report(unknownToneDiagnostic("A highlight", suffix.tone, line));
  return rest.slice(suffix.length);
}

function highlightChildren(
  node: AnyNode,
  report: Report,
  source: string
): void {
  if (!node.children || node.type === "mark") return;
  const queue = [...node.children];
  const out: AnyNode[] = [];
  while (queue.length) {
    const child = queue.shift()!;
    if (child.type !== "text") {
      highlightChildren(child, report, source);
      out.push(child);
      continue;
    }
    const value = child.value ?? "";
    const base = offsetOf(child, source);
    let open = findDelimiter(OPENER_RE, value, 0);
    // `==` ending the node: an opener only before a non-text sibling.
    if (
      open !== -1 &&
      open + 2 === value.length &&
      (queue[0]?.type ?? "text") === "text"
    )
      open = -1;
    if (open === -1) {
      out.push(child);
      continue;
    }
    const before = value.slice(0, open);
    const sameNodeClose = findDelimiter(CLOSER_RE, value, open + 2);
    if (sameNodeClose !== -1) {
      if (before) out.push(textNode(before, base));
      const mark: AnyNode = {
        type: "mark",
        data: { hName: "mark" },
        children: [
          textNode(value.slice(open + 2, sameNodeClose), plus(base, open + 2)),
        ],
      };
      out.push(mark);
      const rest = value.slice(sameNodeClose + 2);
      const after = takeTone(
        mark,
        rest,
        plus(base, sameNodeClose + 2),
        report,
        node.position?.start.line
      );
      if (after)
        queue.unshift(textNode(after, plus(base, value.length - after.length)));
      continue;
    }
    const j = queue.findIndex((n, k) => {
      if (n.type !== "text") return false;
      const at = findDelimiter(CLOSER_RE, n.value ?? "", 0);
      if (at === -1) return false;
      // `==` starting the node: a closer only after a non-text sibling.
      return at > 0 || (k > 0 && queue[k - 1]!.type !== "text");
    });
    if (j === -1) {
      out.push(child);
      continue;
    }
    const middle = queue.splice(0, j);
    middle.forEach((n) => highlightChildren(n, report, source));
    const closing = queue.shift()!;
    const closingBase = offsetOf(closing, source);
    const close = findDelimiter(CLOSER_RE, closing.value ?? "", 0);
    const head = value.slice(open + 2);
    const tail = (closing.value ?? "").slice(0, close);
    if (before) out.push(textNode(before, base));
    const mark: AnyNode = {
      type: "mark",
      data: { hName: "mark" },
      children: [
        ...(head ? [textNode(head, plus(base, open + 2))] : []),
        ...middle,
        ...(tail ? [textNode(tail, closingBase)] : []),
      ],
    };
    out.push(mark);
    const closingValue = closing.value ?? "";
    const rest = takeTone(
      mark,
      closingValue.slice(close + 2),
      plus(closingBase, close + 2),
      report,
      node.position?.start.line
    );
    if (rest)
      queue.unshift(
        textNode(rest, plus(closingBase, closingValue.length - rest.length))
      );
  }
  node.children = out;
}

export function remarkHighlight() {
  return (tree: Root, file?: VFile) => {
    highlightChildren(
      tree as unknown as AnyNode,
      (d) => pushDiagnostic(file, d),
      String(file?.value ?? "")
    );
  };
}

// ─── The factory ────────────────────────────────────────────────────────────

/**
 * The remark plugin list every Synap reader runs, for hosts that own their own
 * processor (`react-markdown`'s `remarkPlugins`). Append renderer-specific
 * plugins AFTER these, never before.
 */
export const synapRemarkPlugins = [
  remarkGfm,
  remarkDirective,
  remarkMathBlocks,
  remarkInlineFormat,
  remarkRestoreProse,
  remarkDisplayMath,
  remarkRepairEmbeds,
  remarkGithubAlerts,
  remarkHighlight,
] as const;

/** A fresh processor with the Synap syntax and transforms. */
export function createMarkdownProcessor(): Processor<Root, Root, Root> {
  const processor = unified().use(remarkParse);
  for (const plugin of synapRemarkPlugins) processor.use(plugin as never);
  return processor as unknown as Processor<Root, Root, Root>;
}

const shared = createMarkdownProcessor();

export interface ParsedMarkdown {
  tree: Root;
  diagnostics: Diagnostic[];
}

/** Parse and transform, keeping what the transforms reported. */
export function parseMarkdownWithDiagnostics(markdown: string): ParsedMarkdown {
  const file = new VFile(markdown);
  const tree = shared.runSync(shared.parse(markdown), file) as Root;
  return {
    tree,
    diagnostics: [...((file.data as SynapFileData).synapDiagnostics ?? [])],
  };
}

/** Markdown → the transformed mdast every Synap reader shares. */
export function parseMarkdown(markdown: string): Root {
  return parseMarkdownWithDiagnostics(markdown).tree;
}

export type MdastNode = RootContent;
export type { ContainerDirective };
