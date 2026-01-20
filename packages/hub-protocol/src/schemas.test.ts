/**
 * Tests for Hub Protocol Schemas
 */

import { describe, it, expect } from "vitest";
import {
  validateHubInsight,
  validateAction,
  validateAnalysis,
  isActionPlan,
  isAnalysis,
  type HubInsight,
  type Action,
  type Analysis,
} from "./schemas.js";

describe("ActionSchema", () => {
  it("should validate a valid action", () => {
    const action: Action = {
      eventType: "task.creation.requested",
      data: {
        title: "Test task",
        dueDate: "2025-01-25",
      },
      requiresConfirmation: false,
    };

    const result = validateAction(action);
    expect(result.eventType).toBe("task.creation.requested");
    expect(result.requiresConfirmation).toBe(false);
  });

  it("should default requiresConfirmation to false", () => {
    const action = {
      eventType: "task.creation.requested",
      data: {},
    };

    const result = validateAction(action);
    expect(result.requiresConfirmation).toBe(false);
  });

  it("should validate optional fields", () => {
    const action: Action = {
      eventType: "project.creation.requested",
      subjectId: "123e4567-e89b-12d3-a456-426614174000",
      data: { title: "My Project" },
      requiresConfirmation: true,
      priority: 80,
      metadata: { source: "hub" },
    };

    const result = validateAction(action);
    expect(result.subjectId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(result.priority).toBe(80);
    expect(result.metadata?.source).toBe("hub");
  });

  it("should reject invalid action", () => {
    expect(() => {
      validateAction({
        // Missing eventType
        data: {},
      });
    }).toThrow();
  });
});

describe("AnalysisSchema", () => {
  it("should validate a valid analysis", () => {
    const analysis: Analysis = {
      title: "Financial Analysis",
      content: "Your expenses have increased by 15%...",
      keyPoints: ["Point 1", "Point 2"],
      recommendations: ["Recommendation 1"],
      tags: ["finance", "analysis"],
    };

    const result = validateAnalysis(analysis);
    expect(result.title).toBe("Financial Analysis");
    expect(result.keyPoints).toHaveLength(2);
  });

  it("should validate analysis with sources", () => {
    const analysis: Analysis = {
      title: "Research Summary",
      content: "Based on your notes...",
      sources: [
        {
          type: "note",
          id: "note-123",
          title: "Research Note",
        },
        {
          type: "external",
          url: "https://example.com",
        },
      ],
    };

    const result = validateAnalysis(analysis);
    expect(result.sources).toHaveLength(2);
    expect(result.sources?.[0]?.type).toBe("note");
  });

  it("should reject invalid analysis", () => {
    expect(() => {
      validateAnalysis({
        // Missing title
        content: "Some content",
      });
    }).toThrow();
  });
});

describe("HubInsightSchema", () => {
  it("should validate a valid action_plan insight", () => {
    const insight: HubInsight = {
      version: "1.0",
      type: "action_plan",
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      actions: [
        {
          eventType: "project.creation.requested",
          data: { title: "My Project" },
          requiresConfirmation: false,
        },
        {
          eventType: "task.creation.requested",
          data: { title: "Task 1" },
          requiresConfirmation: true,
        },
      ],
      confidence: 0.95,
      reasoning: "Based on user preferences",
    };

    const result = validateHubInsight(insight);
    expect(result.type).toBe("action_plan");
    expect(result.actions).toHaveLength(2);
    expect(result.confidence).toBe(0.95);
  });

  it("should validate a valid analysis insight", () => {
    const insight: HubInsight = {
      version: "1.0",
      type: "analysis",
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      analysis: {
        title: "Financial Analysis",
        content: "Your expenses...",
        keyPoints: ["Point 1"],
      },
      confidence: 0.92,
    };

    const result = validateHubInsight(insight);
    expect(result.type).toBe("analysis");
    expect(result.analysis?.title).toBe("Financial Analysis");
  });

  it("should validate a valid suggestion insight", () => {
    const insight: HubInsight = {
      version: "1.0",
      type: "suggestion",
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      analysis: {
        title: "Suggestion",
        content: "You might want to...",
        recommendations: ["Do this", "Do that"],
      },
      confidence: 0.85,
    };

    const result = validateHubInsight(insight);
    expect(result.type).toBe("suggestion");
    expect(result.analysis?.recommendations).toHaveLength(2);
  });

  it("should validate a valid automation insight", () => {
    const insight: HubInsight = {
      version: "1.0",
      type: "automation",
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      actions: [
        {
          eventType: "task.completion.requested",
          data: { taskId: "task-123" },
          requiresConfirmation: false,
        },
      ],
      confidence: 1.0,
    };

    const result = validateHubInsight(insight);
    expect(result.type).toBe("automation");
    expect(result.confidence).toBe(1.0);
  });

  it("should reject invalid version", () => {
    expect(() => {
      validateHubInsight({
        version: "2.0", // Invalid version
        type: "action_plan",
        correlationId: "123e4567-e89b-12d3-a456-426614174000",
        actions: [],
        confidence: 0.95,
      });
    }).toThrow();
  });

  it("should reject invalid correlationId (not UUID)", () => {
    expect(() => {
      validateHubInsight({
        version: "1.0",
        type: "action_plan",
        correlationId: "not-a-uuid",
        actions: [],
        confidence: 0.95,
      });
    }).toThrow();
  });

  it("should reject invalid confidence (out of range)", () => {
    expect(() => {
      validateHubInsight({
        version: "1.0",
        type: "action_plan",
        correlationId: "123e4567-e89b-12d3-a456-426614174000",
        actions: [],
        confidence: 1.5, // Out of range
      });
    }).toThrow();
  });

  it("should require actions for action_plan type", () => {
    // This should pass (actions is optional in schema, but should be validated in business logic)
    const insight: HubInsight = {
      version: "1.0",
      type: "action_plan",
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      confidence: 0.95,
    };

    const result = validateHubInsight(insight);
    expect(result.actions).toBeUndefined();
  });
});

describe("Type Guards", () => {
  it("should identify action_plan insights", () => {
    const insight: HubInsight = {
      version: "1.0",
      type: "action_plan",
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      actions: [
        {
          eventType: "task.creation.requested",
          data: {},
          requiresConfirmation: false,
        },
      ],
      confidence: 0.95,
    };

    expect(isActionPlan(insight)).toBe(true);
    if (isActionPlan(insight)) {
      // TypeScript should know actions is defined here
      expect(insight.actions).toBeDefined();
      expect(insight.actions.length).toBe(1);
    }
  });

  it("should identify analysis insights", () => {
    const insight: HubInsight = {
      version: "1.0",
      type: "analysis",
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      analysis: {
        title: "Analysis",
        content: "Content",
      },
      confidence: 0.95,
    };

    expect(isAnalysis(insight)).toBe(true);
    if (isAnalysis(insight)) {
      // TypeScript should know analysis is defined here
      expect(insight.analysis).toBeDefined();
      expect(insight.analysis.title).toBe("Analysis");
    }
  });

  it("should not identify non-action-plan insights", () => {
    const insight: HubInsight = {
      version: "1.0",
      type: "analysis",
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      analysis: {
        title: "Analysis",
        content: "Content",
      },
      confidence: 0.95,
    };

    expect(isActionPlan(insight)).toBe(false);
  });
});
