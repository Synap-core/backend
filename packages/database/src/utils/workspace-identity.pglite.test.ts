/**
 * REAL-POSTGRES (PGlite) proof for the workspace identity door (0308).
 *
 * Drives the REAL `WorkspaceRepository` (real drizzle query builder) against a
 * `workspaces` table built from its drizzle definition, with the REAL 0308 SQL
 * applied for the indexes — so the constraint names the race backstop maps are
 * the ones Postgres actually raises.
 *
 * Pinned:
 *   - create / rename / settings-replace / settings-merge to an identity another
 *     ACTIVE space holds → `WorkspaceIdentityConflictError` (409, reasonCode,
 *     names the existing space) — whoever owns either space;
 *   - archived spaces never block; renaming a space to its own name is fine;
 *   - the race backstop: a write that skips the pre-check still surfaces the
 *     typed error (23505 → typed), for BOTH indexes;
 *   - `nextFreeWorkspaceName` suffixes system-generated names "(2)", "(3)"…
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { workspaces } from "../schema/workspaces.js";
import { WorkspaceRepository } from "../repositories/workspace-repository.js";
import type { EventRepository } from "../repositories/event-repository.js";
import {
  WorkspaceIdentityConflictError,
  isWorkspaceIdentityConflictError,
  nextFreeWorkspaceName,
  toWorkspaceIdentityError,
  workspaceIdentityViolation,
} from "./workspace-identity.js";

const M0308 = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../migrations/0308_workspace_identity_unique.sql"
  ),
  "utf8"
);

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    const type = c.getSQLType();
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    const nn = c.notNull && !c.primary ? " not null" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${nn}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

let pg: PGlite;
let db: ReturnType<typeof drizzle>;
let repo: WorkspaceRepository;

async function expectConflict(
  p: Promise<unknown>,
  field: "name" | "packageSlug",
  existingWorkspaceId: string | null
): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(WorkspaceIdentityConflictError);
  const e = err as WorkspaceIdentityConflictError;
  expect(e.statusCode).toBe(409);
  expect(e.code).toBe("CONFLICT");
  expect(e.reasonCode).toBe("WORKSPACE_IDENTITY_CONFLICT");
  expect(e.field).toBe(field);
  expect(e.existingWorkspaceId).toBe(existingWorkspaceId);
}

let contentOs: string;
let notes: string;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg);
  await pg.exec(ddlFor(workspaces));
  await pg.exec(M0308);
  const events = {
    append: async () => undefined,
  } as unknown as EventRepository;
  repo = new WorkspaceRepository(db, events);

  contentOs = (
    await repo.create(
      {
        name: "Content OS",
        ownerId: "alice",
        settings: { packageSlug: "content-os", proposalId: "content-os" },
      },
      "alice"
    )
  ).id;
  notes = (await repo.create({ name: "Notes", ownerId: "alice" }, "alice")).id;
}, 120_000);

describe("WorkspaceRepository — identity is refused as a typed 409", () => {
  it("create with a taken name (any case/spacing, another owner) names the existing space", async () => {
    await expectConflict(
      repo.create({ name: "  content OS ", ownerId: "bob" }, "bob"),
      "name",
      contentOs
    );
  });

  it("create from a template another active space holds", async () => {
    await expectConflict(
      repo.create(
        {
          name: "Fresh name",
          ownerId: "bob",
          settings: { packageSlug: "content-os" },
        },
        "bob"
      ),
      "packageSlug",
      contentOs
    );
  });

  it("rename into a taken name; renaming to your own name is fine", async () => {
    await expectConflict(
      repo.update(notes, { name: "CONTENT os" }, "alice"),
      "name",
      contentOs
    );
    const self = await repo.update(notes, { name: "notes" }, "alice");
    expect(self.name).toBe("notes");
  });

  it("settings replace / merge that stamps a held template slug", async () => {
    await expectConflict(
      repo.update(notes, { settings: { packageSlug: "content-os" } }, "alice"),
      "packageSlug",
      contentOs
    );
    await expectConflict(
      repo.mergeSettings(notes, { packageSlug: "content-os" }, "alice"),
      "packageSlug",
      contentOs
    );
  });

  it("an archived space never blocks", async () => {
    const old = await repo.create({ name: "Archive Me", ownerId: "a" }, "a");
    await pg.query(`UPDATE workspaces SET archived_at = now() WHERE id = $1`, [
      old.id,
    ]);
    const again = await repo.create({ name: "Archive Me", ownerId: "b" }, "b");
    expect(again.name).toBe("Archive Me");
  });
});

describe("race backstop — the index's 23505 maps to the same typed error", () => {
  it("name index (a write that skipped the pre-check)", async () => {
    const err = await db
      .insert(workspaces)
      .values({ name: "Content OS", ownerId: "racer", settings: {} })
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(workspaceIdentityViolation(err)).toBe("name");
    const typed = toWorkspaceIdentityError(err, { name: "Content OS" });
    expect(isWorkspaceIdentityConflictError(typed)).toBe(true);
    expect((typed as WorkspaceIdentityConflictError).field).toBe("name");
  });

  it("template index", async () => {
    const err = await db
      .insert(workspaces)
      .values({
        name: "Racer two",
        ownerId: "racer",
        settings: {},
        packageSlug: "content-os",
      })
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(workspaceIdentityViolation(err)).toBe("packageSlug");
  });

  it("an unrelated error passes through untouched", () => {
    const other = Object.assign(new Error("x"), { code: "23503" });
    expect(toWorkspaceIdentityError(other, { name: "n" })).toBe(other);
  });
});

describe("nextFreeWorkspaceName — system-generated defaults only", () => {
  it("returns the base when free, else the first free '(n)'", async () => {
    expect(await nextFreeWorkspaceName(db, "Brand New")).toBe("Brand New");
    await repo.create({ name: "My Workspace", ownerId: "u1" }, "u1");
    expect(await nextFreeWorkspaceName(db, "My Workspace")).toBe(
      "My Workspace (2)"
    );
    await repo.create({ name: "my workspace (2)", ownerId: "u2" }, "u2");
    expect(await nextFreeWorkspaceName(db, "My Workspace")).toBe(
      "My Workspace (3)"
    );
  });

  it("a base with SQL wildcard characters is matched exactly", async () => {
    await repo.create({ name: "100% Done", ownerId: "u" }, "u");
    expect(await nextFreeWorkspaceName(db, "100_ Done")).toBe("100_ Done");
    expect(await nextFreeWorkspaceName(db, "100% Done")).toBe("100% Done (2)");
  });
});
