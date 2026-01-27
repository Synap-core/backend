/**
 * Centralized Configuration Management
 *
 * Provides type-safe, validated configuration from environment variables.
 * All packages should use this instead of directly accessing process.env.
 *
 * @example
 * ```typescript
 * import { config } from '@synap-core/core';
 *
 * const dbUrl = config.database.url;
 * const storageProvider = config.storage.provider;
 * ```
 */

import { z } from "zod";
import { createLogger } from "./logger.js";

const configLogger = createLogger({ module: "config" });

// ============================================================================
// CONFIGURATION SCHEMAS
// ============================================================================

const DatabaseConfigSchema = z.object({
  dialect: z.enum(["postgres"]).default("postgres"),
  url: z
    .string()
    .min(1, {
      message: "DATABASE_URL is required (PostgreSQL connection string)",
    }),
});

const StorageConfigSchema = z.object({
  provider: z.enum(["r2", "minio"]).default("minio"), // Default to MinIO, auto-detect R2 if credentials present
  // R2 config
  r2AccountId: z.string().optional(),
  r2AccessKeyId: z.string().optional(),
  r2SecretAccessKey: z.string().optional(),
  r2BucketName: z.string().default("synap-storage"),
  r2PublicUrl: z.string().optional(),
  // MinIO config
  minioEndpoint: z.string().default("http://localhost:9000"),
  minioAccessKeyId: z.string().default("minioadmin"),
  minioSecretAccessKey: z.string().default("minioadmin"),
  minioBucketName: z.string().default("synap-storage"),
  minioPublicUrl: z.string().optional(),
});

const AIModelOverrideSchema = z
  .object({
    chat: z.string().optional(),
    intent: z.string().optional(),
    planner: z.string().optional(),
    responder: z.string().optional(),
  })
  .default({});

const AIAnthropicConfigSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().default("claude-3-haiku-20240307"),
  maxOutputTokens: z.coerce.number().default(2048),
  temperature: z.coerce.number().min(0).max(2).default(0.7),
  models: AIModelOverrideSchema,
});

const AIOpenAIConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().default("gpt-4o-mini"),
  maxTokens: z.coerce.number().default(2048),
  temperature: z.coerce.number().min(0).max(2).default(0.7),
  models: AIModelOverrideSchema,
});

const AIConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  streaming: z.coerce.boolean().default(false),
  anthropic: AIAnthropicConfigSchema.default({}),
  openai: AIOpenAIConfigSchema.default({}),
  embeddings: z
    .object({
      provider: z.enum(["openai", "deterministic"]).default("openai"),
      model: z.string().default("text-embedding-3-small"),
    })
    .default({}),
});

const AuthConfigSchema = z.object({
  // Ory Stack
  kratosPublicUrl: z.string().optional(),
  kratosAdminUrl: z.string().optional(),
  hydraPublicUrl: z.string().optional(),
  hydraAdminUrl: z.string().optional(),
  hydraSecretsSystem: z.string().optional(),
  // OAuth Providers (optional)
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  githubClientId: z.string().optional(),
  githubClientSecret: z.string().optional(),
});

