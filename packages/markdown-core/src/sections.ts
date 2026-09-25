import { DIRECTIVE_ATTRIBUTES } from "./directive-registry.js";
import { parseMarkdown } from "./processor.js";

export interface ReportSection {
  /** Allowlisted `:::synap-section{…}` attributes, exactly as authored. */
  attributes: Record<string, string>;
  /** Markdown source of the section body — feed it straight to `MarkdownRenderer`. */
  content: string;
}

/** One paginated unit for a slide-deck presenter. */
export interface Slide {
  /** Stable, deeplinkable id — derived from authored attributes/heading text where possible. */
  id: string;
  /** Human-facing slide title. */
  title: string;
  /** 0-based position in the deck. */
  index: number;
  /** Markdown source of the slide body — feed it straight to `MarkdownRenderer`. */
  content: string;
  /**
   * `content` MINUS the leading heading that already became `title`.
   *
   * A deck draws `title` as the slide's own headline, so feeding it `content`
   * printed the claim TWICE on every section slide — once as the presenter's
   * headline and again, larger, as the markdown `h2` two lines below it. A
   * long-form reader wants the heading in the flow; a deck has already promoted
   * it to chrome. Both readings are legitimate, so segmentation hands out both
   * strings rather than picking one: `content` is unchanged (scroll, tests,
   * every existing caller), `body` is what a presenter renders under its own
   * headline.
   *
   * Equal to `content` whenever no leading heading was consumed.
   */
  body: string;
  /**
   * This slide carries the DOCUMENT's own title (the `# ` a report opens with),
   * not a section claim.
   *
   * A presenter needs this for two decisions it cannot make from `index`: draw
   * no headline of its own here (the body already renders the title at prose
   * scale), and keep a running head on every OTHER slide. Keying those off
   * `index === 0` was wrong for a report whose first slide is a section — the
   * document title then appeared nowhere at all.
   */
  isTitleSlide?: boolean;
  /** Allowlisted `:::synap-section{…}` attributes, when this slide came from a section. */
  attributes?: Record<string, string>;
}

/** The shared pipeline (`processor.ts`) — the same tree every other reader sees. */
function parseTree(markdown: string) {
  return parseMarkdown(markdown) as any;
}

interface RawSection {
  node: any;
  attributes: Record<string, string>;
  content: string;
  /**
   * The section's first TOP-LEVEL `heading` child, when it has one. Computed
   * here rather than at the call site so the "what is this section called"
   * question has exactly one answer, derived by the same walk that produced
   * the section — the whole reason `getTopLevelSections` exists.
   */
  heading?: any;
  /** The section's own top-level children, in document order. */
  children: any[];
}

/**
 * Walk the TOP-LEVEL `::::synap-section` blocks of an already-parsed tree, in
 * document order. Shared by `listSections` and `segmentSlides` so there is
 * exactly one AST walker for this shape — never two that could drift.
 */
function getTopLevelSections(tree: any, markdown: string): RawSection[] {
  const allowed = DIRECTIVE_ATTRIBUTES["synap-section"];
  const sections: RawSection[] = [];

  for (const node of (tree.children ?? []) as any[]) {
    if (node.type !== "containerDirective" || node.name !== "synap-section") {
      continue;
    }

    const attributes: Record<string, string> = {};
    for (const key of allowed) {
      const value = node.attributes?.[key];
      if (value != null) attributes[key] = String(value);
    }

    const children = (node.children ?? []) as any[];
    const start = children[0]?.position?.start?.offset;
    const end = children[children.length - 1]?.position?.end?.offset;

    sections.push({
      node,
      attributes,
      children,
      // `.find`, not `children[0]`, matching tiers 2 and 3, which both take the
      // first heading anywhere in their node group. The generator is instructed
      // to open every section with its `##`, but a section whose heading sits
      // after a lead-in paragraph still has a real name, and reading it is
      // strictly better than falling back to pipeline vocabulary.
      heading: (node.children ?? []).find((c: any) => c.type === "heading"),
      content:
        typeof start === "number" && typeof end === "number"
          ? markdown.slice(start, end)
          : "",
    });
  }

  return sections;
}

