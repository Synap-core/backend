/**
 * Core system initialization
 * Initializes and manages all subsystems
 */

import { InputRouter } from '@initiativ/input';
import { Storage } from '@initiativ/storage';
import { RAGEngine } from '@initiativ/rag';
import { UserMemory } from '@initiativ/memory';
import { AgentOrchestrator } from '@initiativ/agents';
import { GitVersioning, AutoCommit } from '@initiativ/git';
import { CoreConfig } from './types.js';
import { EventLogger } from './events.js';

export class InitiativCore {
  // Subsystems
  public input: InputRouter;
  public storage: Storage;
  public rag?: RAGEngine; // Optional - only if embeddings API key provided
  public memory: UserMemory;
  public agents: AgentOrchestrator;
  public git: GitVersioning;
  public autoCommit: AutoCommit;
  public events: EventLogger;

  private initialized: boolean = false;

  constructor(config: CoreConfig) {

    // Initialize input router
    this.input = new InputRouter({
      transcriptionProvider: config.transcriptionProvider,
      transcriptionApiKey: config.transcriptionApiKey
    });

    // Initialize storage
    this.storage = new Storage({
      basePath: config.dataPath,
      userId: config.userId,
      autoRebuild: config.autoRebuildCache ?? true
    });

    // Setup RAG (but don't initialize yet - will do in init())
    if (config.embeddingsApiKey) {
      // Default to 'openai' if no provider specified
      const provider = (config.embeddingsProvider || 'openai') as 'openai' | 'cohere' | 'google' | 'local';
      
      this.rag = new RAGEngine({
        provider,
        apiKey: config.embeddingsApiKey,
        model: config.embeddingsModel,
        embeddingsModel: config.embeddingsModel
      });
    }

    // Initialize memory
    this.memory = new UserMemory({
      apiKey: config.agentApiKey,
      model: config.agentModel
    });

    // Initialize agents
    this.agents = new AgentOrchestrator({
      apiKey: config.agentApiKey,
      model: config.agentModel
    });

    // Initialize Git
    this.git = new GitVersioning({
      repoPath: config.dataPath,
      author: {
        name: 'Initiativ System',
        email: `${config.userId}@initiativ.local`
      }
    });

    // Initialize auto-commit
    this.autoCommit = new AutoCommit(this.git, {
      enabled: config.autoCommitEnabled ?? false, // Disabled by default for stability
      intervalMs: config.autoCommitIntervalMs
    });

    // Initialize event logger
    this.events = new EventLogger(config.dataPath, {
      autoFlush: true,
      flushIntervalMs: 5000
    });
  }

  /**
   * Initialize all subsystems
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log('🚀 Initializing Initiativ Core...');

    const startTime = Date.now();

    // 1. Initialize storage
    await this.storage.init();
    console.log('  ✅ Storage initialized');

    // 2. Initialize Git
    await this.git.init();
    console.log('  ✅ Git initialized');

    // 3. RAG is now LAZY - only initialized when --rag flag is used
    if (this.rag) {
      console.log('  ℹ️  RAG available (will initialize on first --rag use)');
    } else {
      console.log('  ℹ️  RAG disabled (no embeddings API key)');
    }

    // 4. Start auto-commit (if enabled)
    if (this.autoCommit['enabled']) {
      this.autoCommit.start();
      console.log('  ✅ Auto-commit started');
    } else {
      console.log('  ℹ️  Auto-commit disabled (manual commits only)');
    }

    this.initialized = true;
    console.log('✨ Initiativ Core ready!\n');

    // Log system init event
    await this.events.log({
      event: 'system_init',
      source: 'system',
      latency: Date.now() - startTime,
      data: {
        notesCount: this.storage.getStats().totalNotes,
        ragEnabled: !!this.rag
      }
    });
  }


  /**
   * Initialize RAG on-demand (Lazy Loading - Layer 4)
   * Only called when user uses --rag flag
   */
  async initializeRAG(): Promise<void> {
    if (!this.rag) {
      throw new Error('RAG not available. Set EMBEDDINGS_PROVIDER and API key in .env');
    }

    // Check if already initialized
    const stats = this.rag.getStats();
    if (stats.totalDocuments > 0) {
      return; // Already initialized
    }

    console.log('  📚 Initializing RAG (Layer 3 + 4)...');
    
    // Load all notes
    const notes = this.storage.getAllNotes();
    console.log(`  📚 Indexing ${notes.length} notes into vector store...`);
    
    const startTime = Date.now();
    
    // Index in RAG
    const documents = notes.map(note => ({
      id: note.id,
      content: `${note.title}\n\n${note.content}`,
      metadata: { tags: note.tags }
    }));
    
    await this.rag.indexDocuments(documents);
    
    const latency = Date.now() - startTime;
    console.log(`  ✅ RAG initialized (${notes.length} docs in ${latency}ms)`);

    // Log event
    await this.events.log({
      event: 'rag_indexed',
      source: 'system',
      latency,
      data: {
        documents_count: documents.length,
        provider: stats.provider
      }
    });
  }

  /**
   * Shutdown system gracefully
   */
  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Initiativ Core...');

    // Log shutdown
    await this.events.log({
      event: 'system_shutdown',
      source: 'system'
    });

    // Flush events
    await this.events.shutdown();

    // Stop auto-commit timer
    this.autoCommit.stop();

    // Close storage
    this.storage.close();

    console.log('  ✅ Shutdown complete');
  }

  /**
   * Get system status
   */
  getStatus(): {
    initialized: boolean;
    storage: { totalNotes: number; totalTags: number };
    rag?: { totalDocuments: number; provider: string };
    git: { pendingCommits: number };
  } {
    const storageStats = this.storage.getStats();

    return {
      initialized: this.initialized,
      storage: {
        totalNotes: storageStats.totalNotes,
        totalTags: storageStats.totalTags
      },
      rag: this.rag ? {
        totalDocuments: this.rag.getStats().totalDocuments,
        provider: this.rag.getStats().provider
      } : undefined,
      git: {
        pendingCommits: this.autoCommit.getPendingCount()
      }
    };
  }
}

