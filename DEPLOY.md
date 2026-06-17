# WattLab — Deploy Production

Guida completa per portare WattLab online su infrastruttura tua e seria.
Risultato finale: `https://tuodominio.com` con sito + API + database, HTTPS automatico, backup giornalieri.

---

## Architettura

```
                 tuodominio.com (HTTPS automatico Let's Encrypt)
                              │
                    ┌─────────┴─────────┐
                    │   Caddy (proxy)   │
                    └───┬───────────┬───┘
            /  (sito)   │           │   /api/*
                  ┌─────┴────┐  ┌───┴────┐     ┌────────────┐
                  │index.html│  │ API    │────▶│ PostgreSQL │
                  │          │  │ Node 20│     │ + backup   │
                  └──────────┘  └────────┘     └────────────┘

           Tutto in Docker Compose su un VPS — un'unica macchina, un unico dominio.
```

Sito e API sullo **stesso dominio** = niente CORS, cookie sicuri SameSite=Lax, architettura pulita.

---

## Le 3 cose che devi fare tu (io non posso farle al posto tuo)

### 1. Compra il dominio (~10 €/anno)

Vai su **Cloudflare Registrar** (https://domains.cloudflare.com) — vende i domini a prezzo di costo, senza markup.
Alternativa: Namecheap, Porkbun.

Registra il dominio che vuoi (es. `wattlab.it`, `wattlab.app`, ...).

### 2. Affitta il VPS (~4,5 €/mese)

Vai su **Hetzner Cloud** (https://www.hetzner.com/cloud):

1. Crea account → New Project → Add Server
2. Location: **Falkenstein** o **Nuremberg** (Germania, vicino e veloce per l'Italia)
3. Image: **Ubuntu 24.04**
4. Type: **CX22** (2 vCPU, 4GB RAM — più che sufficiente) → ~4,5 €/mese
5. SSH Key: **aggiungi la tua chiave SSH** (vedi sotto se non ce l'hai)
6. Create & Buy

Ti danno un **IP pubblico** (es. `95.217.123.45`). Salvalo.

**Se non hai una chiave SSH** (sul tuo PC, PowerShell):
```powershell
ssh-keygen -t ed25519
# Premi Enter 3 volte. La chiave pubblica è in:
type $env:USERPROFILE\.ssh\id_ed25519.pub
# Copia l'output e incollalo su Hetzner quando crei il server
```

### 3. Punta il dominio al VPS

Nel pannello DNS del dominio (su Cloudflare):

| Tipo | Nome | Valore        | Proxy |
|------|------|---------------|-------|
| A    | @    | IP_DEL_VPS    | ❌ DNS only (grigio) |
| A    | www  | IP_DEL_VPS    | ❌ DNS only (grigio) |

⚠️ **Proxy OFF** (nuvola grigia): Caddy gestisce HTTPS da solo, il proxy Cloudflare confliggerebbe col rilascio del certificato. (Si può riattivare dopo, opzionale.)

---

## Deploy (una volta fatte le 3 cose sopra)

### Step A — Prepara il VPS (5 min, una volta sola)

Dal tuo PC, PowerShell:

```powershell
# Copia lo script di setup sul VPS (sostituisci IP)
scp C:\Users\ricac\Downloads\wattlab-server\deploy\setup-vps.sh root@IP_DEL_VPS:/root/

# Entra nel VPS
ssh root@IP_DEL_VPS

# (ora sei sul VPS) — esegui il setup
bash /root/setup-vps.sh
```

Lo script configura: firewall, fail2ban, aggiornamenti automatici, Docker, struttura cartelle.

### Step B — Configura i secret (2 min, una volta sola)

Ancora sul VPS:

```bash
cd /opt/wattlab
```

Crea il file `.env`:
```bash
cat > .env <<EOF
DOMAIN=tuodominio.com
POSTGRES_PASSWORD=$(openssl rand -base64 32)
JWT_ACCESS_SECRET=$(openssl rand -base64 64 | tr -d '\n')
JWT_REFRESH_SECRET=$(openssl rand -base64 64 | tr -d '\n')
ADMIN_EMAIL=piana.richh@gmail.com
EOF
chmod 600 .env
```

(Genera automaticamente password e secret crittografici forti. Cambia solo `DOMAIN`.)

Esci dal VPS: `exit`

### Step C — Deploy dal tuo PC (1 comando)

PowerShell, dalla cartella `wattlab-server`:

```powershell
cd C:\Users\ricac\Downloads\wattlab-server
.\deploy\deploy-from-pc.ps1 -VpsIp IP_DEL_VPS
```

Lo script copia tutto (sito, server, config) e avvia lo stack Docker sul VPS.

Primo avvio: ~2-3 minuti (build dell'immagine). Caddy ottiene il certificato HTTPS automaticamente al primo accesso.

### Step D — Verifica

1. Apri `https://tuodominio.com` → vedi l'app ✓
2. Apri `https://tuodominio.com/api/health` → vedi `{"ok":true}` ✓
3. Registrati nell'app con `piana.richh@gmail.com`
4. Profilo → Admin Dashboard → banner **verde "Server connesso · same-origin (/api)"** ✓

---

## Operazioni quotidiane

### Aggiornare l'app (nuovo index.html o nuovo codice server)

Dal tuo PC:
```powershell
cd C:\Users\ricac\Downloads\wattlab-server
.\deploy\deploy-from-pc.ps1 -VpsIp IP_DEL_VPS
```
Stesso comando del deploy. Copia i file aggiornati e riavvia. Downtime: ~5 secondi.

### Vedere i log

```powershell
ssh root@IP_DEL_VPS "cd /opt/wattlab && docker compose logs -f api"
```
(Ctrl+C per uscire)

### Attivare i backup giornalieri (una volta sola)

```powershell
ssh root@IP_DEL_VPS
# sul VPS:
crontab -e
# aggiungi questa riga (backup ogni notte alle 3):
0 3 * * * /opt/wattlab/scripts/backup.sh >> /opt/wattlab/backups/backup.log 2>&1
```

I backup vanno in `/opt/wattlab/backups/`, tenuti gli ultimi 14, compressi.

### Ripristinare un backup

```bash
# sul VPS:
ls /opt/wattlab/backups/                     # scegli il file
/opt/wattlab/scripts/restore.sh /opt/wattlab/backups/wattlab_XXXXXX.sql.gz
```

### Riavviare tutto

```bash
ssh root@IP_DEL_VPS "cd /opt/wattlab && docker compose restart"
```

---

## Costi totali

| Voce            | Costo           |
|-----------------|-----------------|
| Dominio         | ~10 €/anno      |
| VPS Hetzner CX22| ~4,5 €/mese     |
| HTTPS (Let's Encrypt) | gratis    |
| **Totale**      | **~65 €/anno**  |

Il VPS CX22 regge tranquillamente migliaia di utenti per un'app di questo tipo. Quando servisse scalare: upgrade del VPS con un click su Hetzner (downtime ~30s).

---

## Sicurezza inclusa

- ✅ HTTPS forzato con certificato auto-rinnovato (Let's Encrypt via Caddy)
- ✅ HSTS, X-Frame-Options, nosniff, Referrer-Policy
- ✅ Firewall: solo porte 22/80/443 aperte
- ✅ fail2ban: ban automatico brute-force SSH
- ✅ Postgres NON esposto a internet (rete Docker interna)
- ✅ Password bcrypt cost 12, JWT rotation, cookie httpOnly
- ✅ Rate limiting (120 req/min generale, 10 req/min su login/register)
- ✅ Container non-root
- ✅ Aggiornamenti di sicurezza automatici del sistema
- ✅ Backup giornalieri con retention 14 giorni
