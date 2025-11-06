/**
 * Better Auth Configuration - Multi-User SaaS
 * 
 * Features:
 * - Email/Password authentication
 * - Google OAuth
 * - GitHub OAuth
 * - Session management (7 days)
 * - Drizzle adapter for PostgreSQL
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool } from '@neondatabase/serverless';

// Create PostgreSQL connection for Better Auth
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// Better Auth instance
export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      // Better Auth will create these tables automatically
      // user, session, account, verification
    }
  }),
  
  // Email & Password authentication
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // TODO: Enable in production with email service
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  
  // Social OAuth providers
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      enabled: !!process.env.GOOGLE_CLIENT_ID,
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      enabled: !!process.env.GITHUB_CLIENT_ID,
    },
  },
  
  // Session configuration
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // Update every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes cache
    },
  },
  
  // Security settings
  advanced: {
    crossSubDomainCookies: {
      enabled: false, // Enable if using subdomains
    },
    useSecureCookies: process.env.NODE_ENV === 'production',
  },
  
  // Base URL for redirects
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
  
  // Secret for JWT signing
  secret: process.env.BETTER_AUTH_SECRET || 'development-secret-change-in-production',
});

// Type exports
export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user;

/**
 * Get session from request headers
 */
export async function getSession(headers: Headers): Promise<Session | null> {
  try {
    const session = await auth.api.getSession({
      headers,
    });
    return session;
  } catch (error) {
    console.error('[Better Auth] Failed to get session:', error);
    return null;
  }
}

/**
 * Auth middleware for Hono
 * 
 * Usage:
 * ```typescript
 * app.use('/api/protected/*', betterAuthMiddleware);
 * ```
 */
import type { MiddlewareHandler } from 'hono';

export const betterAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const session = await getSession(c.req.raw.headers);
  
  if (!session || !session.user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  // Note: RLS not active with Neon serverless
  // User isolation is handled via explicit filtering in queries
  
  // Add to context
  c.set('user', session.user);
  c.set('userId', session.user.id);
  c.set('session', session);
  c.set('authenticated', true);
  
  return next();
};

