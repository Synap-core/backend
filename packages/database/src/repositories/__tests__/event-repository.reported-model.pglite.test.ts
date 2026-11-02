/**
 * 0389 — every event a request appends carries the model and provider its
 * client REPORTED (`X-Synap-Model` / `X-Synap-Model-Provider`, entered by
 * `runWithReportedModel`), stamped at the ONE append floor, as REAL SQL on
 * PGlite against the baseline's own `events` table.
 *
 * Rows that rule out a wrong rule:
 *  - no report → both columns NULL (unknown, never "anthropic");
 *  - an oversized or URL-shaped model → NULL; an unlisted provider → `other`
 *    (the raw word is never stored);
 *  - an event that carries its OWN pair (a Hub agent run; a metered capability
 *    run whose provider is the capability's) keeps it whole, never mixed with
 *    the request's.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { SynapEvent } from "@synap-core/core";
import { EventRepository } from "../event-repository.js";
import { runWithReportedModel } from "../../utils/request-write-context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = readFileSync(
  resolve(HERE, "../../../migrations/0000_baseline_schema.sql"),
  "utf8"
);

let pg: PGlite;
let repo: EventRepository;

beforeAll(async () => {
  const start = BASELINE.indexOf('CREATE TABLE IF NOT EXISTS "events" (');
  expect(start).toBeGreaterThan(-1);
  const create = BASELINE.slice(start, BASELINE.indexOf("\n);", start) + 3);
  pg = new PGlite();
  await pg.exec(create);
  repo = new EventRepository({
    unsafe: async (sql: string, params: unknown[]) =>
      (await pg.query(sql, params)).rows,
  } as never);
});

const event = (own: Partial<SynapEvent> = {}): SynapEvent =>
  ({
    id: randomUUID(),
    version: "v1",
    type: "entity.update.completed",
    subjectId: randomUUID(),
    subjectType: "entity",
    data: {},
    userId: "user-1",
    source: "api",
    timestamp: new Date(),
    ...own,
  }) as SynapEvent;

async function stored(id: string) {
  const r = await pg.query<{ model: string | null; provider: string | null }>(
    "SELECT model, provider FROM events WHERE id = $1",
    [id]
  );
  return r.rows[0];
}

async function appendAs(
  model: string | undefined,
  provider: string | undefined,
  own: Partial<SynapEvent> = {}
) {
  const e = event(own);
  await runWithReportedModel(model, provider, () => repo.append(e));
  return stored(e.id);
}

describe("events carry the model and provider the request's client reported (0389)", () => {
  it("a reported pair is stamped on the request's event", async () => {
    expect(await appendAs("glm-4.6", "zai")).toEqual({
      model: "glm-4.6",
      provider: "zai",
    });
    expect(await appendAs("claude-opus-5-5", undefined)).toEqual({
      model: "claude-opus-5-5",
      provider: null,
    });
  });

  it("nothing reported reads unknown, never anthropic", async () => {
    const e = event();
    await repo.append(e);
    expect(await stored(e.id)).toEqual({ model: null, provider: null });
    expect(await appendAs(undefined, "  ")).toEqual({
      model: null,
      provider: null,
    });
  });

  it("junk is bounded: an oversized or URL model is dropped, an unlisted provider reads other", async () => {
    expect(await appendAs("m".repeat(129), "groq")).toEqual({
      model: null,
      provider: "other",
    });
    expect(
      await appendAs("https://api.z.ai/api/anthropic", "https://api.z.ai")
    ).toEqual({ model: null, provider: "other" });
  });

  it("an event that carries its own pair keeps it whole", async () => {
    // A metered capability run: the provider is the capability's, no model.
    expect(
      await appendAs("glm-4.6", "zai", { provider: "firecrawl" } as never)
    ).toEqual({ model: null, provider: "firecrawl" });
    // A Hub agent run names both.
    expect(
      await appendAs("glm-4.6", "zai", {
        model: "gpt-5",
        provider: "openai",
      } as never)
    ).toEqual({ model: "gpt-5", provider: "openai" });
  });
});
