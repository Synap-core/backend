/**
 * `presence.recovery.complete`: the browser that finishes "I lost my passkey"
 * is the one session kept signed in (founder, answer 4819a6c3). The router
 * hands the service the caller's OWN Kratos session id; it needs a fresh
 * sign-in AT the pod, and never runs from a Synap app's device session.
 *
 * No live Postgres or Kratos: the recovery service is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock("../services/presence/recovery.js", () => ({
  completePresenceRecovery: (args: unknown) => h.complete(args),
  cancelPresenceRecovery: vi.fn(),
  readPresenceRecovery: vi.fn(),
  requestPresenceRecovery: vi.fn(),
}));
vi.mock("../services/agent-connect.js", () => ({
  openAgentConnectProposal: vi.fn(async () => null),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

import { presenceRouter } from "./presence.js";

const PERSON = "11111111-1111-4111-8111-111111111111";
const signedIn = (minutesAgo: number, method = "password") => ({
  id: "kratos-session-here",
  identity: { id: PERSON },
  authentication_methods: [
    {
      method,
      completed_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    },
  ],
});
const caller = (session: Record<string, unknown>, extra = {}) =>
  presenceRouter.createCaller({
    authenticated: true,
    userId: PERSON,
    sessionKind: "kratos",
    session,
    ...extra,
  } as never);

beforeEach(() => {
  h.complete.mockReset();
  h.complete.mockResolvedValue({ status: "completed" });
});

describe("presence.recovery.complete", () => {
  it("keeps the caller's own session signed in, and only that one", async () => {
    await caller(signedIn(2)).recovery.complete();
    expect(h.complete).toHaveBeenCalledWith({
      userId: PERSON,
      keepSessionId: "kratos-session-here",
    });
  });

  it("GUARDRAIL: a stale or federated sign-in, or a device session, finishes nothing", async () => {
    await expect(
      caller(signedIn(30)).recovery.complete()
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller(signedIn(1, "oidc")).recovery.complete()
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller(
        { ...signedIn(1), device: { id: "d", authTime: new Date() } },
        { sessionKind: "person_device" }
      ).recovery.complete()
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.complete).not.toHaveBeenCalled();
  });
});
