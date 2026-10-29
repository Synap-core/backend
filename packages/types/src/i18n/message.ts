/**
 * The message syntax: a strict subset of ICU MessageFormat, parsed once and
 * memoised, formatted with no `Intl`.
 *
 * THE SUBSET (nothing else parses):
 * - text;
 * - `{name}`: a value; a string prints as is, a number through the locale's
 *   number form (`formatNumber`: "1,234.5" in English, "1 234,5" in French),
 *   as ICU prints a number argument. Pass a year or an id as a string;
 * - `{n, plural, one {…} other {…}}`: CLDR categories (`zero one two few many
 *   other`) and exact matches `=0`, `=1`, … (checked first). `#` inside a
 *   branch prints the number in the locale's number form. `other` is required;
 * - `{g, select, a {…} b {…} other {…}}`: string keys, `other` required.
 *
 * Branches nest. Argument names are `[A-Za-z_][A-Za-z0-9_]*`, select keys
 * `[A-Za-z0-9_-]+`.
 *
 * NOT supported, so a message never means something different here and in an
 * ICU library: `number` / `date` / `time` / `selectordinal` arguments, plural
 * `offset:`, and ICU quoting. An ASCII apostrophe placed where ICU would start
 * a quote (before `{`, `}`, `'`, or `#` inside a plural) is a syntax error;
 * write the typographic apostrophe ’ (U+2019), which French copy uses anyway.
 * Every other apostrophe is plain text, as in ICU ("l'espace" is fine).
 *
 * Numbers print through `@synap-core/types/value-format` (no `Intl`), so
 * "1 000 000 d’éléments" reads right in French.
 */
import type { Locale } from "./locale.js";
import { pluralCategory } from "./plural.js";
import { formatNumber } from "../value-format/numbers.js";

/** One piece of a parsed message. */
export type MessagePart =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "arg"; readonly name: string }
  | { readonly kind: "pound" }
  | {
      readonly kind: "plural" | "select";
      readonly name: string;
      /** Selector → branch, in source order (`=0`, `one`, `other`, a select key). */
      readonly options: Readonly<Record<string, MessageAst>>;
    };

/** A parsed message. */
export type MessageAst = readonly MessagePart[];

/** A value a message can print or select on. */
export type ParamValue = string | number;

/** Thrown for a message outside the subset; names the offset. */
export class MessageSyntaxError extends Error {
  constructor(
    readonly source: string,
    readonly offset: number,
    detail: string
  ) {
    super(`${detail} at offset ${offset} in message "${source}"`);
    this.name = "MessageSyntaxError";
  }
}

const PLURAL_SELECTORS = new Set([
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
]);

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

class Parser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parse(): MessageAst {
    return this.parts(false, false);
  }

  private fail(detail: string, at = this.pos): never {
    throw new MessageSyntaxError(this.src, at, detail);
  }

  /** Text and arguments until the end, or until the `}` closing a branch. */
  private parts(inPlural: boolean, inBranch: boolean): MessagePart[] {
    const out: MessagePart[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ kind: "text", value: text });
      text = "";
    };
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === "{") {
        flush();
        out.push(this.argument(inPlural));
        continue;
      }
      if (ch === "}") {
        if (inBranch) break;
        this.fail("Unmatched }");
      }
      if (ch === "#" && inPlural) {
        flush();
        out.push({ kind: "pound" });
        this.pos++;
        continue;
      }
      if (ch === "'") {
        const next = this.src[this.pos + 1];
        if (
          next === "{" ||
          next === "}" ||
          next === "'" ||
          (next === "#" && inPlural)
        ) {
          this.fail(
            "An ASCII apostrophe here is ICU quoting, which the subset does not support (write ’)"
          );
        }
      }
      text += ch;
      this.pos++;
    }
    if (inBranch && this.pos >= this.src.length) this.fail("Unclosed {");
    flush();
    return out;
  }

  private skipSpace(): void {
    while (this.pos < this.src.length && isSpace(this.src[this.pos]))
      this.pos++;
  }

  private ident(what: string): string {
    const start = this.pos;
    if (!isIdentStart(this.src[this.pos] ?? "")) this.fail(`Expected ${what}`);
    while (this.pos < this.src.length && isIdentChar(this.src[this.pos]))
      this.pos++;
    return this.src.slice(start, this.pos);
  }

  private expect(ch: string): void {
    if (this.pos >= this.src.length) this.fail("Unclosed {");
    if (this.src[this.pos] !== ch) this.fail(`Expected "${ch}"`);
    this.pos++;
  }

  /** `{name}`, `{name, plural, …}` or `{name, select, …}`; at the `{`. */
  private argument(inPlural: boolean): MessagePart {
    this.expect("{");
    this.skipSpace();
    const name = this.ident("an argument name");
    this.skipSpace();
    if (this.src[this.pos] === "}") {
      this.pos++;
      return { kind: "arg", name };
    }
    this.expect(",");
    this.skipSpace();
    const typeAt = this.pos;
    const type = this.ident("an argument type");
    if (type !== "plural" && type !== "select") {
      this.fail(
        `Unsupported argument type "${type}" (the subset has plural and select)`,
        typeAt
      );
    }
    this.skipSpace();
    this.expect(",");
    return {
      kind: type,
      name,
      options: this.options(type, type === "plural" || inPlural),
    };
  }

  /** `sel {…} sel {…} }`; consumes the argument's closing `}`. */
  private options(
    type: "plural" | "select",
    inPlural: boolean
  ): Record<string, MessageAst> {
    const options: Record<string, MessageAst> = {};
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.src.length) this.fail("Unclosed {");
      if (this.src[this.pos] === "}") {
        this.pos++;
        break;
      }
      const at = this.pos;
      const selector = this.selector(type);
      if (Object.prototype.hasOwnProperty.call(options, selector)) {
        this.fail(`Duplicate selector "${selector}"`, at);
      }
      this.skipSpace();
      this.expect("{");
      options[selector] = this.parts(inPlural, true);
      this.expect("}");
    }
    if (!Object.prototype.hasOwnProperty.call(options, "other")) {
      this.fail(`A ${type} needs an "other" branch`);
    }
    return options;
  }

  private selector(type: "plural" | "select"): string {
    const start = this.pos;
    if (type === "plural" && this.src[this.pos] === "=") {
      this.pos++;
      while (/[0-9]/.test(this.src[this.pos] ?? "")) this.pos++;
      if (this.pos === start + 1) this.fail("Expected a number after =");
      return this.src.slice(start, this.pos);
    }
    while (/[A-Za-z0-9_-]/.test(this.src[this.pos] ?? "")) this.pos++;
    const word = this.src.slice(start, this.pos);
    if (!word) this.fail("Expected a selector");
    if (type === "plural" && !PLURAL_SELECTORS.has(word)) {
      this.fail(`Unknown plural category "${word}"`, start);
    }
    return word;
  }
}

