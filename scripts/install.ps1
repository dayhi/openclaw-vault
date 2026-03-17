param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InstallerArgs
)

$ErrorActionPreference = "Stop"

$scriptUrl = if ($env:OPENCLAW_VAULT_INSTALLER_URL) {
  $env:OPENCLAW_VAULT_INSTALLER_URL
} else {
  "https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/openclaw-vault/scripts/install.mjs"
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-vault-" + [guid]::NewGuid().ToString("N"))
$tempFile = Join-Path $tempDir "install.mjs"

try {
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri $scriptUrl -OutFile $tempFile
  & node $tempFile @InstallerArgs
  exit $LASTEXITCODE
}
finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
