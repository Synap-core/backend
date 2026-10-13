/**
 * Starting a login flow from a browser that is already signed in.
 *
 * Kratos answers 400 `{ error: { id: "session_already_available" } }`. The
 * client read `id` at the top level, so it never matched and /login showed
 * "Failed to create login flow (400)" to a signed-in operator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLoginFlow,
  existingSessionAction,
  loginFlowRefusal,
} from "./kratos-flow";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ALREADY = {
  error: {
    id: "session_already_available",
    code: 400,
    status: "Bad Request",
    reason: "A valid session was detected and thus login is not possible.",
    message: "The request was malformed or contained invalid parameters",
  },
};

let urls: string[] = [];
beforeEach(() => {
  urls = [];
  process.env.POD_PUBLIC_URL = "https://pod.example.com";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.POD_PUBLIC_URL;
});

const SESSION = { id: "s1", active: true, identity: { id: "u1" } };

/** `create` answers the flow request; whoami answers with `whoamiRes`. */
function answer(create: Response, whoamiRes: Response = json(SESSION)) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return url.includes("/sessions/whoami") ? whoamiRes : create;
    })
  );
}

describe("loginFlowRefusal", () => {
  it("reads session_already_available from Kratos' error envelope", () => {
    expect(loginFlowRefusal(400, ALREADY)).toEqual({ kind: "signed_in" });
  });

  it("still accepts a bare top-level id", () => {
    expect(loginFlowRefusal(400, { id: "session_already_available" })).toEqual({
      kind: "signed_in",
    });
  });

  it("words any other refusal with Kratos' message and reason", () => {
    expect(
      loginFlowRefusal(400, {
        error: { id: "x", message: "Bad", reason: "because" },
      })
    ).toEqual({ kind: "error", message: "Bad: because" });
  });

  it("falls back to the status when the body says nothing", () => {
    expect(loginFlowRefusal(502, null)).toEqual({
      kind: "error",
      message: "Failed to create login flow (502)",
    });
  });
});

describe("createLoginFlow", () => {
  it("reports the existing session instead of throwing", async () => {
    answer(json(ALREADY, 400));
    await expect(
      createLoginFlow("https://admin.example/login")
    ).resolves.toEqual({ existingSession: SESSION });
  });

  it("never shows the bare 400 when the session can't be read back", async () => {
    answer(json(ALREADY, 400), json({}, 429));
    await expect(createLoginFlow()).rejects.toThrow(/already signed in/);
  });

  it("asks for a re-auth flow with refresh=true", async () => {
    answer(json({ id: "f1", ui: { action: "x", method: "POST", nodes: [] } }));
    const r = await createLoginFlow(undefined, { refresh: true });
    expect(r.flow?.id).toBe("f1");
    expect(new URL(urls[0]).searchParams.get("refresh")).toBe("true");
  });
});

describe("existingSessionAction", () => {
  it("returns when the server could not check (busy pod)", () => {
    expect(existingSessionAction("unavailable")).toBe("return");
  });

  it("returns when the server saw the session (re-auth)", () => {
    expect(existingSessionAction("active")).toBe("return");
  });

  it("explains instead of looping when the server saw NO session", () => {
    expect(existingSessionAction("none")).toBe("explain_cookie_scope");
  });
});
