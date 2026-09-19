/**
 * AI Capture Routing Types — Single Source of Truth
 *
 * These types define the advisory routing hints emitted by the Intelligence Service
 * during capture/structure operations. The backend's WorkspaceResolutionService is
 * the AUTHORITATIVE placer; these fields are advisory (the IS's catalog-wide guess).
 *
 * Consolidated from 5+ locations into this single canonical definition.
 * Phase 2 Week 2 — eliminates duplicate definitions.
 */

import { z } from "zod";

/**
 * Zod schemas for wire format validation.
 * These are the canonical schemas — all consumers import from here.
 */

export const AIWorkspaceRoutingHintSchema = z.object({
  targetWorkspaceId: z.string().uuid().nullable(),
  targetWorkspaceName: z.string().nullable(),
  targetWorkspaceReason: z.string().nullable(),
  targetWorkspaceConfidence: z.number().min(0).max(1).nullable(),
});

export const AIProjectRoutingHintSchema = z.object({
  targetProjectId: z.string().uuid().nullable(),
  targetProjectName: z.string().nullable(),
  targetProjectReason: z.string().nullable(),
  targetProjectConfidence: z.number().min(0).max(1).nullable(),
});

export const AIRoutingHintsSchema = z.object({
  workspace: AIWorkspaceRoutingHintSchema,
  project: AIProjectRoutingHintSchema,
});

// Type inference from schemas — ensures types stay in sync with schemas
export type AIWorkspaceRoutingHint = z.infer<
  typeof AIWorkspaceRoutingHintSchema
>;
export type AIProjectRoutingHint = z.infer<typeof AIProjectRoutingHintSchema>;
export type AIRoutingHints = z.infer<typeof AIRoutingHintsSchema>;

// Re-export individual field schemas for granular composition
export const targetWorkspaceIdSchema = z.string().uuid().nullable();
export const targetWorkspaceNameSchema = z.string().nullable();
export const targetWorkspaceReasonSchema = z.string().nullable();
export const targetWorkspaceConfidenceSchema = z
  .number()
  .min(0)
  .max(1)
  .nullable();

export const targetProjectIdSchema = z.string().uuid().nullable();
export const targetProjectNameSchema = z.string().nullable();
export const targetProjectReasonSchema = z.string().nullable();
export const targetProjectConfidenceSchema = z
  .number()
  .min(0)
  .max(1)
  .nullable();
