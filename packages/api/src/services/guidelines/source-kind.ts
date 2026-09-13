/**
 * THE `sourceKind` VOCABULARY GATE for guidelines — a capture input kind
 * (`GUIDELINE_SOURCE_KINDS`), or `import:<IMPORT_SOURCE_VALUES>`.
 *
 * Lives in services (not the tRPC router that used to own it) so every door —
 * the tRPC write door, the Hub read door, the correction paths — imports it
 * DOWNWARD. Not in `@synap/database` because that package does not depend on
 * `@synap-core/types`, where the import vocabulary lives.
 */

import {
  GUIDELINE_SOURCE_KINDS,
  IMPORT_SOURCE_KIND_PREFIX,
} from "@synap/database";
import { IMPORT_SOURCE_VALUES } from "@synap-core/types";

export function isGuidelineSourceKind(ref: string | null | undefined): boolean {
  if (!ref) return false;
  if ((GUIDELINE_SOURCE_KINDS as readonly string[]).includes(ref)) return true;
  return (
    ref.startsWith(IMPORT_SOURCE_KIND_PREFIX) &&
    (IMPORT_SOURCE_VALUES as readonly string[]).includes(
      ref.slice(IMPORT_SOURCE_KIND_PREFIX.length)
    )
  );
}
