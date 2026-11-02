import 'server-only';

import { pino, type LoggerOptions } from 'pino';

type SerializedError = {
  type: string;
  message: string;
  stack?: string;
  code?: unknown;
  cause?: SerializedError;
  errors?: SerializedError[];
};

// pg attaches its client, password included, to errors, and pino's default serializer copies every
// enumerable property. Only the fields named here reach the logs.
function serializeError(err: unknown): SerializedError {
  if (!(err instanceof Error)) return { type: typeof err, message: String(err) };
  const { code, errors } = err as Error & { code?: unknown; errors?: unknown };
  return {
    type: err.name,
    message: err.message,
    stack: err.stack,
    code,
    // Drizzle wraps driver errors as "Failed query: ...", so the actual reason is in the cause.
    ...(err.cause !== undefined && { cause: serializeError(err.cause) }),
    ...(Array.isArray(errors) && { errors: errors.map(serializeError) }),
  };
}

export const loggerOptions: LoggerOptions = {
  redact: ['authorization', 'cookie', '*.apiKey', '*.password'],
  serializers: { err: serializeError },
};

export const logger = pino(loggerOptions);