const ServerConfigSchema = z.object({
  port: z.coerce.number().default(3000),
  nodeEnv: z.enum(["development", "production", "test"]).default("development"),
  corsOrigins: z.string().optional(),
  logLevel: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

const InngestConfigSchema = z.object({
  eventKey: z.string().optional(),
  signingKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

const Mem0ConfigSchema = z.object({
  apiUrl: z.string().optional(),
  apiKey: z.string().optional(),
  dbPassword: z.string().optional(),
  logLevel: z.string().optional(),
});

const ConfigSchema = z.object({
  database: DatabaseConfigSchema,
  storage: StorageConfigSchema,
  ai: AIConfigSchema,
  auth: AuthConfigSchema,
  server: ServerConfigSchema,
  inngest: InngestConfigSchema,
  mem0: Mem0ConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
// StorageConfig with provider always set (after auto-detection)
export type StorageConfig = Omit<
  z.infer<typeof StorageConfigSchema>,
  "provider"
> & {
  provider: "r2" | "minio";
};
export type AIConfig = z.infer<typeof AIConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type InngestConfig = z.infer<typeof InngestConfigSchema>;
export type Mem0Config = z.infer<typeof Mem0ConfigSchema>;

// ============================================================================
// CONFIGURATION LOADER
// ============================================================================

/**
 * Load and validate configuration from environment variables
 *
 * @returns Validated configuration object
 * @throws Error if required configuration is invalid
 */
function loadConfig(): Config {
  try {
    // Auto-detect storage provider if not explicitly set
    const explicitProvider = process.env.STORAGE_PROVIDER as
      | "r2"
      | "minio"
      | undefined;
    const hasR2Credentials =
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY;

    // If provider not set, auto-detect: use R2 if credentials exist, otherwise MinIO
    const detectedProvider: "r2" | "minio" =
      explicitProvider || (hasR2Credentials ? "r2" : "minio");

    const rawConfig = {
      database: {
        dialect: "postgres" as const,
        url: process.env.DATABASE_URL,
      },
      storage: {
        provider: detectedProvider,
        r2AccountId: process.env.R2_ACCOUNT_ID,
        r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
        r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        r2BucketName: process.env.R2_BUCKET_NAME,
        r2PublicUrl: process.env.R2_PUBLIC_URL,
        minioEndpoint: process.env.MINIO_ENDPOINT,
        minioAccessKeyId: process.env.MINIO_ACCESS_KEY_ID,
        minioSecretAccessKey: process.env.MINIO_SECRET_ACCESS_KEY,
        minioBucketName: process.env.MINIO_BUCKET_NAME,
        minioPublicUrl: process.env.MINIO_PUBLIC_URL,
      },
      ai: {
        provider: process.env.AI_PROVIDER,
        streaming: process.env.AI_STREAMING,
        anthropic: {
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: process.env.ANTHROPIC_MODEL,
          maxOutputTokens: process.env.ANTHROPIC_MAX_TOKENS,
          temperature: process.env.ANTHROPIC_TEMPERATURE,
          models: {
            chat: process.env.ANTHROPIC_CHAT_MODEL,
            intent: process.env.ANTHROPIC_INTENT_MODEL,
            planner: process.env.ANTHROPIC_PLANNER_MODEL,
            responder: process.env.ANTHROPIC_RESPONDER_MODEL,
          },
        },
        openai: {
          apiKey: process.env.OPENAI_API_KEY,
          baseUrl: process.env.OPENAI_BASE_URL,
          model: process.env.OPENAI_MODEL,
          maxTokens: process.env.OPENAI_MAX_TOKENS,
          temperature: process.env.OPENAI_TEMPERATURE,
          models: {
            chat: process.env.OPENAI_CHAT_MODEL,
            intent: process.env.OPENAI_INTENT_MODEL,
            planner: process.env.OPENAI_PLANNER_MODEL,
            responder: process.env.OPENAI_RESPONDER_MODEL,
          },
        },
        embeddings: {
          provider: process.env.EMBEDDING_PROVIDER,
          model:
            process.env.EMBEDDING_MODEL ?? process.env.OPENAI_EMBEDDING_MODEL,
        },
      },
      auth: {
        // Ory Stack
        kratosPublicUrl: process.env.KRATOS_PUBLIC_URL,
        kratosAdminUrl: process.env.KRATOS_ADMIN_URL,
        hydraPublicUrl: process.env.HYDRA_PUBLIC_URL,
        hydraAdminUrl: process.env.HYDRA_ADMIN_URL,
        hydraSecretsSystem: process.env.ORY_HYDRA_SECRETS_SYSTEM,
        // OAuth Providers
        googleClientId: process.env.GOOGLE_CLIENT_ID,
        googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
        githubClientId: process.env.GITHUB_CLIENT_ID,
        githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
      },
      server: {
        port: process.env.PORT,
        nodeEnv: process.env.NODE_ENV,
        corsOrigins: process.env.CORS_ORIGINS,
        logLevel: process.env.LOG_LEVEL,
      },
      inngest: {
        eventKey: process.env.INNGEST_EVENT_KEY,
        signingKey: process.env.INNGEST_SIGNING_KEY,
        baseUrl: process.env.INNGEST_BASE_URL,
      },
      mem0: {
        apiUrl: process.env.MEM0_API_URL,
        apiKey: process.env.MEM0_API_KEY,
        dbPassword: process.env.MEM0_DB_PASSWORD,
        logLevel: process.env.MEM0_LOG_LEVEL,
      },
    };

    const parsedConfig = ConfigSchema.parse(rawConfig);

    // Override provider with auto-detected value if not explicitly set
    // This ensures we use MinIO by default if R2 credentials are missing
    const config: Config = {
      ...parsedConfig,
      storage: {
        ...parsedConfig.storage,
        provider: explicitProvider || detectedProvider, // Use explicit or auto-detected
      },
    };

    // Log configuration status (without secrets)
    configLogger.info(
      {
        database: { connected: !!config.database.url },
        storage: {
          provider: config.storage.provider,
          autoDetected: !explicitProvider,
        },
        server: { port: config.server.port, env: config.server.nodeEnv },
      },
      "Configuration loaded"
    );

    return config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      configLogger.error({ issues }, "Configuration validation failed");
      throw new Error(
        `Invalid configuration: ${issues.map((i) => `${i.path}: ${i.message}`).join(", ")}`
      );
    }
    throw error;
  }
}

/**
 * Global configuration instance
 *
 * Loaded once at module initialization.
 * All packages should import this instead of accessing process.env directly.
 *
 * @example
 * ```typescript
 * import { config } from '@synap-core/core';
 *
 * const dbUrl = config.database.url;
 * const storageProvider = config.storage.provider;
 * ```
 */
export const config = loadConfig();

// Make config available globally for lazy access (avoids circular dependencies)
if (typeof globalThis !== "undefined") {
  (globalThis as any).__synap_core_module = { config };
}

/**
 * Validate required configuration for specific features
 *
 * @param feature - Feature name (e.g., 'r2', 'ory', 'ai', 'postgres')
 * @throws Error if required configuration is missing
 *
 * @example
 * ```typescript
 * validateConfig('r2');
 * // Throws if R2 credentials are missing
 * ```
 */
export function validateConfig(
  feature: "r2" | "ory" | "ai" | "postgres" | "mem0"
): void {
  switch (feature) {
    case "r2":
      if (
        !config.storage.r2AccountId ||
        !config.storage.r2AccessKeyId ||
        !config.storage.r2SecretAccessKey
      ) {
        throw new Error(
          "R2 storage requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY environment variables"
        );
      }
      break;

    case "ory":
      if (!config.auth.kratosPublicUrl || !config.auth.hydraPublicUrl) {
        throw new Error(
          "Ory Stack requires KRATOS_PUBLIC_URL and HYDRA_PUBLIC_URL environment variables"
        );
      }
      if (!config.auth.hydraSecretsSystem) {
        throw new Error(
          "Ory Hydra requires ORY_HYDRA_SECRETS_SYSTEM environment variable"
        );
      }
      break;

    case "ai": {
      const { provider, anthropic, openai, embeddings } = config.ai;

      if (provider === "anthropic" && !anthropic.apiKey) {
        throw new Error(
          "Anthropic provider requires ANTHROPIC_API_KEY environment variable"
        );
      }

      if (provider === "openai" && !openai.apiKey) {
        throw new Error(
          "OpenAI provider requires OPENAI_API_KEY environment variable"
        );
      }

      if (embeddings.provider === "openai" && !openai.apiKey) {
        throw new Error(
          "OpenAI embeddings require OPENAI_API_KEY environment variable"
        );
      }

      break;
    }

    case "postgres":
      if (!config.database.url) {
        throw new Error(
          "PostgreSQL requires DATABASE_URL environment variable"
        );
      }
      break;

    case "mem0":
      if (!config.mem0.apiKey) {
        throw new Error("Mem0 requires MEM0_API_KEY environment variable");
      }
      if (!config.mem0.apiUrl) {
        throw new Error("Mem0 requires MEM0_API_URL environment variable");
      }
      break;
  }
}
