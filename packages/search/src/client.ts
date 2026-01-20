/**
 * Typesense Client Singleton
 * Configured with environment variables
 */

import Typesense from "typesense";

let client: Typesense.Client | null = null;
let adminClient: Typesense.Client | null = null;

export function getTypesenseClient(): Typesense.Client {
  if (!client) {
    const host = process.env.TYPESENSE_HOST || "localhost";
    const port = parseInt(process.env.TYPESENSE_PORT || "8108");
    const protocol = process.env.TYPESENSE_PROTOCOL || "http";
    const apiKey = process.env.TYPESENSE_API_KEY;

    if (!apiKey) {
      throw new Error("TYPESENSE_API_KEY environment variable is required");
    }

    client = new Typesense.Client({
      nodes: [
        {
          host,
          port,
          protocol: protocol as "http" | "https",
        },
      ],
      apiKey,
      connectionTimeoutSeconds: 5,
      numRetries: 3,
      retryIntervalSeconds: 0.1,
      healthcheckIntervalSeconds: 60,
      logLevel: process.env.NODE_ENV === "production" ? "warn" : "info",
    });
  }
  return client;
}

/**
 * Admin client for collection management and key generation
 */
export function getTypesenseAdminClient(): Typesense.Client {
  if (!adminClient) {
    const host = process.env.TYPESENSE_HOST || "localhost";
    const port = parseInt(process.env.TYPESENSE_PORT || "8108");
    const protocol = process.env.TYPESENSE_PROTOCOL || "http";
    const adminApiKey = process.env.TYPESENSE_ADMIN_API_KEY;

    if (!adminApiKey) {
      throw new Error(
        "TYPESENSE_ADMIN_API_KEY environment variable is required"
      );
    }

    adminClient = new Typesense.Client({
      nodes: [
        {
          host,
          port,
          protocol: protocol as "http" | "https",
        },
      ],
      apiKey: adminApiKey,
      connectionTimeoutSeconds: 5,
    });
  }
  return adminClient;
}

/**
 * Test connection to Typesense
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = getTypesenseClient();
    await client.health.retrieve();
    return true;
  } catch (error) {
    console.error("Typesense connection failed:", error);
    return false;
  }
}
