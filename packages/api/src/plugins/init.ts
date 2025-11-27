/**
 * Plugin Initialization
 * 
 * Registers default plugins and initializes the plugin system.
 */

import { pluginManager, intelligenceHubPlugin } from './index.js';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'plugin-init' });

/**
 * Initialize plugins
 * 
 * Registers default plugins and initializes the plugin system.
 * This should be called at application startup.
 */
export async function initializePlugins(): Promise<void> {
  try {
    logger.info('Initializing plugin system');

    // Register Intelligence Hub plugin (if enabled)
    if (intelligenceHubPlugin.enabled) {
      await pluginManager.register(intelligenceHubPlugin);
      logger.info('Intelligence Hub plugin registered');
    } else {
      logger.debug('Intelligence Hub plugin disabled (INTELLIGENCE_HUB_ENABLED != "true")');
    }

    // Initialize all plugins
    await pluginManager.initialize();

    const stats = pluginManager.getStats();
    logger.info(
      {
        totalPlugins: stats.totalPlugins,
        enabledPlugins: stats.enabledPlugins,
        pluginNames: stats.pluginNames,
      },
      'Plugin system initialized'
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to initialize plugins');
    // Don't throw - allow app to start even if plugins fail
  }
}

