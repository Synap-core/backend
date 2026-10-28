/**
 * The Hub REST validation refusal names its fields: a route whose body fails
 * its Zod schema answers 400 `{ error: "<path>: <message>, …", fieldErrors:
 * { "<dotted path>": [messages] } }` — the same projection tRPC sends as
 * `data.fieldErrors`. Mounted on a minimal OpenAPIHono with the SAME hook the
 * parent Hub app uses (`hubValidationHook`).
 *
 * NEGATIVE CONTROL: dropping `fieldErrors` from the hook's body turns the
 * fieldErrors assertion red.
 */
import { describe, it, expect } from "vitest";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { hubValidationHook } from "./_validation-hook.js";

const app = new OpenAPIHono({ defaultHook: hubValidationHook });
app.openapi(
  createRoute({
    method: "post",
    path: "/things",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              title: z.string().min(1),
              tags: z.array(z.string()),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "ok" } },
  }),
  (c) => c.json({ ok: true }, 200)
);

async function post(body: unknown) {
  const res = await app.request("/things", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("Hub REST — a refused body names its fields", () => {
  it("400 with a readable error and fieldErrors keyed by dotted path", async () => {
    const { status, body } = await post({ title: "", tags: ["a", 2] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/^title: .+, tags\.1: .+/);
    const fieldErrors = body.fieldErrors as Record<string, string[]>;
    expect(Object.keys(fieldErrors).sort()).toEqual(["tags.1", "title"]);
    expect(fieldErrors.title.length).toBeGreaterThan(0);
  });

  it("a valid body passes through", async () => {
    const { status } = await post({ title: "x", tags: [] });
    expect(status).toBe(200);
  });
});
