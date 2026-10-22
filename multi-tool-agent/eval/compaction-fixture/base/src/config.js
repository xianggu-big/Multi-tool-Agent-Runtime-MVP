export const AUTH_TIMEOUT_MS = 1500;
export const SESSION_COOKIE = 'acme_sid';
export const MAX_LOGIN_ATTEMPTS = 5;
export const AUDIT_RETENTION_DAYS = 30;
export const LEGACY_AUTH_MODE = 'cookie-v1';
export const TOKEN_ISSUER = 'acme-auth';
export const TOKEN_TTL_SECONDS = 900;

// 认证链路共享的配置。事故复盘时这些常量是定位超时/会话问题的第一站。