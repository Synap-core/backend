/**
 * A `vault://<id>` PARAM LINKS the existing secret — it is never re-encrypted
 * as the literal text of a pointer. On real Postgres (PGlite).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * The review form lets a reviewer EITHER type a new key OR pick one already in
 * the vault. Picking one sends `params[apiKey] = "vault://<id>"`, which
 * interpolates into the template's `vault[].value`. The writer used to
 * `encryptServerSide` whatever landed there — so the stored credential would
 * have been the STRING "vault://<id>", and every call with it would fail at the
 * provider with nothing pointing at why.
 *
 * ── WHY PGLITE AND NOT A MOCK ───────────────────────────────────────────────
 * The claim is "no new secret ROW", and a mocked `db.insert` cannot disprove a
 * row that was never counted. The `secrets` table is real here, so the
 * assertion is a real `count(*)` before and after.
 *
 * ── THE SEAM IS DRIVEN, NOT HAND-BUILT ──────────────────────────────────────
 * The `vault[].value` is NOT hand-written as `vault://<id>`. It starts as the
 * manifest's `"{{apiKey}}"` and goes through the REAL `interpolateDeep` with
 * the REAL wire params — the same call `createCapabilityFromDefinition` makes.
 * Hand-building the post-interpolation value downstream of that step is exactly
 * how a projection line becomes load-bearing and untested.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  process.env.VAULT_SERVER_KEY = "ab".repeat(32);
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      close: () => Promise<void>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init() };
});
// The write gate is authority, not storage — its own tests cover it. Here it
// would demand workspace/member rows that have nothing to do with the claim.
vi.mock("../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));

import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { decryptServerSide } from "@synap/database";
import { interpolateDeep } from "../_shared/interpolate.js";
import { createVaultSecret } from "./create-from-definition.js";
import { isSetupRequiredLike } from "../proposals/setup-required-error.js";

/** CREATE TABLE from the drizzle definition — columns, types, literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

type Db = {
  insert: (typeof import("@synap/database"))["db"]["insert"];
  select: (typeof import("@synap/database"))["db"]["select"];
};
let db: Db;

const OWNER = randomUUID();
const OTHER = randomUUID();

/** The manifest, verbatim in the shape a `.capability.json` declares. */
const MANIFEST = {
  key: "acme",
  name: "Acme",
  params: [{ name: "apiKey", label: "API Key", required: true }],
  vault: [
    {
      ref: "acmeKey",
      name: "Acme API Key",
      value: "{{apiKey}}",
      type: "api_key",
      service: "acme",
    },
  ],
  tools: [],
  skills: [],
};

/** Drive the REAL interpolation the applier does, then hand it the REAL writer. */
function vaultDefForParams(params: Record<string, unknown>) {
  const def = interpolateDeep(MANIFEST, {
    name: MANIFEST.name,
    key: MANIFEST.key,
    ...params,
  });
  return def.vault[0]!;
}

async function countSecrets(): Promise<number> {
  const rows = await db.select().from(schema.secrets);
  return rows.length;
}

