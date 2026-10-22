import { handleLogin, handleLogout, handleSession } from './handlers.js';

export function route(method, path, payload = {}) {
  if (method === 'POST' && path === '/login') return handleLogin(payload);
  if (method === 'POST' && path === '/logout') return handleLogout(payload.sessionId);
  if (method === 'GET' && path === '/session') return handleSession(payload.sessionId);
  return { status: 404, body: { error: 'not found' } };
}