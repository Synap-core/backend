/**
 * Which dialect a verb's `skills.parameters` is written in. A leaf module (no
 * imports) so the run door's validator and the pod-file reader
 * (`file-parameters.ts`, imported by the install door) share the one rule
 * without pulling the builtin verb registry into every importer.
 */

/**
 * Is this bag JSON Schema rather than the shorthand type map?
 *
 * DISCRIMINATE ON `properties`, NOT ON `type`. A type map may legitimately
 * declare a FIELD named `type` — `exa_search` does (`"type": "string?"`) — so
 * keying on `type` alone would misread a real type map as a schema. Only the
 * pairing of `type: "object"` with a `properties` OBJECT identifies the
 * dialect.
 */
export function looksLikeJsonSchema(
  declared: Record<string, unknown>
): boolean {
  return (
    declared.type === "object" &&
    typeof declared.properties === "object" &&
    declared.properties !== null &&
    !Array.isArray(declared.properties)
  );
}
