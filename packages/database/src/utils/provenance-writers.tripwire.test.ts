/**
 * TRIPWIRE: catalog capabilities record HOW a record arrived as `provenance`
 * (a value of the closed `PROVENANCE_VALUES`) and WHO it came from as
 * `provider` — never as `source` (decision 2026-09-14, `provenance.ts`).
 *
 * The defect this guards: eight connector capabilities wrote
 * `source: '<provider>'` into `propose.entity` properties. When `source`
 * carried an enum, every one of those writes was refused at APPROVAL — after
 * the provider had already run (a fal generation was billed, then 422). A
 * `provenance` value outside the enum would fail the same way, so both are
 * checked here, at authoring time, instead of on a person's approve click.
 *
 * Scans every `capabilities/*.capability.json` of the sibling synap-app
 * catalog (derived, never hand-listed). Skips with a logged reason when the
 * sibling checkout is absent (CI checks out this repo alone — a LOCAL guard).
 *
 * NOT covered: a writer that builds the key dynamically (`[key]: v`), or one
 * outside the catalog (pod-local skills). `arch-client-intelligence` is
 * excluded: it is parked by founder decision (2026-10-12).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVENANCE_VALUES } from "./provenance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPS = resolve(
  HERE,
  "../../../../../synap-app/packages/workspace-templates/capabilities"
);
const PARKED = new Set(["arch-client-intelligence.capability.json"]);

const SOURCE_WRITE = /\bsource: ?'([^']*)'/g;
const PROVENANCE_WRITE = /\bprovenance: ?'([^']*)'/g;

function scan(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1]!);
}

const present = existsSync(CAPS);
if (!present)
  console.warn(
    `[provenance-writers] SKIP: no catalog checkout at ${CAPS} — writers cannot be checked here`
  );

describe.runIf(present)(
  "catalog capabilities write provenance, never source",
  () => {
    const files = present
      ? readdirSync(CAPS).filter((f) => f.endsWith(".capability.json"))
      : [];
    const texts = files.map((f) => ({
      f,
      text: readFileSync(join(CAPS, f), "utf8"),
    }));

    it("non-vacuity: the scan sees the catalog and its connector writers", () => {
      expect(files.length).toBeGreaterThan(20);
      const writers = texts.filter(
        (t) => scan(t.text, PROVENANCE_WRITE).length
      );
      expect(writers.map((t) => t.f)).toEqual(
        expect.arrayContaining([
          "fal-ai.capability.json",
          "fal-media-lab.capability.json",
          "cal-com.capability.json",
        ])
      );
      // The patterns can still see what they hunt.
      expect(scan(`{ url, source: 'fal.ai' }`, SOURCE_WRITE)).toEqual([
        "fal.ai",
      ]);
      expect(scan(`{ provenance:'connector' }`, PROVENANCE_WRITE)).toEqual([
        "connector",
      ]);
    });

    it("no capability writes `source: '<value>'`", () => {
      const offenders = texts
        .filter((t) => !PARKED.has(t.f))
        .flatMap((t) => scan(t.text, SOURCE_WRITE).map((v) => `${t.f}: ${v}`));
      expect(offenders).toEqual([]);
    });

    it("every `provenance` a capability writes is a declared value", () => {
      const allowed = new Set<string>(PROVENANCE_VALUES);
      const offenders = texts.flatMap((t) =>
        scan(t.text, PROVENANCE_WRITE)
          .filter((v) => !allowed.has(v))
          .map((v) => `${t.f}: ${v}`)
      );
      expect(offenders).toEqual([]);
    });
  }
);
