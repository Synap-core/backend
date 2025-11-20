/**
 * Tests for @synap/client SDK
 * 
 * Tests the 3-layer architecture:
 * 1. Core RPC client (auto-generated)
 * 2. Business facade
 * 3. Authentication
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import SynapClient from '../index.js';
import type { AppRouter } from '../types.js';

// Mock fetch for tRPC calls
global.fetch = vi.fn();

// Mock the @synap/api AppRouter type
// In real usage, this would be imported from @synap/api
type MockAppRouter = {
  notes: {
    create: {
      mutate: (input: { content: string; title?: string }) => Promise<{
        success: boolean;
        status: 'pending';
        requestId: string;
        entityId: string;
      }>;
    };
    list: {
      query: (input?: { limit?: number; offset?: number }) => Promise<Array<{
        id: string;
        title: string | null;
        preview: string | null;
        createdAt: Date;
        updatedAt: Date;
      }>>;
    };
    get: {
      query: (input: { id: string }) => Promise<{
        id: string;
        title: string | null;
        preview: string | null;
        content?: string;
        fileUrl?: string;
        createdAt: Date;
        updatedAt: Date;
      }>;
    };
  };
  chat: {
    sendMessage: {
      mutate: (input: { content: string; threadId?: string }) => Promise<{
        success: boolean;
        status: 'pending';
        requestId: string;
        threadId: string;
        websocketUrl: string;
      }>;
    };
    getThread: {
      query: (input: { threadId: string }) => Promise<{
        id: string;
        messages: Array<{
          id: string;
          role: 'user' | 'assistant';
          content: string;
          createdAt: Date;
        }>;
      }>;
    };
  };
  system: {
    health: {
      query: () => Promise<{ status: string; timestamp: string }>;
    };
  };
};

describe('SynapClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should create a client with URL and token', () => {
      const client = new SynapClient({
        url: 'http://localhost:3000',
        token: 'test-token',
      });

      expect(client).toBeInstanceOf(SynapClient);
      expect(client.rpc).toBeDefined();
      expect(client.notes).toBeDefined();
      expect(client.chat).toBeDefined();
      expect(client.tasks).toBeDefined();
      expect(client.capture).toBeDefined();
      expect(client.system).toBeDefined();
    });

    it('should create a client with getToken function', () => {
      const getToken = vi.fn().mockResolvedValue('async-token');
      const client = new SynapClient({
        url: 'http://localhost:3000',
        getToken,
      });

      expect(client).toBeInstanceOf(SynapClient);
      expect(client.rpc).toBeDefined();
    });
  });

  describe('Real-time URL', () => {
    it('should generate real-time URL from config URL', () => {
      const client = new SynapClient({
        url: 'http://localhost:3000',
        token: 'test-token',
      });

      const url = client.getRealtimeUrl('user-123');
      expect(url).toContain('wss://');
      expect(url).toContain('user_123');
      expect(url).toContain('/subscribe');
    });

    it('should use custom realtimeUrl if provided', () => {
      const client = new SynapClient({
        url: 'http://localhost:3000',
        realtimeUrl: 'wss://custom.realtime.app',
        token: 'test-token',
      });

      const url = client.getRealtimeUrl('user-123');
      expect(url).toBe('wss://custom.realtime.app/rooms/user_123/subscribe');
    });
  });

  describe('Update Token', () => {
    it('should create a new client instance with updated token', () => {
      const client = new SynapClient({
        url: 'http://localhost:3000',
        token: 'old-token',
      });

      const newClient = client.updateToken(() => 'new-token');
      expect(newClient).toBeInstanceOf(SynapClient);
      expect(newClient).not.toBe(client); // Should be a new instance
    });
  });
});

describe('NotesFacade', () => {
  let client: SynapClient;

  beforeEach(() => {
    client = new SynapClient({
      url: 'http://localhost:3000',
      token: 'test-token',
    });
  });

  it('should have create method', () => {
    expect(client.notes.create).toBeDefined();
    expect(typeof client.notes.create).toBe('function');
  });

  it('should have list method', () => {
    expect(client.notes.list).toBeDefined();
    expect(typeof client.notes.list).toBe('function');
  });

  it('should have get method', () => {
    expect(client.notes.get).toBeDefined();
    expect(typeof client.notes.get).toBe('function');
  });
});

describe('ChatFacade', () => {
  let client: SynapClient;

  beforeEach(() => {
    client = new SynapClient({
      url: 'http://localhost:3000',
      token: 'test-token',
    });
  });

  it('should have sendMessage method', () => {
    expect(client.chat.sendMessage).toBeDefined();
    expect(typeof client.chat.sendMessage).toBe('function');
  });

  it('should have getThread method', () => {
    expect(client.chat.getThread).toBeDefined();
    expect(typeof client.chat.getThread).toBe('function');
  });

  it('should have listThreads method', () => {
    expect(client.chat.listThreads).toBeDefined();
    expect(typeof client.chat.listThreads).toBe('function');
  });
});

describe('TasksFacade', () => {
  let client: SynapClient;

  beforeEach(() => {
    client = new SynapClient({
      url: 'http://localhost:3000',
      token: 'test-token',
    });
  });

  it('should have complete method', () => {
    expect(client.tasks.complete).toBeDefined();
    expect(typeof client.tasks.complete).toBe('function');
  });
});

describe('CaptureFacade', () => {
  let client: SynapClient;

  beforeEach(() => {
    client = new SynapClient({
      url: 'http://localhost:3000',
      token: 'test-token',
    });
  });

  it('should have thought method', () => {
    expect(client.capture.thought).toBeDefined();
    expect(typeof client.capture.thought).toBe('function');
  });
});

describe('SystemFacade', () => {
  let client: SynapClient;

  beforeEach(() => {
    client = new SynapClient({
      url: 'http://localhost:3000',
      token: 'test-token',
    });
  });

  it('should have health method', () => {
    expect(client.system.health).toBeDefined();
    expect(typeof client.system.health).toBe('function');
  });

  it('should have info method', () => {
    expect(client.system.info).toBeDefined();
    expect(typeof client.system.info).toBe('function');
  });
});

