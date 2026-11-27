/**
 * Devices (0461) — the devices registry (devices plan 767a5978 §3, P1;
 * founder decision 78fc3fa1: tables, not entity kinds; internal namespace
 * `fleet`, product word "Devices").
 *
 * One row per device the person connects: a computer, a VM, a container, a
 * cloud server, a disk, a phone, a printer, a camera, a sensor. A computer
 * that runs the Synap runner keeps its `users` principal
 * (`agent_type = 'machine'`): that row is the device's KEY (it signs in,
 * holds grants, hosts agents), this row is the THING (what it is, what it
 * has, where it sits). A device with no runner never becomes a user.
 *
 * - `kind`: text with a shape check, never an enum (`DEVICE_KINDS` in
 *   `@synap-core/types/device-manifest`): a new kind needs no migration.
 * - `manifest`: the device manifest v1, as it last reported it.
 * - Status is a READ verdict (`deriveDeviceStatus`) from `lastReportAt` and
 *   the manifest's health. There is no status column, on purpose.
 * - One device per principal (`devices_principal_uidx`): the backfill and the
 *   enrolment door never make a twin.
 *
 * Writes: the enrolment door and a runner's report
 * (`packages/api/src/services/fleet/`), and the computer doors that rename a
 * computer or say whose it is (they write the same words here). Reads: the
 * `fleet` router and the MCP `devices[]`, through the access layer.
 */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  DeviceBelongsTo,
  DeviceConnection,
  DeviceManifest,
} from "@synap-core/types/device-manifest";

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The person whose device it is. */
    ownerUserId: text("owner_user_id").notNull(),
    /** The space it is filed in, if any (a shared device is read there). */
    workspaceId: uuid("workspace_id"),
    belongsTo: text("belongs_to")
      .$type<DeviceBelongsTo>()
      .notNull()
      .default("person"),
    /** `DEVICE_KINDS`; any slug passes the database check. */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    /** The device it runs on: host → VM → container. */
    parentDeviceId: uuid("parent_device_id"),
    /** The machine user, when the device runs the Synap runner. */
    principalUserId: text("principal_user_id"),
    connection: jsonb("connection")
      .$type<DeviceConnection>()
      .notNull()
      .default({ mode: "manual" }),
    manifest: jsonb("manifest").$type<DeviceManifest | null>(),
    labels: text("labels").array().notNull().default([]),
    lastReportAt: timestamp("last_report_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    retiredAt: timestamp("retired_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    principalUidx: uniqueIndex("devices_principal_uidx")
      .on(table.principalUserId)
      .where(sql`${table.principalUserId} IS NOT NULL`),
    ownerIdx: index("devices_owner_idx").on(table.ownerUserId),
    workspaceIdx: index("devices_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    parentIdx: index("devices_parent_idx")
      .on(table.parentDeviceId)
      .where(sql`${table.parentDeviceId} IS NOT NULL`),
  })
);

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
