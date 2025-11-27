/**
 * @synap/hub-protocol-client
 * 
 * Hub Protocol Client - Type-safe tRPC client for Hub ↔ Data Pod communication
 * 
 * This package provides a reusable client for any Hub (Intelligence Hub or third-party)
 * to communicate with a Synap Data Pod via the Hub Protocol V1.0.
 * 
 * @example
 * ```typescript
 * import { HubProtocolClient } from '@synap/hub-protocol-client';
 * 
 * const client = new HubProtocolClient({
 *   dataPodUrl: 'http://localhost:3000',
 *   token: 'user-session-token',
 * });
 * 
 * const { token } = await client.generateAccessToken('req-123', ['preferences', 'notes']);
 * const data = await client.requestData(token, ['preferences', 'notes']);
 * await client.submitInsight(token, insight);
 * ```
 */

export { HubProtocolClient } from './client.js';
export type {
  HubProtocolClientConfig,
  HubScope,
  RequestDataFilters,
} from './types.js';

