/**
 * @initiativ/git
 * Git versioning for Initiativ Core
 * 
 * Features:
 * - Pure JavaScript Git operations (isomorphic-git)
 * - Auto-commit batching to avoid Git bloat
 * - Versions .md files only (NOT database)
 */

// Export types
export type {
  GitConfig,
  Commit,
  GitStatus
} from './types.js';

// Export components
export { GitVersioning } from './versioning.js';
export { AutoCommit } from './auto-commit.js';
export type { AutoCommitConfig } from './auto-commit.js';

