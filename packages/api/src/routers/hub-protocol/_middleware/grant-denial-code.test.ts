/**
 * A Hub REST 403 carrying a denial of the key's grant says so in fields:
 * `code` / `reasonCode` "GRANT_DENIED" and the refused `action`. Driven
 * through a Hono app with the REAL middleware and the REAL `grantWriteDenial`
 * (a workspace write: no database read), as the doors answer today.
 *
 * Rows, each ruling out a wrong implementation:
 *  - `{ error: reason }` gains the three fields, its words unchanged;
 *  - words that WRAP the sentence ("Permission denied: …") are tagged too;
 *  - a 403 for another reason in a request that also produced a denial is
 *    left alone (the fields follow the sentence, not the request);
 *  - the same sentence typed by hand, with no denial produced, is left alone
 *    (no prefix matching: only a denial the producer recorded is tagged);
 *  - a field the route set is never overwritten;
 *  - the hub mounts it OUTSIDE auth, so every route is wrapped.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { grantOfScope, runWithGrant } from "@synap/database";
import { grantWriteDenial } from "../../../utils/grant-write-check.js";
import { grantDenialCodeMiddleware } from "./grant-denial-code.js";

const KEY = grantOfScope({ permissions: ["entity"] });
const deny = () =>
  runWithGrant(KEY, () =>
    grantWriteDenial({ subjectType: "workspace", action: "update" })
  );
const SENTENCE = `This key's grant does not allow "workspace.update".`;

function app() {
  const a = new Hono();
  a.use("/*", grantDenialCodeMiddleware);
  a.post("/plain", async (c) => c.json({ error: await deny() }, 403));
  a.post("/wrapped", async (c) =>
    c.json({ error: `Permission denied: ${await deny()}` }, 403)
  );
  a.post("/other", async (c) => {
    await deny(); // a preview that was denied; the refusal is another one
    return c.json({ error: "You are not a member of this workspace" }, 403);
  });
  a.post("/typed", (c) => c.json({ error: SENTENCE }, 403));
  a.post("/own-code", async (c) =>
    c.json({ error: await deny(), code: "ROUTE_CODE" }, 403)
  );
  return a;
}

const post = async (path: string) => {
  const res = await app().request(path, { method: "POST" });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

describe("a grant denial on Hub REST carries its code", () => {
  it("the producer's sentence is what the denial says", async () => {
    expect(await deny()).toBe(SENTENCE);
  });

  it("{ error: reason } gains code, reasonCode and the refused action", async () => {
    const r = await post("/plain");
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: SENTENCE,
      code: "GRANT_DENIED",
      reasonCode: "GRANT_DENIED",
      action: "workspace.update",
    });
  });

  it("words that wrap the sentence are tagged too", async () => {
    const r = await post("/wrapped");
    expect(r.body).toMatchObject({
      code: "GRANT_DENIED",
      action: "workspace.update",
    });
  });

  it("a 403 for another reason is left alone", async () => {
    const r = await post("/other");
    expect(r.body).toEqual({ error: "You are not a member of this workspace" });
  });

  it("the sentence typed by hand, with no denial produced, is left alone", async () => {
    const r = await post("/typed");
    expect(r.body).toEqual({ error: SENTENCE });
  });

  it("a field the route set is kept", async () => {
    const r = await post("/own-code");
    expect(r.body).toMatchObject({
      code: "ROUTE_CODE",
      reasonCode: "GRANT_DENIED",
      action: "workspace.update",
    });
  });

  it("the hub mounts it outside auth, so every route is wrapped", () => {
    const src = readFileSync(
      join(__dirname, "../../hub-protocol-rest.ts"),
      "utf8"
    );
    const code = src.indexOf('app.use("/*", grantDenialCodeMiddleware)');
    const auth = src.indexOf('app.use("/*", hubAuthMiddleware)');
    expect(code).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(code);
  });
});
