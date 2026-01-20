/**
 * Plugin Manager for Data Pod
 *
 * Manages registration and execution of Data Pod plugins.
 */

import { createLogger } from "@synap-core/core";
import type { DataPodPlugin, ThoughtInput, ThoughtResponse } from "./types.js";
import { dynamicRouterRegistry } from "../router-registry.js";
// NOTE: @synap/ai has been moved to synap-intelligence-hub (proprietary)
// Tools are now managed by Intelligence Hub
// import { dynamicToolRegistry } from '@synap/ai';
// NOTE: LangGraph is now in Intelligence Hub (proprietary)
// import { StateGraph } from '@langchain/langgraph';

const logger = createLogger({ module: "plugin-manager" });

/**
 * Plugin Manager
 *
 * Singleton that manages all Data Pod plugins.
 */
class PluginManager {
  private plugins: Map<string, DataPodPlugin> = new Map();
  private initialized = false;

  /**
   * Register a plugin
   */
  async register(plugin: DataPodPlugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }

    this.plugins.set(plugin.name, plugin);

    // Initialize plugin if manager is already initialized
    if (this.initialized && plugin.onInit) {
      try {
        await plugin.onInit();
        logger.info({ plugin: plugin.name }, "Plugin initialized");
      } catch (error) {
        logger.error(
          { err: error, plugin: plugin.name },
          "Failed to initialize plugin"
        );
        throw error;
      }
    }

    // Register router if present
    if (plugin.registerRouter) {
      const router = plugin.registerRouter();
      dynamicRouterRegistry.register(plugin.name, router, {
        source: plugin.name,
        version: plugin.version,
        description: `Router from plugin: ${plugin.name}`,
      });
      logger.info({ plugin: plugin.name }, "Plugin router registered");
    }

    // Register tools if present
    if (plugin.registerTools) {
      const { dynamicToolRegistry } = await import("@synap/ai");
      plugin.registerTools(dynamicToolRegistry);
      logger.info({ plugin: plugin.name }, "Plugin tools registered");
    }

    // Register agent if present
    // NOTE: Agents are now enabled via @synap/ai framework
    // Plugins can register LangGraph agents
    if (plugin.registerAgent) {
      logger.warn(
        { plugin: plugin.name },
        "Agent registration available - implement LangGraph integration"
      );
      // TODO: Implement LangGraph agent registration when needed
      // const graph = new StateGraph({});
      // plugin.registerAgent(graph);
      // logger.info({ plugin: plugin.name }, 'Plugin agent registered');
    }

    logger.info(
      { plugin: plugin.name, version: plugin.version },
      "Plugin registered"
    );
  }

  /**
   * Unregister a plugin
   */
  async unregister(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      return false;
    }

    // Destroy plugin
    if (plugin.onDestroy) {
      try {
        await plugin.onDestroy();
      } catch (error) {
        logger.error({ err: error, plugin: name }, "Error destroying plugin");
      }
    }

    // Unregister router
    if (plugin.registerRouter) {
      dynamicRouterRegistry.unregister(name);
    }

    // Remove from map
    this.plugins.delete(name);

    logger.info({ plugin: name }, "Plugin unregistered");
    return true;
  }

  /**
   * Get a plugin by name
   */
  getPlugin(name: string): DataPodPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all enabled plugins
   */
  getEnabledPlugins(): DataPodPlugin[] {
    return Array.from(this.plugins.values()).filter((p) => p.enabled);
  }

  /**
   * Process a thought using plugins
   *
   * Tries each enabled plugin that supports processThought.
   * Returns the first successful result.
   */
  async processThought(input: ThoughtInput): Promise<ThoughtResponse | null> {
    const enabledPlugins = this.getEnabledPlugins().filter(
      (p) => p.processThought
    );

    for (const plugin of enabledPlugins) {
      if (!plugin.processThought) {
        continue;
      }

      try {
        logger.debug(
          { plugin: plugin.name, userId: input.userId },
          "Trying plugin for thought processing"
        );
        const result = await plugin.processThought(input);

        if (result.success) {
          logger.info(
            { plugin: plugin.name, requestId: result.requestId },
            "Plugin processed thought successfully"
          );
          return result;
        }
      } catch (error) {
        logger.warn(
          { err: error, plugin: plugin.name },
          "Plugin processing failed, trying next"
        );
        // Continue to next plugin
      }
    }

    // No plugin could process the thought
    return null;
  }

  /**
   * Initialize all plugins
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    logger.info({ pluginCount: this.plugins.size }, "Initializing plugins");

    for (const plugin of this.plugins.values()) {
      if (plugin.onInit) {
        try {
          await plugin.onInit();
          logger.debug({ plugin: plugin.name }, "Plugin initialized");
        } catch (error) {
          logger.error(
            { err: error, plugin: plugin.name },
            "Failed to initialize plugin"
          );
          // Continue with other plugins
        }
      }
    }

    this.initialized = true;
    logger.info("All plugins initialized");
  }

  /**
   * Get plugin statistics
   */
  getStats(): {
    totalPlugins: number;
    enabledPlugins: number;
    pluginNames: string[];
  } {
    return {
      totalPlugins: this.plugins.size,
      enabledPlugins: this.getEnabledPlugins().length,
      pluginNames: Array.from(this.plugins.keys()),
    };
  }
}

/**
 * Singleton instance
 */
export const pluginManager = new PluginManager();
