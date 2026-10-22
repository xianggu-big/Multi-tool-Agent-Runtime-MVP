export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function toHttpStatus(error) {
  if (error instanceof HttpError) return error.status;
  if (error instanceof AuthError) {
    if (error.code === 'INVALID_CREDENTIALS') return 401;
    if (error.code === 'ACCOUNT_LOCKED') return 429;
    return 400;
  }
  return 500;
}