/**
 * The pod's built-in web reader (Web Access W0 reader half, Library "any link
 * → data" W2): site adapters + article extraction behind one SSRF-guarded
 * fetch, producing `@synap-core/types/url-read` reads. The one `readUrl`
 * door calls {@link readBuiltin} as its free rung.
 */

export {
  readBuiltin,
  readSentPage,
  builtinStamp,
  type ReadBuiltinOptions,
} from "./read-builtin.js";
export { extractFromHtml } from "./extract.js";
export {
  SITE_ADAPTERS,
  POD_NEVER_FETCHES,
  podNeverFetches,
  findSiteAdapter,
  oembedEndpointFor,
} from "./registry.js";
export type { SiteAdapter, SiteAdapterContext, SiteRead } from "./adapter.js";
export type { WebFetcher } from "./fetch.js";
export { BUILTIN_READ_TEXT_MAX, ADEQUATE_BODY_CHARS } from "./limits.js";
