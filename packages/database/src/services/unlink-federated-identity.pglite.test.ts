/**
 * "Unlink this account" removes exactly one person's link to one issuer.
 * Real drizzle delete on PGlite: a widened WHERE (issuer only, or user only)
 * turns one of the "stays" assertions red.
 *
 * The table is created with the columns and keys of 0192 minus the foreign
 * keys (`users`, `trusted_issuers` are not needed to test which rows go).
 * NOT COVERED: the Pod Admin procedure and the sign-in credential detach
 * (`unlink-account.test.ts` in @synap/api).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { federatedIdentityLinks } from "../schema/federation.js";
import { unlinkFederatedIdentity } from "./user-provisioning.js";

const client = new PGlite();
const db = drizzle(client, { schema: { federatedIdentityLinks } });
const conn = db as unknown as Parameters<typeof unlinkFederatedIdentity>[1];

const STUDIO_ISSUER = "11111111-1111-4111-8111-111111111111";
const OTHER_ISSUER = "22222222-2222-4222-8222-222222222222";

async function links() {
  const { rows } = await client.query<{
    issuer_id: string;
    user_id: string;
  }>(
    "select issuer_id, user_id from federated_identity_links order by user_id, issuer_id"
  );
  return rows.map((r) => `${r.user_id}@${r.issuer_id.slice(0, 1)}`);
}

beforeAll(async () => {
  await client.exec(`
    CREATE TABLE federated_identity_links (
      issuer_id uuid NOT NULL,
      issuer_subject text NOT NULL,
      user_id text NOT NULL,
      linked_by_user_id text,
      linked_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (issuer_id, issuer_subject)
    );
    CREATE UNIQUE INDEX federated_identity_links_issuer_user_unique
      ON federated_identity_links (issuer_id, user_id);
    INSERT INTO federated_identity_links (issuer_id, issuer_subject, user_id) VALUES
      ('${STUDIO_ISSUER}', 'cp-ada', 'ada'),
      ('${STUDIO_ISSUER}', 'cp-bob', 'bob'),
      ('${OTHER_ISSUER}', 'other-ada', 'ada');
  `);
});
afterAll(async () => {
  await client.close();
});

describe("unlinkFederatedIdentity", () => {
  it("removes only that person's link to that issuer", async () => {
    await expect(
      unlinkFederatedIdentity({ issuerId: STUDIO_ISSUER, userId: "ada" }, conn)
    ).resolves.toEqual({ issuerSubject: "cp-ada" });
    // Bob's link stays; Ada's link to another issuer stays.
    expect(await links()).toEqual(["ada@2", "bob@1"]);
  });

  it("says when there was nothing to unlink", async () => {
    await expect(
      unlinkFederatedIdentity({ issuerId: STUDIO_ISSUER, userId: "ada" }, conn)
    ).resolves.toBeNull();
    expect(await links()).toEqual(["ada@2", "bob@1"]);
  });
});
