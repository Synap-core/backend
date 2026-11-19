/**
 * Hub `PATCH /focus-sessions/:id` — ONE CARD PER QUESTION at the door the
 * live twin came through (session cf60123c: a pod-run agent's `update_run`
 * → this PATCH with `outcomes`, on the AI service's internal key, which names
 * no acting agent). The second card never reaches the membrane, and the reply
 * names the open card the person already has (`deduped` + a warning).
 *
 * Harness of `focus-sessions.patch-stamps.test.ts`: the real route, the
 * stored row stubbed, the membrane the observed seam (it answers `proposed`
 * here, so the reply can be read).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const FIRST = {
  key: "validation-esteban-arias",
  kind: "decision",
  label: "Disposition Esteban Arias — Nurturing ou Disqualified",
  status: "pending",
  owner: "human",
  blockedReason: "decision",
  why: "Antoine doit choisir entre Nurturing et Disqualified.",
  ask: {
    mode: "choose",
    options: [
      { label: "Nurturing", value: "Passer le lead en nurturing" },
      {
        label: "Disqualified",
        value: "Passer le lead en disqualified",
        recommended: true,
      },
    ],
  },
};
const SECOND = {
  key: "disposition-esteban-arias",
  kind: "decision",
  label: "Disposition d'Esteban Arias (Prometheus)",
  owner: "human",
  blockedReason: "decision",
  why: "Prometheus a répondu le 2 Nov : pas un fit actuel.",
  unblocks: "La fiche est clôturée",
  ask: {
    mode: "choose",
    options: [
      { label: "Nurturing", value: "nurturing", recommended: true },
      { label: "Disqualified", value: "disqualified" },
    ],
  },
};

const h = vi.hoisted(() => ({ gated: [] as Array<Record<string, unknown>> }));

vi.mock("../../../utils/permission-check.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkPermissionOrPropose: async (p: Record<string, unknown>) => {
    h.gated.push(p);
    return {
      proposalId: "p-1",
      proposalType: "focus_session.update",
      summary: "s",
    };
  },
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

function app(keyType?: string): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (keyType) c.set("keyType", keyType);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const patch = (body: unknown, keyType?: string) =>
  app(keyType).request(`/focus-sessions/${SESSION_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const gatedLabels = () =>
  (
    (h.gated.at(-1)!.data as Record<string, unknown>).expectedOutputs as Array<
      Record<string, unknown>
    >
  ).map((o) => o.label);

describe("Hub PATCH — one card per question", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.gated = [];
    findFirstSpy = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        workspaceId: null,
        goal: "g",
        status: "active",
        criteria: [],
        expectedOutputs: [FIRST],
      } as never);
  });
  afterEach(() => findFirstSpy.mockRestore());

  it("a pod-run agent's second card for the open question is left out and named back", async () => {
    const res = await patch({ outcomes: [SECOND] }, "is_internal");
    const body = (await res.json()) as Record<string, any>;
    expect(h.gated).toHaveLength(1);
    expect(gatedLabels()).toEqual([FIRST.label]);
    expect(body.deduped).toEqual([
      {
        key: "validation-esteban-arias",
        label: FIRST.label,
        asked: SECOND.label,
      },
    ]);
    expect(body.warnings.join(" ")).toContain(
      `"${SECOND.label}" asks what "${FIRST.label}" already asks`
    );
  });

  it("CONTROL: the person's own key files what it sends", async () => {
    const res = await patch({ outcomes: [SECOND] });
    const body = (await res.json()) as Record<string, any>;
    expect(gatedLabels()).toEqual([FIRST.label, SECOND.label]);
    expect(body.deduped).toBeUndefined();
  });
});
