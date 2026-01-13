/**
 * Seed Script: Create Hub Protocol API Key
 *
 * Creates an API key for Intelligence Hub to authenticate with Data Pod
 */

import { sql } from "../src/client-pg.js";
import { randomBytes, createHash } from "crypto";
import * as bcrypt from "bcryptjs";

// Configuration
const HUB_API_KEY_RAW =
  process.env.HUB_PROTOCOL_API_KEY ||
  `synap_hub_${randomBytes(32).toString("hex")}`;
const HUB_KEY_PREFIX = "synap_hub_live_";

async function seedHubProtocolKey() {
  console.log("🔑 Creating Hub Protocol API Key...\n");

  try {
    // Hash the API key
    const keyHash = await bcrypt.hash(HUB_API_KEY_KEY_RAW, 12);

    // Insert API key
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
        'Intelligence Hub',
        ${HUB_KEY_PREFIX},
        ${keyHash},
        'intelligence-hub-1',
        ARRAY['hub-protocol.read', 'hub-protocol.write'],
        NULL,
        true
      )
      ON CONFLICT (key_hash) DO NOTHING
      RETURNING id, key_name
    `;

    if (result.length > 0) {
      console.log("✅ API key created successfully!");
      console.log(`   ID: ${result[0].id}`);
      console.log(`   Name: ${result[0].key_name}`);
      console.log(`   Scopes: hub-protocol.read, hub-protocol.write`);
      console.log("\n🔐 IMPORTANT: Save this API key securely!\n");
      console.log(`   HUB_PROTOCOL_API_KEY=${HUB_API_KEY_RAW}\n`);
      console.log("   Add this to your Intelligence Hub .env file");
      console.log("   This key will NOT be shown again!\n");
    } else {
      console.log("ℹ️  API key already exists (duplicate key_hash)");
    }
  } catch (error) {
    console.error("❌ Failed to create API key:", error);
    throw error;
  } finally {
    await sql.end();
  }
}

seedHubProtocolKey();
