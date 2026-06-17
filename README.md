# WattLab Server

Backend API per WattLab — **Hono + PostgreSQL + Drizzle ORM**, production-ready.

| Documento | Per cosa |
|---|---|
| **[DEPLOY.md](./DEPLOY.md)** | Mettere l'app online (dominio + VPS + HTTPS + backup) |
| **[QUICKSTART.md](./QUICKSTART.md)** | Sviluppo locale sul PC |

## Stack

- **Runtime**: Node.js 20+ · **Framework**: [Hono](https://hono.dev)
- **DB**: PostgreSQL 16 via [Drizzle ORM](https://orm.drizzle.team)
- **Auth**: JWT (access 15min + refresh 30g con rotation) · bcrypt cost 12
- **Infra production**: Docker Compose (Caddy + API + Postgres) su VPS
- **HTTPS**: automatico via Caddy/Let's Encrypt

## Architettura

Sito e API sullo **stesso dominio** (same-origin):

```
https://tuodominio.com      → index.html (statico, servito da Caddy)
https://tuodominio.com/api  → API Node (proxy via Caddy)
```

Niente CORS in produzione, cookie httpOnly SameSite=Lax, CSRF-safe by design.

## Endpoints (tutti sotto `/api`)

### Health
- `GET /api/health` — liveness · `GET /api/health/ready` — readiness (ping DB)

### Auth
- `POST /api/auth/register` — { email, password ≥8 char }
- `POST /api/auth/login` · `POST /api/auth/refresh` (rotation) · `POST /api/auth/logout` · `GET /api/auth/me`
- `POST /api/auth/forgot-password` · `POST /api/auth/reset-password`
- `POST /api/auth/verify-email` · `POST /api/auth/resend-verification`

### User (auth richiesta)
- `GET /api/user/me` · `PUT /api/user/profile` (codice atleta/nome) · `PUT /api/user/password` · `DELETE /api/user/me`
- `GET /api/user/sessions` · `POST /api/user/sessions/revoke-all`

### Sync / Cloud backup (auth richiesta)
- `POST /api/sync/snapshot` — salva backup localStorage (ultimi 10 mantenuti)
- `GET /api/sync/latest` · `GET /api/sync/list` · `GET /api/sync/snapshot/:id`

### Admin (solo `ADMIN_EMAIL`)
- `GET /api/admin/stats` — KPI dashboard · `GET /api/admin/system/db`
- `GET /api/admin/users[?q=]` — lista/ricerca (email, codice atleta, nome) · `GET /api/admin/users/:id` — dettaglio
- `POST /api/admin/users/:id/grant-premium?days=30` · `POST .../revoke-premium` · `DELETE /api/admin/users/:id`
- **Atleti privati**: `GET /api/admin/athletes` · `POST /api/admin/athletes` · `DELETE /api/admin/athletes/:id` · `GET /api/admin/users/:id/data`
- `GET /api/admin/audit`

## Sicurezza (difesa in profondità)

**Avvio (fail-fast)**
- `lib/config.ts` valida tutta la config al boot: in produzione il server **rifiuta di partire** se i JWT secret sono mancanti/deboli (<32 char), uguali tra loro, placeholder, se `COOKIE_SECURE` non è `true` o se `ADMIN_EMAIL`/`DATABASE_URL` mancano. Niente deploy insicuri silenziosi.
- Ping DB all'avvio + readiness probe `/api/health/ready`.

**Autenticazione**
- bcrypt cost 12 (OWASP) · password policy con blocklist + controllo email-in-password
- **Account lockout**: 5 tentativi falliti → blocco 15 min (per account, non solo IP)
- **Timing-attack mitigation**: il login esegue sempre un bcrypt compare, anche per email inesistenti
- JWT con `iss`/`aud`/`jti`, algoritmo bloccato HS256 (no alg-confusion)
- Refresh token opachi hashati SHA-256, **rotation a ogni uso**
- **Reuse detection**: un refresh token già ruotato che ricompare = furto → revoca di TUTTE le sessioni
- **Verifica email** (opzionale via `REQUIRE_EMAIL_VERIFICATION`): token 24h, gate al login
- Cambio password → revoca tutte le sessioni · endpoint `/user/sessions` + revoke-all
- Cookie httpOnly + Secure + SameSite=Lax (same-origin by design)

**API**
- Rate limit per-IP (X-Forwarded-For reale): 120/min generale, **10/min auth**, 5/min forgot-password · header `X-RateLimit-*` + `Retry-After`
- Body limit 6MB · Content-Type enforcement (mutating = solo JSON)
- Security headers completi (HSTS preload, nosniff, DENY frame, COOP/CORP same-origin, referrer policy)
- Audit log: login, lockout, token reuse, verifica email, azioni admin
- Logging strutturato 1-riga per richiesta (errori sempre, 4xx/5xx in prod)
- Purge automatico token scaduti (refresh + reset) ogni 6h
- `unhandledRejection`/`uncaughtException` loggati, processo non crasha

**Sito (via Caddy)**
- CSP con whitelist precisa delle risorse · frame-ancestors none · upgrade-insecure-requests
- HTTPS automatico Let's Encrypt, HSTS preload

**Container**
- Non-root · `cap_drop: ALL` · `no-new-privileges` · filesystem **read-only** (tmpfs per /tmp)
- Memory/CPU limits · Postgres su rete Docker `internal` (zero accesso internet)

**VPS**
- SSH key-only (password disabilitate) · MaxAuthTries 3 · fail2ban
- Firewall: solo 22/80/443 · sysctl hardening (anti-spoofing, SYN-cookies, ASLR, kptr_restrict)
- Aggiornamenti di sicurezza automatici · backup giornalieri cifrabili

## Struttura

```
wattlab-server/
├── src/
│   ├── index.ts            # entry: middleware, rate-limit, route /api
│   ├── db/{client,schema}  # Postgres pool + 6 tabelle
│   ├── lib/auth.ts         # bcrypt + JWT
│   ├── middleware/auth.ts  # requireAuth / requireAdmin
│   └── routes/             # auth, user, sync, admin
├── Dockerfile              # multi-stage, non-root, healthcheck
├── deploy/
│   ├── docker-compose.yml  # caddy + api + postgres
│   ├── Caddyfile           # HTTPS automatico + static + proxy
│   ├── setup-vps.sh        # hardening VPS one-shot
│   ├── deploy-from-pc.ps1  # deploy con un comando da Windows
│   └── scripts/            # backup.sh, restore.sh, update.sh
├── DEPLOY.md
└── QUICKSTART.md
```
