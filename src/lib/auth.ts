import { hash as bcryptHash, compare as bcryptCompare } from 'bcrypt-ts';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';

// ═══ Password hashing (bcrypt, pure-JS — niente native bindings) ═══
// bcrypt è OWASP-approved per password storage.
// Cost factor 12 = ~250ms per hash su CPU moderna (bilanciato sicurezza/UX).
const BCRYPT_COST = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcryptHash(password, BCRYPT_COST);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await bcryptCompare(password, hash);
  } catch {
    return false;
  }
}

// ═══ JWT (access + refresh) ════════════════════════════════════════
// I secret sono già validati al boot da lib/config.ts (fail-fast).
import { config } from './config.js';
const ACCESS_SECRET = config.jwt.accessSecret;
const REFRESH_SECRET = config.jwt.refreshSecret;
const ACCESS_TTL = config.jwt.accessTtl as jwt.SignOptions['expiresIn'];
const REFRESH_TTL = config.jwt.refreshTtl as jwt.SignOptions['expiresIn'];

export interface AccessTokenPayload {
  sub: string;        // user id
  email: string;
  isPremium: boolean;
}

// Issuer/audience fissi: un token rubato da un altro servizio che usa lo
// stesso secret (misconfigurazione) non viene comunque accettato qui.
const JWT_ISSUER = 'wattlab-api';
const JWT_AUDIENCE = 'wattlab-app';

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, {
    expiresIn: ACCESS_TTL,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    jwtid: randomBytes(8).toString('hex'),
    algorithm: 'HS256',
  });
}

export function signRefreshToken(userId: string): { token: string; hash: string } {
  // Token opaco random (non JWT) — più sicuro, hash in DB
  const token = randomBytes(48).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, ACCESS_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ['HS256'], // blocca alg-confusion attack (es. "none")
    }) as AccessTokenPayload;
  } catch {
    return null;
  }
}

// ═══ Password policy ════════════════════════════════════════════════
// Blocklist delle password più comuni (top breach lists) + regole base.
const COMMON_PASSWORDS = new Set([
  'password','password1','password123','12345678','123456789','1234567890',
  'qwerty123','qwertyuiop','11111111','00000000','iloveyou','sunshine',
  'princess','football','baseball','welcome1','admin123','letmein1',
  'monkey123','dragon123','master123','superman','batman123','trustno1',
  'passw0rd','p4ssword','qwerty12','abc12345','password!','password1!',
]);

export function validatePasswordPolicy(password: string, email?: string): string | null {
  if (password.length < 8) return 'password_too_short';
  if (password.length > 256) return 'password_too_long';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'password_too_common';
  // No password = email o parte locale dell'email
  if (email) {
    const local = email.split('@')[0]?.toLowerCase();
    const p = password.toLowerCase();
    if (p === email.toLowerCase() || (local && local.length >= 4 && p.includes(local))) {
      return 'password_contains_email';
    }
  }
  // Almeno 2 classi di caratteri (lettere + numeri/simboli)
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(rx => rx.test(password)).length;
  if (classes < 2) return 'password_too_weak';
  return null; // ok
}

// Hash dummy per timing-attack mitigation: il login esegue SEMPRE un compare
// bcrypt anche se l'utente non esiste, così il tempo di risposta non rivela
// se un'email è registrata.
export const DUMMY_BCRYPT_HASH = '$2a$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Calcola scadenza refresh in date
export function refreshExpiresAt(): Date {
  const days = parseInt((REFRESH_TTL as string).replace('d', ''), 10) || 30;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
