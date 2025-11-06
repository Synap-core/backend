/**
 * Auto-commit functionality
 * Batches commits at intervals to avoid Git bloat
 */

import { GitVersioning } from './versioning.js';

export interface AutoCommitConfig {
  intervalMs?: number; // Default: 5 minutes
  enabled?: boolean;
}

export class AutoCommit {
  private git: GitVersioning;
  private intervalMs: number;
  private timer?: NodeJS.Timeout;
  private pendingChanges: string[];
  private enabled: boolean;

  constructor(git: GitVersioning, config?: AutoCommitConfig) {
    this.git = git;
    this.intervalMs = config?.intervalMs || 5 * 60 * 1000; // 5 minutes
    this.enabled = config?.enabled ?? true;
    this.pendingChanges = [];
  }

  /**
   * Start auto-commit timer
   */
  start(): void {
    if (!this.enabled || this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.flush().catch(console.error);
    }, this.intervalMs);
  }

  /**
   * Stop auto-commit timer
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Mark a change for batching
   */
  markChange(description: string): void {
    this.pendingChanges.push(description);
  }

  /**
   * Flush pending commits immediately
   */
  async flush(): Promise<string | null> {
    if (this.pendingChanges.length === 0) {
      return null;
    }

    // Check if there are actual Git changes
    try {
      const hasChanges = await this.git.hasChanges();
      if (!hasChanges) {
        this.pendingChanges = [];
        return null;
      }
    } catch (error) {
      console.warn('Could not check Git status:', (error as Error).message);
      this.pendingChanges = [];
      return null;
    }

    // Create commit message
    const message = this.pendingChanges.length === 1
      ? this.pendingChanges[0]
      : `Batch update: ${this.pendingChanges.length} changes\n\n${this.pendingChanges.join('\n')}`;

    // Commit with error handling
    try {
      const sha = await this.git.commit(message);
      this.pendingChanges = [];
      return sha;
    } catch (error) {
      console.warn('Git commit failed:', (error as Error).message);
      this.pendingChanges = [];
      return null;
    }
  }

  /**
   * Commit immediately (bypasses batching)
   */
  async commitNow(message: string): Promise<string> {
    return await this.git.commit(message);
  }

  /**
   * Get pending changes count
   */
  getPendingCount(): number {
    return this.pendingChanges.length;
  }

  /**
   * Clear pending changes without committing
   */
  clearPending(): void {
    this.pendingChanges = [];
  }
}

