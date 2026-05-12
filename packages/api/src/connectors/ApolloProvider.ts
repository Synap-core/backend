import { z } from "zod";
import type {
  EnrichmentCapability,
  EnrichmentInput,
  EnrichmentProvider,
  EnrichmentResult,
} from "./EnrichmentProvider.js";

const APOLLO_BASE_URL = "https://api.apollo.io/api/v1";

const ApolloResponseSchema = z
  .object({
    person: z.record(z.string(), z.unknown()).optional(),
    organization: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type ApolloEndpoint = "people/match" | "organizations/enrich";

export class ApolloProvider implements EnrichmentProvider {
  readonly name = "apollo";
  readonly capabilities: EnrichmentCapability[] = ["person", "company"];

  isConfigured(): boolean {
    return !!process.env.APOLLO_API_KEY;
  }

  async enrich(input: EnrichmentInput): Promise<EnrichmentResult[]> {
    const apiKey = process.env.APOLLO_API_KEY;
    if (!apiKey) return [];

    const endpoint = input.endpoint as ApolloEndpoint;
    const params = (input.params ?? {}) as Record<string, unknown>;

    if (!endpoint)
      throw new Error("ApolloProvider.enrich: input.endpoint is required");

    const res = await fetch(`${APOLLO_BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      throw new Error(
        `Apollo enrichment failed: ${res.status} ${res.statusText}`
      );
    }

    const parsed = ApolloResponseSchema.safeParse(await res.json());
    if (!parsed.success) return [];

    const payload =
      parsed.data.person ?? parsed.data.organization ?? parsed.data;

    return [
      {
        source: "apollo",
        confidence: 0.9,
        data: payload as Record<string, unknown>,
      },
    ];
  }
}
