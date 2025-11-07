import pino, { type Bindings, type Logger, type LoggerOptions } from 'pino';

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: undefined,
};

export const logger: Logger = pino(options);

export const createLogger = (bindings: Bindings): Logger => logger.child(bindings);