/**
 * Enumerate the TOP-LEVEL `::::synap-section` blocks of a document, in
 * document order. A slide-deck presenter paginates on this.
 *
 * Delegates to the same AST walk `segmentSlides` uses — this function's
 * public shape (section bodies only, no id/index) is unchanged.
 */
export function listSections(markdown: string): ReportSection[] {
  const tree = parseTree(markdown);
  return getTopLevelSections(tree, markdown).map(({ attributes, content }) => ({
    attributes,
    content,
  }));
}

// ---------------------------------------------------------------------------
// segmentSlides — the one AST walker. Three-tier cascade, each tier a
// fallback for when the previous finds nothing:
//
//   Tier 1 — `::::synap-section` blocks (+ a leading title slide built from
//            whatever precedes the first section, e.g. the doc's `# ` title).
//            This is the tier that matters: generated reports are exactly
//            `# h1` + N sections, with no `##` and no `---`.
//   Tier 2 — else, top-level headings (`#`/`##`). Hand-written and
//            AI-authored docs use headings as their organizing grammar and
//            never mix in `---`.
//   Tier 3 — else, `---` thematic breaks, for a hand-authored doc that has
//            no headings at all.
//
// `---` is deliberately a FALLBACK, not an override that beats tiers 1-2:
// generated reports (tier 1) never contain a thematic break, and heading
// documents (tier 2) use headings as the single organizing grammar per the
// generator's own contract — letting `---` cut through the middle of a
// heading's content would mean two mechanisms compete to place slide
// boundaries in the same document, which is exactly the "two walkers drift"
// failure mode this module exists to avoid. A fallback ladder keeps boundary
// placement deterministic: the first grammar that produces any boundary wins
// outright, never merges with the others.
// ---------------------------------------------------------------------------

