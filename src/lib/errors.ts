export type AppErrorCode =
  | 'rate_limited'
  | 'budget_exhausted'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'llm_error'
  | 'db_error'
  | 'internal';

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  rate_limited: 429,
  budget_exhausted: 503,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation: 400,
  llm_error: 502,
  db_error: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly safeMessage: string;

  constructor(code: AppErrorCode, safeMessage: string, options?: { cause?: unknown }) {
    super(safeMessage, options);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.safeMessage = safeMessage;
  }
}
