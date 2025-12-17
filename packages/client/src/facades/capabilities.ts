/**
 * Capabilities Facade
 * High-level API for discovering Data Pod capabilities
 * 
 * DISABLED - capabilities router not implemented in @synap/api yet
 */

// import type { TRPCClient } from '@trpc/client'; // Disabled - not used
// import type { AppRouter } from '../types.js'; // Disabled - not used

export class CapabilitiesFacade {
  // constructor(private rpc: TRPCClient<AppRouter>) {} // Disabled - not used

  /**
   * List all available capabilities
   * - Core features
   * - Installed plugins  
   * - Intelligence services
   */
  async list(): Promise<any> {
    throw new Error('Capabilities router not yet implemented in API');
    // return this.rpc.capabilities.list.query();
  }

  /**
   * Check if specific capability is available
   */
  async has(_capability: string): Promise<boolean> {
    throw new Error('Capabilities router not yet implemented in API');
    // const result = await this.rpc.capabilities.hasCapability.query({ capability });
    // return result.available;
  }

  /**
   * Check if intelligence service with capability exists
   */
  async hasIntelligence(_capability: string): Promise<boolean> {
    throw new Error('Capabilities router not yet implemented in API');
    // const caps = await this.list();
    // return caps.intelligenceServices.some((s: any) => 
    //   s.capabilities.includes(capability)
    // );
  }

  /**
   * Get list of available intelligence services
   */
  async getIntelligenceServices(): Promise<any[]> {
    throw new Error('Capabilities router not yet implemented in API');
    // const caps = await this.list();
    // return caps.intelligenceServices;
  }
}
