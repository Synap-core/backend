import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "@synap/database";
import { users } from "@synap/database/schema";
import { kratosAdmin } from "@synap/auth";
import {
  createAdminUser,
  ensureUserRow,
  ensureWorkspaceForUser,
  findKratosIdentityByEmail,
} from "./create-admin-user.js";
import {
  PasswordStepError,
  parseSecretFromStdin,
  readStdin,
  setPasswordAndVerify,
  verifyPasswordLogin,
} from "./user-admin-password.js";

type Action = "list" | "add-admin" | "reset-password" | "delete";

const action = (process.env.ACTION || "list") as Action;
const email = process.env.ADMIN_EMAIL || process.env.USER_EMAIL || "";
// The password is a SECRET: it is read from STDIN (see main()), never from
// argv or env. The CLI wrapper pipes it in; there is no env fallback.
let password = "";
const kratosPublicUrl =
  process.env.KRATOS_PUBLIC_URL || "http://localhost:4433";
const name = process.env.ADMIN_NAME || process.env.USER_NAME || "";
// D7: opt-in — no blank personal workspace unless CREATE_WORKSPACE=true.
const createWorkspace = process.env.CREATE_WORKSPACE === "true";
const limitRaw = process.env.LIMIT || "200";
const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 200;

async function runList() {
  const db = await getDb();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      lastSyncedAt: users.lastSyncedAt,
    })
    .from(users)
    .limit(Math.max(1, Math.min(1000, limit)));

  if (rows.length === 0) {
    console.log("No users found.");
    return;
  }

  console.log("Users:");
  for (const row of rows) {
    console.log(
      [
        `- id=${row.id}`,
        `email=${row.email}`,
        `name=${row.name ?? "-"}`,
        `created=${row.createdAt?.toISOString?.() ?? "-"}`,
        `updated=${row.updatedAt?.toISOString?.() ?? "-"}`,
      ].join(" ")
    );
  }
}

async function getIdentityIdByEmail(
  emailValue: string
): Promise<string | null> {
  const db = await getDb();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, emailValue))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function runAddAdmin() {
  if (!email || !password) {
    throw new Error(
      "ADMIN_EMAIL/USER_EMAIL and a password on stdin are required"
    );
  }
  try {
    const result = await createAdminUser(email, password, name || undefined, {
      createWorkspace,
    });
    await verifyPasswordLogin(kratosPublicUrl, email, password);
    console.log("Admin user created; login verified.");
    console.log(`identity_id=${result.identityId}`);
    if (result.workspaceId) {
      console.log(`workspace_id=${result.workspaceId}`);
    } else {
      console.log("workspace_id=<none>");
    }
    return;
  } catch (error) {
    const err = error as { response?: { status?: number } };
    if (err.response?.status !== 409) throw error;
  }

  // Existing Kratos identity -> make command idempotent: reset password and ensure DB row.
  const identity = await findKratosIdentityByEmail(email);
  if (!identity) {
    throw new Error(
      `Identity conflict reported by Kratos, but no identity found for ${email}`
    );
  }

  await ensureUserRow(identity.id, email, name || identity.traits?.name);
  await setPasswordAndVerify({
    admin: kratosAdmin as never,
    identityId: identity.id,
    email,
    password,
    publicUrl: kratosPublicUrl,
  });

  let workspaceId: string | null = null;
  if (createWorkspace) {
    workspaceId = await ensureWorkspaceForUser(identity.id, name);
  }

  console.log(
    "Admin identity already existed; password updated and user synced."
  );
  console.log(`identity_id=${identity.id}`);
  if (workspaceId) {
    console.log(`workspace_id=${workspaceId}`);
  } else {
    console.log("workspace_id=<none>");
  }
}

async function runResetPassword() {
  if (!email || !password) {
    throw new Error(
      "USER_EMAIL (or ADMIN_EMAIL) and a password on stdin are required"
    );
  }

  const identityId = await getIdentityIdByEmail(email);
  const resolvedIdentityId =
    identityId ?? (await findKratosIdentityByEmail(email))?.id ?? null;
  if (!resolvedIdentityId)
    throw new PasswordStepError(
      "identity-not-found",
      `No Kratos identity found for email: ${email}`
    );

  const { data: identity } = await kratosAdmin.getIdentity({
    id: resolvedIdentityId,
  });
  await ensureUserRow(
    resolvedIdentityId,
    email,
    (identity.traits as { name?: string } | undefined)?.name
  );
  await setPasswordAndVerify({
    admin: kratosAdmin as never,
    identityId: resolvedIdentityId,
    email,
    password,
    publicUrl: kratosPublicUrl,
  });

  console.log(`Password reset for ${email}; login verified.`);
}

async function runDelete() {
  if (!email) {
    throw new Error("USER_EMAIL (or ADMIN_EMAIL) is required");
  }
  const identityId = await getIdentityIdByEmail(email);
  const resolvedIdentityId =
    identityId ?? (await findKratosIdentityByEmail(email))?.id ?? null;
  if (!resolvedIdentityId)
    throw new Error(`User not found for email: ${email}`);
  await kratosAdmin.deleteIdentity({ id: resolvedIdentityId });
  console.log(`Deleted identity for ${email} (${resolvedIdentityId}).`);
  console.log("Note: DB cleanup depends on your schema constraints/cascades.");
}

async function main() {
  if (action === "add-admin" || action === "reset-password") {
    password = parseSecretFromStdin(await readStdin(process.stdin));
  }
  switch (action) {
    case "list":
      await runList();
      break;
    case "add-admin":
      await runAddAdmin();
      break;
    case "reset-password":
      await runResetPassword();
      break;
    case "delete":
      await runDelete();
      break;
    default:
      throw new Error(`Unknown ACTION=${action}`);
  }
}

main().catch((error) => {
  if (error instanceof PasswordStepError) {
    console.error(
      `[user-admin-cli] FAILED at step ${error.step}: ${error.message}`
    );
  } else {
    // Message only: an axios error embeds the request body (the password)
    // in config.data.
    console.error(
      "[user-admin-cli] failed:",
      error instanceof Error ? error.message : String(error)
    );
  }
  process.exit(1);
});
