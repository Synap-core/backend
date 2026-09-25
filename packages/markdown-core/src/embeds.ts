/**
 * EMBEDS — the one reader and the one writer of `:::synap-*` references.
 *
 * The grammar (DOCUMENTS-CENTERPIECE-PLAN §3, decided):
 *
 *   :::synap-cell{cellKey="chart-bar"}       ← attributes are REFERENCE-ONLY
 *   ```json                                  ← optional props block, FIRST child
 *   {"profileSlug":"task","groupBy":"status"}
 *   ```
 *
 *   Tasks pile up in **Review**.             ← optional markdown FALLBACK
 *   :::
 *
 * `readEmbed` accepts both that form and the legacy attribute form
 * (`cellProps='{…}'`, `data-cell-props`) forever, and says which it saw
 * (`legacy`). `serializeEmbed` is the ONLY writer and only ever emits the new
 * form, losslessly — the three hand-rolled writers it replaces each dropped or
 * stripped `"`, `{`, `}` with a different rule.
 */

import type { RootContent } from "mdast";
import type { Diagnostic } from "./diagnostics.js";
import { fenceColonsFor, scanContainers } from "./scan.js";

/** The reference embeds (`synap-section` is prose with an author, not an embed). */
export const EMBED_DIRECTIVES = [
  "synap-entity",
  "synap-view",
  "synap-cell",
] as const;
export type EmbedDirective = (typeof EMBED_DIRECTIVES)[number];

/** Attribute channels that carried props before the body form. Read, never written. */
const LEGACY_PROPS_KEYS = ["cellProps", "data-cell-props"] as const;

/** Container directives whose body is prose, not an embed body. */
const NOT_EMBEDS = new Set(["synap-section"]);

type DirectiveLike = {
  type: string;
  name?: string;
  attributes?: Record<string, string | null | undefined> | null;
  children?: unknown[];
  data?: object;
  position?: {
    start: { line: number; offset?: number };
    end: { line: number; offset?: number };
  };
};

export interface Embed {
  /** `synap-cell` */
  directive: string;
  /** `cell` — the directive name without the `synap-` prefix. */
  kind: string;
  /**
   * Reference attributes as authored (ids, keys) — every string attribute
   * EXCEPT the legacy props channels. Readers that render pick their own
   * allowlist (`DIRECTIVE_ATTRIBUTES`).
   */
  ref: Record<string, string>;
  /** Decoded props, when a props block or a legacy props attribute carried a JSON object. */
  props?: Record<string, unknown>;
  /**
   * Why the props could not be read. Present ⇒ `props` is absent, and the
   * reader MUST show this rather than render the embed with an empty config.
   */
  propsError?: string;
  /** The markdown fallback: every child after the props block. */
  fallback: RootContent[];
  /** Props came from a legacy ATTRIBUTE (`cellProps`), not the body block. */
  legacy: boolean;
  /** Closed only by a parent fence or the end of the document (see `remarkRepairEmbeds`). */
  unterminated: boolean;
  /** 1-based line of the opener, when the node carries a position. */
  line?: number;
  /** What reading this embed found wrong. Never thrown — returned. */
  diagnostics: Diagnostic[];
}

