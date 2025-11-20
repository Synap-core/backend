/**
 * Hub Protocol Utilities
 * 
 * Functions for JWT token generation, validation, and audit logging
 * for the Hub Protocol V1.0
 */

import jwt from 'jsonwebtoken';
import { createLogger } from '@synap/core';
import { getEventRepository } from '@synap/database';
import { createSynapEvent, EventTypes } from '@synap/types';

const logger = createLogger({ module: 'hub-utils' });

// ============================================================================
// JWT CONFIGURATION
// ============================================================================

const HUB_JWT_SECRET = process.env.HUB_JWT_SECRET || process.env.SYNAP_SECRET_TOKEN || 'change-me-in-production';

if (!process.env.HUB_JWT_SECRET && process.env.NODE_ENV === 'production') {
  logger.warn('HUB_JWT_SECRET not set - using SYNAP_SECRET_TOKEN. This is not recommended for production.');
}

// ============================================================================
// TOKEN PAYLOAD TYPES
// ============================================================================

export interface HubTokenPayload {
  userId: string;
  requestId: string;
  scope: string[];
  iat: number;
  exp: number;
}

// ============================================================================
// TOKEN GENERATION
// ============================================================================

/**
 * Generate a JWT token for Hub access
 * 
 * @param userId - User ID
 * @param requestId - Request ID from Hub
 * @param scope - List of permissions (e.g., ['preferences', 'calendar'])
 * @param expiresIn - Duration in seconds (60-300, default: 300)
 * @returns Token JWT and expiration timestamp
 */
export function generateHubAccessToken(
  userId: string,
  requestId: string,
  scope: string[],
  expiresIn: number = 300
): { token: string; expiresAt: number } {
  // Clamp expiresIn between 60 and 300 seconds (1-5 minutes)
  const validExpiresIn = Math.max(60, Math.min(300, expiresIn));
  
  const now = Math.floor(Date.now() / 1000);
  const exp = now + validExpiresIn;
  
  const payload: HubTokenPayload = {
    userId,
    requestId,
    scope,
    iat: now,
    exp,
  };
  
  const token = jwt.sign(payload, HUB_JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: validExpiresIn,
  });
  
  logger.debug({ userId, requestId, scope, expiresIn: validExpiresIn }, 'Hub access token generated');
  
  return {
    token,
    expiresAt: exp * 1000, // Return in milliseconds
  };
}

// ============================================================================
// TOKEN VALIDATION
// ============================================================================

/**
 * Validate a Hub JWT token
 * 
 * @param token - JWT token to validate
 * @returns Decoded payload or null if invalid
 */
export function validateHubToken(token: string): HubTokenPayload | null {
  try {
    const decoded = jwt.verify(token, HUB_JWT_SECRET, {
      algorithms: ['HS256'],
    }) as HubTokenPayload;
    
    // Verify token hasn't expired
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp < now) {
      logger.warn({ exp: decoded.exp, now }, 'Hub token expired');
      return null;
    }
    
    // Verify required fields
    if (!decoded.userId || !decoded.requestId || !decoded.scope) {
      logger.warn({ decoded }, 'Hub token missing required fields');
      return null;
    }
    
    return decoded;
  } catch (error) {
    logger.warn({ err: error }, 'Hub token validation failed');
    return null;
  }
}

// ============================================================================
// AUDIT LOGGING
// ============================================================================

/**
 * Log a Hub access event for audit trail
 * 
 * @param userId - User ID
 * @param requestId - Request ID
 * @param action - Action type ('token.generated' | 'data.requested' | 'insight.submitted')
 * @param metadata - Additional metadata
 */
export async function logHubAccess(
  userId: string,
  requestId: string,
  action: 'token.generated' | 'data.requested' | 'insight.submitted',
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const eventRepo = getEventRepository();
    
    // Create audit event
    const auditEvent = createSynapEvent({
      type: EventTypes.HUB_ACCESS_LOGGED,
      data: {
        action,
        requestId,
        ...metadata,
      },
      userId,
      source: 'system',
      correlationId: requestId,
    });
    
    await eventRepo.append(auditEvent);
    
    logger.debug({ userId, requestId, action }, 'Hub access logged');
  } catch (error) {
    // Don't fail the request if audit logging fails
    logger.error({ err: error, userId, requestId, action }, 'Failed to log Hub access');
  }
}

