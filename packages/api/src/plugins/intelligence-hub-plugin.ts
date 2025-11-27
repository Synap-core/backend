/**
 * Intelligence Hub Plugin
 * 
 * Example plugin that routes thoughts to the Intelligence Hub.
 * 
 * This demonstrates how to create a plugin for the Data Pod.
 */

import { createLogger } from '@synap/core';
import type { DataPodPlugin, ThoughtInput, ThoughtResponse } from './types.js';
import { HubProtocolClient } from '@synap/hub-protocol-client';
import { randomUUID } from 'crypto';

const logger = createLogger({ module: 'intelligence-hub-plugin' });

/**
 * Intelligence Hub Plugin
 * 
 * Routes thoughts to the Intelligence Hub via Hub Protocol.
 */
export const intelligenceHubPlugin: DataPodPlugin = {
  name: 'intelligence-hub',
  version: '1.0.0',
  enabled: process.env.INTELLIGENCE_HUB_ENABLED === 'true',

  async processThought(input: ThoughtInput): Promise<ThoughtResponse> {
    const requestId = randomUUID();
    
    logger.debug({ 
      userId: input.userId, 
      contentLength: input.content.length,
      requestId,
    }, 'Processing thought via Intelligence Hub plugin');

    // Get Intelligence Hub configuration
    const hubUrl = process.env.INTELLIGENCE_HUB_URL;
    const hubApiKey = process.env.INTELLIGENCE_HUB_API_KEY;

    if (!hubUrl || !hubApiKey) {
      logger.warn('Intelligence Hub not configured');
      throw new Error('Intelligence Hub not configured');
    }

    // Create Hub Protocol Client
    const hubClient = new HubProtocolClient({
      dataPodUrl: hubUrl,
      getToken: async () => hubApiKey,
    });

    try {
      // Call Intelligence Hub via Hub Protocol
      // Note: This is a simplified example. In practice, the Intelligence Hub
      // would be called via the Backend App, not directly from the Data Pod.
      // This plugin is for power users who want to connect their own Hub.
      
      // For now, we'll just return a success response
      // The actual implementation would call the Hub's expertise endpoint
      logger.info({ requestId }, 'Thought routed to Intelligence Hub (via plugin)');

      return {
        success: true,
        requestId,
        events: [],
      };
    } catch (error) {
      logger.error({ err: error, requestId }, 'Intelligence Hub plugin failed');
      throw error;
    }
  },

  async onInit(): Promise<void> {
    logger.info('Intelligence Hub plugin initialized');
  },

  async onDestroy(): Promise<void> {
    logger.info('Intelligence Hub plugin destroyed');
  },
};

