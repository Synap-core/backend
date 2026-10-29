/**
 * Catalogs and the translator.
 *
 * A catalog is a flat object, message key → message text. Keys name the slot
 * (`relay.home.empty.title`, `action.open.imperative`), never the English
 * words. The English catalog is the source AND the type: declare it
 * `const en = { … } as const`, then `const fr: Catalog<typeof en> = { … }`
 * must hold every English key and no other. `createT` returns `t(key, params)`
 * whose params are read from the English text (`ParamsOf`), so a missing or
 * misspelt parameter is a compile error.
 *
 * Never a module-global locale on a server: call `createT(recipient.locale,
 * catalogs)` per recipient.
 */
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from "./locale.js";
import {
  formatMessage,
  messageArguments,
  MessageSyntaxError,
  type ParamValue,
} from "./message.js";
import { NOUN_BUNDLE_MEMBERS } from "./noun.js";
import type { ParamsArgs } from "./params.js";

/** Any catalog: message key → message text. */
export type MessageCatalog = Readonly<Record<string, string>>;

/** A translation of the source catalog `T`: every key of `T`, no other. */
export type Catalog<T extends MessageCatalog> = {
  readonly [K in keyof T]: string;
};

/** The source catalog and one translation per other supported locale. */
export type Catalogs<T extends MessageCatalog> = { readonly en: T } & {
  readonly [L in Exclude<Locale, "en">]: Catalog<T>;
};

/** The translator: the message at `key`, formatted with `params`. */
export type TFunction<T extends MessageCatalog> = <K extends keyof T & string>(
  key: K,
  ...params: ParamsArgs<T[K]>
) => string;

function messageAt(
  catalog: MessageCatalog | undefined,
  key: string
): string | undefined {
  if (!catalog || !Object.prototype.hasOwnProperty.call(catalog, key)) {
    return undefined;
  }
  const message = catalog[key];
  return typeof message === "string" ? message : undefined;
}

/**
 * The translator for `locale`. A key the locale's catalog lacks, or holds a
 * malformed message for, falls back to English, formatted with English plural
 * rules: the person sees English words, never a raw key.
 *
 * @throws Error for a key the English catalog does not have (a type error in
 *   TypeScript; reachable only from untyped callers).
 */
export function createT<T extends MessageCatalog>(
  locale: Locale,
  catalogs: Catalogs<T>
): TFunction<T> {
  const own =
    locale === DEFAULT_LOCALE
      ? undefined
      : (catalogs as Partial<Record<Locale, MessageCatalog>>)[locale];
  return ((key: string, params?: Readonly<Record<string, ParamValue>>) => {
    const translated = messageAt(own, key);
    if (translated !== undefined) {
      try {
        return formatMessage(translated, params, locale);
      } catch (err) {
        if (!(err instanceof MessageSyntaxError)) throw err;
      }
    }
    const source = messageAt(catalogs.en, key);
    if (source === undefined) {
      throw new Error(`Unknown message key "${key}"`);
    }
    return formatMessage(source, params, DEFAULT_LOCALE);
  }) as TFunction<T>;
}

/** One thing wrong with a catalog, found by {@link catalogProblems}. */
export interface CatalogProblem {
  readonly locale: Locale;
  readonly key: string;
  readonly problem: "missing" | "extra" | "syntax" | "arguments";
  readonly detail: string;
}

const BUNDLE_MEMBERS: ReadonlySet<string> = new Set(NOUN_BUNDLE_MEMBERS);
/** The one argument a noun bundle counts as, whichever members a message reads. */
const NOUN_BUNDLE = `{${NOUN_BUNDLE_MEMBERS.join(",")}}`;

/**
 * The arguments `message` reads, with the noun bundle's members folded into
 * ONE argument (`ParamsOf` hands a message reading any member all of them, so
 * English "Deleted {obj}" and French reading `objG` and `Obj` read the same).
 */
function argumentsOf(
  message: string
): Map<string, string> | MessageSyntaxError {
  let args: Map<string, string>;
  try {
    args = messageArguments(message);
  } catch (err) {
    if (err instanceof MessageSyntaxError) return err;
    throw err;
  }
  const folded = new Map<string, string>();
  for (const [name, use] of args) {
    if (BUNDLE_MEMBERS.has(name)) folded.set(NOUN_BUNDLE, "arg");
    else folded.set(name, use);
  }
  return folded;
}

function describe(args: Map<string, string>): string {
  return [...args].map(([name, use]) => `${name}:${use}`).join(", ") || "none";
}

/**
 * Everything wrong with a set of catalogs, for a parity test: an English
 * message outside the subset; a translation missing a key, holding a key
 * English lacks, outside the subset, or reading other arguments than the
 * English message (a counted argument must stay counted; a printed one may
 * become counted or selected). The noun bundle counts as one argument: when
 * English reads any of `obj`, `Obj`, `objs`, `objG`, `objV`, a translation
 * may read any of them, and must read at least one. Empty when the catalogs
 * are sound.
 */
export function catalogProblems(
  catalogs: { readonly en: MessageCatalog } & Partial<
    Record<Locale, MessageCatalog>
  >
): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  const sourceArgs = new Map<string, Map<string, string>>();
  for (const [key, message] of Object.entries(catalogs.en)) {
    const args = argumentsOf(message);
    if (args instanceof MessageSyntaxError) {
      problems.push({
        locale: "en",
        key,
        problem: "syntax",
        detail: args.message,
      });
    } else {
      sourceArgs.set(key, args);
    }
  }
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const catalog = catalogs[locale];
    if (!catalog) continue;
    for (const key of Object.keys(catalogs.en)) {
      if (!Object.prototype.hasOwnProperty.call(catalog, key)) {
        problems.push({ locale, key, problem: "missing", detail: "" });
      }
    }
    for (const [key, message] of Object.entries(catalog)) {
      if (!Object.prototype.hasOwnProperty.call(catalogs.en, key)) {
        problems.push({ locale, key, problem: "extra", detail: "" });
        continue;
      }
      const args = argumentsOf(message);
      if (args instanceof MessageSyntaxError) {
        problems.push({ locale, key, problem: "syntax", detail: args.message });
        continue;
      }
      const expected = sourceArgs.get(key);
      if (!expected) continue;
      const same =
        args.size === expected.size &&
        [...expected].every(([name, use]) => {
          const got = args.get(name);
          return got !== undefined && (use === "arg" || got === use);
        });
      if (!same) {
        problems.push({
          locale,
          key,
          problem: "arguments",
          detail: `expected ${describe(expected)}, got ${describe(args)}`,
        });
      }
    }
  }
  return problems;
}
