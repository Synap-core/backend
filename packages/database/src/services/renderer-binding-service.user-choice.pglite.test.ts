/**
 * `readUserRendererChoice` on a real Postgres (PGlite).
 *
 * The property: a user's explicit "Open in" choice for a kind stays readable
 * after they unbind it. Resolution cannot answer this — once a user binding is
 * revoked the ladder falls to the profile/default rung, exactly as for a user
 * who never chose — so the reader looks at the binding HISTORY, tombstones
 * included. The rows are written through the real write door
 * (`setRendererBinding` / `revokeRendererBinding`), so the history is the one
 * production produces: a rebind revokes the incumbent and inserts a newer row.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  readUserRendererChoice,
  revokeRendererBinding,
  setRendererBinding,
} from "./renderer-binding-service.js";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

const USER = "u-1";
const userKey = {
  scopeKind: "user" as const,
  userId: USER,
  subjectKind: "person",
  contentKind: "entity-detail" as const,
};
const sourceApp = { kind: "source-app" as const };
const cell = { kind: "cell" as const, cellKey: "contact-card", props: {} };

const choice = () =>
  readUserRendererChoice(db, {
    userId: USER,
    subjectKind: "person",
    contentKind: "entity-detail",
  });

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE renderer_bindings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scope_kind text NOT NULL,
      user_id text,
      workspace_id uuid,
      subject_kind text NOT NULL,
      subject_id text,
      content_kind text NOT NULL,
      ref jsonb NOT NULL,
      source_proposal_id uuid,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );
  `);
  db = drizzle(pg);
}, 120_000);

beforeEach(async () => {
  await pg.exec(`DELETE FROM renderer_bindings`);
});

afterAll(async () => {
  await pg?.close();
});

describe("readUserRendererChoice", () => {
  it("never chose → null, even with other scopes, users, objects and kinds bound", async () => {
    await setRendererBinding(db, {
      scopeKind: "workspace",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      subjectKind: "person",
      contentKind: "entity-detail",
      ref: sourceApp,
      actorUserId: USER,
    });
    await setRendererBinding(db, {
      ...userKey,
      userId: "someone-else",
      ref: sourceApp,
      actorUserId: "someone-else",
    });
    await setRendererBinding(db, {
      ...userKey,
      subjectId: "entity-42",
      ref: sourceApp,
      actorUserId: USER,
    });
    await setRendererBinding(db, {
      ...userKey,
      contentKind: "entity-card",
      ref: sourceApp,
      actorUserId: USER,
    });
    await setRendererBinding(db, {
      ...userKey,
      subjectKind: "company",
      ref: sourceApp,
      actorUserId: USER,
    });

    await expect(choice()).resolves.toBeNull();
  });

  it("chose the source app → 'source'", async () => {
    await setRendererBinding(db, {
      ...userKey,
      ref: sourceApp,
      actorUserId: USER,
    });
    await expect(choice()).resolves.toBe("source");
  });

  it("chose Synap by unbinding → 'synap' (the revoked row is still their choice)", async () => {
    await setRendererBinding(db, {
      ...userKey,
      ref: sourceApp,
      actorUserId: USER,
    });
    await revokeRendererBinding(db, { ...userKey, actorUserId: USER });

    await expect(choice()).resolves.toBe("synap");
  });

  it("the LATEST binding decides: source → a Synap cell → source again", async () => {
    await setRendererBinding(db, {
      ...userKey,
      ref: sourceApp,
      actorUserId: USER,
    });
    await setRendererBinding(db, { ...userKey, ref: cell, actorUserId: USER });
    await expect(choice()).resolves.toBe("synap");

    await setRendererBinding(db, {
      ...userKey,
      ref: sourceApp,
      actorUserId: USER,
    });
    await expect(choice()).resolves.toBe("source");
  });
});
