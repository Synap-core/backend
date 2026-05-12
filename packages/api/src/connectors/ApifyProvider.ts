import { z } from "zod";
import type {
  EnrichmentCapability,
  EnrichmentInput,
  EnrichmentProvider,
  EnrichmentResult,
} from "./EnrichmentProvider.js";

const ApifyDatasetItemsSchema = z.array(z.record(z.string(), z.unknown()));

export class ApifyProvider implements EnrichmentProvider {
  readonly name = "apify";
  readonly capabilities: EnrichmentCapability[] = [
    "person",
    "company",
    "leads",
  ];

  isConfigured(): boolean {
    return !!process.env.APIFY_API_TOKEN;
  }

  async enrich(input: EnrichmentInput): Promise<EnrichmentResult[]> {
    const token = process.env.APIFY_API_TOKEN;
    if (!token) return [];

    const actorId = input.actorId as string;
    const params = (input.params ?? {}) as Record<string, unknown>;

    if (!actorId)
      throw new Error("ApifyProvider.enrich: input.actorId is required");

    const res = await fetch(
      `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }
    );

    if (!res.ok) {
      throw new Error(
        `Apify actor run failed: ${res.status} ${res.statusText}`
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
