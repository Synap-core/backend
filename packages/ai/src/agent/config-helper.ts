/**
 * Config Helper for LangGraph Nodes
 * 
 * Provides lazy-loaded access to AI configuration for Vercel AI SDK usage.
 * This ensures config is loaded only when needed, avoiding circular dependencies.
 */

function getConfig() {
  // Try globalThis first (set by @synap/core)
  try {
    const globalModule = (globalThis as any).__synap_core_module;
    if (globalModule?.config) {
      return globalModule.config;
    }
  } catch {
    // globalThis not available or config not set
  }

  // If globalThis doesn't have it, we need to import it
  // This should only happen if @synap/core wasn't imported first
  throw new Error(
    'AI config not loaded. Please ensure @synap/core is imported before using AI features.'
  );
}

/**
 * Get the Anthropic model name for a specific purpose
 */
export function getAnthropicModel(purpose: 'intent' | 'planner' | 'responder' | 'chat'): string {
  const config = getConfig();
  const ai = config.ai;

  if (ai.provider !== 'anthropic') {
    throw new Error(`AI provider is set to '${ai.provider}', but Anthropic model was requested.`);
  }

  if (!ai.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set.');
  }

  // Check for purpose-specific model override
  const purposeModel = ai.anthropic.models[purpose];
  if (purposeModel) {
    return purposeModel;
  }

  // Fall back to default model
  return ai.anthropic.model;
}

/**
 * Get Anthropic API key
 */
export function getAnthropicApiKey(): string {
  const config = getConfig();
  const ai = config.ai;

  if (ai.provider !== 'anthropic') {
    throw new Error(`AI provider is set to '${ai.provider}', but Anthropic API key was requested.`);
  }

  if (!ai.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set.');
  }

  return ai.anthropic.apiKey;
}