const parsed = new Map<string, MessageAst>();

/**
 * Parse a message (memoised: each distinct text is parsed once).
 * @throws MessageSyntaxError for anything outside the subset.
 */
export function parseMessage(source: string): MessageAst {
  let ast = parsed.get(source);
  if (!ast) {
    ast = new Parser(source).parse();
    parsed.set(source, ast);
  }
  return ast;
}

/** A number in the locale's form; a string as it was given. */
function printValue(value: ParamValue, locale: Locale): string {
  return typeof value === "number"
    ? formatNumber(value, { locale })
    : String(value);
}

function formatParts(
  parts: MessageAst,
  locale: Locale,
  params: Readonly<Record<string, ParamValue>> | undefined,
  pound: string
): string {
  let out = "";
  for (const part of parts) {
    switch (part.kind) {
      case "text":
        out += part.value;
        break;
      case "pound":
        out += pound;
        break;
      case "arg": {
        const value = params?.[part.name];
        // A missing value shows its placeholder: visible, never a crash.
        out += value == null ? `{${part.name}}` : printValue(value, locale);
        break;
      }
      case "plural": {
        const raw = params?.[part.name];
        const n = typeof raw === "number" ? raw : Number(raw);
        const branch =
          part.options[`=${n}`] ??
          part.options[pluralCategory(locale, n)] ??
          part.options.other;
        const shown = raw == null ? `{${part.name}}` : printValue(raw, locale);
        out += formatParts(branch, locale, params, shown);
        break;
      }
      case "select": {
        const raw = params?.[part.name];
        const key = raw == null ? "other" : String(raw);
        const branch = Object.prototype.hasOwnProperty.call(part.options, key)
          ? part.options[key]
          : part.options.other;
        out += formatParts(branch, locale, params, pound);
        break;
      }
    }
  }
  return out;
}

/**
 * Format `source` with `params`; plural branches follow `locale`'s rules.
 * @throws MessageSyntaxError when `source` is outside the subset.
 */
export function formatMessage(
  source: string,
  params: Readonly<Record<string, ParamValue>> | undefined,
  locale: Locale
): string {
  return formatParts(parseMessage(source), locale, params, "#");
}

/** Print an AST back to message text (the inverse of {@link parseMessage}). */
export function printMessage(ast: MessageAst): string {
  let out = "";
  for (const part of ast) {
    switch (part.kind) {
      case "text":
        out += part.value;
        break;
      case "pound":
        out += "#";
        break;
      case "arg":
        out += `{${part.name}}`;
        break;
      default:
        out += `{${part.name}, ${part.kind},`;
        for (const [selector, branch] of Object.entries(part.options)) {
          out += ` ${selector} {${printMessage(branch)}}`;
        }
        out += "}";
    }
  }
  return out;
}

/** How a message uses an argument: printed, counted, or selected on. */
export type ArgumentUse = "arg" | "plural" | "select";

/**
 * Every argument `source` reads, with how it reads it. A name used both as a
 * plural and printed (`{n, plural, … {#} …} {n}`) reports `plural`.
 */
export function messageArguments(source: string): Map<string, ArgumentUse> {
  const found = new Map<string, ArgumentUse>();
  const walk = (ast: MessageAst) => {
    for (const part of ast) {
      if (part.kind === "arg") {
        if (!found.has(part.name)) found.set(part.name, "arg");
      } else if (part.kind === "plural" || part.kind === "select") {
        found.set(part.name, part.kind);
        for (const branch of Object.values(part.options)) walk(branch);
      }
    }
  };
  walk(parseMessage(source));
  return found;
}
