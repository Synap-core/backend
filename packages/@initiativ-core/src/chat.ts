/**
 * Chat branching system
 * Implements "Chain of Thoughts" - Git-like branching for conversations
 */

import { Storage } from '@initiativ/storage';
import { UserMemory } from '@initiativ/memory';
import { AgentOrchestrator } from '@initiativ/agents';
import { ChatThread, ChatMessage, BranchSummary } from './types.js';

export class ChatManager {
  private storage: Storage;
  private memory: UserMemory;
  private agents: AgentOrchestrator;
  private threads: Map<string, ChatThread>;
  private messages: Map<string, ChatMessage[]>;

  constructor(storage: Storage, memory: UserMemory, agents: AgentOrchestrator) {
    this.storage = storage;
    this.memory = memory;
    this.agents = agents;
    this.threads = new Map();
    this.messages = new Map();

    // Create main thread
    this.createMainThread();
  }

  /**
   * Create main thread
   */
  private createMainThread(): void {
    const mainThread: ChatThread = {
      id: 'main',
      type: 'main',
      status: 'open',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.threads.set('main', mainThread);
    this.messages.set('main', []);
  }

  /**
   * Create a new branch
   */
  async createBranch(intent: string, parentId: string = 'main'): Promise<ChatThread> {
    const branchId = `branch_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const branch: ChatThread = {
      id: branchId,
      type: 'branch',
      parentId,
      status: 'open',
      intent,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.threads.set(branchId, branch);
    this.messages.set(branchId, []);

    // Save branch metadata as note
    await this.storage.createNote(`Branch: ${intent}`, {
      title: `Branch: ${intent}`,
      tags: ['branch', 'chat'],
      metadata: {
        threadId: branchId,
        threadType: 'branch',
        parentThread: parentId
      }
    });

    return branch;
  }

  /**
   * Add message to thread
   */
  addMessage(threadId: string, role: 'user' | 'assistant', content: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    const messages = this.messages.get(threadId) || [];
    messages.push({
      role,
      content,
      timestamp: new Date()
    });

    this.messages.set(threadId, messages);

    // Update thread timestamp
    thread.updatedAt = new Date();
  }

  /**
   * Get messages for thread
   */
  getMessages(threadId: string): ChatMessage[] {
    return this.messages.get(threadId) || [];
  }

  /**
   * Get thread by ID
   */
  getThread(threadId: string): ChatThread | undefined {
    return this.threads.get(threadId);
  }

  /**
   * Get all branches
   */
  getBranches(): ChatThread[] {
    return Array.from(this.threads.values()).filter(t => t.type === 'branch');
  }

  /**
   * Merge branch back to main
   * 
   * Steps:
   * 1. Get all messages from branch
   * 2. Ask LLM to summarize the branch work
   * 3. Extract facts to memory
   * 4. Append summary to main thread
   * 5. Mark branch as merged
   */
  async merge(branchId: string): Promise<BranchSummary> {
    const branch = this.threads.get(branchId);
    if (!branch || branch.type !== 'branch') {
      throw new Error(`Invalid branch: ${branchId}`);
    }

    const branchMessages = this.messages.get(branchId) || [];
    
    if (branchMessages.length === 0) {
      throw new Error('Cannot merge empty branch');
    }

    // Step 1: Generate summary using LLM
    const summary = await this.generateBranchSummary(branch, branchMessages);

    // Step 2: Extract facts from branch conversation
    const facts = await this.memory.extractFacts(
      branchMessages.map(m => ({ role: m.role, content: m.content })),
      branchId
    );

    // Step 3: Collect artifacts (notes created in this branch)
    const branchNotes = this.storage.getAllNotes({
      limit: 100
    }).filter(note => 
      note.metadata && 
      (note.metadata as any).threadId === branchId
    );

    const artifacts = branchNotes.map(n => n.title);

    // Step 4: Add summary to main thread
    this.addMessage(
      branch.parentId || 'main',
      'assistant',
      `[Merged from branch: ${branch.intent}]\n\n${summary}\n\nArtifacts created: ${artifacts.join(', ')}`
    );

    // Step 5: Mark branch as merged
    branch.status = 'merged';
    branch.updatedAt = new Date();

    // Save merge record
    await this.storage.createNote(summary, {
      title: `Branch Merge: ${branch.intent}`,
      tags: ['merge', 'summary'],
      metadata: {
        branchId,
        parentThread: branch.parentId,
        artifactCount: artifacts.length,
        factCount: facts.length
      }
    });

    return {
      facts: facts.map(f => f.fact),
      artifacts,
      summary
    };
  }

  /**
   * Generate branch summary using LLM
   */
  private async generateBranchSummary(
    branch: ChatThread,
    messages: ChatMessage[]
  ): Promise<string> {
    const conversationText = messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n');

    const prompt = `Summarize this conversation branch concisely (max 200 words).

Branch Intent: ${branch.intent}

Conversation:
${conversationText}

Summary (what was accomplished, key decisions, next steps):`;

    // Use simple LLM call (no tools needed for summary)
    const response = await this.agents['llm'].invoke(prompt);
    return response.content.toString().trim();
  }

  /**
   * Archive a branch (doesn't delete, just marks as archived)
   */
  archiveBranch(branchId: string): void {
    const branch = this.threads.get(branchId);
    if (branch && branch.type === 'branch') {
      branch.status = 'archived';
      branch.updatedAt = new Date();
    }
  }
}

