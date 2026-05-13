export interface EnrichmentInput {
  [key: string]: unknown;
}

export interface EnrichmentResult {
  source: string;
  confidence: number;
  data: Record<string, unknown>;
}

export type EnrichmentCapability = "person" | "company" | "leads";

export interface EnrichmentProvider {
  readonly name: string;
  readonly capabilities: EnrichmentCapability[];
  isConfigured(apiKey?: string): boolean;
  enrich(input: EnrichmentInput, apiKey?: string): Promise<EnrichmentResult[]>;
}

export class EnrichmentProviderRegistry {
  private providers = new Map<string, EnrichmentProvider>();

  register(p: EnrichmentProvider): void {
    this.providers.set(p.name, p);
  }

  get(name: string): EnrichmentProvider | undefined {
    return this.providers.get(name);
  }

  forCapability(cap: EnrichmentCapability): EnrichmentProvider[] {
    return [...this.providers.values()].filter(
      (p) => p.isConfigured() && p.capabilities.includes(cap)
    );
  }
}

export const enrichmentProviderRegistry = new EnrichmentProviderRegistry();
