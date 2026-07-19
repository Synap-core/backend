/**
 * K1 anti-eviction proof for the product-neutral `service` identity (Item 2).
 *
 * The core K1 bug is that /setup/agent revokes every active hub_inbound key for
 * the owner before minting a new one, so two integrators sharing an agentType
 * silently evict each other. The `service` mint core MUST NOT do this: two
 * service keys for the same owner+workspace have to coexist.
 *
 * This test drives the mint core `createAndVerifyServiceKey` directly (no HTTP /
 * provisioning auth needed) and asserts:
 *   1. minting a SECOND key leaves the FIRST active (the K1 regression proof),
 *   2. the minted keys carry `keyType:"service"` and `linkedUserId:null`
 *      (so no agent remap fires → operator-direct writes),
 *   3. the mint core never calls `revokeActiveHubInboundKeysForUser`.
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "crypto";
import {
  db,
  sql,
  eq,
  apiKeys,
  EventRepository,
  ApiKeyRepository,
} from "@synap/database";
import { createAndVerifyServiceKey } from "../../../services/external-registration.js";
import * as hubIntegration from "../../../services/hub-integration-registration.js";
import { apiKeyService } from "../../../services/api-keys.js";

describe("createAndVerifyServiceKey — K1 anti-eviction", () => {
  const ownerUserId = `svc-owner-${randomUUID().slice(0, 8)}`;
  const workspaceId = randomUUID();

  afterAll(async () => {
    await db.delete(apiKeys).where(eq(apiKeys.userId, ownerUserId));
    vi.restoreAllMocks();
  });

  it("mints two service keys for the same owner+workspace and BOTH stay active", async () => {
    const revokeSpy = vi.spyOn(
      hubIntegration,
      "revokeActiveHubInboundKeysForUser"
    );

    const eventRepo = new EventRepository(sql);
    const apiKeyRepo = new ApiKeyRepository(db, eventRepo);

    const mint = () =>
      createAndVerifyServiceKey(
        apiKeyRepo,
        {
          keyName: "K1 Test Service Key",
          scope: ["hub-protocol.read"],
          userId: ownerUserId,
          workspaceId,
        },
        ownerUserId,
        ownerUserId
      );

    const first = await mint();
    expect(first.outcome).toBe("CONNECTED_VERIFIED");

    const second = await mint();
    expect(second.outcome).toBe("CONNECTED_VERIFIED");

    // Both rows persist AND both remain active — the second mint did NOT evict
    // the first. This is the direct K1 regression proof.
    const rows = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, ownerUserId));
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.isActive === true)).toBe(true);

    // Identity contract: real `service` keyType, `linkedUserId` NULL (no agent
    // remap → operator-direct), bound to the requested workspace.
    expect(rows.every((r) => r.keyType === "service")).toBe(true);
    expect(rows.every((r) => r.linkedUserId === null)).toBe(true);
    expect(rows.every((r) => r.workspaceId === workspaceId)).toBe(true);

    // The FIRST key still authenticates after the second mint.
    const verifyFirst = await apiKeyService.validateApiKey(first.plainKey);
    expect(verifyFirst).not.toBeNull();
    expect(verifyFirst?.isActive).toBe(true);
    expect(verifyFirst?.keyType).toBe("service");

    // The mint core never triggers sibling revocation.
    expect(revokeSpy).not.toHaveBeenCalled();
  });
});
