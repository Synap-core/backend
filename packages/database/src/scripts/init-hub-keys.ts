/**
 * Database Initialization Script
 *
 * Runs after migrations to set up initial data:
 * - Hub Protocol API keys (from environment)
 * - System profiles (if needed)
 * - Essential configuration
 *
 * IMPORTANT: This script is idempotent - safe to run multiple times
 */

import { sql } from "../client-pg.js";
import bcrypt from "bcrypt";

interface HubKey {
  rawKey: string;
  name: string;
  hubId: string;
}

// Parse HUB_PROTOCOL_API_KEYS from environment
// Format: "key1:name1:hubId1,key2:name2:hubId2"
// Or single key: HUB_PROTOCOL_API_KEY
function parseHubKeys(): HubKey[] {
  const keys: HubKey[] = [];

  // Check for multiple keys (new format)
  const multiKeys = process.env.HUB_PROTOCOL_API_KEYS;
  if (multiKeys) {
    const entries = multiKeys
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const [rawKey, name, hubId] = entry.split(":").map((s) => s.trim());
      if (rawKey && name && hubId) {
        keys.push({ rawKey, name, hubId });
      } else {
        console.warn(`⚠️  Skipping invalid key entry: ${entry}`);
      }
    }
  }

  // Check for single key (legacy format)
  const singleKey = process.env.HUB_PROTOCOL_API_KEY;
  if (singleKey && keys.length === 0) {
    keys.push({
      rawKey: singleKey,
      name: "Intelligence Hub (Primary)",
      hubId: "intelligence-hub-primary",
    });
  }

  return keys;
}

async function seedHubProtocolKeys() {
  console.log("🔑 Initializing Hub Protocol API Keys...\n");

  const keys = parseHubKeys();

  if (keys.length === 0) {
    console.log("ℹ️  No HUB_PROTOCOL_API_KEY(S) provided in environment");
    console.log("   Skipping API key initialization");
    console.log(
      "   Set HUB_PROTOCOL_API_KEY or HUB_PROTOCOL_API_KEYS to seed keys\n"
    );
    return;
  }

  console.log(`   Found ${keys.length} API key(s) to seed\n`);

  let created = 0;
  let skipped = 0;

  for (const { rawKey, name, hubId } of keys) {
    try {
      // Hash the API key
      const keyHash = await bcrypt.hash(rawKey, 12);

      // Extract prefix for efficient lookup
      const keyPrefix = rawKey.split("_").slice(0, 3).join("_") + "_";

      // Insert API key (idempotent)
      const result = await sql`
        INSERT INTO api_keys (
          user_id,
          key_name,
          key_prefix,
          key_hash,
          hub_id,
          scope,
          expires_at,
          is_active
        ) VALUES (
          'system',
          ${name},
          ${keyPrefix},
          ${keyHash},
          ${hubId},
          ARRAY['hub-protocol.read', 'hub-protocol.write']::text[],
          NULL,
          true
        )
        ON CONFLICT (key_hash) DO NOTHING
        RETURNING id, key_name, hub_id
      `;

      if (result.length > 0) {
        console.log(`✅ Created API key: ${name}`);
        console.log(`   Hub ID: ${hubId}`);
        console.log(`   Key ID: ${result[0].id}`);
        console.log(`   Scopes: hub-protocol.read, hub-protocol.write\n`);
        created++;
      } else {
        console.log(`⏭️  Skipped (already exists): ${name}\n`);
        skipped++;
      }
    } catch (error) {
      console.error(`❌ Failed to create key for ${name}:`, error);
      // Continue with other keys
    }
  }

  console.log(
    `\n📊 Summary: ${created} created, ${skipped} skipped, ${keys.length} total\n`
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
