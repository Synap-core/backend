import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the session check answers: proceed, or the route's 401 / 503. */
let session: "active" | "none" | "unavailable" = "active";
vi.mock("../../../lib/kratos", () => ({
  apiSessionDenial: async () =>
    session === "active"
      ? null
      : Response.json({}, { status: session === "none" ? 401 : 503 }),
}));

import { GET } from "./route";
import { PUT } from "./settings/route";

const fetchMock = vi.fn();

beforeEach(() => {
  session = "active";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const pod = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
  });

const get = () =>
  GET(
    new Request("http://pod-admin.test/api/pod-updates", {
      headers: { cookie: "s=1", "x-forwarded-for": "198.51.100.7" },
    })
  );

const put = (body: unknown) =>
  PUT(
    new Request("http://pod-admin.test/api/pod-updates/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: "s=1" },
      body: JSON.stringify(body),
    })
  );

describe("GET /api/pod-updates", () => {
  it("forwards the cookie and client address, and relays the pod's answer", async () => {
    fetchMock.mockResolvedValue(pod(200, { canEdit: true }));
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canEdit: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/pod-updates$/);
    expect(init.headers.Cookie).toBe("s=1");
    expect(init.headers["x-forwarded-for"]).toBe("198.51.100.7");
  });

  it("does not call the pod without a session", async () => {
    session = "none";
    expect((await get()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503, not 401, when the pod could not check the session", async () => {
    session = "unavailable";
    expect((await get()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the pod's 503 a 503", async () => {
    fetchMock.mockResolvedValue(pod(503, { error: "settings_unavailable" }));
    expect((await get()).status).toBe(503);
  });

  it("never relays a non-JSON answer as data", async () => {
    fetchMock.mockResolvedValue(pod(404, "<html>not found</html>"));
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Pod returned 404." });
  });

  it("says the pod is unreachable as a 502", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await get()).status).toBe(502);
  });
});

describe("PUT /api/pod-updates/settings", () => {
  it("forwards the patch as a PUT", async () => {
    fetchMock.mockResolvedValue(pod(200, { canEdit: true }));
    const res = await put({ auto: false });
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/pod-updates\/settings$/);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ auto: false });
  });

  it("keeps the pod's 403 for a non-admin", async () => {
    fetchMock.mockResolvedValue(pod(403, { error: "forbidden" }));
    expect((await put({ channel: "fast" })).status).toBe(403);
  });

  it("refuses a non-object body without calling the pod", async () => {
    expect((await put("nope")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
