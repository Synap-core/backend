/**
 * Core workflows
 * Pre-defined workflows that orchestrate multiple subsystems
 */

import { InitiativCore } from './system.js';
import { CaptureOptions, SearchOptions, Insight } from './types.js';
import type { Input } from '@initiativ/input';
import type { Note, SearchResult } from '@initiativ/storage';

export class Workflows {
  constructor(private core: InitiativCore) {}

  /**
   * Workflow: Capture Note
   * 
   * Steps:
   * 1. Process input (text/audio transcription)
   * 2. Save as .md file
   * 3. AI enrichment (tags, title) if enabled
   * 4. Update RAG index
   * 5. Queue Git commit
   */
  async captureNote(input: Input, options?: CaptureOptions): Promise<Note> {
    const startTime = Date.now();
    
    // Step 1: Process input
    const processed = await this.core.input.process(input);

    // Step 2: Create note
    const note = await this.core.storage.createNote(processed.content, {
      tags: options?.tags,
      metadata: {
        ...options?.metadata,
        inputSource: processed.metadata.source,
        processedAt: processed.metadata.processedAt
      }
    });

    // Step 3: AI enrichment (optional)
    let finalNote = note;
    if (options?.autoEnrich) {
      const enrichStartTime = Date.now();
      
      const [tags, title] = await Promise.all([
        this.core.agents.generateTags(note.content, 5),
        this.core.agents.generateTitle(note.content)
      ]);

      // Update note with AI-generated metadata
      finalNote = await this.core.storage.updateNote(note.id, {
        tags: [...(note.tags || []), ...tags],
        title: title
      });

      // Log AI enrichment
      await this.core.events.log({
        event: 'ai_enrichment',
        entity_id: finalNote.id,
        source: 'ai_agent',
        latency: Date.now() - enrichStartTime,
        data: {
          tags_generated: tags.length,
          title_generated: true
        }
      });
    }

    // Step 4: Update RAG index (if available)
    if (this.core.rag) {
      await this.core.rag.indexDocument({
        id: finalNote.id,
        content: `${finalNote.title}\n\n${finalNote.content}`,
        metadata: { tags: finalNote.tags }
      });
    }

    // Step 5: Queue Git commit
    this.core.autoCommit.markChange(`Add note: ${finalNote.title}`);

    // Log event
    await this.core.events.log({
      event: 'note_created',
      entity_id: finalNote.id,
      source: 'user',
      latency: Date.now() - startTime,
      data: {
        input_type: input.type,
        enriched: options?.autoEnrich !== false,
        tags_count: (finalNote.tags || []).length
      }
    });

    return finalNote;
  }

  /**
   * Workflow: Search Notes
   * 
   * Supports both FTS (fast) and RAG (semantic)
   */
  async searchNotes(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const startTime = Date.now();
    if (options?.useRAG) {
      // Check if RAG is available
      if (!this.core.rag) {
        throw new Error('RAG search not available. No embeddings API key configured.');
      }

      // Initialize RAG lazily on first use (Layer 4 lazy loading)
      await this.core.initializeRAG();

      // Semantic search via RAG
      const ragResults = await this.core.rag.search(query, options.limit || 10);

      // Map to storage SearchResult format
      return ragResults.map(r => ({
        note: this.core.storage.getAllNotes().find(n => n.id === r.document.id)!,
        score: r.score,
        snippet: r.document.content.substring(0, 200)
      })).filter(r => r.note); // Filter out missing notes
    } else {
      // Full-text search via SQLite FTS
      const results = this.core.storage.searchNotes(query, {
        limit: options?.limit,
        tags: options?.tags
      });

      // Log search event
      await this.core.events.log({
        event: 'search_executed',
        source: 'user',
        latency: Date.now() - startTime,
        data: {
          query,
          method: 'fts',
          results_count: results.length
        }
      });

      return results;
    }
  }

  /**
   * Workflow: Get Insights
   * 
   * Analyzes user patterns and provides insights
   */
  async getInsights(): Promise<Insight[]> {
    const stats = this.core.storage.getStats();
    const allNotes = this.core.storage.getAllNotes({ limit: 1000 });

    const insights: Insight[] = [];

    // Insight 1: Note count
    insights.push({
      type: 'activity',
      message: `You have ${stats.totalNotes} notes in your knowledge base`,
      data: { totalNotes: stats.totalNotes }
    });

    // Insight 2: Top tags
    if (stats.totalTags > 0) {
      const tagCounts = this.countTags(allNotes);
      const topTags = Object.entries(tagCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([tag]) => tag);

      insights.push({
        type: 'topics',
        message: `Your top topics: ${topTags.join(', ')}`,
        data: { topTags, tagCounts }
      });
    }

    // Insight 3: Recent activity
    const recentNotes = allNotes
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 10);

    const daysActive = this.calculateDaysActive(allNotes);
    const notesPerDay = stats.totalNotes / (daysActive || 1);

    insights.push({
      type: 'activity',
      message: `You create an average of ${notesPerDay.toFixed(1)} notes per day`,
      data: { notesPerDay, daysActive, recentNotes: recentNotes.length }
    });

    // Insight 4: Memory facts
    const facts = this.core.memory.getFacts();
    if (facts.length > 0) {
      insights.push({
        type: 'patterns',
        message: `I've learned ${facts.length} facts about your preferences`,
        data: { factCount: facts.length }
      });
    }

    return insights;
  }

  /**
   * Helper: Count tags across all notes
   */
  private countTags(notes: Note[]): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const note of notes) {
      if (note.tags) {
        for (const tag of note.tags) {
          counts[tag] = (counts[tag] || 0) + 1;
        }
      }
    }

    return counts;
  }

  /**
   * Helper: Calculate days active
   */
  private calculateDaysActive(notes: Note[]): number {
    if (notes.length === 0) return 0;

    const dates = notes.map(n => n.createdAt.getTime());
    const oldest = Math.min(...dates);
    const newest = Math.max(...dates);

    const diffMs = newest - oldest;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    return Math.max(1, Math.ceil(diffDays));
  }
}

