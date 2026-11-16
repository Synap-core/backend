/**
 * INSTALLATIONS READ FLOOR (0409) — what a person installed on their computers
 * is THEIRS: the installation, the URLs it is reachable at (bindings), the jobs
 * its computer ran. A SPACE's need binding (0426, no installation) is the
 * space's: its members read it, whoever set it.
 *
 * Predicate level, like two-user-floor.test.ts: build an AccessContext, compile
 * the WHERE the access layer emits for each table (PgDialect), and prove the
 * owner binding. An unregistered table throws in `scopedDb().predicate`, so the
 * first assertion is also the "is it registered at all" check.
 *
 * Shape of the floor:
 *   - installations / host_jobs, and an installation's binding: owner AND
 *     workspace lens (a NULL workspace stays owner-private), as box_runs. B
 *     can never read A's rows, whatever the lens.
 *   - a space's need binding (installation_id NULL): the space's membership
 *     lens only, no owner term (D3: filled once per space, shared).
 *   - intent_defaults: dropped by 0426.
 *
 * What it does NOT cover: the host-job routes, which floor on the computer
 * itself and never read through scopedDb (U7 tests them).
 */

import { describe, it, expect } from "vitest";
import { PgDialect, type AnyPgColumn } from "drizzle-orm/pg-core";
import { eq, type SQL } from "drizzle-orm";
import {
  installations,
  installationBindings,
  hostJobs,
} from "@synap/database/schema";
import { AccessContext, scopedDb } from "./index.js";
import { withVisibility } from "./visibility.js";
import { GRANT_READ_SPECS } from "./grant-read.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

const A = "user-A";
const B = "user-B";
const accessA = AccessContext.operator({ userId: A });
const accessB = AccessContext.operator({ userId: B });

const OWNED: [string, object][] = [
  ["installations", installations],
  ["installation_bindings", installationBindings],
  ["host_jobs", hostJobs],
];

describe("installations floor — the owner within the workspace lens", () => {
  it.each(OWNED)(
    "%s: the owner term binds the caller's own id (A→A, B→B)",
    (name, table) => {
      for (const lens of [null, "ws-shared"]) {
        const qA = compile(scopedDb(accessA.withLens(lens)).predicate(table)!);
        const qB = compile(scopedDb(accessB.withLens(lens)).predicate(table)!);
        expect(qA.sql).toContain(`"${name}"."user_id" = $1`);
        expect(qA.params[0]).toBe(A);
        expect(qB.params[0]).toBe(B);
        expect(qA.params).not.toContain(B);
        expect(qB.params).not.toContain(A);
      }
    }
  );

  it.each(OWNED)(
    "%s: a focused space narrows to it, and the owner term survives",
    (name, table) => {
      const q = compile(
        scopedDb(accessB.withLens("ws-shared")).predicate(table)!
      );
      expect(q.sql).toContain(`"${name}"."workspace_id"`);
      expect(q.params).toContain("ws-shared");
      expect(q.params).toContain(B);
    }
  );

  it.each(OWNED)(
    "%s: a by-id read cannot bypass the owner floor",
    (_name, table) => {
      const byId = eq((table as { id: AnyPgColumn }).id, "row-owned-by-A");
      const q = compile(
        withVisibility(scopedDb(accessB).predicate(table), byId)!
      );
      expect(q.params).toContain(B);
      expect(q.params).not.toContain(A);
    }
  );
});

describe("installation_bindings — a space's need binding is the space's", () => {
  it("installation rows keep the owner term; space rows follow the lens only", () => {
    const q = compile(
      scopedDb(accessB.withLens("ws-shared")).predicate(installationBindings)!
    );
    // Two branches: the installation one carries B's owner term, the space
    // one (installation_id IS NULL) carries none.
    expect(q.sql).toContain(`"installation_bindings"."installation_id" is not null`);
    expect(q.sql).toContain(`"installation_bindings"."installation_id" is null`);
    const spaceBranch = q.sql.slice(
      q.sql.indexOf(`"installation_bindings"."installation_id" is null`)
    );
    expect(spaceBranch).not.toContain(`"installation_bindings"."user_id"`);
    expect(spaceBranch).toContain(`"installation_bindings"."workspace_id"`);
    expect(q.params).toContain("ws-shared");
  });
});

describe("installations — a grant names the installation subject", () => {
  it("installation, binding and job read under `installation`", () => {
    expect(GRANT_READ_SPECS.get(installations)?.subject).toBe("installation");
    // A binding and a job follow their installation: the id a grant narrows
    // to is the INSTALLATION's, never the row's own.
    const binding = GRANT_READ_SPECS.get(installationBindings);
    expect(binding?.subject).toBe("installation");
    expect(binding?.idColumn).toBe(installationBindings.installationId);
    const job = GRANT_READ_SPECS.get(hostJobs);
    expect(job?.subject).toBe("installation");
    expect(job?.idColumn).toBe(hostJobs.installationId);
  });
});
