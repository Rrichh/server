# ═══════════════════════════════════════════════════════════════════
# WattLab — deploy dal PC Windows al VPS
# Uso (PowerShell, dalla cartella wattlab-server):
#   .\deploy\deploy-from-pc.ps1 -VpsIp 1.2.3.4
#
# Cosa fa: copia sito + server + config sul VPS via SCP, poi
# lancia il build/restart remoto via SSH.
# Richiede: OpenSSH client (incluso in Windows 10/11 di default).
# ═══════════════════════════════════════════════════════════════════
param(
  [Parameter(Mandatory=$true)][string]$VpsIp,
  [string]$VpsUser = "root",
  [string]$SitePath = "..\index.html"
)

$ErrorActionPreference = "Stop"
$remote = "${VpsUser}@${VpsIp}"

Write-Host "▸ [1/4] Copia file di orchestrazione (compose, Caddyfile, scripts)..." -ForegroundColor Cyan
scp -r "$PSScriptRoot\docker-compose.yml" "$PSScriptRoot\Caddyfile" "${remote}:/opt/wattlab/"
scp -r "$PSScriptRoot\scripts" "${remote}:/opt/wattlab/"
ssh $remote "chmod +x /opt/wattlab/scripts/*.sh"

Write-Host "▸ [2/4] Copia codice server..." -ForegroundColor Cyan
$serverRoot = Split-Path $PSScriptRoot -Parent
ssh $remote "mkdir -p /opt/wattlab/server"
scp -r "$serverRoot\src" "$serverRoot\package.json" "$serverRoot\tsconfig.json" "$serverRoot\drizzle.config.ts" "$serverRoot\Dockerfile" "$serverRoot\.dockerignore" "${remote}:/opt/wattlab/server/"
if (Test-Path "$serverRoot\package-lock.json") {
  scp "$serverRoot\package-lock.json" "${remote}:/opt/wattlab/server/"
}

Write-Host "▸ [3/4] Copia sito (index.html)..." -ForegroundColor Cyan
$siteFile = Resolve-Path (Join-Path $serverRoot $SitePath)
scp $siteFile "${remote}:/opt/wattlab/site/index.html"

Write-Host "▸ [4/4] Build e avvio sul VPS..." -ForegroundColor Cyan
ssh $remote "cd /opt/wattlab && docker compose up -d --build && docker compose ps"

Write-Host ""
Write-Host "✓ Deploy completato." -ForegroundColor Green
Write-Host "  Controlla: https://il-tuo-dominio (dopo che il DNS punta al VPS)" -ForegroundColor Green
