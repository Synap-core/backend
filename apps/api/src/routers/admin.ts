/**
 * Admin Management Router
 *
 * Handles admin invitations and validation for control-plane-provisioned backends
 */

import { Hono } from "hono";
import { getDb } from "@synap/database";
import {
  adminInvitations,
  provisioningTokens,
  invites,
  users,
} from "@synap/database/schema";
import { eq, and, gte, isNull } from "drizzle-orm";
import crypto from "crypto";
import { safeTokenEqual } from "@synap/auth";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "admin-router" });

export const adminRouter = new Hono();

/**
 * Bootstrap first self-hosted admin via one-time token.
 * POST /api/admin/bootstrap/claim
 *
 * Body: { token, email, role? }
 * - token must match ADMIN_BOOTSTRAP_TOKEN in env
 * - token is one-time (tracked in provisioning_tokens)
 * - creates a pod-wide invite so the user can complete Kratos registration
 */
adminRouter.post("/bootstrap/claim", async (c) => {
  try {
    const expectedToken = process.env.ADMIN_BOOTSTRAP_TOKEN?.trim();
    if (!expectedToken) {
      return c.json(
        { error: "Bootstrap token flow is not enabled on this pod" },
        403
      );
    }

    const body = await c.req.json().catch(() => null);
    const token =
      body && typeof body.token === "string" ? body.token.trim() : "";
    const email =
      body && typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : "";
    const roleRaw =
      body && typeof body.role === "string" ? body.role.trim() : "admin";
    const role: "admin" | "editor" | "viewer" =
      roleRaw === "viewer" || roleRaw === "editor" || roleRaw === "admin"
        ? roleRaw
        : "admin";

    if (!token || !email) {
      return c.json({ error: "token and email are required" }, 400);
    }

    // Basic email sanity check (enough for bootstrap path, avoid adding heavy deps)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: "Invalid email address" }, 400);
    }

    if (!safeTokenEqual(token, expectedToken)) {
      return c.json({ error: "Invalid bootstrap token" }, 401);
    }

    const db = await getDb();

    // First-admin only path: once any human user exists, bootstrap is closed.
    const existingHuman = await db.query.users.findFirst({
      where: eq(users.userType, "human"),
      columns: { id: true, email: true },
    });
    if (existingHuman) {
      return c.json(
        {
          error:
            "Bootstrap already completed on this pod. Use normal invites/admin flows.",
        },
        409
      );
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(`admin_bootstrap:${token}`)
      .digest("hex");
    const existingTokenUse = await db.query.provisioningTokens.findFirst({
      where: eq(provisioningTokens.tokenHash, tokenHash),
    });
    if (existingTokenUse?.usedAt) {
      return c.json({ error: "Bootstrap token already used" }, 403);
    }

    // Idempotent-ish on email: replace existing pending invite for same email.
    const pending = await db.query.invites.findFirst({
      where: eq(invites.email, email),
    });
    if (pending) {
      await db.delete(invites).where(eq(invites.id, pending.id));
    }

    const inviteToken = crypto.randomBytes(24).toString("hex");
    await db.insert(invites).values({
      type: "pod",
      email,
      role,
      token: inviteToken,
      invitedBy: "admin-bootstrap",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
    });

    if (existingTokenUse) {
      await db
        .update(provisioningTokens)
        .set({ usedAt: new Date() })
        .where(eq(provisioningTokens.id, existingTokenUse.id));
    } else {
      await db.insert(provisioningTokens).values({
        tokenHash,
        usedAt: new Date(),
      });
    }

    logger.info({ email, role }, "Bootstrap invite claimed via one-time token");
    return c.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed bootstrap claim");
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Validate admin invitation token
 * GET /api/admin/validate-invite?token=...
 */
adminRouter.get("/validate-invite", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.json({ error: "Token required" }, 400);
  }

  const db = await getDb();
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const invitation = await db.query.adminInvitations.findFirst({
    where: and(
      eq(adminInvitations.tokenHash, tokenHash),
      gte(adminInvitations.expiresAt, new Date()),
      isNull(adminInvitations.usedAt)
    ),
  });

  if (!invitation) {
    return c.json({ valid: false, error: "Invalid or expired token" }, 400);
  }

  return c.json({
    valid: true,
    email: invitation.email,
    backendDomain: invitation.backendDomain,
  });
});

/**
 * POST /api/admin/invite — RETIRED (security decision D9).
 *
 * It minted an admin invitation for whoever held the pod's PROVISIONING_TOKEN,
 * once, at any time — including after the pod had an owner. Nothing calls it
 * (the Control Plane's own `/admin/invite` is a different, CP-side route), and
 * the first owner is created through the bootstrap-only doors
 * (`/api/hub/setup/magic-link` → `/setup/first-admin`). After bootstrap, people
 * are invited from the owner's session.
 */
adminRouter.post("/invite", (c) => {
  logger.warn("Rejected retired provisioning-token admin invite");
  return c.json(
    {
      error:
        "Admin invitations no longer use the PROVISIONING_TOKEN. Create the first owner with `synap setup admin --magic-link`, then invite people from the owner's session.",
      code: "PROVISIONING_TOKEN_RETIRED",
    },
    403
  );
});
