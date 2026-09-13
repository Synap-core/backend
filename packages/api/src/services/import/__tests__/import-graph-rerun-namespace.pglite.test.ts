/**
 * A RERUN FILES ITS OWN import.graph PROPOSAL — the dedup key's namespace,
 * driven through the real stamp and the real lookup SQL on PGlite.
 *
 * Real: `buildImportGraphProposalData` (the stamp every import writer uses),
 * `findPriorImportGraphProposal` → `findPriorCaptureGraphProposal` (the real
 * owner floor incl. the `ownAgentUserIds` users subquery, the status +
 * type + `data->>'idempotencyKey'` predicate). The tables are generated from the
 * Drizzle definitions, so the lookup's `select()` sees every real column.
 *
 * Wiring (source scan, derived): every `findPriorImportGraphProposal(` and
 * `buildImportGraphProposalData(` call in `import-orchestrator.ts` forwards
 * `idempotencyNamespace`, and the rerun replayer passes it. Granularity is the
 * call site in that one file; `structuring.ts`'s own `proposeImportGraph`
 * writer takes no namespace (not a rerun path) and is NOT scanned.
 *
 * NOT covered: `ImportOrchestrator.analyze` end to end (IS + profiles) —
 * NEEDS-DOGFOOD.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals, users, type db as DatabaseHandle } from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { computeImportGraphIdempotencyKey } from "../../../utils/pending-capture-dedup.js";
import {
  buildImportGraphProposalData,
  findPriorImportGraphProposal,
  importGraphIdempotencyKey,
} from "../structuring.js";

const USER = "user-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

/** Every column of a real Drizzle table, nullable; enums/vectors as text. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const graph = (title: string): CompositeProposalOperation[] => [
  { op: "create_entity", ref: "e1", profileSlug: "note", title },
];

let client: PGlite;
let database: typeof DatabaseHandle;

async function fileProposal(opts: {
  status: string;
  operations: CompositeProposalOperation[];
  idempotencyNamespace?: string;
}): Promise<string> {
  const id = randomUUID();
  const data = buildImportGraphProposalData({
    operations: opts.operations,
    source: "markdown",
    sourceId: id,
    workspaceId: null,
    ...(opts.idempotencyNamespace
      ? { idempotencyNamespace: opts.idempotencyNamespace }
      : {}),
  });
  await client.query(
    `insert into proposals (id, created_by, status, proposal_type, data, created_at)
     values ($1, $2, $3, 'import.graph', $4::jsonb, now())`,
    [id, USER, opts.status, JSON.stringify(data)]
  );
  return id;
}

const lookup = (
  ops: CompositeProposalOperation[],
  idempotencyNamespace?: string
) =>
  findPriorImportGraphProposal(
    {
      userId: USER,
      workspaceId: null,
      operations: ops,
      ...(idempotencyNamespace ? { idempotencyNamespace } : {}),
    },
    database
  );

describe("import.graph idempotency namespace — a rerun files its own proposal", () => {
  beforeAll(async () => {
    client = new PGlite();
    await client.exec(ddlFor(proposals as unknown as PgTable));
    await client.exec(ddlFor(users as unknown as PgTable));
    database = drizzle(client) as unknown as typeof DatabaseHandle;
  });
  beforeEach(async () => {
    await client.exec("delete from proposals; delete from users;");
  });

  it("without a namespace the key is byte-identical to the content key (existing callers unchanged)", async () => {
    const ops = graph("Ada");
    expect(
      importGraphIdempotencyKey({ workspaceId: null, operations: ops })
    ).toBe(
      computeImportGraphIdempotencyKey({ workspaceId: null, operations: ops })
    );
    const parent = await fileProposal({
      status: "auto_approved",
      operations: ops,
    });
    expect(await lookup(ops)).toMatchObject({
      id: parent,
      status: "auto_approved",
    });
  });

  it("an add rerun of an AUTO-APPLIED import does not get the parent's proposal back", async () => {
    const ops = graph("Ada");
    const parent = await fileProposal({
      status: "auto_approved",
      operations: ops,
    });

    const inChild = await lookup(ops, "rerun:child-1");
    expect(inChild).toBeNull();

    // …so the child files its own, stamped under its namespace, and the parent
    // is still what an un-namespaced re-analyze resolves to.
    const child = await fileProposal({
      status: "pending",
      operations: ops,
      idempotencyNamespace: "rerun:child-1",
    });
    expect(child).not.toBe(parent);
    expect(await lookup(ops)).toMatchObject({
      id: parent,
      status: "auto_approved",
    });
  });

  it("a repeated analyze inside the SAME rerun session still dedups; another rerun does not", async () => {
    const ops = graph("Ada");
    const child = await fileProposal({
      status: "pending",
      operations: ops,
      idempotencyNamespace: "rerun:child-1",
    });
    expect(await lookup(ops, "rerun:child-1")).toMatchObject({
      id: child,
      status: "pending",
    });
    expect(await lookup(ops, "rerun:child-2")).toBeNull();
  });

  it("a degenerate graph stays keyless with a namespace (never a bare prefix key)", () => {
    expect(
      importGraphIdempotencyKey({
        operations: [],
        idempotencyNamespace: "rerun:x",
      })
    ).toBeNull();
    expect(
      buildImportGraphProposalData({
        operations: [],
        source: "markdown",
        sourceId: "s",
        idempotencyNamespace: "rerun:x",
      })
    ).not.toHaveProperty("idempotencyKey");
  });

  it("wiring: every orchestrator stamp + lookup forwards the namespace, and the rerun passes it", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "import-orchestrator.ts"),
      "utf8"
    );
    const calls = [
      ...src.matchAll(
        /(findPriorImportGraphProposal|buildImportGraphProposalData)\(\{([\s\S]*?)\n\s*\}\)/g
      ),
    ];
    // Non-vacuity: analyze + analyzeLarge each have one lookup and one stamp.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(
        call[2],
        `${call[1]} call does not forward idempotencyNamespace`
      ).toContain("idempotencyNamespace");
    }
    const rerun = readFileSync(
      join(__dirname, "..", "..", "focus-sessions", "rerun-session.ts"),
      "utf8"
    );
    expect(rerun).toMatch(
      /orchestrator\.analyze\(\{[\s\S]*?idempotencyNamespace: a\.idempotencyNamespace/
    );
  });
});
