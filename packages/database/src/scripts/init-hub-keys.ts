/**
 * Hub Key Seeding Script
 *
 * Seeds hub_inbound API keys into the api_keys table from the
 * intelligence_services registry. Each registered IS gets one hub_inbound entry
 * so the pod can validate inbound callbacks from that IS.
 *
 * Source of truth: intelligence_services table (populated by CP provisioning).
 * This script is idempotent — safe to run multiple times.
 */

import { sql } from "../client-pg.js";
import { resolveServiceKey } from "../utils/service-key-crypto.js";
import bcrypt from "bcrypt";

async function seedHubProtocolKeys() {
  console.log(
    "🔑 Seeding Hub Protocol inbound keys from intelligence_services...\n"
  );

  let rows: { service_id: string; name: string; api_key: string }[];
  try {
    rows = await sql<typeof rows>`
      SELECT service_id, name, api_key
      FROM intelligence_services
      WHERE enabled = true
        AND api_key IS NOT NULL
        AND api_key != ''
        AND api_key != 'SYNC_PLACEHOLDER'
      ORDER BY created_at ASC
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Table may not exist on very first boot before IS provisioning runs
    if (msg.includes("does not exist")) {
      console.log(
        "ℹ️  intelligence_services table not found — skipping (pre-provisioning state)\n"
      );
      return;
    }
    throw err;
  }

  if (rows.length === 0) {
    console.log(
      "ℹ️  No registered intelligence services found — skipping hub key seeding"
    );
    console.log(
      "   Keys are seeded automatically after provisioning via Control Plane\n"
    );
    return;
  }

  console.log(`   Found ${rows.length} intelligence service(s)\n`);

  let created = 0;
  let skipped = 0;

  for (const row of rows) {
    let plainKey: string;
    try {
      plainKey = resolveServiceKey(row.api_key);
    } catch {
      console.warn(
        `⚠️  Could not decrypt key for service ${row.service_id} — skipping`
      );
      continue;
    }

    if (!plainKey) continue;

    const name = `IS Hub Key — ${row.name || row.service_id}`;
    try {
      const keyHash = await bcrypt.hash(plainKey, 12);

      // Derive a best-effort key prefix for audit purposes.
      // The prefix constraint is relaxed for hub_inbound type (migration 0028),
      // so this value is informational only.
      const parts = plainKey.split("_");
      const keyPrefix =
        parts.length >= 3
          ? parts.slice(0, 3).join("_") + "_"
          : plainKey.slice(0, 12) + "_";

      const result = await sql`
        INSERT INTO api_keys (
          user_id,
          key_name,
          key_prefix,
          key_hash,
          hub_id,
          key_type,
          scope,
          expires_at,
          is_active
        ) VALUES (
          'system',
          ${name},
          ${keyPrefix},
          ${keyHash},
          ${row.service_id},
          'hub_inbound',
          ARRAY['hub-protocol.read', 'hub-protocol.write']::text[],
          NULL,
          true
        )
        ON CONFLICT (key_hash) DO NOTHING
        RETURNING id, key_name, hub_id
      `;

      if (result.length > 0) {
        console.log(`✅ Created hub key: ${name} (hub_id=${row.service_id})\n`);
        created++;
      } else {
        console.log(`⏭️  Skipped (already exists): ${name}\n`);
        skipped++;
      }
    } catch (error) {
      console.error(`❌ Failed to seed key for ${row.service_id}:`, error);
    }
  }

  console.log(
    `📊 Summary: ${created} created, ${skipped} skipped, ${rows.length} total\n`
  );
}

async function main() {
  try {
    await seedHubProtocolKeys();
    console.log("✅ Database initialization complete\n");
  } catch (error) {
    console.error("❌ Database initialization failed:", error);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
