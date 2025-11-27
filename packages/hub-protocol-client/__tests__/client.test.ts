/**
 * Hub Protocol Client Tests
 * 
 * Tests for the Hub Protocol Client
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HubProtocolClient } from '../src/client.js';
import { TRPCClientError } from '@trpc/client';

// Mock @trpc/client
vi.mock('@trpc/client', () => {
  const mockClient = {
    hub: {
      generateAccessToken: {
        mutate: vi.fn(),
      },
      requestData: {
        query: vi.fn(),
      },
      submitInsight: {
        mutate: vi.fn(),
      },
    },
  };

  return {
    createTRPCProxyClient: vi.fn(() => mockClient),
    httpBatchLink: vi.fn(() => ({})),
    TRPCClientError: class MockTRPCClientError extends Error {
      data?: { code?: string };
      constructor(message: string, data?: { code?: string }) {
        super(message);
        this.data = data;
      }
    },
  };
});

// Mock @synap/core
vi.mock('@synap/core', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

describe('HubProtocolClient', () => {
  let client: HubProtocolClient;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new HubProtocolClient({
      dataPodUrl: 'http://localhost:3000',
      token: 'test-token',
    });
    // Get the mock client from the mocked module
    const { createTRPCProxyClient } = require('@trpc/client');
    mockClient = createTRPCProxyClient({ links: [] });
  });

  describe('constructor', () => {
    it('should create client with config', () => {
      expect(client).toBeDefined();
    });

    it('should handle getToken function', () => {
      const getToken = vi.fn(() => 'token-from-function');
      const clientWithGetToken = new HubProtocolClient({
        dataPodUrl: 'http://localhost:3000',
        getToken,
      });
      expect(clientWithGetToken).toBeDefined();
    });
  });

  describe('generateAccessToken', () => {
    it('should generate access token successfully', async () => {
      mockClient.hub.generateAccessToken.mutate.mockResolvedValue({
        token: 'mock-jwt-token',
        expiresAt: Date.now() + 300000,
        requestId: 'req-123',
      });

      const result = await client.generateAccessToken('req-123', ['preferences', 'notes'], 300);

      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('expiresAt');
      expect(result.token).toBe('mock-jwt-token');
      expect(mockClient.hub.generateAccessToken.mutate).toHaveBeenCalledWith({
        requestId: 'req-123',
        scope: ['preferences', 'notes'],
        expiresIn: 300,
      });
    });

    it('should handle errors', async () => {
      mockClient.hub.generateAccessToken.mutate.mockRejectedValue(
        new TRPCClientError('Token generation failed')
      );

      await expect(
        client.generateAccessToken('req-123', ['preferences'], 300)
      ).rejects.toThrow();
    });
  });

  describe('requestData', () => {
    it('should request data successfully', async () => {
      mockClient.hub.requestData.query.mockResolvedValue({
        userId: 'user-123',
        requestId: 'req-123',
        data: { preferences: {}, notes: [] },
        metadata: {
          retrievedAt: new Date().toISOString(),
          scope: ['preferences', 'notes'],
          recordCount: 0,
        },
      });

      const result = await client.requestData('mock-token', ['preferences', 'notes']);

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('metadata');
      expect(result.metadata.recordCount).toBe(0);
      expect(mockClient.hub.requestData.query).toHaveBeenCalledWith({
        token: 'mock-token',
        scope: ['preferences', 'notes'],
        filters: undefined,
      });
    });

    it('should apply filters when provided', async () => {
      mockClient.hub.requestData.query.mockResolvedValue({
        userId: 'user-123',
        requestId: 'req-123',
        data: {},
        metadata: { retrievedAt: new Date().toISOString(), scope: [], recordCount: 0 },
      });

      await client.requestData('mock-token', ['notes'], {
        limit: 10,
        dateRange: {
          start: '2025-01-01T00:00:00Z',
          end: '2025-01-31T23:59:59Z',
        },
      });

      expect(mockClient.hub.requestData.query).toHaveBeenCalledWith({
        token: 'mock-token',
        scope: ['notes'],
        filters: {
          limit: 10,
          dateRange: {
            start: '2025-01-01T00:00:00Z',
            end: '2025-01-31T23:59:59Z',
          },
        },
      });
    });
  });

  describe('submitInsight', () => {
    it('should submit insight successfully', async () => {
      const insight = {
        version: '1.0',
        type: 'action_plan',
        correlationId: 'req-123',
        actions: [
          {
            eventType: 'task.creation.requested',
            data: { title: 'Test Task' },
            requiresConfirmation: true,
            priority: 70,
          },
        ],
        confidence: 0.85,
        reasoning: 'Test reasoning',
      };

      mockClient.hub.submitInsight.mutate.mockResolvedValue({
        success: true,
        requestId: 'req-123',
        eventIds: ['event-1', 'event-2'],
        eventsCreated: 2,
      });

      const result = await client.submitInsight('mock-token', insight);

      expect(result.success).toBe(true);
      expect(result.eventsCreated).toBe(2);
      expect(mockClient.hub.submitInsight.mutate).toHaveBeenCalledWith({
        token: 'mock-token',
        insight,
      });
    });
  });

  describe('updateDataPodUrl', () => {
    it('should update Data Pod URL', () => {
      const newUrl = 'http://new-datapod.com';
      client.updateDataPodUrl(newUrl);
      // Client should be recreated with new URL
      expect(client).toBeDefined();
    });
  });
});

