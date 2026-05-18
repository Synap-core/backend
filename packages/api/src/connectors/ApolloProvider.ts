import { z } from "zod";
import type {
  EnrichmentCapability,
  EnrichmentInput,
  EnrichmentProvider,
  EnrichmentResult,
} from "./EnrichmentProvider.js";

const APOLLO_BASE_URL = "https://api.apollo.io/api/v1";

const ApolloSingleResponseSchema = z
  .object({
    person: z.record(z.string(), z.unknown()).optional(),
    organization: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const ApolloPeopleSearchResponseSchema = z
  .object({
    people: z.array(z.record(z.string(), z.unknown())).optional(),
    contacts: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

type ApolloEndpoint =
  | "people/match"
  | "organizations/enrich"
  | "mixed_people/search";

export class ApolloProvider implements EnrichmentProvider {
  readonly name = "apollo";
  readonly capabilities: EnrichmentCapability[] = [
    "person",
    "company",
    "leads",
  ];

  isConfigured(apiKey?: string): boolean {
    return !!(apiKey ?? process.env.APOLLO_API_KEY);
  }

  async enrich(
    input: EnrichmentInput,
    apiKey?: string
  ): Promise<EnrichmentResult[]> {
    const resolvedKey = apiKey ?? process.env.APOLLO_API_KEY;
    if (!resolvedKey) return [];

    const endpoint = input.endpoint as ApolloEndpoint;
    const params = (input.params ?? {}) as Record<string, unknown>;

    if (!endpoint)
      throw new Error("ApolloProvider.enrich: input.endpoint is required");

    const res = await fetch(`${APOLLO_BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": resolvedKey,
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Apollo API failed (${endpoint}): ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`
      );
    }

    const json = await res.json();

    // People search returns an array of people
    if (endpoint === "mixed_people/search") {
      const parsed = ApolloPeopleSearchResponseSchema.safeParse(json);
      if (!parsed.success) return [];
      const people = [
        ...(parsed.data.people ?? []),
        ...(parsed.data.contacts ?? []),
      ];
      return people.map((p) => ({
        source: "apollo",
        confidence: 0.85,
        data: p,
      }));
    }

    // Single person/org match returns one record
    const parsed = ApolloSingleResponseSchema.safeParse(json);
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
