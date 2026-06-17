# Quick Start — Sviluppo locale

Per testare il server sul tuo PC mentre sviluppi. **Per il deploy online vedi [DEPLOY.md](./DEPLOY.md).**

## Requisiti

- Node.js 20+ (`node -v` per verificare)
- Docker Desktop **oppure** un Postgres qualsiasi

## Setup

```powershell
cd C:\Users\ricac\Downloads\wattlab-server
copy .env.example .env
```

Edita `.env` e imposta `DATABASE_URL` con un Postgres raggiungibile. Il modo più rapido con Docker Desktop:

```powershell
docker run -d --name wattlab-pg -e POSTGRES_USER=wattlab -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=wattlab -p 5432:5432 postgres:16-alpine
```

E nel `.env`:
```env
DATABASE_URL=postgresql://wattlab:devpass@localhost:5432/wattlab
```

Poi:

```powershell
npm install
npm run dev         # avvia su localhost:3000 (le migrazioni si applicano da sole al boot)
```

Le tabelle vengono create automaticamente all'avvio dalle migrazioni in `drizzle/`.
(Se cambi lo schema durante lo sviluppo: `npm run db:generate` per creare una nuova migrazione, oppure `npm run db:push` per applicarla al volo senza generarla.)

Test: apri http://localhost:3000/api/health → `{"ok":true,...}`
Verifica completa: con il server attivo, `npm run test:smoke`

## Collegare l'app in locale

Apri `index.html` dal file → Profilo → Admin Dashboard → ⚙️ Config API URL → `http://localhost:3000`

(In produzione non serve configurare nulla: il client usa same-origin `/api` automaticamente.)
