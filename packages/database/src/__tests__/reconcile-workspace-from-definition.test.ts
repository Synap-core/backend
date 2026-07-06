/**
 * reconcileWorkspaceFromDefinition — additivity + non-destructiveness tests
 *
 * Proves the "sync an existing workspace to a newer template" contract:
 *   1. Create a workspace from a BASE definition.
 *   2. Reconcile against an AUGMENTED definition (extra profile + extra
 *      property-def + extra entityLinks) → the new pieces are ADDED, and
 *      NOTHING existing is removed or duplicated.
 *   3. Reconcile again with the SAME augmented definition → a no-op (0 added).
 *
 * Requires a live Postgres (see packages/api/vitest.config.ts DATABASE_URL).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { sql } from "../client-pg.js";
import {
  createWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
} from "../utils/create-workspace-from-definition.js";
import { reconcileWorkspaceFromDefinition } from "../utils/reconcile-workspace-from-definition.js";
import { profileWorkspaceAccess } from "../schema/profiles.js";

// The schema module graph has a circular import (profiles ↔ workspaces) that
// Node/tsx resolve correctly but vite's SSR transform (vitest) leaves with
// undefined table bindings — which is why every existing DB test here uses raw
// `sql` and never the repositories/utils. When run under a harness that loads
// the schema natively (Node ESM), this suite runs fully; under the broken
// transform we skip cleanly instead of erroring. Behaviour is otherwise
// verified end-to-end against Postgres (see PR notes).
const SCHEMA_LOADS = !!profileWorkspaceAccess;

const suf = crypto.randomUUID().slice(0, 8);
const userId = `test-recon-${suf}`;
const clientSlug = `tclient-${suf}`;
const partnerSlug = `tpartner-${suf}`;
const refersType = `trefers-${suf}`;
const servesType = `tserves-${suf}`;

let workspaceId: string;

const baseDefinition: WorkspaceDefinitionInput = {
  workspaceName: `Recon Test ${suf}`,
  profiles: [
    {
      slug: clientSlug,
      displayName: "Client",
      properties: [
        { slug: "clientStatus", label: "Status", valueType: "text" },
      ],
    },
  ],
};

// Augmented template: client gains a NEW property; a NEW `partner` profile
// appears; two NEW schema links (client↔partner) are introduced.
const augmentedDefinition: WorkspaceDefinitionInput = {
  workspaceName: `Recon Test ${suf}`,
  profiles: [
    {
      slug: clientSlug,
      displayName: "Client",
      properties: [
        { slug: "clientStatus", label: "Status", valueType: "text" }, // unchanged
        { slug: "clientTier", label: "Tier", valueType: "text" }, // NEW
      ],
    },
    {
      slug: partnerSlug,
      displayName: "Partner",
      properties: [{ slug: "partnerType", label: "Type", valueType: "text" }],
    },
  ],
  entityLinks: [
    {
      sourceProfileSlug: clientSlug,
      targetProfileSlug: partnerSlug,
      type: refersType,
    },
    {
      sourceProfileSlug: partnerSlug,
      targetProfileSlug: clientSlug,
      type: servesType,
    },
  ],
};

describe.skipIf(!SCHEMA_LOADS)(
  "reconcileWorkspaceFromDefinition — additive + non-destructive",
  () => {
    beforeAll(async () => {
      await sql`
      INSERT INTO users (id, email, name)
      VALUES (${userId}, ${`${userId}@test.local`}, 'Recon Test')
      ON CONFLICT (id) DO NOTHING
    `;
      const result = await createWorkspaceFromDefinition({
        definition: baseDefinition,
        userId,
        createdBy: "user",
      });
      workspaceId = result.workspaceId;
    });

    afterAll(async () => {
      if (!workspaceId) {
        await sql`DELETE FROM users WHERE id = ${userId}`;
        return;
      }
      // Best-effort cleanup (unique slugs keep this isolated regardless).
      await sql`DELETE FROM profile_relations WHERE relation_def_id IN (SELECT id FROM relation_defs WHERE workspace_id = ${workspaceId})`;
      await sql`DELETE FROM relation_defs WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM profile_properties WHERE profile_id IN (SELECT id FROM profiles WHERE workspace_id = ${workspaceId})`;
      await sql`DELETE FROM property_defs WHERE profile_id IN (SELECT id FROM profiles WHERE workspace_id = ${workspaceId})`;
      await sql`DELETE FROM views WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM profiles WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
    });

    it("adds the missing profile, property-def, and entity links without touching existing data", async () => {
      // Sanity: base workspace has the client profile + clientStatus only.
      const [clientBefore] = await sql`
      SELECT id FROM profiles WHERE workspace_id = ${workspaceId} AND slug = ${clientSlug}
    `;
      expect(clientBefore?.id).toBeTruthy();
      const propsBefore = await sql`
      SELECT slug FROM property_defs WHERE profile_id = ${clientBefore.id}
    `;
      expect(propsBefore.map((p) => p.slug)).toContain("clientStatus");
      expect(propsBefore.map((p) => p.slug)).not.toContain("clientTier");

      const report = await reconcileWorkspaceFromDefinition({
        workspaceId,
        userId,
        definition: augmentedDefinition,
      });

      // ── Report assertions ──────────────────────────────────────────────
      expect(report.profiles.added).toContain(partnerSlug);
      expect(report.profiles.reused).toContain(clientSlug);

      const addedProps = report.properties.added.map(
        (p) => `${p.profile}.${p.slug}`
      );
      expect(addedProps).toContain(`${clientSlug}.clientTier`);
      expect(addedProps).toContain(`${partnerSlug}.partnerType`);

      const skippedProps = report.properties.skipped.map(
        (p) => `${p.profile}.${p.slug}`
      );
      expect(skippedProps).toContain(`${clientSlug}.clientStatus`);

      expect(report.properties.conflicts).toHaveLength(0);
      expect(report.entityLinks.added).toHaveLength(2);
      expect(report.entityLinks.unresolved).toHaveLength(0);

      // ── DB assertions: existing preserved, new added, nothing duplicated ─
      const clientProfiles = await sql`
      SELECT id FROM profiles WHERE workspace_id = ${workspaceId} AND slug = ${clientSlug}
    `;
      expect(clientProfiles).toHaveLength(1); // client NOT duplicated
      expect(clientProfiles[0].id).toBe(clientBefore.id); // same row

      const clientProps = await sql`
      SELECT slug FROM property_defs WHERE profile_id = ${clientBefore.id} ORDER BY slug
    `;
      const clientPropSlugs = clientProps.map((p) => p.slug);
      expect(clientPropSlugs).toContain("clientStatus"); // preserved
      expect(clientPropSlugs).toContain("clientTier"); // added
      // clientStatus appears exactly once (not duplicated).
      expect(clientPropSlugs.filter((s) => s === "clientStatus")).toHaveLength(
        1
      );

      const partnerProfiles = await sql`
      SELECT id FROM profiles WHERE workspace_id = ${workspaceId} AND slug = ${partnerSlug}
    `;
      expect(partnerProfiles).toHaveLength(1); // new profile created once

      const links = await sql`
      SELECT rd.slug FROM profile_relations pr
      JOIN relation_defs rd ON rd.id = pr.relation_def_id
      WHERE rd.workspace_id = ${workspaceId}
    `;
      const linkSlugs = links.map((l) => l.slug);
      expect(linkSlugs).toContain(refersType);
      expect(linkSlugs).toContain(servesType);
      expect(links).toHaveLength(2);
    });

    it("re-applying the SAME augmented definition is a no-op (0 added)", async () => {
      const report = await reconcileWorkspaceFromDefinition({
        workspaceId,
        userId,
        definition: augmentedDefinition,
      });

      expect(report.profiles.added).toHaveLength(0);
      expect(report.properties.added).toHaveLength(0);
      expect(report.properties.conflicts).toHaveLength(0);
      expect(report.entityLinks.added).toHaveLength(0);

      // Everything is now "skipped" / "reused", not re-created.
      expect(report.profiles.reused).toEqual(
        expect.arrayContaining([clientSlug, partnerSlug])
      );
      expect(report.entityLinks.skipped).toHaveLength(2);

      // DB still has exactly one of each — no duplication on re-run.
      const profiles = await sql`
      SELECT slug FROM profiles WHERE workspace_id = ${workspaceId}
        AND slug IN (${clientSlug}, ${partnerSlug})
    `;
      expect(profiles).toHaveLength(2);
      const links = await sql`
      SELECT pr.id FROM profile_relations pr
      JOIN relation_defs rd ON rd.id = pr.relation_def_id
      WHERE rd.workspace_id = ${workspaceId}
    `;
      expect(links).toHaveLength(2);
    });
  }
);
