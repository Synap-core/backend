/**
 * TRIPWIRE — every `document_versions` insert stamps `author` from the DECLARED
 * set, and the set is exactly what the schema declares.
 *
 * THE DEFECT THIS PINS: `apply-approval.ts` branch B3 mints the version row for
 * an ACCEPTED AI EDIT. It stamped `author: "user"` with the reviewing human's
 * id — so the agent that wrote the text vanished from the provenance rail and
 * the row asserted the human had typed it. That is not a missing feature; it is
 * a durable lie in the one table document history reads.
 *
 * Why a SOURCE scan and not a type check: `author` is a `text` column, and
 * every wrong value here typechecks perfectly. The `$type<DocumentVersionAuthor>()`
 * annotation catches a bare literal, but not a value spread in from a helper,
 * not a `String(x)`, and not a fifth writer added in another package that
 * imports the table directly. Ten insert sites across four packages is exactly
 * the shape that drifts.
 *
 * Two assertions, and both matter:
 *   1. every insert site names `author` — an omitted NOT NULL column fails at
 *      RUNTIME, on a user's save, not in CI;
 *   2. every literal it stamps is in `DOCUMENT_VERSION_AUTHORS` — so a writer
 *      inventing `"agent"` or `"assistant"` for the concept `"ai"` already
 *      names is caught while it is one line, not after six surfaces read it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { DOCUMENT_VERSION_AUTHORS } from "@synap/database/schema";

const BACKEND = fileURLToPath(new URL("../../../..", import.meta.url));

/** The packages that may write a document version. */
const SCANNED = ["api", "jobs", "database", "realtime"];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.includes(".test.")
    )
      yield full;
  }
}

interface InsertSite {
  file: string;
  /** The brace-matched `.values({ … })` argument, verbatim. */
  body: string;
}

/**
 * Every `.insert(documentVersions).values({ … })` on disk, with the values
 * object taken by brace matching so a nested object or a spread ternary (B3
 * stamps its author inside one) is captured whole rather than truncated at the
 * first newline.
 */
function scanInsertSites(): InsertSite[] {
  const out: InsertSite[] = [];
  for (const pkg of SCANNED) {
    const root = join(BACKEND, "packages", pkg, "src");
    for (const full of walk(root)) {
      const src = readFileSync(full, "utf8");
      const re =
        /\.insert\(\s*documentVersions\s*\)[\s\S]{0,80}?\.values\(\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (let i = end; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}" && --depth === 0) {
            end = i;
            break;
          }
        }
        out.push({
          file: full.slice(BACKEND.length).replace(/\\/g, "/"),
          body: src.slice(m.index, end + 1),
        });
      }
    }
  }
  return out;
}

/** Every `author: "…"` string literal inside one values object. */
function authorLiterals(body: string): string[] {
  return [...body.matchAll(/\bauthor:\s*"([^"]*)"/g)].map((m) => m[1]);
}

describe("TRIPWIRE: document_versions.author is stamped from the declared set", () => {
  const sites = scanInsertSites();

  it("finds the insert sites (the corpus is not empty)", () => {
    // A corpus tripwire must prove its corpus: zero sites means the regex
    // stopped matching, not that the codebase stopped writing versions.
    expect(sites.length).toBeGreaterThanOrEqual(8);
  });

  it("every insert site names `author`", () => {
    const missing = sites
      .filter((s) => !/\bauthor:/.test(s.body))
      .map((s) => s.file);
    expect(
      missing,
      "these `.insert(documentVersions)` sites omit `author`, a NOT NULL " +
        "column — the failure lands at runtime on a user's save:\n" +
        missing.join("\n")
    ).toEqual([]);
  });

  it("every stamped literal is in DOCUMENT_VERSION_AUTHORS", () => {
    const offenders: string[] = [];
    for (const s of sites) {
      for (const lit of authorLiterals(s.body)) {
        if (!(DOCUMENT_VERSION_AUTHORS as readonly string[]).includes(lit))
          offenders.push(`${s.file}: author: "${lit}"`);
      }
    }
    expect(
      offenders,
      "a document-version writer invented a value the declared set does not " +
        `carry (declared: ${DOCUMENT_VERSION_AUTHORS.join(" | ")}). Add it to ` +
        "DOCUMENT_VERSION_AUTHORS in packages/database/src/schema/documents.ts " +
        "and teach the readers, or use the value that already means this:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the AI-edit checkpoint stamps `ai`, not the accepting human", () => {
    // The specific regression: B3 must never go back to `author: "user"` with
    // the reviewer's id for an agent-drafted edit.
    const b3 = sites.find((s) =>
      s.file.endsWith("routers/proposals/apply-approval.ts")
    );
    expect(
      b3,
      "apply-approval.ts no longer inserts a document version"
    ).toBeDefined();
    expect(
      authorLiterals(b3!.body),
      "the accepted-AI-edit version must be able to name the drafting agent"
    ).toContain("ai");
  });
});
