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
    if (!existsSync(APP_COPY)) {
      // Isolated checkout (synap-app not a sibling). Nothing to bind against.
      console.warn(
        `[drift] synap-app copy not found at ${APP_COPY} — skipping cross-repo drift check.`
      );
      return;
    }

    const appSrc = readFileSync(APP_COPY, "utf-8");
    if (!/function findUnresolvedReferences/.test(appSrc)) {
      // Cutover done: the app copy re-exports a shared module.
      console.warn(
        "[drift] synap-app unresolved.ts has no findUnresolvedReferences body — appears to re-export (cutover complete); drift check retired."
      );
      return;
    }

    expect(
      appSrc,
      "synap-app/packages/core/command-template/src/unresolved.ts has drifted " +
        "from synap-backend's template-references.ts. The two must stay " +
        "byte-identical — copy one over the other (see the file headers)."
    ).toBe(readFileSync(OWN_COPY, "utf-8"));
  });
});
