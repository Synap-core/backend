/**
 * Drift guard for the command-template reference grammar.
 *
 * `template-references.ts` exists twice — here (runtime substitution) and at
 * `synap-app/packages/headless/src/command-template/unresolved.ts` (browser
 * authoring surfaces). Neither repo is a dependency of the other, so a single
 * shared module is not reachable today; see either file's header.
 *
 * Two hand-maintained copies with no guard is exactly how grammar #1 and
 * grammar #3 diverged in the first place. This test BINDS them: because the
 * file is deliberately dependency-free and written so neither copy names
 * itself, the copies can be compared BYTE FOR BYTE — no normalization, no
 * comment-stripping, no escape hatch through which a real behavioural change
 * could slip.
 *
 * It finds synap-app through `scripts/sibling-checkout.mjs`. CI does not
 * provide that checkout, so this is a LOCAL guard (like the other synap-app
 * guards): without the sibling it skips with the reason printed. A sibling
 * that exists but lost the file fails. Once the synap-app copy becomes a
 * re-export (cutover done), delete this test on purpose.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  siblingCheckout,
  siblingSkipReason,
} from "../../../../scripts/sibling-checkout.mjs";

const OWN_COPY = join(import.meta.dirname, "template-references.ts");
const SYNAP_APP = siblingCheckout("synap-app");
const APP_COPY = join(
  SYNAP_APP ?? "<no synap-app checkout>",
  "packages/headless/src/command-template/unresolved.ts"
);
if (!SYNAP_APP) {
  console.warn(siblingSkipReason("synap-app", "template-references-drift"));
}

describe("template-references.ts — no drift between the two copies", () => {
  it.runIf(SYNAP_APP !== null)(
    "synap-app's unresolved.ts is byte-identical to the backend copy",
    () => {
      expect(
        existsSync(APP_COPY),
        `synap-app copy not found at ${APP_COPY}. The checkout is there but the ` +
          "file it binds is gone — if the copies were merged behind a shared " +
          "module, DELETE this test deliberately."
      ).toBe(true);

      const appSrc = readFileSync(APP_COPY, "utf-8");
      // Renaming the function in the app copy must not silently retire the guard.
      expect(
        /function findUnresolvedReferences/.test(appSrc),
        "synap-app's unresolved.ts no longer defines findUnresolvedReferences. If " +
          "the copies were genuinely merged behind a shared module, DELETE this " +
          "test deliberately — do not let it pass by not finding what it guards."
      ).toBe(true);

      expect(
        appSrc,
        "synap-app/packages/headless/src/command-template/unresolved.ts has drifted " +
          "from synap-backend's template-references.ts. The two must stay " +
          "byte-identical — copy one over the other (see the file headers)."
      ).toBe(readFileSync(OWN_COPY, "utf-8"));
    }
  );
});
