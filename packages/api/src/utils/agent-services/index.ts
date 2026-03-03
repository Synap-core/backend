import { TRPCError } from "@trpc/server";
import { openclawEntry } from "./services/openclaw.js";
import { zeroclawEntry } from "./services/zeroclaw.js";
import type { ServiceCatalogEntry } from "./types.js";

export type { ServiceCatalogEntry, DockerCommandOpts } from "./types.js";

export const SERVICE_CATALOG: Record<string, ServiceCatalogEntry> = {
  openclaw: openclawEntry,
  zeroclaw: zeroclawEntry,
};

/**
 * Look up a service catalog entry by type.
 * Throws if the type is not registered.
 */
export function getServiceEntry(serviceType: string): ServiceCatalogEntry {
  const entry = SERVICE_CATALOG[serviceType];
  if (!entry) {
    const known = Object.keys(SERVICE_CATALOG).join(", ");
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Unknown service type "${serviceType}". Known types: ${known}`,
    });
  }
  return entry;
}
