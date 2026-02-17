/**
 * Admin Invitations Schema
 *
 * Stores invitation tokens for control-plane-provisioned backends
 * Allows passwordless initial admin setup via email link
 */
import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
export const adminInvitations = pgTable("admin_invitations", {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(), // SHA256 hash of token
    expiresAt: timestamp("expires_at", {
        mode: "date",
        withTimezone: true,
    }).notNull(),
    usedAt: timestamp("used_at", { mode: "date", withTimezone: true }),
    backendDomain: text("backend_domain").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
        .defaultNow()
        .notNull(),
}, (table) => ({
    emailIdx: index("idx_admin_invitations_email").on(table.email),
    tokenHashIdx: index("idx_admin_invitations_token_hash").on(table.tokenHash),
}));
//# sourceMappingURL=admin-invitations.js.map