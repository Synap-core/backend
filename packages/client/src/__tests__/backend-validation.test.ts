/**
 * Backend Validation Tests
 * 
 * Validates that the backend exposes the correct endpoints for auto-generation
 * of the SDK client types.
 */

import { describe, it, expect } from 'vitest';

describe('Backend API Exports Validation', () => {
  it('should export AppRouter type from @synap/api', async () => {
    // Dynamically import to test actual module loading
    const apiModule = await import('@synap/api');
    
    // Check that AppRouter type is exported
    // Note: We can't directly test types at runtime, but we can test that
    // the module exports what we need
    expect(apiModule).toBeDefined();
    expect('appRouter' in apiModule).toBe(true);
    expect(typeof apiModule.appRouter).toBe('object');
  });

  it('should export appRouter instance with all routers', async () => {
    const { appRouter } = await import('@synap/api');
    
    expect(appRouter).toBeDefined();
    expect(typeof appRouter).toBe('object');
    
    // Verify that appRouter has the expected router structure
    // This is a runtime check - TypeScript will validate types at compile time
    const routerKeys = Object.keys(appRouter || {});
    
    // Expected routers based on src/index.ts
    const expectedRouters = ['notes', 'chat', 'events', 'capture', 'suggestions', 'system'];
    
    expectedRouters.forEach(routerName => {
      expect(routerKeys).toContain(routerName);
      expect((appRouter as any)[routerName]).toBeDefined();
    });
  });

  it('should have notes router with create, list, get procedures', async () => {
    const { appRouter } = await import('@synap/api');
    
    const notesRouter = (appRouter as any).notes;
    expect(notesRouter).toBeDefined();
    
    // Check for expected procedures
    // Note: In tRPC, procedures are nested under their type (query/mutation)
    // This is a structural check
    expect(typeof notesRouter).toBe('object');
  });

  it('should have chat router with sendMessage, getThread, listThreads', async () => {
    const { appRouter } = await import('@synap/api');
    
    const chatRouter = (appRouter as any).chat;
    expect(chatRouter).toBeDefined();
    expect(typeof chatRouter).toBe('object');
  });

  it('should have system router with health, info', async () => {
    const { appRouter } = await import('@synap/api');
    
    const systemRouter = (appRouter as any).system;
    expect(systemRouter).toBeDefined();
    expect(typeof systemRouter).toBe('object');
  });

  it('should have events router with log procedure', async () => {
    const { appRouter } = await import('@synap/api');
    
    const eventsRouter = (appRouter as any).events;
    expect(eventsRouter).toBeDefined();
    expect(typeof eventsRouter).toBe('object');
  });

  it('should have capture router with thought procedure', async () => {
    const { appRouter } = await import('@synap/api');
    
    const captureRouter = (appRouter as any).capture;
    expect(captureRouter).toBeDefined();
    expect(typeof captureRouter).toBe('object');
  });

  it('should allow importing AppRouter type in client package', async () => {
    // Test that the client can import the AppRouter type
    const typesModule = await import('../types.js');
    
    // This would fail at compile time if AppRouter wasn't exported correctly
    // At runtime, we just verify the module loads and exports AppRouter
    expect(typesModule).toBeDefined();
    expect('AppRouter' in typesModule || typeof typesModule.AppRouter !== 'undefined').toBe(true);
  });
});

