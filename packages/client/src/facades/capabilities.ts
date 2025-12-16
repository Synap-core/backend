/**
 * Capabilities Facade
 * High-level API for discovering Data Pod capabilities
 */

import type { TRPCClient } from '@trpc/client';
import type { AppRouter } from '../types.js';

export class CapabilitiesFacade {
  constructor(private rpc: TRPCClient<AppRouter>) {}

  /**
   * List all available capabilities
   * - Core features
   * - Installed plugins  
   * - Intelligence services
   */
  async list() {
    return this.rpc.capabilities.list.query();
  }

  /**
   * Check if specific capability is available
   */
  async has(capability: string) {
    const result = await this.rpc.capabilities.hasCapability.query({ capability });
    return result.available;
  }

  /**
   * Check if intelligence service with capability exists
   */
  async hasIntelligence(capability: string) {
    const caps = await this.list();
    return caps.intelligenceServices.some(s => 
      s.capabilities.includes(capability)
    );
  }

  /**
   * Get list of available intelligence services
   */
  async getIntelligenceServices() {
    const caps = await this.list();
    return caps.intelligenceServices;
  }
}
