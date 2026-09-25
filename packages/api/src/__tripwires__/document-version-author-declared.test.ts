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

/** Every `claimDocumentRevision(…)` call, paren-matched, verbatim. */
function claimCalls(src: string): string[] {
  const out: string[] = [];
  const re = /\bclaimDocumentRevision\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        out.push(src.slice(m.index, i + 1));
        break;
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

  /**
   * Helpers an insert may SPREAD its author from. Each returns
   * `{ author: DocumentVersionAuthor, … }` (typed), and its own literals are
   * checked below like an insert's: a spread is named, never trusted blind.
   */
  const AUTHOR_HELPERS: Record<string, string> = {
    initialVersionAuthor:
      "packages/database/src/repositories/document-repository.ts",
  };
  const helperBody = (name: string): string => {
    const src = readFileSync(join(BACKEND, AUTHOR_HELPERS[name]!), "utf8");
    const start = src.indexOf(`export function ${name}(`);
    expect(start, `${name} is no longer declared where named`).toBeGreaterThan(
      -1
    );
    // Skip the parameter list and a `{ … }` return type: the body opens at
    // the first `{` that ends a line.
    const open = src.indexOf("{\n", src.indexOf(")", start) + 1);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
    }
    return "";
  };

  it("every insert site names `author` (literally, or by spreading a named helper)", () => {
    const spreadsHelper = (body: string) =>
      Object.keys(AUTHOR_HELPERS).some((h) =>
        new RegExp(`\\.\\.\\.${h}\\(`).test(body)
      );
    const missing = sites
      .filter((s) => !/\bauthor:/.test(s.body) && !spreadsHelper(s.body))
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
    // the reviewer's id for an agent-drafted edit. Since W4a the row is cut by
    // the content-write door (`claimDocumentRevision`), so the author B3 names
    // is the one it PASSES to the door — scanned from that call.
    const src = readFileSync(
      join(BACKEND, "packages/api/src/routers/proposals/apply-approval.ts"),
      "utf8"
    );
    const call = claimCalls(src);
    expect(
      call.length,
      "apply-approval.ts no longer writes a document through claimDocumentRevision"
    ).toBeGreaterThanOrEqual(1);
    expect(
      call.some((c) =>
        /authorKind:\s*"ai",\s*authorId:\s*proposal\.agentUserId/.test(c)
      ),
      "the accepted-AI-edit checkpoint must name the drafting agent"
    ).toBe(true);
  });

  it("every author a named helper returns is in DOCUMENT_VERSION_AUTHORS", () => {
    for (const name of Object.keys(AUTHOR_HELPERS)) {
      const literals = authorLiterals(helperBody(name));
      expect(
        literals.length,
        `${name} returns no author literal`
      ).toBeGreaterThan(0);
      for (const l of literals)
        expect(
          DOCUMENT_VERSION_AUTHORS as readonly string[],
          `${name}: ${l}`
        ).toContain(l);
    }
  });

  it("every `authorKind` literal passed to the content-write door is in DOCUMENT_VERSION_AUTHORS", () => {
    // The door inserts the row with the author it is given, so the literals
    // at its call sites are what reaches `document_versions.author`.
    const literals: string[] = [];
    for (const pkg of SCANNED) {
      for (const full of walk(join(BACKEND, "packages", pkg, "src"))) {
        for (const c of claimCalls(readFileSync(full, "utf8"))) {
          for (const m of c.matchAll(/\bauthorKind:\s*"([^"]*)"/g))
            literals.push(`${full.slice(BACKEND.length)}: ${m[1]}`);
        }
      }
    }
    // Non-vacuity: the known callers (section, approval, update, snapshot,
    // restore, backfill) name their author literally.
    expect(literals.length).toBeGreaterThanOrEqual(5);
    const offenders = literals.filter(
      (l) =>
        !(DOCUMENT_VERSION_AUTHORS as readonly string[]).includes(
          l.split(": ").pop()!
        )
    );
    expect(offenders).toEqual([]);
  });
});
