/**
 * CROSS-REPO tripwire — every Synap app id is a reserved pod name.
 *
 * WHY (security review A2, #94): a Synap app (`isSynapApp`, an exact
 * `https://<id>.synap.live` origin) gets a token HELD BY THE PERSON who
 * consents (`app_person`, services/app-person-token.ts). The Control Plane
 * names pods, and a legacy flat pod holds `<name>.synap.live`: a pod named
 * `content-studio` would answer on the official app's own origin and be
 * handed the person's token. So no pod may take an app id — the CP's
 * `RESERVED_SUBDOMAINS` must hold every one of `SYNAP_APP_IDS`.
 *
 * HOW (derived, never a hand copy): the pod's list is IMPORTED here. The CP
 * cannot import it, so it mirrors it (`src/lib/synap-app-ids.ts`) and its
 * `RESERVED_SUBDOMAINS` spreads that mirror. Read from the CP checkout:
 *  1. the mirror equals `SYNAP_APP_IDS` (as sets);
 *  2. the reserved set — its string literals, plus the mirror when the file
 *     imports it from `./synap-app-ids` and spreads `...SYNAP_APP_IDS` —
 *     holds every id.
 * The CP pins the same pair from its side (`src/lib/synap-app-ids.test.ts`,
 * which also checks the runtime set).
 *
 * The guard fails in THIS repo because the list is edited here: adding an
 * app id to `SYNAP_APP_IDS` turns it red until the CP reserves the name.
 * CI lays the CP out beside this checkout, so there an absent CP fails;
 * only a developer machine with no CP clone skips, with the reason printed.
 *
 * WHAT IT DOES NOT SEE (stated): a pod that ALREADY holds an app id (a row
 * made before the name was reserved), and a pod's `custom_domain` set to an
 * app's host. Reserving a name refuses new pods only.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  siblingCheckout,
  siblingRequired,
  siblingSkipReason,
} from "../../../../scripts/sibling-checkout.mjs";
import { SYNAP_APP_IDS } from "../routers/oauth/config.js";

const CP_ROOT = siblingCheckout("synap-control-plane-api");
const CP_LIB = join(
  CP_ROOT ?? "<no synap-control-plane-api checkout>",
  "src/lib"
);
const CP_MIRROR = join(CP_LIB, "synap-app-ids.ts");
const CP_RESERVED = join(CP_LIB, "reserved-subdomains.ts");

const runGuard = CP_ROOT !== null || siblingRequired();
if (!runGuard) {
  console.warn(
    siblingSkipReason("synap-control-plane-api", "synap-app-ids-reserved")
  );
}

/** The string literals of the array that follows `declaration`. */
function arrayLiterals(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`not found in source: ${declaration}`);
  const open = source.indexOf("[", start + declaration.length);
  const close = source.indexOf("]", open);
  if (open === -1 || close === -1) {
    throw new Error(`no array literal after ${declaration}`);
  }
  const body = source.slice(open + 1, close).replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

function cpMirror(): string[] {
  return arrayLiterals(
    readFileSync(CP_MIRROR, "utf8"),
    "export const SYNAP_APP_IDS ="
  );
}

/** What the CP's RESERVED_SUBDOMAINS holds, as its source builds it. */
function cpReserved(): Set<string> {
  const src = readFileSync(CP_RESERVED, "utf8");
  const declaration = "export const RESERVED_SUBDOMAINS = new Set";
  const reserved = new Set(arrayLiterals(src, declaration));
  const start = src.indexOf(declaration);
  const body = src.slice(start, src.indexOf("]", start));
  const importsMirror =
    /import\s*\{[^}]*\bSYNAP_APP_IDS\b[^}]*\}\s*from\s*["']\.\/synap-app-ids["']/.test(
      src
    );
  if (importsMirror && /\.\.\.\s*SYNAP_APP_IDS\b/.test(body)) {
    for (const id of cpMirror()) reserved.add(id);
  }
  return reserved;
}

describe.runIf(runGuard)("every Synap app id is a reserved pod name", () => {
  it("can see the control plane's mirror and reserved set", () => {
    expect(
      existsSync(CP_MIRROR) && existsSync(CP_RESERVED),
      `Cannot find ${CP_MIRROR} or ${CP_RESERVED}. The CP must mirror ` +
        "SYNAP_APP_IDS and reserve every id (security review A2, #94)."
    ).toBe(true);
    // A parse that silently found nothing would pass the checks vacuously.
    expect(cpReserved().size).toBeGreaterThan(10);
    expect(SYNAP_APP_IDS.length).toBeGreaterThan(0);
  });

  it("the CP mirror equals SYNAP_APP_IDS", () => {
    expect([...cpMirror()].sort()).toEqual([...SYNAP_APP_IDS].sort());
  });

  it("the CP reserves every SYNAP_APP_IDS id as a pod name", () => {
    const reserved = cpReserved();
    const open = SYNAP_APP_IDS.filter((id) => !reserved.has(id));
    expect(
      open,
      "These Synap app ids are not reserved pod names in the control plane " +
        "(src/lib/reserved-subdomains.ts): a pod could take the app's origin " +
        "and receive the person's token."
    ).toEqual([]);
  });
});
