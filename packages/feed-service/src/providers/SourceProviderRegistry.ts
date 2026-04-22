/**
 * SourceProviderRegistry
 *
 * Singleton registry of `ISourceProvider` implementations, keyed by
 * `provider.meta.type`. New providers register themselves at package import
 * time (see `feed-service/src/index.ts` for the built-in registrations).
 *
 * The registry is intentionally dumb: it's a `Map` with three methods. All
 * scheduling, vault resolution, and cursor persistence happen outside.
 *
 * Why a singleton rather than DI: the registry must be reachable from
 * background workers (pg-boss handlers) and tRPC routes alike with zero
 * wiring. Tests that want to register a fake provider can `register()` it
 * before asserting.
 */

import type { ISourceProvider, SourceProviderMeta } from "./ISourceProvider.js";

class SourceProviderRegistryImpl {
  private readonly providers = new Map<string, ISourceProvider>();

  /**
   * Register a provider. Re-registering the same `type` overwrites — useful
   * in tests. Logs a soft warning to aid debugging silent overwrites.
   */
  register(provider: ISourceProvider): void {
    const existing = this.providers.get(provider.meta.type);
    if (existing && existing !== provider) {
      // No logger dep here — providers register at module top-level where
      // pino may not yet be initialised. Use console.warn so any overwrite
      // is still visible.
      console.warn(
        `[SourceProviderRegistry] Overwriting provider type "${provider.meta.type}"`
      );
    }
    this.providers.set(provider.meta.type, provider);
  }

  get(type: string): ISourceProvider | null {
    return this.providers.get(type) ?? null;
  }

  list(): SourceProviderMeta[] {
    return Array.from(this.providers.values()).map((p) => p.meta);
  }

  /** Test helper — drops every registration. Not exported as public API. */
  _reset(): void {
    this.providers.clear();
  }
}

export const sourceProviderRegistry = new SourceProviderRegistryImpl();
export type SourceProviderRegistry = SourceProviderRegistryImpl;
