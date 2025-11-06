/**
 * Git versioning using simple-git
 * Battle-tested Git wrapper for Node.js
 */

import { simpleGit, SimpleGit, LogResult } from 'simple-git';
import { GitConfig, Commit, GitStatus } from './types.js';

export class GitVersioning {
  private repoPath: string;
  private author: { name: string; email: string };
  private git: SimpleGit;

  constructor(config: GitConfig) {
    this.repoPath = config.repoPath;
    this.author = config.author || {
      name: 'Initiativ System',
      email: 'system@initiativ.app'
    };
    this.git = simpleGit(this.repoPath);
  }

  /**
   * Initialize Git repository
   */
  async init(): Promise<void> {
    try {
      await this.git.status();
      // Already initialized, check if we need initial commit
      const log = await this.git.log({ maxCount: 1 }).catch(() => null);
      
      if (!log || log.total === 0) {
        // Create initial commit
        await this.createInitialCommit();
      }
    } catch {
      // Initialize new repo
      await this.git.init();
      await this.git.addConfig('user.name', this.author.name);
      await this.git.addConfig('user.email', this.author.email);
      
      // Create initial commit
      await this.createInitialCommit();
    }
  }

  /**
   * Create initial commit
   */
  private async createInitialCommit(): Promise<void> {
    try {
      // Create .gitignore
      const fs = await import('fs/promises');
      const gitignorePath = `${this.repoPath}/.gitignore`;
      await fs.writeFile(gitignorePath, 'cache.db\nevents.jsonl\n*.log\n', 'utf-8');
      
      // Add and commit
      await this.git.add('.gitignore');
      await this.git.commit('Initial commit', undefined, {
        '--author': `${this.author.name} <${this.author.email}>`
      });
    } catch (error) {
      console.warn('Could not create initial commit:', (error as Error).message);
    }
  }

  /**
   * Commit all changes
   */
  async commit(message: string): Promise<string> {
    // Check if there are any changes first
    const status = await this.git.status();
    const hasChanges = status.files.length > 0;

    if (!hasChanges) {
      throw new Error('No changes to commit');
    }

    // Stage all changes
    await this.git.add('.');

    // Create commit
    const result = await this.git.commit(message, undefined, {
      '--author': `${this.author.name} <${this.author.email}>`
    });

    return result.commit;
  }

  /**
   * Get commit history
   */
  async getHistory(limit: number = 10): Promise<Commit[]> {
    try {
      const log: LogResult = await this.git.log({ maxCount: limit });

      return log.all.map(commit => ({
        oid: commit.hash,
        message: commit.message,
        author: {
          name: commit.author_name,
          email: commit.author_email,
          timestamp: new Date(commit.date).getTime() / 1000
        },
        parent: undefined // simple-git doesn't expose parent in log
      }));
    } catch {
      return []; // No commits yet
    }
  }

  /**
   * Checkout a specific commit
   */
  async checkout(ref: string): Promise<void> {
    await this.git.checkout(ref);
  }

  /**
   * Get current status
   */
  async getStatus(): Promise<GitStatus> {
    const status = await this.git.status();

    return {
      modified: status.modified,
      added: status.created,
      deleted: status.deleted,
      untracked: status.not_added
    };
  }

  /**
   * Get current branch
   */
  async getCurrentBranch(): Promise<string> {
    const branch = await this.git.branch();
    return branch.current || 'main';
  }

  /**
   * Check if repo has uncommitted changes
   */
  async hasChanges(): Promise<boolean> {
    const status = await this.git.status();
    return status.files.length > 0;
  }
}
