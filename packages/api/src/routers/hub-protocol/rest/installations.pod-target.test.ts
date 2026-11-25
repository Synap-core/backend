/**
 * Hub `POST /installations/request` with `computer: "pod"` (any case): the
 * pod itself is the target, handled BEFORE any computer is looked up, through
 * the one rule `requestPodInstall` (the MCP door's "pod" target asks through
 * it too). The rule has its own suites; this file pins the door: who reaches
 * it, with what, and how each answer goes on the wire.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  podAsks: [] as Array<Record<string, unknown>>,
  computerLookups: 0,
  answer: null as null | ((input: Record<string, unknown>) => unknown),
}));

vi.mock(
  "../../../services/installations/request-installation.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      requestPodInstall: async (input: Record<string, unknown>) => {
        h.podAsks.push(input);
        return h.answer!(input);
      },
      requestInstallation: async () => {
        throw new Error("a pod ask must never reach requestInstallation");
      },
    };
  }
);

vi.mock(
  "../../../services/installations/installations.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      resolveCallerComputer: async () => {
        h.computerLookups += 1;
        return null;
      },
      loadPersonsComputer: async () => {
        h.computerLookups += 1;
        return null;
      },
    };
  }
);

import { registerInstallationsRoutes } from "./installations.js";
import type { HubHono, HubVariables } from "./_shared.js";

const PERSON = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const PROPOSAL = "33333333-3333-4333-8333-333333333333";
const KEY = "media-ffmpeg";

function appAs(vars: { agentUserId?: string }): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    c.set("userId", PERSON);
    if (vars.agentUserId) c.set("agentUserId", vars.agentUserId);
    await next();
  });
  registerInstallationsRoutes(app);
  return app;
}

const ask = (app: HubHono, body: Record<string, unknown>) =>
  app.request("/installations/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// The rule's answers as `requestPodInstall` gives them: a person's ask
// installs, an agent's is a `capability.install` proposal.
const byCaller = (input: Record<string, unknown>) =>
  input.agentUserId
    ? {
        status: "proposed",
        proposalId: PROPOSAL,
        reviewUrl: `https://pod.example/proposal/${PROPOSAL}`,
      }
    : { status: "installed", result: { installed: true, secret: "x" } };

beforeEach(() => {
  h.podAsks.length = 0;
  h.computerLookups = 0;
  h.answer = byCaller;
});

describe('POST /installations/request computer "pod"', () => {
  it("an agent's install is proposed (202) with its review link, through requestPodInstall", async () => {
    const res = await ask(appAs({ agentUserId: AGENT }), {
      capabilityKey: KEY,
      action: "install",
      computer: "pod",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "proposed",
      proposalId: PROPOSAL,
      reviewUrl: `https://pod.example/proposal/${PROPOSAL}`,
    });
    expect(typeof body.message).toBe("string");
    expect(h.podAsks).toEqual([
      { userId: PERSON, agentUserId: AGENT, capabilityKey: KEY },
    ]);
    expect(h.computerLookups).toBe(0);
  });

  it('a person\'s install is installed (200), whatever the case of "pod", and the result stays on the pod', async () => {
    const res = await ask(appAs({}), {
      capabilityKey: KEY,
      action: "install",
      computer: "Pod",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "installed" });
    expect(h.podAsks).toEqual([
      { userId: PERSON, agentUserId: null, capabilityKey: KEY },
    ]);
    expect(h.computerLookups).toBe(0);
  });

  it("a capability already on the pod answers already_on_pod (200)", async () => {
    h.answer = () => ({ status: "already_on_pod", capabilityKey: KEY });
    const res = await ask(appAs({}), {
      capabilityKey: KEY,
      action: "install",
      computer: "POD",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "already_on_pod",
      capabilityKey: KEY,
    });
  });

  it("a refusal keeps its status, code and reason, never the manifest", async () => {
    h.answer = () => ({
      status: "refused",
      code: "CANNOT_INSTALL",
      reason: "RUNS_ON_COMPUTER",
      error: `${KEY} runs on a computer, not on the pod: name one of the person's computers.`,
      httpStatus: 409,
      manifest: { placement: { runsOn: ["computer"] } },
    });
    const res = await ask(appAs({ agentUserId: AGENT }), {
      capabilityKey: KEY,
      action: "install",
      computer: "pod",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "CANNOT_INSTALL",
      reason: "RUNS_ON_COMPUTER",
      error: `${KEY} runs on a computer, not on the pod: name one of the person's computers.`,
    });
  });

  it.each(["remove", "update", "verify"])(
    'action "%s" on the pod is refused (409 CANNOT_INSTALL) before anything is asked',
    async (action) => {
      const res = await ask(appAs({ agentUserId: AGENT }), {
        capabilityKey: KEY,
        action,
        computer: "pod",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "CANNOT_INSTALL" });
      expect(h.podAsks).toHaveLength(0);
      expect(h.computerLookups).toBe(0);
    }
  );

  it("a computer that is not the pod still goes through the computer lookup", async () => {
    const res = await ask(appAs({}), {
      capabilityKey: KEY,
      action: "install",
      computer: "pod-mac",
    });
    expect(res.status).toBe(404);
    expect(h.computerLookups).toBe(1);
    expect(h.podAsks).toHaveLength(0);
  });
});
