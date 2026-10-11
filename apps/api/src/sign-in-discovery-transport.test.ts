/**
 * `GET /api/federation/discovery` must be readable BEFORE sign-in from every
 * client of the one sign-in door (`signInToPodWithCloud`): a web app on an
 * owner-approved origin (which has no pod token yet) and the browser
 * extension (an origin the pod never approved). Driven through the REAL
 * `podEdgeCorsMiddleware`, with the origin-approval lookup and the explicit
 * token check stubbed so both branches are reachable without a database.
 *
 * Does NOT cover: the route body itself (federation.ts), or any other
 * federation path — those keep the ordinary origin + token gates, which the
 * last case pins.
 */
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const approved = vi.hoisted(() => ({ value: false }));

vi.mock("./cors-origin.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./cors-origin.js")>();
  return {
    ...real,
    isApprovedApplicationOrigin: vi.fn(async () => approved.value),
  };
});
vi.mock("./explicit-pod-session.js", () => ({
  validateExplicitPodSessionToken: vi.fn(async (token?: string) =>
    token === "good" ? "valid" : "invalid"
  ),
}));

let podEdgeCorsMiddleware: typeof import("./pod-edge-cors.js").podEdgeCorsMiddleware;

beforeAll(async () => {
  process.env.DATABASE_URL ??=
    "postgresql://synap:test@localhost:5432/synap_test";
  process.env.SYNAP_BASE_DOMAIN = "pod.example.test";
  ({ podEdgeCorsMiddleware } = await import("./pod-edge-cors.js"));
}, 120_000);

beforeEach(() => {
  approved.value = false;
});

function app() {
  const a = new Hono();
  a.use("*", podEdgeCorsMiddleware);
  a.get("/api/federation/discovery", (c) =>
    c.json({
      cloudSignIn: { available: true, provider: "cp", issuerUrl: null },
    })
  );
  a.post("/api/federation/discovery", (c) => c.json({ ok: true }));
  a.get("/api/hub/entities", (c) => c.json({ items: [] }));
  return a;
}

const APP_ORIGIN = "https://crm.synap.test";
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnop";

describe("pre-sign-in discovery transport", () => {
  it("an approved app origin reads discovery without a pod token", async () => {
    approved.value = true;
    const res = await app().request("/api/federation/discovery", {
      headers: { Origin: APP_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    // Credentialless: approved origins get credentials only on Kratos bootstrap.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("an origin the pod never approved (the extension) is not refused", async () => {
    const res = await app().request("/api/federation/discovery", {
      headers: { Origin: EXTENSION_ORIGIN },
    });
    expect(res.status).toBe(200);
    // No ACAO: CORS still stops an unapproved WEB page from reading it.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("every other pod API keeps its gates (non-vacuity)", async () => {
    // Unapproved origin → refused at the server boundary.
    const refused = await app().request("/api/hub/entities", {
      headers: { Origin: EXTENSION_ORIGIN },
    });
    expect(refused.status).toBe(403);
    // Approved origin without a token → 401.
    approved.value = true;
    const tokenless = await app().request("/api/hub/entities", {
      headers: { Origin: APP_ORIGIN },
    });
    expect(tokenless.status).toBe(401);
    // A write to the discovery path is not exempt.
    approved.value = false;
    const write = await app().request("/api/federation/discovery", {
      method: "POST",
      headers: { Origin: EXTENSION_ORIGIN },
    });
    expect(write.status).toBe(403);
  });
});
