import { z } from "zod";
import type {
  EnrichmentCapability,
  EnrichmentInput,
  EnrichmentProvider,
  EnrichmentResult,
} from "./EnrichmentProvider.js";

const ApifyDatasetItemsSchema = z.array(z.record(z.string(), z.unknown()));

// Actor run timeout in seconds — passed to Apify's run-sync endpoint
const ACTOR_TIMEOUT_SECONDS = 120;

export class ApifyProvider implements EnrichmentProvider {
  readonly name = "apify";
  readonly capabilities: EnrichmentCapability[] = [
    "person",
    "company",
    "leads",
  ];

  isConfigured(apiKey?: string): boolean {
    return !!(apiKey ?? process.env.APIFY_API_TOKEN);
  }

  async enrich(
    input: EnrichmentInput,
    apiKey?: string
  ): Promise<EnrichmentResult[]> {
    const token = apiKey ?? process.env.APIFY_API_TOKEN;
    if (!token) return [];

    const actorId = input.actorId as string;
    const params = (input.params ?? {}) as Record<string, unknown>;

    if (!actorId)
      throw new Error("ApifyProvider.enrich: input.actorId is required");

    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${token}&timeout=${ACTOR_TIMEOUT_SECONDS}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      // AbortSignal gives a 10s grace period beyond the Apify timeout
      signal: AbortSignal.timeout((ACTOR_TIMEOUT_SECONDS + 10) * 1000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 403) {
        throw new Error(
          `Apify actor "${actorId}" requires a paid subscription. Visit apify.com/store, find the actor, and subscribe before using it.`
        );
      }
      throw new Error(
        `Apify actor "${actorId}" failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`
      );
    }

    const parsed = ApifyDatasetItemsSchema.safeParse(await res.json());
    if (!parsed.success) return [];

    return parsed.data.map((item) => ({
      source: `apify/${actorId}`,
      confidence: 0.7,
      data: item,
    }));
  }
}
