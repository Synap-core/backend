/**
 * The command-template reference grammar lives in `@synap-core/types`
 * (`text-template/references.ts`), the one implementation every runtime
 * imports. This file keeps the api's historical import path.
 */
export {
  REF_ARG,
  REF_BARE_ARG,
  REF_CONTEXT,
  REF_ENTITY,
  REF_LEGACY_ARG,
  REF_LEGACY_SELECTION,
  findUnresolvedReferences,
  type UnresolvedReference,
  type UnresolvedReferenceKind,
} from "@synap-core/types/text-template";
