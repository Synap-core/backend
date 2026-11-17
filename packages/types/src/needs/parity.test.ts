/**
 * PARITY: the need vocabulary this mirror declares === the pod's seeded rows.
 *
 * `src/needs/index.ts` is a HAND MIRROR of the pod's `needs` table (rows in
 * SQL, a list in TypeScript); this test re-derives the seed migration SQL and
 * fails the moment the two disagree on a slug, its intents or its aliases.
 * SAMENESS, never correctness. Read by path, not by import (no dependency on
 * the database package); skips cleanly where synap-backend is absent.
 *
 * It also pins the behaviour of the ref parser every reader shares
 * (`need:<slug>[/<intent>]`), and that every intent a need groups is a slug
 * of the intent vocabulary.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NEEDS,
  NEED_SLUGS,
  NEED_SLUG_RE,
  canonicalNeedSlug,
  declaredNeedsOf,
  isKnownNeed,
  needRefIntents,
  needRefProblem,
  needRefsOf,
  parseNeedRef,
  unknownNeeds,
} from "./index.js";
import { isKnownIntent } from "../capability-intents/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/needs → src → types → packages → synap-backend
const MIGRATIONS_DIR = join(HERE, "../../../../packages/database/migrations");
const MIGRATIONS = [join(MIGRATIONS_DIR, "0426_needs.sql")];
const haveMigrations = MIGRATIONS.every((m) => existsSync(m));

interface SeededNeed {
  slug: string;
  intents: string[];
  aliases: string[];
}

const arrayOf = (body: string) =>
  [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]!);

/** The rows the pod seeds, read out of the `INSERT INTO "needs"` VALUES. */
function deriveSeededNeeds(): SeededNeed[] {
  const out: SeededNeed[] = [];
  for (const migration of MIGRATIONS) {
    const sql = readFileSync(migration, "utf8");
    const start = sql.indexOf('INSERT INTO "needs"');
    expect(start, `no needs INSERT in ${migration}`).toBeGreaterThan(0);
    const insert = sql.slice(start, sql.indexOf("ON CONFLICT", start));
    for (const m of insert.matchAll(
      /\(\s*'([a-z][a-z0-9-]*)'\s*,\s*'[^']*'\s*,\s*'[^']*'\s*,\s*ARRAY\[([^\]]*)\]\s*,\s*ARRAY\[([^\]]*)\](?:::text\[\])?\s*\)/g
    )) {
      out.push({
        slug: m[1]!,
        intents: arrayOf(m[2]!),
        aliases: arrayOf(m[3]!),
      });
    }
  }
  return out;
}

describe("need vocabulary parity — mirror === the pod's seeded needs", () => {
  it("non-vacuity: a real, distinct, well-formed list", () => {
    expect(NEEDS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(NEED_SLUGS).size).toBe(NEED_SLUGS.length);
    for (const n of NEEDS) {
      expect(n.slug).toMatch(NEED_SLUG_RE);
      expect(n.intents.length, n.slug).toBeGreaterThan(0);
      // Every intent a need groups is a slug of the intent vocabulary.
      for (const i of n.intents)
        expect(isKnownIntent(i), `${n.slug}:${i}`).toBe(true);
    }
    // No alias shadows a slug or another alias: a name resolves to ONE need.
    const names = [...NEED_SLUGS, ...NEEDS.flatMap((n) => n.aliases)];
    expect(new Set(names).size).toBe(names.length);
  });

  it.skipIf(!haveMigrations)(
    "the mirrored needs match the pod's seeded rows (slug, intents, aliases)",
    () => {
      const seeded = deriveSeededNeeds();
      expect(seeded.length).toBeGreaterThanOrEqual(12);
      expect(seeded).toEqual(
        NEEDS.map((n) => ({
          slug: n.slug,
          intents: [...n.intents],
          aliases: [...n.aliases],
        }))
      );
    }
  );
});

describe("need refs — the one parser every reader shares", () => {
  it("parses need:<slug> and need:<slug>/<intent>, and refuses the rest", () => {
    expect(parseNeedRef("need:code-host")).toEqual({
      need: "code-host",
      intent: null,
    });
    expect(parseNeedRef("need:gate/fetch_record")).toEqual({
      need: "gate",
      intent: "fetch_record",
    });
    expect(parseNeedRef("code-host")).toBeNull();
    expect(parseNeedRef("fetch_record")).toBeNull();
    expect(parseNeedRef("need:")).toBeNull();
    expect(parseNeedRef("need:Code")).toBeNull();
    expect(parseNeedRef(42)).toBeNull();
  });

  it("an alias resolves to its slug; an unknown name to nothing", () => {
    expect(canonicalNeedSlug("git-host")).toBe("code-host");
    expect(canonicalNeedSlug("code-host")).toBe("code-host");
    expect(canonicalNeedSlug("nope")).toBeNull();
    expect(isKnownNeed("ci")).toBe(true);
    expect(isKnownNeed("nope")).toBe(false);
    expect(unknownNeeds(["gate", "nope", "ci", "nope"])).toEqual(["nope"]);
  });

  it("says what is wrong with a ref, and nothing about a good one", () => {
    expect(needRefProblem("need:gate")).toBeNull();
    expect(needRefProblem("need:gate/fetch_record")).toBeNull();
    expect(needRefProblem("need:nope")).toMatch(/names no need/);
    expect(needRefProblem("need:gate/publish_post")).toMatch(/does not group/);
    expect(needRefProblem("need")).toMatch(/not a need ref/);
  });

  it("a ref asks for its one intent, or every intent of the need", () => {
    expect(needRefIntents({ need: "gate", intent: null })).toEqual([
      "run_external_job",
      "fetch_record",
    ]);
    expect(needRefIntents({ need: "ci", intent: "fetch_record" })).toEqual([
      "fetch_record",
    ]);
    expect(needRefIntents({ need: "gate", intent: "publish_post" })).toEqual(
      []
    );
    expect(needRefIntents({ need: "nope", intent: null })).toEqual([]);
  });

  it("a space declares the needs its playbooks name, everywhere they name one", () => {
    const playbook = {
      tools: ["get_entity", "need:code-host", "fetch_record"],
      requires: ["media-ffmpeg", "need:deploy-target"],
      criteria: [
        { check: { kind: "capability", capability: "need:gate/fetch_record" } },
      ],
      stages: [
        { key: "a", tools: ["need:git-host"], requires: ["need:file-store"] },
        { key: "b", criteria: [{ check: { capability: "need:payments" } }] },
        null,
      ],
    };
    expect(needRefsOf(playbook)).toEqual([
      "need:code-host",
      "need:deploy-target",
      "need:gate/fetch_record",
      "need:git-host",
      "need:file-store",
      "need:payments",
    ]);
    // Canonical slugs, each once; an unknown one is kept to be reported.
    expect(
      declaredNeedsOf([playbook, { tools: ["need:mystery", "need:code-host"] }])
    ).toEqual([
      "code-host",
      "deploy-target",
      "gate",
      "file-store",
      "payments",
      "mystery",
    ]);
    expect(declaredNeedsOf([{ tools: "need:code-host" }, {}])).toEqual([]);
  });
});
