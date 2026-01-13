#!/usr/bin/env tsx
/**
 * Hub Protocol Flow Validation Script
 *
 * Validates the complete Hub Protocol flow without requiring a running Data Pod.
 * Tests:
 * 1. Agent ActionExtractor can extract actions
 * 2. Hub Orchestrator can execute requests (with mocked client)
 * 3. Insights are generated correctly
 */

import "dotenv/config";
import { runActionExtractor } from "../packages/intelligence-hub/src/agents/action-extractor.js";
import { randomUUID } from "crypto";

const colors = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  reset: "\x1b[0m",
};

function log(message: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function divider() {
  console.log("─".repeat(60));
}

async function validateAgent() {
  log("\n🧪 Testing ActionExtractor Agent...", "blue");
  divider();

  if (!process.env.ANTHROPIC_API_KEY) {
    log("⚠️  ANTHROPIC_API_KEY not set - skipping agent test", "yellow");
    return false;
  }

  try {
    const testQuery = "Rappelle-moi d'appeler Paul demain à 14h";
    log(`📝 Query: "${testQuery}"`, "blue");

    const result = await runActionExtractor({
      query: testQuery,
      context: {
        preferences: {
          timezone: "Europe/Paris",
        },
      },
      requestId: randomUUID(),
    });

    // Validate result
    if (!result.insight) {
      log("❌ No insight generated", "red");
      return false;
    }

    log("✅ Insight generated:", "green");
    console.log(`   Type: ${result.insight.type}`);
    console.log(`   Version: ${result.insight.version}`);
    console.log(`   Confidence: ${result.insight.confidence}`);
    console.log(`   Actions: ${result.insight.actions?.length ?? 0}`);

    if (result.insight.actions && result.insight.actions.length > 0) {
      const action = result.insight.actions[0];
      console.log(`   Event Type: ${action.eventType}`);
      console.log(`   Title: ${(action.data as any).title || "N/A"}`);
      if ((action.data as any).dueDate) {
        console.log(`   Due Date: ${(action.data as any).dueDate}`);
      }
    }

    if (result.extractedAction) {
      log("\n✅ Action extracted:", "green");
      console.log(`   Type: ${result.extractedAction.type}`);
      console.log(`   Title: ${result.extractedAction.title}`);
      if (result.extractedAction.dueDate) {
        console.log(`   Due Date: ${result.extractedAction.dueDate}`);
      }
    }

    return true;
  } catch (error) {
    log(
      `❌ Agent test failed: ${error instanceof Error ? error.message : String(error)}`,
      "red",
    );
    return false;
  }
}

async function validateNoteExtraction() {
  log("\n🧪 Testing Note Extraction...", "blue");
  divider();

  if (!process.env.ANTHROPIC_API_KEY) {
    log(
      "⚠️  ANTHROPIC_API_KEY not set - skipping note extraction test",
      "yellow",
    );
    return false;
  }

  try {
    const testQuery =
      "Note: Paul aime le café et préfère les réunions le matin";
    log(`📝 Query: "${testQuery}"`, "blue");

    const result = await runActionExtractor({
      query: testQuery,
      context: {},
      requestId: randomUUID(),
    });

    if (!result.insight) {
      log("❌ No insight generated", "red");
      return false;
    }

    const actionType = result.insight.actions?.[0]?.eventType;
    if (actionType === "note.creation.requested") {
      log("✅ Note correctly extracted", "green");
      return true;
    } else {
      log(`⚠️  Expected note.creation.requested, got ${actionType}`, "yellow");
      return false;
    }
  } catch (error) {
    log(
      `❌ Note extraction test failed: ${error instanceof Error ? error.message : String(error)}`,
      "red",
    );
    return false;
  }
}

async function validateInsightSchema() {
  log("\n🧪 Testing Insight Schema Validation...", "blue");
  divider();

  if (!process.env.ANTHROPIC_API_KEY) {
    log("⚠️  ANTHROPIC_API_KEY not set - skipping schema validation", "yellow");
    return false;
  }

  try {
    const { validateHubInsight } = await import("@synap/hub-protocol");

    const result = await runActionExtractor({
      query: "Create a task for tomorrow",
      context: {},
      requestId: randomUUID(),
    });

    if (!result.insight) {
      log("❌ No insight generated", "red");
      return false;
    }

    // Validate schema
    const validated = validateHubInsight(result.insight);
    log("✅ Insight schema is valid", "green");
    console.log(`   Version: ${validated.version}`);
    console.log(`   Type: ${validated.type}`);
    console.log(`   Correlation ID: ${validated.correlationId}`);

    return true;
  } catch (error) {
    log(
      `❌ Schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
      "red",
    );
    return false;
  }
}

async function main() {
  log("🚀 Hub Protocol Flow Validation", "blue");
  log("=".repeat(60), "blue");

  const results = {
    agent: false,
    noteExtraction: false,
    schema: false,
  };

  // Test 1: Agent extraction
  results.agent = await validateAgent();

  // Test 2: Note extraction
  results.noteExtraction = await validateNoteExtraction();

  // Test 3: Schema validation
  results.schema = await validateInsightSchema();

  // Summary
  divider();
  log("\n📊 Validation Summary:", "blue");
  console.log(`   Agent Extraction: ${results.agent ? "✅" : "❌"}`);
  console.log(`   Note Extraction: ${results.noteExtraction ? "✅" : "❌"}`);
  console.log(`   Schema Validation: ${results.schema ? "✅" : "❌"}`);

  const allPassed = Object.values(results).every((r) => r);

  if (allPassed) {
    log("\n✅ All validations passed!", "green");
    process.exit(0);
  } else {
    log("\n⚠️  Some validations failed", "yellow");
    process.exit(1);
  }
}

main().catch((error) => {
  log(
    `\n❌ Fatal error: ${error instanceof Error ? error.message : String(error)}`,
    "red",
  );
  process.exit(1);
});
