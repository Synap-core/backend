// Isolated smoke test — no DB, no Typesense, no full app import.
//
// Builds a fresh OpenAPIHono instance, runs ONLY the stub registrations
// + a manual exercise of the entity / thread / memory / knowledge codec
// schemas, then dumps stats. Verifies that the OpenAPI doc is well-formed
// and that `getOpenAPI31Document` works.
//
// Note: this exercises ONLY the stub registrations. The high-priority
// routes (/entities, /threads, /memory, /knowledge — ~21 operations) live
// in their per-resource files and are added at runtime by the real
// `register*Routes` functions. Together with the stubs they make up
// roughly 90 OpenAPI operations on the live `/api/hub/openapi.json` doc.

import { OpenAPIHono } from "@hono/zod-openapi";

// Source-import the stubs and full schemas (no DB deps for these files).
const { registerOpenApiStubs } = await import(
  "../src/routers/hub-protocol/rest/_openapi-stubs.ts"
);
const entityCodec = await import(
  "../src/routers/hub-protocol/rest/_codecs/entity.ts"
);
const threadCodec = await import(
  "../src/routers/hub-protocol/rest/_codecs/thread.ts"
);
const memoryCodec = await import(
  "../src/routers/hub-protocol/rest/_codecs/memory.ts"
);
const knowledgeCodec = await import(
  "../src/routers/hub-protocol/rest/_codecs/knowledge.ts"
);

const app = new OpenAPIHono();
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "API key",
});

// Register the named schemas so they appear under components.schemas.
for (const codec of [entityCodec, threadCodec, memoryCodec, knowledgeCodec]) {
  for (const [name, schema] of Object.entries(codec)) {
    if (schema && typeof schema === "object" && "_def" in schema) {
      // ZodType — register it (idempotent if already named).
      try {
        app.openAPIRegistry.register(name, schema);
      } catch {
        // Some are already named via .openapi() — skip dup.
      }
    }
  }
}

registerOpenApiStubs(app);

const doc = app.getOpenAPI31Document({
  openapi: "3.1.0",
  info: { title: "Synap Hub Protocol (stubs only)", version: "1.0.0" },
  servers: [{ url: "/api/hub" }],
});

console.log("--- STATS ---");
console.log("Paths:", Object.keys(doc.paths ?? {}).length);
console.log(
  "Operations:",
  Object.values(doc.paths ?? {}).reduce(
    (n, p) => n + Object.keys(p ?? {}).length,
    0
  )
);
console.log("Tags:", [
  ...new Set(
    Object.values(doc.paths ?? {}).flatMap((p) =>
      Object.values(p ?? {}).flatMap((op) => op?.tags ?? [])
    )
  ),
].sort());

console.log("\n--- HEAD (first 50 lines) ---");
const out = JSON.stringify(doc, null, 2);
console.log(out.split("\n").slice(0, 50).join("\n"));
