/**
 * `searchEvents({ dataLines })` — the lens page's Happened prefilter, run as
 * REAL SQL on PGlite (not a string match on the builder): only the terminal
 * `.completed` fact of a record change or a lifecycle family survives, so a
 * page's LIMIT is never spent on governance phases or delivery attempts.
 *
 * Rows that rule out a wrong rule:
 *  - `app.request.requested` — a lifecycle family at a NON-terminal phase
 *    (the old prefilter admitted any phase of a lifecycle subject);
 *  - `webhooks.deliver.requested` — one row per delivery attempt (floods);
 *  - `entity.create.requested` — a record change's governance phase;
 *  - a four-segment type — never a line.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { EventRepository } from "../event-repository.js";

let pg: PGlite;
let repo: EventRepository;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE events (
    id text PRIMARY KEY,
    type text NOT NULL,
    subject_type text,
    subject_id text,
    user_id text,
    data jsonb,
    metadata jsonb,
    source text,
    timestamp timestamptz NOT NULL DEFAULT now()
  );`);
  const types = [
    "entity.create.completed",
    "entity.create.requested",
    "app.approve.completed",
    "app.request.requested",
    "apiKey.revoke.completed",
    "webhooks.deliver.requested",
    "webhook.deliver.completed",
    "connector.auth_expire.completed",
    "entity.update.completed.extra",
    "proposal.approve.validated",
  ];
  for (const [i, type] of types.entries()) {
    await pg.query(
      "INSERT INTO events (id, type, data) VALUES ($1, $2, '{}'::jsonb)",
      [`e${i}`, type]
    );
  }
  repo = new EventRepository({
    unsafe: async (sql: string, params: unknown[]) =>
      (await pg.query(sql, params)).rows,
  } as never);
});

describe("searchEvents dataLines — only the .completed fact reaches a page", () => {
  it("admits record changes and lifecycle families at .completed, nothing else", async () => {
    const rows = await repo.searchEvents({
      limit: 100,
      dataLines: {
        recordActions: ["create", "update"],
        lifecycleSubjects: ["app", "apiKey", "connector"],
      },
    });
    expect(rows.map((r) => r.eventType).sort()).toEqual(
      [
        "apiKey.revoke.completed",
        "app.approve.completed",
        "connector.auth_expire.completed",
        "entity.create.completed",
      ].sort()
    );
  });
});
