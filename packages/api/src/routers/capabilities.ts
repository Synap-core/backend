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

    // Get active intelligence services
    const services = await db.query.intelligenceServices.findMany({
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
      "Capabilities retrieved",
    );

    return response;
  }),

  /**
   * Check if a specific capability is available
   */
  hasCapability: publicProcedure
    .input(z.object({ capability: z.string() }))
    .query(async ({ input }) => {
      const services = await db.query.intelligenceServices.findMany({
        where: eq(intelligenceServices.status, "active"),
      });

      const available = services.some((s) =>
        s.capabilities.includes(input.capability),
      );

      return { available };
    }),
});
