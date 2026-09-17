/**
 * MCP Prompts
 *
 * Exposes prompt templates for AI agents
 */

import type { Prompt } from "@modelcontextprotocol/sdk/types.js";

export const prompts = {
  /**
   * List all available prompts
   */
  async list(): Promise<Prompt[]> {
    return [
      {
        name: "synap_behavior",
        description:
          "Synap-first operating mode. Request this prompt at the start of any session to establish the correct behavioral contract: orient first, search before answering, save proactively, link entities, persist facts to memory.",
        arguments: [],
      },
      {
        name: "create_project_structure",
        description:
          "From user intent: orient, ask, extend-first, then project/domains/sessions. Load system/synap/from-intent. Domain install is agent-os, not this prompt.",
        arguments: [
          {
            name: "projectName",
            description: "Name of the engagement / project lens",
            required: true,
          },
          {
            name: "description",
            description: "What this engagement is for",
            required: false,
          },
        ],
      },
      {
        name: "analyze_entity_relationships",
        description: "Template for analyzing relationships between entities",
        arguments: [
          {
            name: "entityId",
            description: "ID of the entity to analyze",
            required: true,
          },
        ],
      },
    ];
  },

  /**
   * Get a prompt template
   */
  async get(
    name: string,
    args?: Record<string, unknown>
  ): Promise<{
    messages: Array<{
      role: "user" | "assistant" | "system";
      content: {
        type: "text";
        text: string;
      };
    }>;
  }> {
    switch (name) {
      case "synap_behavior":
        return {
          messages: [
            {
              role: "system",
              content: {
                type: "text",
                text: `You are connected to Synap — the user's sovereign knowledge infrastructure. All their projects, tasks, contacts, decisions, notes, and memory live here. Operate in Synap-first mode:

1. ORIENT FIRST: Call synap_orient at the start of every session — it returns a light lens map. Two composable lenses: a PROJECT is a company/initiative (what you organize by); a WORKSPACE is an operational domain (Foundation, CRM, Marketing, Finance…) where data lives. Reads default pod-wide; writes default to a workspace. When the user has projects, orient around them; if they have none (a fresh single-domain pod), don't push project-framing. Never assume what exists. If a project clearly lacks a domain it needs — and the user hasn't declined it — offer once, at the end, to set it up.

2. ASK BEFORE ANSWERING: Before answering any question about the user's projects, tasks, people, decisions, or data — call synap_ask (the one recall door; it routes across entities, runbooks, and remembered facts). Do not answer from your own training when Synap has the authoritative answer.

3. SAVE PROACTIVELY: When the user shares a task, decision, meeting outcome, contact, or any durable information — save it without waiting to be asked. Use synap_capture for almost everything (it structures free text into the right entities); reach for synap_create_entity only when you already know the exact type + fields, or synap_create_document for long-form notes.

4. LINK EVERYTHING: An isolated entity has no value. Link every new entity to at least one related entity with synap_link_entities. Tasks belong to projects. Notes belong to people or meetings. Decisions belong to projects.

5. PERSIST TO MEMORY: Facts about the user (preferences, team, working style, recurring context) belong in synap_remember_fact — not in your conversation context. Memory survives sessions; context does not.

Synap is the ground truth. Prefer it over your own knowledge for anything about the user's world.`,
              },
            },
          ],
        };

      case "create_project_structure":
        return {
          messages: [
            {
              role: "system",
              content: {
                type: "text",
                text: `You are turning a user INTENT into Synap structure. Load synap_load_skill({ref:"system/synap/from-intent"}) and follow it.

1. Orient + list_profiles. If startHere.pendingReview.count > 0, raise the queue first.
2. REUSE. If orient.projects already names this company/commitment, that is the project — ask to reuse; do not mint a twin.
3. Ask only what is still unknown. EXTEND FIRST (system/synap-schema/extend-first). Hats on ANY kind.
4. First user-facing reply: short reuse/extend map + ONE next write to confirm. Never a 7-step plan. Never onboard an empty workspace just because it is empty. Never invent CLI.
5. Missing DOMAIN only → agent-os. proposed is success.`,
              },
            },
            {
              role: "user",
              content: {
                type: "text",
                text: `User intent: ${args?.projectName || "Untitled"}\n\n${args?.description || ""}\n\nFollow from-intent: orient, ask what is still unknown (commitment / domains / thing vs hat vs relationship-with-a-life), propose extend-first structure, confirm, then write.`,
              },
            },
          ],
        };

      case "analyze_entity_relationships":
        return {
          messages: [
            {
              role: "system",
              content: {
                type: "text",
                text: "You are a data analysis assistant. Analyze entity relationships and provide insights.",
              },
            },
            {
              role: "user",
              content: {
                type: "text",
                text: `Analyze relationships for entity: ${args?.entityId || "unknown"}\n\nPlease provide:\n1. Direct relationships\n2. Indirect relationships (through other entities)\n3. Relationship patterns and insights`,
              },
            },
          ],
        };

      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  },
};
