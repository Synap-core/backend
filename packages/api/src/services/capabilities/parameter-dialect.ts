/**
 * Which dialect a verb's `skills.parameters` is written in. A leaf module (no
 * imports) so the run door's validator and the pod-file reader
 * (`file-parameters.ts`, imported by the install door) share the one rule
 * without pulling the builtin verb registry into every importer.
 */

// The rule itself lives in `@synap-core/types/find` (pure, read by every
// surface's `bindContext` too); re-exported so this leaf stays the api's door.
export { looksLikeJsonSchema } from "@synap-core/types/find";
