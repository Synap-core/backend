/**
 * `@synap-core/types/i18n`: the one door for the words Synap writes (chrome),
 * in every runtime: pod, CLI, Electron, web, React Native (Hermes).
 *
 * - `Locale`, `SUPPORTED_LOCALES`, `resolveLocale`: which language;
 * - `pluralCategory`: CLDR cardinal rules for en and fr, as code (no `Intl`);
 * - `parseMessage` / `formatMessage`: a strict ICU MessageFormat subset
 *   (`{name}`, `plural` with `#` and `=N`, `select`), documented in
 *   `message.ts`, so catalogs stay readable by any ICU library later;
 * - `Catalog`, `createT`: typed catalogs where English is the source and the
 *   type, and params are checked against the English message text;
 * - `catalogProblems`: parity checks for a catalog test;
 * - `pseudoLocalize`: a pseudo-locale for leak and overflow checks.
 *
 * Content (what people and agents write) is never translated: only chrome
 * goes through a catalog. Pure and dependency-free.
 */
export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isLocale,
  resolveLocale,
  type Locale,
} from "./locale.js";
export {
  PLURAL_CATEGORIES,
  pluralCategory,
  type PluralCategory,
} from "./plural.js";
export {
  MessageSyntaxError,
  formatMessage,
  messageArguments,
  parseMessage,
  printMessage,
  type ArgumentUse,
  type MessageAst,
  type MessagePart,
  type ParamValue,
} from "./message.js";
export type { ParamsArgs, ParamsOf } from "./params.js";
export {
  catalogProblems,
  createT,
  type Catalog,
  type CatalogProblem,
  type Catalogs,
  type MessageCatalog,
  type TFunction,
} from "./translator.js";
export { pseudoLocalize, pseudoLocalizeMessage } from "./pseudo.js";
