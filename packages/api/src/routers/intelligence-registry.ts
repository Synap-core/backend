/**
 * Intelligence Registry Router
 * 
 * Manages registration and discovery of external intelligence services
 */

import { z } from 'zod';
import { router, protectedProcedure, publicProcedure } from '../trpc.js';
import { db, intelligenceServices, eq, and } from '@synap/database';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'intelligence-registry' });

// Simple ID generator (timestamp + random)
const generateId = () => `svc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Validation schemas
const RegisterServiceSchema = z.object({
  serviceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  webhookUrl: z.string().url(),
  apiKey: z.string().min(1),
  capabilities: z.array(z.string()).min(1),
  pricing: z.enum(['free', 'premium', 'enterprise', 'custom']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const UpdateServiceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  webhookUrl: z.string().url().optional(),
  capabilities: z.array(z.string()).optional(),
  status: z.enum(['active', 'inactive', 'suspended']).optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const intelligenceRegistryRouter = router({
  /**
   * Register a new intelligence service
   * 
   * This allows external intelligence services to register with the Data Pod
   */
  register: protectedProcedure
    .input(RegisterServiceSchema)
    .mutation(async ({ input }) => {
      logger.info({ serviceId: input.serviceId }, 'Registering intelligence service');
      
      // Check if service ID already exists
      const existing = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.serviceId, input.serviceId)
      });
      
      if (existing) {
        throw new Error(`Service with ID "${input.serviceId}" already registered`);
      }
      
      const [service] = await db.insert(intelligenceServices)
        .values({
          id: generateId(),
          serviceId: input.serviceId,
          name: input.name,
          description: input.description,
          version: input.version,
          webhookUrl: input.webhookUrl,
          apiKey: input.apiKey,
          capabilities: input.capabilities,
          pricing: input.pricing || 'free',
          status: 'active',
          enabled: true,
          metadata: input.metadata || {},
        })
        .returning();
      
      logger.info({ 
        serviceId: service.serviceId,
        capabilities: service.capabilities 
      }, 'Intelligence service registered');
      
      return service;
    }),
  
  /**
   * List all registered intelligence services
   */
  list: publicProcedure
    .input(z.object({
      status: z.enum(['active', 'inactive', 'suspended']).optional(),
      enabled: z.boolean().optional(),
    }).optional())
    .query(async ({ input }) => {
      const conditions = [];
      
      if (input?.status) {
        conditions.push(eq(intelligenceServices.status, input.status));
      }
      if (input?.enabled !== undefined) {
        conditions.push(eq(intelligenceServices.enabled, input.enabled));
      }
      
      const services = await db.query.intelligenceServices.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: (services, { desc }) => [desc(services.createdAt)]
      });
      
      // Don't expose API keys in list
      return services.map(s => ({
        id: s.id,
        serviceId: s.serviceId,
        name: s.name,
        description: s.description,
        version: s.version,
        capabilities: s.capabilities,
        pricing: s.pricing,
        status: s.status,
        enabled: s.enabled,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
    }),
  
  /**
   * Get a specific service by ID
   */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const service = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.id, input.id)
      });
      
      if (!service) {
        throw new Error('Service not found');
      }
      
      // Don't expose API key
      const { apiKey, ...publicService } = service;
      return publicService;
    }),
  
  /**
   * Update an intelligence service
   */
  update: protectedProcedure
    .input(UpdateServiceSchema)
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;
      
      const [updated] = await db.update(intelligenceServices)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(intelligenceServices.id, id))
        .returning();
      
      if (!updated) {
        throw new Error('Service not found');
      }
      
      logger.info({ serviceId: updated.serviceId }, 'Intelligence service updated');
      
      return updated;
    }),
  
  /**
   * Unregister an intelligence service
   */
  unregister: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.delete(intelligenceServices)
        .where(eq(intelligenceServices.id, input.id));
      
      logger.info({ id: input.id }, 'Intelligence service unregistered');
      
      return { success: true };
    }),
  
  /**
   * Find services by capability
   */
  findByCapability: publicProcedure
    .input(z.object({ capability: z.string() }))
    .query(async ({ input }) => {
      // Note: This requires PostgreSQL's JSONB operators
      const services = await db.query.intelligenceServices.findMany({
        where: and(
          eq(intelligenceServices.status, 'active'),
          eq(intelligenceServices.enabled, true)
        )
      });
      
      // Filter by capability (client-side for now)
      const filtered = services.filter(s => 
        s.capabilities.includes(input.capability)
      );
      
      return filtered.map(s => ({
        id: s.id,
        serviceId: s.serviceId,
        name: s.name,
        capabilities: s.capabilities,
        webhookUrl: s.webhookUrl,
      }));
    }),
});
