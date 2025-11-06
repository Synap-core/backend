/**
 * Types for Git operations
 */

export interface GitConfig {
  repoPath: string;
  author?: {
    name: string;
    email: string;
  };
}

export interface Commit {
  oid: string;
  message: string;
  author: {
    name: string;
    email: string;
    timestamp: number;
  };
  parent?: string[];
}

export interface GitStatus {
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
}

