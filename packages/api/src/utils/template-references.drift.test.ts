/**
 * Drift guard for the command-template reference grammar.
 *
 * `template-references.ts` exists twice — here (runtime substitution) and at
 * `synap-app/packages/core/command-template/src/unresolved.ts` (browser
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
 * It skips in an isolated checkout where synap-app is not a sibling, and
 * retires itself if the synap-app copy becomes a re-export (cutover done).
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_COPY = join(HERE, "template-references.ts");
// utils → src → api → packages → synap-backend → <repo root>
const APP_COPY = join(
  HERE,
  "../../../../../synap-app/packages/core/command-template/src/unresolved.ts"
);

describe("template-references.ts — no drift between the two copies", () => {
  it("synap-app's unresolved.ts is byte-identical to the backend copy", () => {
    // A guard that silently passes when it cannot run is WORSE than no guard —
    // both file headers tell the reader the copies are byte-bound, so a quiet
    // skip in CI would make that claim false while looking green. synap-backend
    // and synap-app are separate repos, so a backend-only checkout is a real
    // scenario: it must be opted into explicitly, not inferred from absence.
    if (process.env.SYNAP_ISOLATED_CHECKOUT === "1") return;

    expect(
      existsSync(APP_COPY),
      `synap-app copy not found at ${APP_COPY}. This guard binds two copies of ` +
        "the grammar across repos; without the sibling checkout it cannot run. " +
        "Set SYNAP_ISOLATED_CHECKOUT=1 to acknowledge running without it."
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
      "synap-app/packages/core/command-template/src/unresolved.ts has drifted " +
        "from synap-backend's template-references.ts. The two must stay " +
        "byte-identical — copy one over the other (see the file headers)."
    ).toBe(readFileSync(OWN_COPY, "utf-8"));
  });
});