function headingText(node: any): string {
  let text = "";
  const walk = (n: any) => {
    if (
      typeof n.value === "string" &&
      (n.type === "text" || n.type === "inlineCode")
    ) {
      text += n.value;
    }
    if (Array.isArray(n.children)) {
      for (const child of n.children) walk(child);
    }
  };
  walk(node);
  return text.trim();
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function capitalize(input: string): string {
  return input.length ? input[0].toUpperCase() + input.slice(1) : input;
}

/** Dedupe a candidate id key against ones already used in this deck. */
function dedupeId(baseKey: string, seen: Map<string, number>): string {
  const count = seen.get(baseKey) ?? 0;
  seen.set(baseKey, count + 1);
  return count === 0 ? baseKey : `${baseKey}-${count + 1}`;
}

function sliceNodes(markdown: string, nodes: any[]): string {
  if (nodes.length === 0) return "";
  const start = nodes[0]?.position?.start?.offset;
  const end = nodes[nodes.length - 1]?.position?.end?.offset;
  return typeof start === "number" && typeof end === "number"
    ? markdown.slice(start, end)
    : "";
}

/**
 * The slide body with a LEADING heading dropped — see `Slide.body`.
 *
 * Only ever drops the FIRST node, and only when that node is the very heading
 * whose text became the slide title. A heading that sits after a lead-in
 * paragraph still names the slide, but removing it from the middle of the prose
 * would leave a hole; it stays.
 */
function bodyWithoutLeadingTitle(
  markdown: string,
  nodes: any[],
  heading: any | undefined,
  usedAsTitle: boolean
): string {
  if (!usedAsTitle || !heading || nodes[0] !== heading) {
    return sliceNodes(markdown, nodes);
  }
  return sliceNodes(markdown, nodes.slice(1));
}

/**
 * THE FALLBACK, not the first choice — and it used to be the only choice, which
 * is the defect this comment exists to keep fixed.
 *
 * What it produces is PIPELINE VOCABULARY: `Capitalize(round) · agent`, e.g.
 * "Analyze · analyst". The deck renders that as the largest text on the slide,
 * and the attribution row 12px beneath it prints the SAME two facts again as a
 * round chip and an agent name. Headline and metadata saying one thing in two
 * sizes is not a title; it is the machine describing its own plumbing where the
 * reader expects to be told what was found.
 *
 * The real fix is upstream — the assembler now opens every `::::synap-section`
 * with a one-line claim `##` (`ensure-report-automation.ts`, seed v12), and
 * `segmentByTier1` prefers that heading. This stays because reports already
 * generated by seed ≤ v11 have no heading to prefer, and a slide titled
 * "Analyze · analyst" still beats one titled "Section 2".
 */
function titleFromSectionAttributes(
  attrs: Record<string, string>,
  index: number
): string {
  const parts: string[] = [];
  if (attrs.round) parts.push(capitalize(attrs.round));
  if (attrs.agent) parts.push(attrs.agent);
  if (parts.length > 0) return parts.join(" · ");
  if (attrs.status) return capitalize(attrs.status);
  return `Section ${index + 1}`;
}

function segmentByTier1(
  markdown: string,
  topChildren: any[],
  sections: RawSection[]
): Slide[] {
  const slides: Slide[] = [];
  const firstSectionIndex = topChildren.indexOf(sections[0].node);
  const preambleNodes = topChildren.slice(0, firstSectionIndex);

  if (preambleNodes.length > 0) {
    const heading = preambleNodes.find((n) => n.type === "heading");
    const content = sliceNodes(markdown, preambleNodes);
    slides.push({
      id: "title",
      title: heading ? headingText(heading) || "Overview" : "Overview",
      index: 0,
      content,
      // The preamble IS the document's title block — a presenter must not draw a
      // second headline over it, and every later slide can name the document
      // from here.
      body: content,
      isTitleSlide: !!heading,
    });
  }

  const seen = new Map<string, number>();
  for (const { attributes, content, heading, children } of sections) {
    const index = slides.length;
    // TITLE PRECEDENCE — a real heading first, attributes only as a fallback.
    //   1. the section's own `##` claim ("Half the open tasks are blocked"),
    //   2. else the attribute-derived label ("Analyze · analyst"),
    //   3. else `Section N` (folded into (2)'s own last resort).
    // Read from the AST, never a regex over the source: the section body may
    // contain an unterminated `:::synap-cell{…}` whose text a naive `^##` scan
    // would happily mistake for a heading.
    const claim = heading ? headingText(heading) : "";
    const title = claim || titleFromSectionAttributes(attributes, index);
    // Same precedence for the id, with the AUTHORED `id` attribute still on
    // top: an explicit key is a deliberate deeplink target and outranks any
    // derivation, including a heading that a later edit may reword.
    const baseKey =
      (attributes.id && slugify(attributes.id)) ||
      (claim && slugify(claim)) ||
      slugify([attributes.round, attributes.agent].filter(Boolean).join("-")) ||
      `section-${index}`;
    slides.push({
      id: dedupeId(baseKey, seen),
      title,
      index,
      content,
      body: bodyWithoutLeadingTitle(markdown, children, heading, !!claim),
      attributes,
    });
  }

  return slides;
}

function segmentByHeadings(
  markdown: string,
  topChildren: any[],
  headings: any[]
): Slide[] {
  const slides: Slide[] = [];
  const firstHeadingIndex = topChildren.indexOf(headings[0]);
  const preambleNodes = topChildren.slice(0, firstHeadingIndex);

  if (preambleNodes.length > 0) {
    const content = sliceNodes(markdown, preambleNodes);
    slides.push({
      id: "untitled",
      title: "Untitled",
      index: 0,
      content,
      body: content,
    });
  }

  const seen = new Map<string, number>();
  headings.forEach((heading, i) => {
    const startIdx = topChildren.indexOf(heading);
    const nextIdx = headings[i + 1]
      ? topChildren.indexOf(headings[i + 1])
      : topChildren.length;
    const segmentNodes = topChildren.slice(startIdx, nextIdx);
    const claim = headingText(heading);
    const title = claim || `Slide ${i + 1}`;
    const baseKey = slugify(title) || `slide-${i + 1}`;
    slides.push({
      id: dedupeId(baseKey, seen),
      title,
      index: slides.length,
      content: sliceNodes(markdown, segmentNodes),
      body: bodyWithoutLeadingTitle(markdown, segmentNodes, heading, !!claim),
      // A `#` at the top of a heading-organized document is the document's
      // title; a `##` is a section of it. Only the former suppresses a
      // presenter's own headline.
      isTitleSlide: slides.length === 0 && heading.depth === 1 && !!claim,
    });
  });

  return slides;
}

function segmentByBreaks(
  markdown: string,
  topChildren: any[],
  breaks: any[]
): Slide[] {
  const breakIndices = new Set(breaks.map((b) => topChildren.indexOf(b)));
  const groups: any[][] = [];
  let current: any[] = [];
  topChildren.forEach((node, idx) => {
    if (breakIndices.has(idx)) {
      groups.push(current);
      current = [];
    } else {
      current.push(node);
    }
  });
  groups.push(current);

  const slides: Slide[] = [];
  for (const nodes of groups) {
    if (nodes.length === 0) continue; // adjacent/leading/trailing breaks produce no slide
    const heading = nodes.find((n) => n.type === "heading");
    const n = slides.length + 1;
    const claim = heading ? headingText(heading) : "";
    slides.push({
      id: `slide-${n}`, // no authored key exists in this tier — position is the only stable-ish handle
      title: claim || `Slide ${n}`,
      index: slides.length,
      content: sliceNodes(markdown, nodes),
      body: bodyWithoutLeadingTitle(markdown, nodes, heading, !!claim),
    });
  }

  return slides;
}

/**
 * Segment a markdown document into presenter slides. AST-only — never a
 * regex over raw text (an unterminated `:::synap-cell{…}` runs to the end of
 * its parent container in `remark-directive`'s grammar, so a naive text
 * split can cut through the middle of it and silently drop everything
 * after). All boundaries come from `position.start/end.offset` on top-level
 * mdast/directive nodes, exactly like `listSections`.
 */
export function segmentSlides(markdown: string): Slide[] {
  if (!markdown || !markdown.trim()) return [];

  const tree = parseTree(markdown);
  const topChildren = (tree.children ?? []) as any[];
  if (topChildren.length === 0) return [];

  const sections = getTopLevelSections(tree, markdown);
  if (sections.length > 0) {
    return segmentByTier1(markdown, topChildren, sections);
  }

  const topHeadings = topChildren.filter(
    (n) => n.type === "heading" && n.depth <= 2
  );
  if (topHeadings.length > 0) {
    return segmentByHeadings(markdown, topChildren, topHeadings);
  }

  const breaks = topChildren.filter((n) => n.type === "thematicBreak");
  if (breaks.length > 0) {
    return segmentByBreaks(markdown, topChildren, breaks);
  }

  // Tier 4 fallback: no section/heading/break boundary anywhere — the whole
  // document is one slide.
  const heading = topChildren.find((n) => n.type === "heading");
  const title = heading ? headingText(heading) || "Document" : "Document";
  const content = sliceNodes(markdown, topChildren);
  return [
    {
      id: heading ? slugify(title) || "document" : "document",
      title,
      index: 0,
      content,
      // The whole document is one slide: whatever heading it has is ITS title,
      // and a presenter must not stack a headline on top of it.
      body: content,
      isTitleSlide: true,
    },
  ];
}
