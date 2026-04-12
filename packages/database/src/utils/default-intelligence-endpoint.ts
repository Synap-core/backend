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
import { eq, and, sql } from "drizzle-orm";
import { resolveServiceKey } from "./service-key-crypto.js";

export interface IntelligenceEndpoint {
  endpoint: string;
  apiKey: string;
}

/**
 * Resolve the default active intelligence service endpoint from the DB.
 * Falls back to INTELLIGENCE_HUB_URL env var if none registered.
 */
export async function resolveDefaultIntelligenceEndpoint(): Promise<IntelligenceEndpoint> {
  try {
    // Include "credential_error" — the key may have been refreshed on the IS
    // side. Excluding these causes a silent fallback to env vars (often wrong),
    // producing misleading "overload" errors. Let the actual request fail with
    // a 401 so the error is actionable.
    const svc = await db.query.intelligenceServices.findFirst({
      where: and(
        sql`${intelligenceServices.status} IN ('active', 'credential_error')`,
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
    endpoint: process.env.INTELLIGENCE_HUB_URL || "http://localhost:3002",
    apiKey: process.env.INTELLIGENCE_HUB_API_KEY || "",
  };
}
