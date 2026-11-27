/** Types for agnostic-backend-detector.mjs — see that file for what it counts and what it cannot see. */

export const ROOTS: string[];

export const DEV_TOKENS: { id: string; words: string[]; why: string }[];

export const DOMAIN_LITERALS: { text: string; why: string }[];

export const DOMAIN_POSITIONAL: {
  texts: string[];
  name: RegExp;
  why: string;
}[];

export const ALLOWLIST: Record<string, string>;

export function wordsOf(text: string): string[];

export function countDomainVocabulary(
  fileName: string,
  text: string
): { dev: number; domain: number; tokens: Record<string, number> };

export function listScannedFiles(roots: string[]): string[];

export function scanAgnosticBackend(
  repo: string,
  roots?: string[]
): {
  files: number;
  perFile: Map<string, { dev: number; domain: number }>;
  tokens: Record<string, number>;
  allowlisted: Record<string, number>;
};
