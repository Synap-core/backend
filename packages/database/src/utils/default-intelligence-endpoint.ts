/**
 * Default Intelligence Endpoint Resolver
 *
 * Queries the intelligence_services table for the first active, enabled service
 * and returns its endpoint + decrypted API key.
 * Falls back to environment variables when no DB-registered service is found.
 *
 * Used by packages/jobs workers that cannot import from packages/api.
 */

import { db } from "../client-pg.js";
import { intelligenceServices } from "../schema/index.js";
import { eq, and } from "drizzle-orm";
import { resolveServiceKey } from "./service-key-crypto.js";

export interface IntelligenceEndpoint {
  endpoint: string;
  apiKey: string;
}

/**
 * Resolve the default active intelligence service endpoint from the DB.
 * Falls back to AGENT_HUB_URL / INTELLIGENCE_HUB_URL env vars if none registered.
 */
export async function resolveDefaultIntelligenceEndpoint(): Promise<IntelligenceEndpoint> {
  try {
    const svc = await db.query.intelligenceServices.findFirst({
      where: and(
        eq(intelligenceServices.status, "active"),
        eq(intelligenceServices.enabled, true)
      ),
      columns: { webhookUrl: true, apiKey: true },
    });

    if (svc?.webhookUrl) {
      return {
        endpoint: svc.webhookUrl,
        apiKey: svc.apiKey ? resolveServiceKey(svc.apiKey) : "",
      };
    }
  } catch {
    // Fall through to env fallback — never block callers on a DB error
  }

  return {
    endpoint:
      process.env.AGENT_HUB_URL ||
      process.env.INTELLIGENCE_HUB_URL ||
      "http://localhost:3001",
    apiKey:
      process.env.AGENT_HUB_API_KEY ||
      process.env.INTELLIGENCE_HUB_API_KEY ||
      "",
  };
}
