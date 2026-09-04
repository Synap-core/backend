/**
 * CONTRACT — `skills.createRule` RETURNS its verdict; it does not throw on a
 * refusal.
 *
 * The two rule doors answer the same question in two shapes, on purpose: Hub
 * REST maps `denied` to HTTP 403 because HTTP has no other way to say it, while
 * this tRPC procedure returns a three-way discriminated union. A review flagged
 * the asymmetry as a place where a refusal could land silently — but the union
 * is the RICHER shape here: a compile refusal names the failing clause, and
 * `browser`'s `ruleDoor.ts` renders that in its own words. Throwing would
 * collapse it into a generic error.
 *
 * So the risk is real but the remedy is the opposite one: pin the contract, so
 * the next person who "fixes" it by throwing breaks a test instead of a user's
 * error message.
 *
 * Source-scan, not a live call: exercising the procedure needs a tRPC context
 * and a database. What must not drift is the SHAPE, and the shape is visible in
 * the source.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROUTER = join(import.meta.dirname, "skills.ts");

function readCreateRule(): string {
  if (!existsSync(ROUTER)) {
    throw new Error(
      `Tripwire cannot read its subject: ${ROUTER}. A moved file must move this test, not silence it.`
    );
  }
  const src = readFileSync(ROUTER, "utf8");
  const at = src.indexOf("createRule: protectedProcedure");
  expect(
    at,
    "`createRule` not found in skills.ts — the door this test pins has moved"
  ).toBeGreaterThan(-1);
  // To the start of the next procedure, so a `throw` elsewhere in the router
  // cannot make this pass or fail.
  const next = src.indexOf("protectedProcedure", at + 40);
  return src.slice(at, next > at ? next : src.length);
}

describe("skills.createRule returns its verdict rather than throwing", () => {
  const body = readCreateRule();

  it("parsed a non-empty procedure body", () => {
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain("createRuleGoverned");
  });

  it("does not throw on a denied verdict", () => {
    // The specific regression: `if (result.status === "denied") throw …`.
    expect(body).not.toMatch(/status\s*===\s*"denied"[\s\S]{0,200}throw/);
  });

  it("returns the door's result, so `denied` reaches the caller intact", () => {
    expect(body).toMatch(/return result;/);
  });

  it("accepts a sentence, so a rule created here can carry behaviour", () => {
    // Without this the tRPC door can only ever create prose, while Hub REST can
    // create a rule that runs — the asymmetry that WOULD matter.
    expect(body).toContain("ruleSentenceSchema");
    expect(body).toMatch(/sentence: input\.sentence/);
  });
});