beforeAll(async () => {
  db = (await h.init()) as Db;
  for (const t of [schema.secrets, schema.secretAuditLog]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
});

afterAll(async () => {
  await h.client?.close();
});

describe("a vault:// param LINKS; a literal value CREATES", () => {
  it("the seam is real: the manifest's {{apiKey}} becomes the ref, not a hand-built string", () => {
    const id = randomUUID();
    expect(vaultDefForParams({ apiKey: `vault://${id}` }).value).toBe(
      `vault://${id}`
    );
  });

  it("links the existing secret — no new row, no re-encryption of the pointer", async () => {
    // Seed an existing secret through the REAL writer with a literal value.
    const created = await createVaultSecret(
      vaultDefForParams({ apiKey: "sk-live-REAL-KEY" }) as never,
      OWNER,
      null
    );
    const after1 = await countSecrets();
    expect(created.vaultRef).toBe(`vault://${created.secretId}`);

    // Now install AGAIN, this time picking that secret in the form. The
    // template-local `name` collides, which is exactly the case where the old
    // idempotent-by-name branch would have OVERWRITTEN the real key with the
    // text of a pointer.
    const linked = await createVaultSecret(
      vaultDefForParams({ apiKey: `vault://${created.secretId}` }) as never,
      OWNER,
      null
    );

    expect(linked.secretId).toBe(created.secretId);
    expect(linked.vaultRef).toBe(`vault://${created.secretId}`);
    // NO new row.
    expect(await countSecrets()).toBe(after1);

    // And the stored credential is still the REAL key, not "vault://…".
    const all = await db.select().from(schema.secrets);
    const stored = all.find((r) => r.id === created.secretId)!;
    const plaintext = decryptServerSide({
      encryptedData: stored.encryptedData,
      iv: stored.iv,
      authTag: stored.authTag,
    });
    expect(plaintext).toBe("sk-live-REAL-KEY");
    expect(plaintext).not.toContain("vault://");
  });

  it("a ref the caller may NOT use is a missing field, never a silent new secret", async () => {
    const foreign = await createVaultSecret(
      {
        ref: "k",
        name: "Foreign key",
        value: "sk-foreign",
        type: "api_key",
      } as never,
      OTHER,
      null
    );
    const before = await countSecrets();

    let err: unknown;
    try {
      await createVaultSecret(
        vaultDefForParams({ apiKey: `vault://${foreign.secretId}` }) as never,
        OWNER,
        null
      );
    } catch (e) {
      err = e;
    }
    expect(isSetupRequiredLike(err)).toBe(true);
    expect((err as { failureClass: string }).failureClass).toBe(
      "missing_field"
    );
    // The refusal did NOT fall back to writing a secret whose value is the ref.
    expect(await countSecrets()).toBe(before);
  });

  it("a ref to nothing at all is refused the same way", async () => {
    const before = await countSecrets();
    let err: unknown;
    try {
      await createVaultSecret(
        vaultDefForParams({ apiKey: `vault://${randomUUID()}` }) as never,
        OWNER,
        null
      );
    } catch (e) {
      err = e;
    }
    expect(isSetupRequiredLike(err)).toBe(true);
    expect(await countSecrets()).toBe(before);
  });

  // A MALFORMED pointer is still a pointer. If the parser answered `null` for
  // `vault://not-a-uuid` it would read as a plain VALUE, and this writer would
  // encrypt and store the literal string as the CREDENTIAL — every call with it
  // would fail at the provider with nothing pointing at why. The parser test
  // pins the answer; this pins the CONSEQUENCE at the door that stores secrets.
  it.each([
    "vault://not-a-uuid",
    "vault://12345",
    "  vault://not-a-uuid  ",
    "vault://a/b/c",
  ])(
    "a malformed pointer %j is refused, never stored as the credential",
    async (malformed) => {
      const before = await countSecrets();
      let err: unknown;
      try {
        await createVaultSecret(
          vaultDefForParams({ apiKey: malformed }) as never,
          OWNER,
          null
        );
      } catch (e) {
        err = e;
      }
      expect(isSetupRequiredLike(err)).toBe(true);
      expect((err as { failureClass: string }).failureClass).toBe(
        "missing_field"
      );
      expect(await countSecrets()).toBe(before);
    }
  );

  it("a POD-WIDE secret owned by someone else IS linkable", async () => {
    const shared = await createVaultSecret(
      {
        ref: "k",
        name: "Shared pod key",
        value: "sk-shared",
        type: "api_key",
        podWide: true,
      } as never,
      OTHER,
      null
    );
    const before = await countSecrets();
    const linked = await createVaultSecret(
      vaultDefForParams({ apiKey: `vault://${shared.secretId}` }) as never,
      OWNER,
      null
    );
    expect(linked.secretId).toBe(shared.secretId);
    expect(await countSecrets()).toBe(before);
  });
});