function decodeProps(
  raw: string,
  channel: string
): { props: Record<string, unknown> } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      error: `The ${channel} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `The ${channel} must be a JSON object.` };
  }
  return { props: parsed as Record<string, unknown> };
}

function isPropsBlock(
  node: unknown
): node is { type: "code"; lang?: string | null; value: string } {
  const n = node as { type?: string; lang?: string | null } | undefined;
  return n?.type === "code" && (n.lang ?? "").toLowerCase() === "json";
}

function isLabel(node: unknown): boolean {
  const n = node as
    { type?: string; data?: { directiveLabel?: boolean } } | undefined;
  return n?.type === "paragraph" && n.data?.directiveLabel === true;
}

/**
 * Read one directive node as an embed. Returns null for anything that is not a
 * `synap-*` reference embed (prose directives, `synap-section`).
 *
 * Never throws and never swallows: a malformed props value is `propsError`
 * plus a `malformed-props` diagnostic.
 */
export function readEmbed(node: DirectiveLike): Embed | null {
  if (
    node.type !== "containerDirective" &&
    node.type !== "leafDirective" &&
    node.type !== "textDirective"
  ) {
    return null;
  }
  const directive = node.name ?? "";
  if (!directive.startsWith("synap-") || NOT_EMBEDS.has(directive)) return null;

  const line = node.position?.start.line;
  const diagnostics: Diagnostic[] = [];
  const ref: Record<string, string> = {};
  let legacyRaw: { raw: string; key: string } | null = null;
  for (const [key, value] of Object.entries(node.attributes ?? {})) {
    if (typeof value !== "string") continue;
    if ((LEGACY_PROPS_KEYS as readonly string[]).includes(key)) {
      legacyRaw ??= { raw: value, key };
      continue;
    }
    ref[key] = value;
  }

  const body =
    node.type === "containerDirective" ? [...(node.children ?? [])] : [];
  if (isLabel(body[0])) body.shift();
  const block = isPropsBlock(body[0])
    ? (body.shift() as { value: string })
    : null;

  let props: Record<string, unknown> | undefined;
  let propsError: string | undefined;
  let legacy = false;
  const fail = (message: string) => {
    propsError = message;
    diagnostics.push({
      code: "malformed-props",
      severity: "error",
      message,
      line,
      directive,
    });
  };

  if (block) {
    const decoded = decodeProps(block.value, "props block");
    if ("error" in decoded) fail(decoded.error);
    else props = decoded.props;
    if (legacyRaw) {
      diagnostics.push({
        code: "duplicate-props",
        severity: "warning",
        message: `\`${legacyRaw.key}\` is ignored: this embed already has a props block.`,
        line,
        directive,
      });
    }
  } else if (legacyRaw) {
    legacy = true;
    diagnostics.push({
      code: "legacy-props",
      severity: "info",
      message: `Props in the \`${legacyRaw.key}\` attribute are read, but the next save writes them as a \`\`\`json block.`,
      line,
      directive,
    });
    // `'{}'` was the editor's "no props" default — not an error, not props.
    if (legacyRaw.raw.trim() && legacyRaw.raw.trim() !== "{}") {
      const decoded = decodeProps(
        legacyRaw.raw,
        `\`${legacyRaw.key}\` attribute`
      );
      if ("error" in decoded) fail(decoded.error);
      else props = decoded.props;
    }
  }

  if (!hasReference(directive, ref)) {
    diagnostics.push({
      code: "missing-ref",
      severity: "error",
      message: `\`:::${directive}\` names nothing to show: it needs ${REQUIRED_REF[directive as EmbedDirective]?.join(" or ") ?? "a reference attribute"}.`,
      line,
      directive,
    });
  }

  return {
    directive,
    kind: directive.slice("synap-".length),
    ref,
    ...(props ? { props } : {}),
    ...(propsError ? { propsError } : {}),
    fallback: body as RootContent[],
    legacy,
    unterminated:
      (node.data as { synapUnterminated?: unknown } | undefined)
        ?.synapUnterminated === true,
    ...(line != null ? { line } : {}),
    diagnostics,
  };
}

/** The attributes, any one of which makes an embed resolvable. */
export const REQUIRED_REF: Record<EmbedDirective, readonly string[]> = {
  "synap-entity": ["id"],
  "synap-view": ["viewId", "data-view-id"],
  "synap-cell": ["instanceId", "cellKey", "data-instance-id", "data-cell-key"],
};

function hasReference(directive: string, ref: Record<string, string>): boolean {
  const required = REQUIRED_REF[directive as EmbedDirective];
  if (!required) return true; // an unknown synap-* directive: nothing to require
  return required.some((key) => !!ref[key]?.trim());
}

