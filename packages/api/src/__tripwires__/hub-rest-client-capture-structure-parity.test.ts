/**
 * TRIPWIRE — hub-rest-client `captureStructure()` must forward every field the
 * server's `/capture/structure` codec accepts.
 *
 * THE FAILURE THIS CATCHES: `packages/hub-rest-client` is the CLIENT LIBRARY
 * used by every external Hub REST consumer of capture (Raycast, the CLI, and
 * any agent that talks Hub REST directly, since it cannot import this repo's
 * zod-4 tRPC contract). It is reachable through NEITHER of the two existing
 * door-parity families in this directory: `cross-door-field-parity` /
 * `cross-door-input-parity` audit doors INSIDE this repo (tRPC / Hub route /
 * MCP) against a service's own exported type — they never look at a package
 * that is itself a caller of a Hub route from outside.
 *
 * That gap is exactly how this bug shipped: the server's
 * `CaptureStructureRequestSchema` (`routers/hub-protocol/rest/_codecs/misc.ts`)
 * accepts `file`/`html`/`context`/`instructions` alongside `text`/`url`, and
 * makes `text` optional specifically so a binary-only capture (a photo, a
 * PDF) is representable — but `HubRestClient.captureStructure()` declared
 * `text: string` as REQUIRED and never even had a `file` parameter to drop.
 * `captureExecute`, thirty lines below in the SAME FILE, already forwards
 * `file` correctly — so a field-name-only check ("does the file mention
 * `file`") would have passed with the bug still in place. This test instead
 * asserts field-by-field that the SPECIFIC method forwards the field, which
 * is the actual failure mode: a field the server accepts that this one client
 * method cannot send.
 *
 * ── WHAT IS DERIVED (both sides; neither is hand-listed) ────────────────────
 * LEFT  = every top-level key inside the server's `CaptureStructureRequestSchema`
 *         `z.object({...})` body, extracted from source (never hand-listed —
 *         add a field to the schema and this test owes it an answer).
 * RIGHT = every key referenced as `input.<key>` inside `captureStructure`'s
 *         request-body object literal in `hub-rest-client/src/client.ts`
 *         (also extracted from source, not hand-listed).
 *
 * `userId` and `workspaceId` are server/client session concerns already
 * covered elsewhere (`userId` is resolved via `resolveUserId()`, never a
 * caller-supplied value at this door) and are excluded from the comparison —
 * every other schema field must have a matching `input.<field>` forward.
 *
 * ── ANTI-STALENESS ───────────────────────────────────────────────────────────
 * Both source files are asserted to exist before parsing (a moved file fails
 * loudly, not silently-empty). Both extracted field lists are asserted
 * non-trivial in size, so a regex that stopped matching reads red rather than
 * "nothing to check, pass".
 *
 * ── LIMIT ─────────────────────────────────────────────────────────────────
 * This proves the field is FORWARDED in the request body, never that the
 * server does the right thing with it, that the type is correct, or that
 * `CaptureStructureInput` (the exported TS type) is kept in sync — a separate,
 * simpler drift this test does not need to catch because TypeScript already
 * would (an extra property on the request body literal that isn't on the
 * input type fails to compile).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "..");
const BACKEND_PACKAGES = join(API_SRC, "../..");

const SERVER_CODEC = join(API_SRC, "routers/hub-protocol/rest/_codecs/misc.ts");
const CLIENT_FILE = join(BACKEND_PACKAGES, "hub-rest-client/src/client.ts");

// Fields deliberately excluded from the comparison: session-identity concerns
// resolved by the client/server themselves, never a value a caller "adds" to
// the payload in the sense this test is auditing.
const EXCLUDED = new Set(["userId", "workspaceId"]);

let serverFields: string[] = [];
let clientForwardedFields: string[] = [];

beforeAll(() => {
  expect(existsSync(SERVER_CODEC), `missing ${SERVER_CODEC}`).toBe(true);
  expect(existsSync(CLIENT_FILE), `missing ${CLIENT_FILE}`).toBe(true);

  const serverSrc = readFileSync(SERVER_CODEC, "utf8");
  const clientSrc = readFileSync(CLIENT_FILE, "utf8");

  // Isolate the CaptureStructureRequestSchema z.object({...}) body: from its
  // declaration to the matching `.refine(` that closes the object (the schema
  // is `z.object({ ... }).refine(...).openapi(...)`).
  const schemaStart = serverSrc.indexOf(
    "export const CaptureStructureRequestSchema"
  );
  expect(
    schemaStart,
    "CaptureStructureRequestSchema not found in codec file"
  ).toBeGreaterThan(-1);
  const schemaEnd = serverSrc.indexOf(".refine(", schemaStart);
  expect(
    schemaEnd,
    "`.refine(` not found after schema — file shape changed"
  ).toBeGreaterThan(-1);
  const schemaBody = serverSrc.slice(schemaStart, schemaEnd);

  // Top-level keys only: a line that opens a new property with `<name>: z.` or
  // `<name>: z\n` at the schema's own indentation (4 spaces, one level inside
  // `z.object({`). Comments and nested object fields (e.g. `previousEntities`'s
  // inner `tempId`/`profileSlug`) are indented deeper and excluded.
  const topLevelKeyRe = /^ {4}([a-zA-Z][a-zA-Z0-9]*): z(?:\.|\s*$)/gm;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = topLevelKeyRe.exec(schemaBody)) !== null) {
    found.add(m[1]);
  }
  serverFields = Array.from(found).filter((f) => !EXCLUDED.has(f));

  // Isolate captureStructure's method body (up to captureExecute, the next
  // method in the same file).
  const methodStart = clientSrc.indexOf("async captureStructure(");
  expect(
    methodStart,
    "captureStructure() not found in client.ts"
  ).toBeGreaterThan(-1);
  const methodEnd = clientSrc.indexOf("async captureExecute(", methodStart);
  expect(
    methodEnd,
    "captureExecute() not found after captureStructure()"
  ).toBeGreaterThan(-1);
  const methodBody = clientSrc.slice(methodStart, methodEnd);

  // Narrow further to the REQUEST BODY object literal actually sent over the
  // wire — the argument passed to `this.request(...)`. Scanning the whole
  // method body would also match `input.file` inside the client-side
  // `.refine`-mirroring guard (`if (!input.text && !input.file && ...)`),
  // which reads the field but never forwards it — exactly the false-positive
  // this test must not produce.
  const requestCallStart = methodBody.indexOf(
    "this.request<CaptureStructureResponse>("
  );
  expect(
    requestCallStart,
    "this.request<CaptureStructureResponse>(...) call not found in captureStructure()"
  ).toBeGreaterThan(-1);
  const requestBodyLiteral = methodBody.slice(requestCallStart);

  const forwardRe = /\binput\.([a-zA-Z][a-zA-Z0-9]*)\b/g;
  const forwarded = new Set<string>();
  while ((m = forwardRe.exec(requestBodyLiteral)) !== null) {
    forwarded.add(m[1]);
  }
  clientForwardedFields = Array.from(forwarded).filter((f) => !EXCLUDED.has(f));
});

describe("hub-rest-client captureStructure() — field parity with the server codec", () => {
  it("extracted a non-trivial server field list (self-guard: parser did not silently break)", () => {
    expect(serverFields.length).toBeGreaterThanOrEqual(7);
    // Known-positive: `file` must be present in the SERVER schema, or the
    // extraction regex is reading the wrong block entirely.
    expect(serverFields).toContain("file");
  });

  it("extracted a non-trivial client-forwarded field list (self-guard)", () => {
    expect(clientForwardedFields.length).toBeGreaterThanOrEqual(7);
  });

  it("every server-accepted CaptureStructureRequest field is forwarded by captureStructure()", () => {
    const missing = serverFields.filter(
      (f) => !clientForwardedFields.includes(f)
    );
    expect(
      missing,
      `hub-rest-client captureStructure() does not forward: ${missing.join(", ")}. ` +
        `The server's CaptureStructureRequestSchema accepts these fields but the ` +
        `client method has no way to send them — an agent or CLI caller can never ` +
        `provide them, indistinguishable from a field deliberately withheld.`
    ).toEqual([]);
  });
});
