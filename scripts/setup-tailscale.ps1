<#
.SYNOPSIS
  Puts reyd behind `tailscale serve` so the PWA reaches it over HTTPS, tailnet-only.

.DESCRIPTION
  This is the piece that makes the whole design work in practice (docs/decisions.md D-003):

    - reyd binds 127.0.0.1 and is never exposed on the LAN or the internet
    - tailscale serve fronts it with a real TLS certificate on the MagicDNS name
    - a real cert means the PWA gets a secure context, so it is installable and
      can register a service worker
    - only devices on your tailnet can reach it at all

  Run from an elevated PowerShell the first time (tailscale serve needs it).

.EXAMPLE
  .\scripts\setup-tailscale.ps1
  .\scripts\setup-tailscale.ps1 -Port 8787 -Reset
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  # Clear any existing serve config for this machine before applying.
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'

function Find-Tailscale {
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($null -ne $cmd) { return $cmd.Source }
  $candidate = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path $candidate) { return $candidate }
  return $null
}

$tailscale = Find-Tailscale
if ($null -eq $tailscale) {
  Write-Host ''
  Write-Host 'Tailscale is not installed.' -ForegroundColor Yellow
  Write-Host 'Install it, sign in, then run this script again:'
  Write-Host '  winget install --id Tailscale.Tailscale'
  Write-Host '  https://tailscale.com/download/windows'
  exit 1
}

Write-Host "Using tailscale at $tailscale"

# Confirm the node is actually up before configuring serve.
$statusJson = & $tailscale status --json 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($statusJson)) {
  Write-Host 'Tailscale is installed but not running or not signed in.' -ForegroundColor Yellow
  Write-Host 'Run:  tailscale up'
  exit 1
}

$status = $statusJson | ConvertFrom-Json
$dnsName = $status.Self.DNSName
if ([string]::IsNullOrWhiteSpace($dnsName)) {
  Write-Host 'Could not determine this machine''s MagicDNS name.' -ForegroundColor Yellow
  Write-Host 'Enable MagicDNS and HTTPS certificates in the Tailscale admin console:'
  Write-Host '  https://login.tailscale.com/admin/dns'
  exit 1
}
$host_ = $dnsName.TrimEnd('.')

if ($Reset) {
  Write-Host 'Clearing existing serve configuration…'
  & $tailscale serve reset
}

Write-Host "Serving https://$host_  ->  http://127.0.0.1:$Port"
& $tailscale serve --bg --https=443 "http://127.0.0.1:$Port"
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'tailscale serve failed.' -ForegroundColor Red
  Write-Host 'Common causes:'
  Write-Host '  - not running as Administrator'
  Write-Host '  - HTTPS certificates not enabled for the tailnet (admin console > DNS)'
  exit 1
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  Daemon URL for your phone:  https://$host_"
Write-Host ''
Write-Host 'Next:'
Write-Host "  1. Make sure reyd is running and REY_PASSWORD is set."
Write-Host "  2. If you serve the PWA from Vercel, set on the daemon:"
Write-Host "       REY_ALLOWED_ORIGINS=https://<your-app>.vercel.app"
Write-Host "  3. Pair your phone:  node scripts/pair.mjs"
Write-Host ''
Write-Host 'This is reachable only from your tailnet. It is not on the public internet.'
& $tailscale serve status
