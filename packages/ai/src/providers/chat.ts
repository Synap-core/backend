import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type ChatModelPurpose = 'chat' | 'intent' | 'planner' | 'responder';

interface ChatModelOptions {
  purpose?: ChatModelPurpose;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
}

type CoreModule = typeof import('@synap/core');

let coreModule: CoreModule | null = null;
let _config: CoreModule['config'] | null = null;

async function loadCore(): Promise<CoreModule> {
  if (!coreModule) {
    coreModule = await import('@synap/core');
    _config = coreModule.config;
  }
  return coreModule!;
}

function getConfig() {
  if (!_config) {
    throw new Error(
      'Config not loaded. Please ensure @synap/core is imported before using AI providers.'
    );
  }
  return _config!;
}

// Pre-load config in the background
loadCore().catch(() => {
  // Will be loaded on first access
});

const cachedModels = new Map<string, BaseChatModel>();

function cacheKey(provider: string, options: ChatModelOptions): string {
  return JSON.stringify({
    provider,
    purpose: options.purpose,
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    streaming: options.streaming ?? false,
  });
}

function resolveModelName(
  provider: 'anthropic' | 'openai',
  purpose: ChatModelPurpose | undefined,
  override: string | undefined
): string {
  if (override) {
    return override;
  }

  const { ai } = getConfig();
  if (provider === 'anthropic') {
    const baseModel = ai.anthropic.model;
    const overrides = ai.anthropic.models;
    if (!purpose) {
      return baseModel;
    }
    return overrides[purpose] ?? baseModel;
  }

  const baseModel = ai.openai.model;
  const overrides = ai.openai.models;
  if (!purpose) {
    return baseModel;
  }
  return overrides[purpose] ?? baseModel;
}

export function createChatModel(options: ChatModelOptions = {}): BaseChatModel {
  const { ai } = getConfig();
  const provider = ai.provider;
  const streaming = options.streaming ?? ai.streaming;
  const key = streaming ? null : cacheKey(provider, options);

  if (key && cachedModels.has(key)) {
    return cachedModels.get(key)!;
  }

  const modelName = resolveModelName(provider, options.purpose, options.model);

  let model: BaseChatModel;

  if (provider === 'anthropic') {
    if (!ai.anthropic.apiKey) {
      throw new Error('Anthropic provider selected but ANTHROPIC_API_KEY is not set.');
    }

    model = new ChatAnthropic({
      apiKey: ai.anthropic.apiKey,
      model: modelName,
      temperature: options.temperature ?? ai.anthropic.temperature,
      maxTokens: options.maxTokens ?? ai.anthropic.maxOutputTokens,
      streaming,
    });
  } else {
    if (!ai.openai.apiKey) {
      throw new Error('OpenAI provider selected but OPENAI_API_KEY is not set.');
    }

    model = new ChatOpenAI({
      apiKey: ai.openai.apiKey,
      model: modelName,
      temperature: options.temperature ?? ai.openai.temperature,
      maxTokens: options.maxTokens ?? ai.openai.maxTokens,
      streaming,
      configuration: ai.openai.baseUrl
        ? {
            baseURL: ai.openai.baseUrl,
          }
        : undefined,
    });
  }

  if (key) {
    cachedModels.set(key, model);
  }

  return model;
}


