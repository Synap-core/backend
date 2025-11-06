/**
 * Security Middleware
 * 
 * Implements defense-in-depth security measures:
 * - Rate limiting (prevent DoS)
 * - Request size limits (prevent memory exhaustion)
 * - Security headers (prevent XSS, clickjacking, etc.)
 */

import type { MiddlewareHandler } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';

/**
 * Rate Limiting Middleware
 * 
 * Limits: 100 requests per 15 minutes per IP
 */
export const rateLimitMiddleware = rateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // Max 100 requests per window
  standardHeaders: 'draft-7', // Use standard RateLimit headers
  keyGenerator: (c) => {
    // Use IP address as key
    return c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  },
  handler: (c) => {
    return c.json({
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter: '15 minutes',
    }, 429);
  },
});

/**
 * Request Size Limit Middleware
 * 
 * Limit: 10MB max request body
 */
export const requestSizeLimit: MiddlewareHandler = async (c, next) => {
  const contentLength = c.req.header('content-length');
  
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    const maxSize = 10 * 1024 * 1024; // 10MB
    
    if (size > maxSize) {
      return c.json({
        error: 'Payload too large',
        message: `Request body must be less than ${maxSize / 1024 / 1024}MB`,
        received: `${(size / 1024 / 1024).toFixed(2)}MB`,
      }, 413);
    }
  }
  
  return next();
};

/**
 * Security Headers Middleware
 * 
 * Adds security headers to prevent common attacks
 */
export const securityHeadersMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  
  // Prevent clickjacking
  c.header('X-Frame-Options', 'DENY');
  
  // Prevent MIME type sniffing
  c.header('X-Content-Type-Options', 'nosniff');
  
  // Enable XSS protection
  c.header('X-XSS-Protection', '1; mode=block');
  
  // Referrer policy
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Content Security Policy (adjust for your needs)
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.anthropic.com https://api.openai.com;"
  );
  
  // HSTS (only in production)
  if (process.env.NODE_ENV === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  
  // Permissions Policy (restrict features)
  c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
};

/**
 * CORS Configuration (already in server, but here for reference)
 */
export const getCorsOrigins = () => {
  const origins = process.env.ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:5173',  // Vite dev
    'http://localhost:3000',  // Next.js dev
    'http://localhost:3001',  // Alternative port
  ];
  
  // Add production origin
  if (process.env.BETTER_AUTH_URL) {
    origins.push(process.env.BETTER_AUTH_URL);
  }
  
  return origins;
};

