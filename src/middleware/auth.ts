import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { verifyAccessToken, type AccessTokenPayload } from '../lib/auth.js';
import { config } from '../lib/config.js';

export type AuthContext = {
  Variables: {
    user: AccessTokenPayload;
  };
};

/**
 * Auth middleware: richiede un access token valido nel cookie httpOnly
 * o nell'header Authorization: Bearer <token>.
 */
export const requireAuth = createMiddleware<AuthContext>(async (c, next) => {
  // 1. Prova cookie httpOnly (preferito per browser)
  let token = getCookie(c, 'wl_access');
  // 2. Fallback header Authorization (API clients, mobile, ecc.)
  if (!token) {
    const auth = c.req.header('Authorization');
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  }
  if (!token) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const payload = verifyAccessToken(token);
  if (!payload) {
    return c.json({ error: 'invalid_token' }, 401);
  }
  c.set('user', payload);
  await next();
});

/**
 * Admin gate: solo per l'email ADMIN_EMAIL (definita in .env).
 * Va applicato DOPO requireAuth.
 */
export const requireAdmin = createMiddleware<AuthContext>(async (c, next) => {
  const user = c.get('user');
  const adminEmail = config.adminEmail; // già validato e lowercased al boot
  if (!user || !adminEmail || user.email.toLowerCase() !== adminEmail) {
    return c.json({ error: 'forbidden' }, 403);
  }
  await next();
});
