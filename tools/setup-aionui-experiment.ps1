$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.local/aionui-experiment'
$sourceRoot = Join-Path $projectRoot '.local/references/AionUi'
$sourceCommit = '11cd2a9a20d1e033157636efc570b41384c66d85'
New-Item -ItemType Directory -Force $runtimeRoot | Out-Null

function Get-VerifiedArchive($Url, $Name, $Hash, $Destination) {
  $archive = Join-Path $runtimeRoot $Name
  if (!(Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $Url -OutFile $archive }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw "$Name SHA256 mismatch; remove that archive and retry" }
  if (!(Test-Path -LiteralPath $Destination)) { Expand-Archive -LiteralPath $archive -DestinationPath $Destination }
}

Get-VerifiedArchive 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-windows-x64.zip' 'bun.zip' 'cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5' (Join-Path $runtimeRoot 'runtime')
Get-VerifiedArchive 'https://github.com/iOfficeAI/AionCore/releases/download/v0.2.2/aioncore-v0.2.2-x86_64-pc-windows-msvc.zip' 'aioncore.zip' 'd1ed8d1da869230c18701747d07e8f068db5b8c9442e65261304aeb4c27eacf6' (Join-Path $runtimeRoot 'backend')

if (!(Test-Path -LiteralPath (Join-Path $sourceRoot '.git'))) {
  git clone https://github.com/iOfficeAI/AionUi.git $sourceRoot
  if ($LASTEXITCODE -ne 0) { throw 'AionUi clone failed' }
  git -C $sourceRoot checkout --detach $sourceCommit
  if ($LASTEXITCODE -ne 0) { throw 'AionUi checkout failed' }
}
if ((git -C $sourceRoot rev-parse HEAD).Trim() -ne $sourceCommit) { throw "AionUi reference checkout must be $sourceCommit; preserve any local edits before switching it" }
$bun = Join-Path $runtimeRoot 'runtime/bun-windows-x64/bun.exe'
$previousCache = $env:BUN_INSTALL_CACHE_DIR
try {
  $env:BUN_INSTALL_CACHE_DIR = Join-Path $runtimeRoot 'bun-cache'
  Push-Location $sourceRoot
  try {
    & $bun install --frozen-lockfile --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'AionUi dependency installation failed' }
    & $bun run package
    if ($LASTEXITCODE -ne 0) { throw 'AionUi build failed' }
  } finally { Pop-Location }
  Push-Location $projectRoot
  try {
    & $bun build tools/aionui-host.mjs --target=node --outfile=.local/aionui-experiment/host.mjs
    if ($LASTEXITCODE -ne 0) { throw 'AionUi host build failed' }
  } finally { Pop-Location }
} finally { $env:BUN_INSTALL_CACHE_DIR = $previousCache }
Write-Output 'AionUi experiment is ready. Restart self-wiki and open AionUi 实验版 in the sidebar.'
