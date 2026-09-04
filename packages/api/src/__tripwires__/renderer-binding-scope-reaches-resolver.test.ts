import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TRIPWIRE — the `renderer_bindings` READ side must actually be reachable.
 *
 * THE BUG (review 2026-09-04): `getEffectiveRendererWithSource` grew a
 * six-rung ladder (user·object → user·kind → workspace·object → workspace·kind
 * → pod·object → pod·kind) behind an optional 4th argument, and a write door
 * that mints user- and object-scoped rows. Every production caller passed
 * THREE arguments. Five of the six rungs were therefore unreachable: a user or
 * per-object binding could be written, was visible in the table, and could
 * never win. Built-but-severed, and both halves typechecked perfectly.
 *
 * A source scan is the only mechanism that sees this. The 4th parameter is
 * OPTIONAL by design (omitting it is the pre-table behaviour), so a caller that
 * drops it is not a type error, and the service's own ladder tests pass the
 * scope directly and so can never notice that nobody else does.
 *
 * `subjectId` is the field name the browser sends
 * (`BoundObjectDetailCell.tsx`); the two must agree or the object rungs stay
 * dark from the only surface that uses them.
 */
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The body of a named tRPC procedure, from its key to the next top-level one. */
function procedure(src: string, name: string): string {
  const start = src.indexOf(`\n  ${name}: `);
  expect(start, `procedure ${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.indexOf("\n    }),\n");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("renderer binding scope reaches the resolver", () => {
  const profiles = read("../routers/profiles.ts");
  const body = procedure(profiles, "getEffectiveRenderers");

  it("the tRPC door accepts subjectId — the name the browser sends", () => {
    expect(
      body,
      "the browser sends { profileSlug: objectKind, subjectId: objectId }"
    ).toMatch(/subjectId:\s*z\.string\(\)\.optional\(\)/);
  });

  it("EVERY resolver call in the door passes the scope, not three arguments", () => {
    const calls = [
      ...body.matchAll(/getEffectiveRendererWithSource\(([\s\S]*?)\n\s*\)/g),
    ].map((m) => m[1]);
    expect(
      calls.length,
      "the door resolves one content kind or all four"
    ).toBeGreaterThanOrEqual(5);
    for (const args of calls) {
      expect(
        args,
        "a three-argument call skips the user AND object rungs — the severance"
      ).toMatch(/,\s*scope\s*$/);
    }
  });

  it("the scope carries BOTH the caller and the subject", () => {
    const scope = /const scope = \{([\s\S]*?)\};/.exec(body)?.[1] ?? "";
    expect(scope, "no userId ⇒ the two user rungs never match").toMatch(
      /userId:\s*ctx\.userId/
    );
    expect(scope, "no subjectId ⇒ the three object rungs never match").toMatch(
      /subjectId:\s*input\.subjectId/
    );
  });

  it("both Hub Protocol doors forward subjectId to the same procedure", () => {
    const hub = read("../routers/hub-protocol/profiles.ts");
    const hubBody = procedure(hub, "getEffectiveRenderers");
    expect(hubBody).toMatch(/subjectId:\s*z\.string\(\)\.optional\(\)/);
    expect(
      hubBody,
      "an accepted-but-dropped field is a door that silently resolves the " +
        "wrong renderer"
    ).toMatch(/subjectId:\s*input\.subjectId/);

    const rest = read("../routers/hub-protocol/rest/profiles.ts");
    expect(rest).toMatch(/c\.req\.query\("subjectId"\)/);
    expect(rest).toMatch(/\n\s*subjectId,\n/);
  });
});
