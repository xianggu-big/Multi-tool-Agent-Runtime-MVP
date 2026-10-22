import { AUDIT_RETENTION_DAYS } from '../config.js';

const entries = [];

export function recordAudit(event) {
  entries.push({ ...event, at: event.at ?? Date.now() });
  const cutoff = Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  while (entries.length && entries[0].at < cutoff) entries.shift();
}

export function listAudit() {
  return [...entries];
}