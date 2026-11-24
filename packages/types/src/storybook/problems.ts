/**
 * What a Storybook read found wrong, as data. Every reader in this module
 * answers `{ ok: true, value, problems }` (problems are warnings: the value is
 * still whole) or `{ ok: false, problems }` (at least one error: there is no
 * value). A reader never "repairs" a payload into an empty one: a mirror that
 * read a broken index as "no components" would mark every record gone.
 */

export type StorybookProblemCode =
  /** The payload (or a part of it) is not a JSON object. */
  | "not-object"
  /** A field the format requires is absent. */
  | "missing-field"
  /** A field holds the wrong JSON type. */
  | "wrong-type"
  /** `version` is not {@link STORYBOOK_BUNDLE_VERSION}. */
  | "wrong-version"
  /** A field holds a value outside its closed list or format. */
  | "bad-value"
  /** Two records share one key. */
  | "duplicate-key"
  /** A key does not follow the identity rule its fields imply. */
  | "key-mismatch"
  /** A reference names a key the bundle does not hold. */
  | "dangling-ref"
  /** The manifest says Storybook could not document a component. */
  | "manifest-component-error"
  /** A component's docgen props could not be read; its props are unknown (not empty). */
  | "props-unreadable"
  /** A source path is absolute (a machine's path), so it cannot be an identity. */
  | "absolute-path";

export interface StorybookProblem {
  code: StorybookProblemCode;
  /** Where, as a JSON path (`components[3].sourcePath`, `entries["a--b"].title`). */
  path: string;
  message: string;
  /** `error`: the read has no value. `warning`: the value is whole, this is a note on it. */
  severity: "error" | "warning";
}

export type StorybookRead<T> =
  | { ok: true; value: T; problems: StorybookProblem[] }
  | { ok: false; problems: StorybookProblem[] };

export const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

export const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

export function hasErrors(problems: StorybookProblem[]): boolean {
  return problems.some((p) => p.severity === "error");
}

/** One line per problem, for a thrown error or a log. */
export function describeProblems(problems: StorybookProblem[]): string {
  return problems.map((p) => `${p.path}: ${p.message}`).join("; ");
}
