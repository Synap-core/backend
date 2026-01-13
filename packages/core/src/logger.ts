/**
 * Production-Ready Logging with Pino
 *
 * Features:
 * - Structured JSON logging
 * - Correlation ID support
 * - Pretty printing in development
 * - Production transport support
 * - OpenTelemetry trace integration
 *
 * Environment Variables:
 * - LOG_LEVEL: Logging level (debug, info, warn, error) - default: info
 * - NODE_ENV: Environment (development, production, test)
 * - PINO_PRETTY: Enable pretty printing (default: true in dev, false in prod)
 * - LOG_TRANSPORT: Transport type (stdout, datadog, http) - default: stdout
 * - LOG_TRANSPORT_URL: URL for HTTP transport (e.g., Datadog intake)
 */

import pino, { type Bindings, type Logger, type LoggerOptions } from "pino";

const nodeEnv = process.env.NODE_ENV || "development";
const isDevelopment = nodeEnv === "development";
const isProduction = nodeEnv === "production";

// Determine if pretty printing should be enabled
const shouldPrettyPrint = process.env.PINO_PRETTY
  ? process.env.PINO_PRETTY === "true"
  : isDevelopment;

/**
 * Pino logger configuration
 */
const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  timestamp: pino.stdTimeFunctions.isoTime,

  // Remove default fields (pid, hostname) for cleaner logs
  // Add them back if needed via environment variable
  base: process.env.PINO_INCLUDE_BASE === "true" ? undefined : null,

  // Redact sensitive fields from logs
  redact: {
    paths: [
      "password",
      "token",
      "apiKey",
      "secret",
      "authorization",
      "cookie",
      "*.password",
      "*.token",
      "*.apiKey",
      "*.secret",
    ],
    censor: "[REDACTED]",
  },

  // Serialize errors properly
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },

  // Format options for better readability
  formatters: {
    level(label) {
      return { level: label };
    },
    // Add correlationId and traceId if available from OpenTelemetry context
    log(object) {
      // OpenTelemetry trace context integration
      // This will be automatically populated by OpenTelemetry if tracing is enabled
      const trace = (globalThis as any).trace;
      if (trace) {
        const span = trace.getActiveSpan?.();
        if (span) {
          const spanContext = span.spanContext();
          return {
            ...object,
            trace_id: spanContext.traceId,
            span_id: spanContext.spanId,
            trace_flags: spanContext.traceFlags,
          };
        }
      }
      return object;
    },
  },
};

/**
 * Create transport configuration based on environment
 */
function createTransport(): any {
  const transportType = process.env.LOG_TRANSPORT || "stdout";

  // Development: Pretty print to console
  if (shouldPrettyPrint) {
    return {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
        singleLine: false,
      },
    };
  }

  // Production: Different transports based on configuration
  switch (transportType) {
    case "datadog":
      // Datadog HTTP transport (requires pino-datadog)
      // Install: pnpm add pino-datadog
      return {
        target: "pino-datadog",
        options: {
          apiKey: process.env.DATADOG_API_KEY,
          service: process.env.OTEL_SERVICE_NAME || "synap-api",
          ddsource: "nodejs",
          ddtags: `env:${nodeEnv}`,
        },
      };

    case "http":
      // Generic HTTP transport for custom log aggregation
      // Install: pnpm add pino-http-send
      return {
        target: "pino-http-send",
        options: {
          url: process.env.LOG_TRANSPORT_URL,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env.LOG_TRANSPORT_AUTH_HEADER && {
              Authorization: process.env.LOG_TRANSPORT_AUTH_HEADER,
            }),
          },
        },
      };

    case "stdout":
    default:
      // Standard JSON output (default for production)
      return undefined;
  }
}

/**
 * Main logger instance
 */
const transport = createTransport();
export const logger: Logger = transport
  ? pino(options, pino.transport(transport))
  : pino(options);

/**
 * Create a child logger with additional bindings (context)
 *
 * @param bindings - Additional fields to include in all log messages
 * @returns Child logger instance
 *
 * @example
 * ```typescript
 * const apiLogger = createLogger({ module: 'api-server' });
 * apiLogger.info({ userId: '123' }, 'User logged in');
 * // Output: {"level":"info","time":"...","module":"api-server","userId":"123","msg":"User logged in"}
 * ```
 */
export const createLogger = (bindings: Bindings): Logger =>
  logger.child(bindings);

/**
 * Create a logger with correlation ID
 *
 * @param correlationId - Correlation ID to track request across services
 * @param additionalBindings - Additional fields to include
 * @returns Logger instance with correlation ID
 *
 * @example
 * ```typescript
 * const requestLogger = createLoggerWithCorrelation('req-123', { userId: '456' });
 * requestLogger.info('Processing request');
 * // Output: {"level":"info","correlationId":"req-123","userId":"456","msg":"Processing request"}
 * ```
 */
export function createLoggerWithCorrelation(
  correlationId: string,
  additionalBindings?: Bindings,
): Logger {
  return logger.child({
    correlationId,
    ...additionalBindings,
  });
}
