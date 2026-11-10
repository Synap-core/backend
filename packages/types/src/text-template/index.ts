/**
 * `@synap-core/types/text-template`: the ONE implementation of the
 * command-template grammar (`{name}`, `@{arg:…}`, `@{context:…}`), pure and
 * dependency-free so the pod, the browser, Relay and the CLI share it.
 *
 * - `references.ts`: the grammar's patterns and the author-time check
 *   (`findUnresolvedReferences`);
 * - `substitute.ts`: parse and multi-pass substitution (what `resolveGoal` and
 *   `intelligence.runCommand` run on);
 * - `render.ts`: single-pass rendering of a stored text with declared
 *   variables (snippets): `renderText`.
 */
export * from "./references.js";
export * from "./substitute.js";
export * from "./render.js";
