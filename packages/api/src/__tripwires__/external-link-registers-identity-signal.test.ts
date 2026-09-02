/**
 * TRIPWIRE — every writer of `entity_external_links` must also register the
 * `external_id` identity signal.
 *
 * `EntityUpsertService.upsert` Step 2 looks an import up as a STRONG signal
 * `{ type: "external_id", value: `${source}:${externalId}` }` through
 * `resolveIdentity`. That read only ever hits rows some writer put in
 * `entity_identity_signals` — the external-links row itself is invisible to the
 * resolver.
 *
 * There are TWO insert doors for `entity_external_links`:
 *   - api/src/utils/entity-link-idempotency.ts  (capture/import idempotency)
 *   - database/src/services/entity-upsert-service.ts (`registerExternalLink`,
 *     the connector/import path)
 * and for a while only the FIRST registered the signal — so a link created by
 * the connector path was invisible to identity resolution, in the very service
 * that performs the lookup. Same subject, two write doors, one populating the
 * index the other queries.
 *
 * Derived, not hand-listed: the writer set is discovered by scanning both
 * packages for `.insert(entityExternalLinks)`, so a THIRD door added tomorrow is
 * caught here rather than shipping half-wired. A size floor guards against a
 * broken extraction passing vacuously.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(here, "..");
const DATABASE_SRC = join(here, "..", "..", "..", "database", "src");

const WHY_IT_MATTERS =
  "A door that inserts into entity_external_links but never calls " +
  "registerIdentitySignals creates a link that resolveIdentity CANNOT see: the " +
  "resolver reads entity_identity_signals, not entity_external_links. The next " +
  "import of the same (provider, externalId) then fails to match and creates a " +
  "DUPLICATE entity. Add the same registerIdentitySignals({ type: 'external_id', " +
  "value: `${provider}:${externalId}` }) call this door's sibling makes.";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "dist" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Files that INSERT an external-link row — the set that must also index it. */
function externalLinkWriters(): string[] {
  return [...walk(API_SRC), ...walk(DATABASE_SRC)].filter((f) =>
    readFileSync(f, "utf8").includes(".insert(entityExternalLinks)")
  );
}

/**
 * The rest of the block ENCLOSING `idx` — brace-matched forward until the
 * enclosing function/method closes. Scoping to the writer's own body is
 * load-bearing: `entity-upsert-service.ts` also contains the READ site and a
 * sibling `registerIdentitySignals` call, so a whole-file grep passes even when
 * the writer itself registers nothing (verified: it did).
 */
function enclosingBlockTail(src: string, idx: number): string {
  let depth = 0;
  for (let i = idx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      if (depth === 0) return src.slice(idx, i);
      depth--;
    }
  }
  return src.slice(idx);
}

/**
 * The key shape both writers and the reader must agree on byte-for-byte:
 * `external_id` + a `provider:externalId` template literal.
 */
const EXTERNAL_ID_SIGNAL_KEY =
  /type:\s*"external_id",\s*\n?\s*value:\s*`\$\{[A-Za-z0-9_.]+\}:\$\{[A-Za-z0-9_.]+\}`/;

describe("tripwire: every entity_external_links writer registers the external_id signal", () => {
  const writers = externalLinkWriters();

  it("finds the known write doors (extraction is not vacuous)", () => {
    const rel = writers.map((f) => relative(join(here, "..", "..", ".."), f));
    // Floor: fewer than two means the scan broke, not that a door vanished.
    expect(
      writers.length,
      `expected at least the two known external-link write doors, found: ${rel.join(", ")}`
    ).toBeGreaterThanOrEqual(2);
    expect(
      rel.some((f) => f.endsWith("utils/entity-link-idempotency.ts"))
    ).toBe(true);
    expect(
      rel.some((f) => f.endsWith("services/entity-upsert-service.ts"))
    ).toBe(true);
  });

  it("each writer also calls registerIdentitySignals with the external_id key", () => {
    const offenders: string[] = [];
    for (const file of writers) {
      const src = readFileSync(file, "utf8");
      const body = enclosingBlockTail(
        src,
        src.indexOf(".insert(entityExternalLinks)")
      );
      if (
        !body.includes("registerIdentitySignals(") ||
        !EXTERNAL_ID_SIGNAL_KEY.test(body)
      ) {
        offenders.push(relative(join(here, "..", "..", ".."), file));
      }
    }
    expect(offenders, `${offenders.join(", ")} — ${WHY_IT_MATTERS}`).toEqual(
      []
    );
  });

  it("the reader looks up the same key shape the writers store", () => {
    const src = readFileSync(
      join(DATABASE_SRC, "services", "entity-upsert-service.ts"),
      "utf8"
    );
    // SCOPED to Step 2's own `lookupSignals` block. Matching the whole file
    // would pass on the WRITER's key at `registerExternalLink` even with the
    // reader deleted — the same vacuity `enclosingBlockTail` exists to prevent.
    const at = src.indexOf("const lookupSignals");
    expect(at, "Step 2's lookupSignals declaration not found").toBeGreaterThan(
      -1
    );
    const readBlock = src.slice(at, src.indexOf("lookupSignals.length", at));
    expect(
      readBlock,
      "EntityUpsertService Step 2 must look up `${source}:${externalId}` as an external_id signal"
    ).toMatch(EXTERNAL_ID_SIGNAL_KEY);
  });

  it("external_id normalization stays trim-only (never lowercased)", () => {
    // If the normalizer lowercased, a case-significant provider id written by
    // one door would not match the other's read — the same severance by a
    // different mechanism.
    const src = readFileSync(
      join(DATABASE_SRC, "services", "identity-resolution-service.ts"),
      "utf8"
    );
    const at = src.indexOf('case "external_id":');
    expect(
      at,
      "external_id case not found in normalizeIdentitySignal"
    ).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("default:", at));
    expect(
      body,
      "external_id must be returned trimmed-only; lowercasing it would break the write/read agreement"
    ).toMatch(/return v;/);
    expect(body).not.toMatch(/toLowerCase/);
  });
});
