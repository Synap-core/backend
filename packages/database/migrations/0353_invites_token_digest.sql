-- 0353 — invites.token_digest (join plan phase 4, decision B2: invite tokens
-- hashed at rest).
--
-- An invite link's token is a bearer secret: whoever holds it can make the
-- invited account. The pod kept it in plain text, so a database read was a
-- join link to every pending invite. The pod now finds an invite by the
-- SHA-256 of its token (`findInviteByToken`, @synap/api
-- routers/workspaces/invite-token.ts), the ONE token lookup.
--
-- EXPAND (CONTRIBUTING "forward-only"): this release writes BOTH the digest
-- and the plaintext, because the previous release reads `token` and a failed
-- update rolls the images back onto this schema. A row with no digest (made by
-- the previous release after such a rollback) is still found by its plaintext.
-- The console can no longer show an old link: "Copy a new link" mints a new
-- token. CONTRACT, in a later release: stop writing `token`, drop its NOT
-- NULL, then the column (`-- synap:contract-of 0353_invites_token_digest.sql`);
-- the apps' Accept on a needs-you or "my invites" row must first move off the
-- plaintext token.
--
-- sha256() is built into PostgreSQL 11+; hex of the UTF-8 bytes equals Node's
-- createHash("sha256").update(token).digest("hex").

ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "token_digest" text;

UPDATE "invites"
   SET "token_digest" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
 WHERE "token_digest" IS NULL
   AND "token" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "invites_token_digest_key"
  ON "invites" ("token_digest");
