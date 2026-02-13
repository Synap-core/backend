/**
 * Capabilities Router
 *
 * Discovers what features and intelligence services are available
 * Frontend SDK calls this to dynamically adapt UI
 */

import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { db, intelligenceServices, eq } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "capabilities" });

/** Default (proprietary) Synap Intelligence service — always available when no custom service configured. */
const DEFAULT_INTELLIGENCE_SERVICE = {
  id: "default",
  serviceId: "default",
  name: "Synap Intelligence",
  capabilities: [
    "chat",
    "analysis",
    "commands",
    "proposals",
    "threads",
  ] as string[],
  pricing: "free" as const,
  version: "1.0",
};

export const capabilitiesRouter = router({
  /**
   * List all available capabilities
   *
   * Returns:
   * - Core features (always available)
   * - Installed plugins
   * - Registered intelligence services
   */
  list: publicProcedure.query(async () => {
    logger.debug("Listing capabilities");

    // Get installed plugins (placeholder - plugin manager doesn't expose getAllPlugins yet)
    const plugins: Array<{ name: string; version: string; enabled: boolean }> =
      [];

    // Get active intelligence services from DB
    const dbServices = await db.query.intelligenceServices.findMany({
      where: eq(intelligenceServices.status, "active"),
      columns: {
        id: true,
        serviceId: true,
        name: true,
        capabilities: true,
        pricing: true,
        version: true,
      },
    });

    // Include default (proprietary) service if not already in DB
    const hasDefault = dbServices.some((s) => s.serviceId === "default");
    const services = hasDefault
      ? dbServices
      : [DEFAULT_INTELLIGENCE_SERVICE, ...dbServices];

    const response = {
      core: {
        version: "1.0.0",
        features: [
          "notes",
          "tasks",
          "chat",
          "entities",
          "events",
          "files",
          "inbox",
        ],
      },
      plugins: plugins,
      intelligenceServices: services.map((s) => ({
        id: s.id,
        serviceId: s.serviceId,
        name: s.name,
        capabilities: s.capabilities,
        pricing: s.pricing || "free",
        version: s.version,
      })),
    };

    logger.debug(
      {
        pluginCount: plugins.length,
        serviceCount: services.length,
      },
      "Capabilities retrieved"
    );

    return response;
  }),

  /**
   * Check if a specific capability is available
   */
  hasCapability: publicProcedure
    .input(z.object({ capability: z.string() }))
    .query(async ({ input }) => {
      const dbServices = await db.query.intelligenceServices.findMany({
        where: eq(intelligenceServices.status, "active"),
      });

      const hasDefaultCapability =
        DEFAULT_INTELLIGENCE_SERVICE.capabilities.includes(input.capability);
      const hasDbCapability = dbServices.some((s) =>
        (s.capabilities as string[]).includes(input.capability)
      );

      return { available: hasDefaultCapability || hasDbCapability };
    }),
});
