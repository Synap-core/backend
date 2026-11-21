/**
 * Renderer bundles (0436, decision c91d26dc): a set of frame cells that draw a
 * pod's objects plus the ONE host-module set they run on (React, react-dom,
 * the JSX runtimes, the kit and the tokens CSS, from one build).
 *
 * The cells live in `widget_definitions` (`cell:<slug>:<key>`); these two
 * tables hold what only a bundle has. Written only by `installRendererBundle`
 * (`packages/api/src/services/renderers/`), read by `renderers.status` /
 * `renderers.hostModules` and `GET /api/hub/renderers/host-modules`.
 *
 * Pod-level: no owner and no space column, so no access-layer rule. The
 * modules are public build output (React, the kit); which CELLS a caller sees
 * is decided on `widget_definitions`, through its own grant clause.
 *
 * `defaults` is the host fallback for a host with no built-ins (pod admin),
 * never a `renderer_bindings` row: a binding would beat the desktop's own
 * adapters (`pickEffectiveRenderer`).
 *
 * ONE host-module set per pod: the unique index on `module` admits one
 * bundle's modules (every set has `react`). The modules' foreign key is
 * DEFERRABLE INITIALLY DEFERRED in SQL, so an install writes them first and
 * the bundle row last, in one transaction (Drizzle does not model the
 * deferral; the migration is the source).
 */

import {
  pgTable,
  text,
  jsonb,
  integer,
  timestamp,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Which cell a host with no built-in draws, by bundle cell key. */
export interface RendererBundleDefaultsRow {
  "entity-card"?: string;
  "entity-detail"?: string;
  views?: Record<string, string>;
}

export const rendererBundles = pgTable("renderer_bundles", {
  slug: text("slug").primaryKey(),
  version: text("version").notNull(),
  /** sha256 over the host-module set (`rendererSetSha256`). */
  setSha256: text("set_sha256").notNull(),
  reactVersion: text("react_version").notNull(),
  kitExports: jsonb("kit_exports").$type<string[]>().notNull().default([]),
  defaults: jsonb("defaults")
    .$type<RendererBundleDefaultsRow>()
    .notNull()
    .default({}),
  /** The catalog source it came from (`synap`). */
  source: text("source").notNull(),
  installedBy: text("installed_by").notNull(),
  installedAt: timestamp("installed_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const rendererHostModules = pgTable(
  "renderer_host_modules",
  {
    bundleSlug: text("bundle_slug").notNull(),
    /** `react` | `reactDom` | `reactDomClient` | `jsxRuntime` | `jsxDevRuntime` | `kit` | `tokensCss`. */
    module: text("module").notNull(),
    source: text("source").notNull(),
    /** sha256 (hex) of the UTF-8 source, recomputed by the pod. */
    sha256: text("sha256").notNull(),
    byteLength: integer("byte_length").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bundleSlug, table.module] }),
    uniqueIndex("renderer_host_modules_one_set").on(table.module),
  ]
);

export type RendererBundleRow = typeof rendererBundles.$inferSelect;
export type RendererHostModuleRow = typeof rendererHostModules.$inferSelect;
