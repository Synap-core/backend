/**
 * Integration tests for @initiativ/core
 * Tests end-to-end workflows
 */

import { InitiativCore } from '../src/system.js';
import { Workflows } from '../src/workflows.js';
import { ChatManager } from '../src/chat.js';
import fs from 'fs/promises';
import path from 'path';

const TEST_DATA_PATH = './test-data';
const TEST_USER_ID = 'test-user';

describe('Integration Tests', () => {
  let core: InitiativCore;
  let workflows: Workflows;
  let chatManager: ChatManager;

  beforeAll(async () => {
    // Clean test directory
    try {
      await fs.rm(TEST_DATA_PATH, { recursive: true });
    } catch {
      // Ignore if doesn't exist
    }

    // Initialize core system
    core = new InitiativCore({
      dataPath: TEST_DATA_PATH,
      userId: TEST_USER_ID,
      embeddingsProvider: 'openai',
      embeddingsApiKey: process.env.OPENAI_API_KEY || 'test-key',
      agentApiKey: process.env.ANTHROPIC_API_KEY || 'test-key',
      agentModel: 'claude-3-haiku-20240307',
      autoCommitEnabled: false // Disable for tests
    });

    await core.init();

    workflows = new Workflows(core);
    chatManager = new ChatManager(core.storage, core.memory, core.agents);
  });

  afterAll(async () => {
    await core.shutdown();
    
    // Clean up test data
    try {
      await fs.rm(TEST_DATA_PATH, { recursive: true });
    } catch {
      // Ignore
    }
  });

  describe('Workflow: Capture Note', () => {
    it('should capture text note successfully', async () => {
      const note = await workflows.captureNote({
        type: 'text',
        data: 'This is a test note about AI and machine learning'
      });

      expect(note.id).toBeDefined();
      expect(note.content).toBe('This is a test note about AI and machine learning');
      expect(note.createdAt).toBeInstanceOf(Date);
    });

    it('should enrich note with AI when enabled', async () => {
      // Mock or skip if no real API key
      if (!process.env.ANTHROPIC_API_KEY) {
        console.log('Skipping AI enrichment test (no API key)');
        return;
      }

      const note = await workflows.captureNote(
        {
          type: 'text',
          data: 'Building a machine learning model for sentiment analysis using Python and TensorFlow'
        },
        { autoEnrich: true }
      );

      expect(note.tags).toBeDefined();
      expect(note.tags!.length).toBeGreaterThan(0);
      expect(note.title).not.toBe('Untitled');
    }, 10000); // Increase timeout for API call
  });

  describe('Workflow: Search Notes', () => {
    beforeAll(async () => {
      // Create test notes
      await workflows.captureNote({
        type: 'text',
        data: 'Machine learning algorithms for classification'
      });

      await workflows.captureNote({
        type: 'text',
        data: 'Building web applications with React and TypeScript'
      });
    });

    it('should search notes with FTS', async () => {
      const results = await workflows.searchNotes('machine learning', {
        useRAG: false
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].note.content).toContain('Machine learning');
    });

    it('should search notes with RAG', async () => {
      // Skip if no API key
      if (!process.env.OPENAI_API_KEY) {
        console.log('Skipping RAG test (no OpenAI API key)');
        return;
      }

      const results = await workflows.searchNotes('AI algorithms', {
        useRAG: true,
        limit: 3
      });

      expect(results.length).toBeGreaterThan(0);
    }, 15000); // Increase timeout for API calls
  });

  describe('Workflow: Get Insights', () => {
    it('should generate insights', async () => {
      const insights = await workflows.getInsights();

      expect(insights.length).toBeGreaterThan(0);
      expect(insights[0].type).toBeDefined();
      expect(insights[0].message).toBeDefined();
    });
  });

  describe('Chat Branching', () => {
    it('should create a branch', async () => {
      const branch = await chatManager.createBranch('Test branch for landing page');

      expect(branch.id).toBeDefined();
      expect(branch.type).toBe('branch');
      expect(branch.intent).toBe('Test branch for landing page');
      expect(branch.status).toBe('open');
    });

    it('should add messages to branch', () => {
      const branches = chatManager.getBranches();
      const branchId = branches[0]?.id || 'main';

      chatManager.addMessage(branchId, 'user', 'What should I do?');
      chatManager.addMessage(branchId, 'assistant', 'Here are the steps...');

      const messages = chatManager.getMessages(branchId);
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });

    it('should merge branch', async () => {
      // Skip if no API key
      if (!process.env.ANTHROPIC_API_KEY) {
        console.log('Skipping merge test (no API key)');
        return;
      }

      const branch = await chatManager.createBranch('Test merge');
      chatManager.addMessage(branch.id, 'user', 'Create a landing page');
      chatManager.addMessage(branch.id, 'assistant', 'I created the sections');

      const summary = await chatManager.merge(branch.id);

      expect(summary.summary).toBeDefined();
      expect(summary.facts).toBeDefined();
      expect(summary.artifacts).toBeDefined();

      const mergedBranch = chatManager.getThread(branch.id);
      expect(mergedBranch?.status).toBe('merged');
    }, 10000);
  });

  describe('System Status', () => {
    it('should get system status', () => {
      const status = core.getStatus();

      expect(status.initialized).toBe(true);
      expect(status.storage).toBeDefined();
      expect(status.rag).toBeDefined();
      expect(status.git).toBeDefined();
    });
  });
});

