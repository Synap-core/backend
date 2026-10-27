/**
 * An inbound webhook source (0362) is a CREDENTIAL: whoever holds its secret
 * fires the space's automations as its owner, and creating one re-binds every
 * automation of the space that declared its name — other members' too
 * (services/webhooks/inbound-source.ts). So minting or replacing one is a POD
 * ADMIN's act:
 *   - a space member who is not a pod admin is FORBIDDEN on the create and
 *     replace doors, and the service is never reached;
 *   - a pod admin reaches it (control);
 *   - no procedure of the router that reaches the create or replace service
 *     is built on anything but `podAdminProcedure` (derived from the router's
 *     source, so a member-level door added later fails here).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  rotate: vi.fn(),
  admins: new Set<string>(),
}));

vi.mock("../services/webhooks/inbound-source.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createInboundWebhookSource: h.create,
  rotateInboundWebhookSecret: h.rotate,
}));
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => h.admins.has(userId),
}));
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { webhooksRouter } from "./webhooks.js";
import type { Context } from "../types/context.js";

const WS = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";

const as = (userId: string) =>
  webhooksRouter.createCaller({
    authenticated: true,
    userId,
  } as unknown as Context);

beforeEach(() => {
  h.create.mockReset().mockResolvedValue({ source: {}, secret: "s" });
  h.rotate.mockReset().mockResolvedValue({ source: {}, secret: "s" });
  h.admins = new Set(["admin-1"]);
});

describe("inbound webhook source doors are pod-admin only", () => {
  it("a member who is not a pod admin cannot create a source", async () => {
    await expect(
      as("member-1").adminCreateInboundSource({ workspaceId: WS, name: "CI" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("a member who is not a pod admin cannot replace a source's secret", async () => {
    await expect(
      as("member-1").adminRotateInboundSourceSecret({
        id: SOURCE,
        workspaceId: WS,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it("a pod admin reaches both (control)", async () => {
    await as("admin-1").adminCreateInboundSource({
      workspaceId: WS,
      name: "CI",
    });
    await as("admin-1").adminRotateInboundSourceSecret({
      id: SOURCE,
      workspaceId: WS,
    });
    expect(h.create).toHaveBeenCalledWith({
      userId: "admin-1",
      workspaceId: WS,
      name: "CI",
    });
    expect(h.rotate).toHaveBeenCalledWith({ id: SOURCE, workspaceId: WS });
  });

  it("every procedure that mints or replaces a source is a podAdminProcedure", () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "webhooks.ts"),
      "utf8"
    );
    // Top-level router entries: `  name: builder` up to the next entry.
    const entries = [
      ...src.matchAll(
        /^ {2}(\w+): (\w+)\b([\s\S]*?)(?=^ {2}(?:\w+: |\/\*\*|\/\/)|^\}\);)/gm
      ),
    ];
    const minting = entries.filter(([, , , body]) =>
      /\b(createInboundWebhookSource|rotateInboundWebhookSecret)\(/.test(body!)
    );
    // Non-vacuity: both admin doors are found by the parse.
    expect(minting.map(([, name]) => name).sort()).toEqual(
      expect.arrayContaining([
        "adminCreateInboundSource",
        "adminRotateInboundSourceSecret",
      ])
    );
    const notAdmin = minting
      .filter(([, , builder]) => builder !== "podAdminProcedure")
      .map(([, name, builder]) => `${name}: ${builder}`);
    expect(notAdmin).toEqual([]);
  });
});
