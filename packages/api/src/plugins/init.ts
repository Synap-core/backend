/**
 * Plugin Initialization
 * 
 * Registers default plugins and initializes the plugin system.
 */

import { pluginManager } from './index.js';
import { createLogger } from '@synap-core/core';

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

    // Register built-in plugins here if needed
    // e.g. await pluginManager.register(somePlugin);
    
    // Initialize all plugins
    await pluginManager.initialize();
    
    logger.info('Plugin system initialized successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize plugin system');
    throw error;
  }
}