// ─── The writer ─────────────────────────────────────────────────────────────

export class EmbedSerializeError extends Error {}

export interface EmbedInput {
  /** `synap-cell` | `synap-view` | `synap-entity` (any `synap-*` except `synap-section`). */
  directive: string;
  /** Reference-only attributes, written in this order. */
  ref: Record<string, string>;
  /** Written as a ```json block when present and non-empty. */
  props?: Record<string, unknown>;
  /** Markdown written after the props block. */
  fallback?: string;
}

const ATTRIBUTE_NAME_RE = /^[A-Za-z_:][A-Za-z0-9\-._:]*$/;

/** Quote an attribute value losslessly: `&` and `"` become character references. */
function quoteAttribute(key: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new EmbedSerializeError(
      `Attribute \`${key}\` cannot contain a line break.`
    );
  }
  return `"${value.replace(/&/g, "&amp;").replace(/"/g, "&#x22;")}"`;
}

/**
 * THE attribute writer: `{a="1" b="x &#x22;y&#x22;"}`. Empty values are
 * omitted. Every value round-trips through micromark AND `scanContainers`
 * byte-for-byte after decoding.
 */
export function serializeAttributes(
  attributes: Record<string, string>
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (!ATTRIBUTE_NAME_RE.test(key)) {
      throw new EmbedSerializeError(
        `\`${key}\` is not a valid attribute name.`
      );
    }
    if (value === "") continue;
    parts.push(`${key}=${quoteAttribute(key, value)}`);
  }
  return parts.length ? `{${parts.join(" ")}}` : "";
}

/**
 * Refuse a body that is not self-contained: an unclosed code fence or an
 * unclosed container inside it would swallow the embed's own closing fence.
 */
export function assertSelfContainedBody(body: string, what: string): void {
  const scan = scanContainers(body);
  if (scan.unclosedRootFence) {
    throw new EmbedSerializeError(`${what} has an unclosed code block.`);
  }
  if (scan.containers.some((c) => !c.terminated)) {
    throw new EmbedSerializeError(
      `${what} has an unclosed ::: block, which would swallow the rest of the document.`
    );
  }
}

/**
 * THE embed writer. Emits the body grammar only; attribute props are never
 * written. Throws `EmbedSerializeError` for input it cannot write losslessly.
 */
export function serializeEmbed(input: EmbedInput): string {
  const { directive } = input;
  if (
    !/^synap-[A-Za-z0-9-]*[A-Za-z0-9]$/.test(directive) ||
    NOT_EMBEDS.has(directive)
  ) {
    throw new EmbedSerializeError(
      `\`${directive}\` is not an embed directive.`
    );
  }
  for (const key of Object.keys(input.ref)) {
    if ((LEGACY_PROPS_KEYS as readonly string[]).includes(key)) {
      throw new EmbedSerializeError(
        `\`${key}\` is a props channel, not a reference: pass it as \`props\`.`
      );
    }
  }
  const fallback = (input.fallback ?? "")
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "");
  if (fallback) assertSelfContainedBody(fallback, "An embed fallback");

  const hasProps = !!input.props && Object.keys(input.props).length > 0;
  // A fallback that itself OPENS with a json block would be read back as the
  // props: pin an explicit empty props block in front of it.
  const fallbackLooksLikeProps = /^ {0,3}(`{3,}|~{3,})[ \t]*json\b/i.test(
    fallback
  );
  const propsBlock =
    hasProps || fallbackLooksLikeProps
      ? ["```json", JSON.stringify(hasProps ? input.props : {}), "```"].join(
          "\n"
        )
      : "";
  const body = [propsBlock, fallback].filter(Boolean).join("\n\n");
  const colons = ":".repeat(fenceColonsFor(body));
  return [
    `${colons}${directive}${serializeAttributes(input.ref)}`,
    ...(body ? [body] : []),
    colons,
  ].join("\n");
}
