param(
  [string]$Distro = "Ubuntu",
  [string]$LinuxUser = "day",
  [switch]$RestartService
)

$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = "\\wsl.localhost\$Distro\home\$LinuxUser\.openclaw\extensions\openclaw-vault"
$excludeNames = @("node_modules", "coverage", ".vitest", ".tmp", ".DS_Store")
$excludeFilePatterns = @("*.log", "*.tmp")

function Assert-PathExists {
  param([string]$PathValue, [string]$Label)
  if (-not (Test-Path -LiteralPath $PathValue)) {
    throw "$Label 不存在: $PathValue"
  }
}

function Remove-TargetChildren {
  param([string]$PathValue)
  if (-not (Test-Path -LiteralPath $PathValue)) {
    return
  }
  Get-ChildItem -LiteralPath $PathValue -Force | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
  }
}

function Copy-PluginTree {
  param([string]$SourceRoot, [string]$DestinationRoot)
  Get-ChildItem -LiteralPath $SourceRoot -Force | ForEach-Object {
    if ($excludeNames -contains $_.Name) {
      return
    }
    foreach ($pattern in $excludeFilePatterns) {
      if ($_.Name -like $pattern) {
        return
      }
    }

    $destinationPath = Join-Path $DestinationRoot $_.Name
    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
      Copy-PluginTree -SourceRoot $_.FullName -DestinationRoot $destinationPath
      return
    }
    Copy-Item -LiteralPath $_.FullName -Destination $destinationPath -Force
  }
}

Assert-PathExists -PathValue $pluginRoot -Label "插件目录"

Write-Host "[1/4] 停止 WSL OpenClaw Gateway 服务"
wsl.exe -d $Distro -- bash -lc "systemctl --user stop openclaw-gateway.service"

Write-Host "[2/4] 准备目标插件目录: $targetRoot"
New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
Remove-TargetChildren -PathValue $targetRoot

Write-Host "[3/4] 同步插件文件到 WSL"
Copy-PluginTree -SourceRoot $pluginRoot -DestinationRoot $targetRoot

if ($RestartService) {
  Write-Host "[4/4] 重启 WSL OpenClaw Gateway 服务"
  wsl.exe -d $Distro -- bash -lc "systemctl --user restart openclaw-gateway.service"
} else {
  Write-Host "[4/4] 已跳过重启；当前服务仍处于停止状态，如需继续验证请先执行 systemctl --user restart openclaw-gateway.service"
}

Write-Host "部署完成: $targetRoot"
