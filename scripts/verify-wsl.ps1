param(
  [string]$Distro = "Ubuntu",
  [string]$LinuxUser = "day",
  [string]$AgentId,
  [string]$InlineSecret = "abc12345xyz",
  [string]$RegisteredSecretName = "demo",
  [string]$RegisteredSecretValue = "abc12345xyz",
  [int]$WaitTimeoutMs = 180000,
  [int]$HistoryLimit = 8
)

$ErrorActionPreference = "Stop"

$linuxHome = "/home/$LinuxUser"
$pluginRoot = "$linuxHome/.openclaw/extensions/openclaw-vault"
$configPath = "$linuxHome/.openclaw/openclaw.json"
$logDir = "/tmp/openclaw"

function Invoke-WslCommand {
  param([string]$Command)
  $wrapped = @'
set -euo pipefail
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi
'@ + "`n" + $Command
  $wrappedBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($wrapped))
  $outputBase64 = wsl.exe -d $Distro -- bash -lc "set -o pipefail; printf '%s' '$wrappedBase64' | base64 -d | bash | base64 -w0"
  if ($LASTEXITCODE -ne 0) {
    throw "WSL 命令失败: $Command"
  }

  $outputBase64Text = if ($null -eq $outputBase64) { "" } else { ([string]$outputBase64).Trim() }
  if ([string]::IsNullOrWhiteSpace($outputBase64Text)) {
    return ""
  }

  try {
    $outputBytes = [Convert]::FromBase64String($outputBase64Text)
  } catch {
    throw "WSL 命令输出不是合法 Base64：$Command"
  }

  return [System.Text.Encoding]::UTF8.GetString($outputBytes)
}

function ConvertFrom-LooseJsonText {
  param([string]$Text, [string]$Label)
  if ($null -eq $Text) {
    throw "$Label 为空。"
  }
  $ansiPattern = [string]([char]27) + "\[[0-9;?]*[ -/]*[@-~]"
  $clean = [regex]::Replace([string]$Text, $ansiPattern, "")
  $clean = $clean.Trim()
  if ([string]::IsNullOrWhiteSpace($clean)) {
    throw "$Label 为空。"
  }

  $startIndices = New-Object System.Collections.Generic.List[int]
  $endIndices = New-Object System.Collections.Generic.List[int]
  for ($i = 0; $i -lt $clean.Length; $i++) {
    $char = $clean[$i]
    if ($char -eq '{' -or $char -eq '[') {
      $startIndices.Add($i)
    }
    if ($char -eq '}' -or $char -eq ']') {
      $endIndices.Add($i)
    }
  }

  for ($s = 0; $s -lt $startIndices.Count; $s++) {
    $start = $startIndices[$s]
    for ($e = $endIndices.Count - 1; $e -ge 0; $e--) {
      $end = $endIndices[$e]
      if ($end -lt $start) {
        continue
      }
      $candidate = $clean.Substring($start, $end - $start + 1).Trim()
      try {
        return $candidate | ConvertFrom-Json
      } catch {
      }
    }
  }

  throw "$Label 不是可解析 JSON。原始输出：$clean"
}

function Invoke-WslJsonCommand {
  param([string]$Command, [string]$Label)
  $output = Invoke-WslCommand $Command
  try {
    return ConvertFrom-LooseJsonText -Text $output -Label $Label
  } catch {
    Write-Host $output
    throw
  }
}

function Invoke-WslGatewayCall {
  param([string]$Method, $Params, [int]$CliTimeoutMs = 30000, [string]$Label = $Method)
  $paramsJson = if ($null -eq $Params) { "{}" } else { $Params | ConvertTo-Json -Compress -Depth 100 }
  $paramsBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($paramsJson))
  $outputPath = "/tmp/openclaw-vault-gateway-call.json"
  $command = @'
params_json=$(printf '%s' '__PARAMS_BASE64__' | base64 -d)
openclaw gateway call __METHOD__ --json --timeout __TIMEOUT__ --params "$params_json" > '__OUTPUT_PATH__'
'@
  $command = $command.Replace("__PARAMS_BASE64__", $paramsBase64)
  $command = $command.Replace("__METHOD__", $Method)
  $command = $command.Replace("__TIMEOUT__", [string]$CliTimeoutMs)
  $command = $command.Replace("__OUTPUT_PATH__", $outputPath)
  Invoke-WslCommand $command | Out-Null
  $rawJson = Invoke-WslCommand "cat '$outputPath'"
  try {
    return $rawJson | ConvertFrom-Json
  } catch {
    Write-Host $rawJson
    throw "$Label 返回的 gateway JSON 无法解析。"
  }
}

function Assert-Contains {
  param([string]$Text, [string]$Needle, [string]$Label)
  if ($Text -notmatch [regex]::Escape($Needle)) {
    throw "$Label 未包含预期内容: $Needle"
  }
}

function Get-ObjectPropertyValue {
  param($Object, [string]$Name)
  if ($null -eq $Object) {
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Convert-HistoryMessageToText {
  param($Message)

  if ($null -eq $Message) {
    return ""
  }

  $content = $Message.content
  if ($content -is [string]) {
    return ([string]$content).Trim()
  }

  if ($content -is [System.Collections.IEnumerable] -and -not ($content -is [string])) {
    $parts = foreach ($entry in @($content)) {
      if ($entry -is [string]) {
        [string]$entry
        continue
      }

      if ($null -ne $entry -and $entry.PSObject.Properties.Match("text").Count -gt 0 -and $entry.text -is [string]) {
        [string]$entry.text
      }
    }

    return (-join $parts).Trim()
  }

  if ($null -ne $Message.PSObject -and $Message.PSObject.Properties.Match("text").Count -gt 0 -and $Message.text -is [string]) {
    return ([string]$Message.text).Trim()
  }

  return ""
}

function Get-LatestAssistantTextFromHistoryPayload {
  param($HistoryPayload)

  $messages = @($HistoryPayload.messages)
  for ($index = $messages.Count - 1; $index -ge 0; $index--) {
    $message = $messages[$index]
    if ($null -eq $message) {
      continue
    }

    $role = [string]$message.role
    if ($role -ne "assistant") {
      continue
    }

    $text = Convert-HistoryMessageToText -Message $message
    if (-not [string]::IsNullOrWhiteSpace($text) -and $text -ne "NO_REPLY") {
      return $text
    }
  }

  return ""
}

function Invoke-GatewayTurn {
  param(
    [string]$Message,
    [string]$Label,
    [string]$ExpectedSubstring,
    [int]$WaitMs = $WaitTimeoutMs
  )

  $runId = [guid]::NewGuid().ToString()
  $sendPayload = Invoke-WslGatewayCall -Method "chat.send" -Params @{
    sessionKey = "main"
    message = $Message
    idempotencyKey = $runId
  } -CliTimeoutMs 30000 -Label "$Label chat.send"

  $sendStatus = [string](Get-ObjectPropertyValue -Object $sendPayload -Name "status")
  if ($sendStatus -notin @("started", "ok", "in_flight")) {
    throw "$Label chat.send 返回异常状态：$($sendPayload | ConvertTo-Json -Compress -Depth 20)"
  }

  $waitPayload = Invoke-WslGatewayCall -Method "agent.wait" -Params @{
    runId = $runId
    timeoutMs = $WaitMs
  } -CliTimeoutMs ($WaitMs + 30000) -Label "$Label agent.wait"

  $waitStatus = [string](Get-ObjectPropertyValue -Object $waitPayload -Name "status")
  if ($waitStatus -ne "ok") {
    throw "$Label 等待失败：$($waitPayload | ConvertTo-Json -Compress -Depth 20)"
  }

  $historyPayload = Invoke-WslGatewayCall -Method "chat.history" -Params @{
    sessionKey = "main"
    limit = $HistoryLimit
  } -CliTimeoutMs 30000 -Label "$Label chat.history"

  $assistantText = Get-LatestAssistantTextFromHistoryPayload -HistoryPayload $historyPayload
  if ([string]::IsNullOrWhiteSpace($assistantText)) {
    $historyJson = $historyPayload | ConvertTo-Json -Depth 20
    Write-Host $historyJson
    throw "chat.history 未找到 assistant 文本回复。"
  }
  Write-Host "$Label 回复: $assistantText"
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSubstring)) {
    Assert-Contains -Text $assistantText -Needle $ExpectedSubstring -Label "$Label 回复"
  }

  return [pscustomobject]@{
    RunId = $runId
    Send = $sendPayload
    Wait = $waitPayload
    History = $historyPayload
    AssistantText = $assistantText
  }
}

function Assert-WslLinuxCommand {
  param([string]$Name)
  $pathValue = Invoke-WslCommand "command -v $Name || true"
  if ($null -eq $pathValue) {
    $pathValue = ""
  } else {
    $pathValue = [string]$pathValue
  }
  $pathValue = $pathValue.Trim()
  if ([string]::IsNullOrWhiteSpace($pathValue)) {
    throw "WSL 缺少 $Name，请先在 WSL 内安装对应依赖后再重试。"
  }
  if ($pathValue -match '^/mnt/[a-z]/') {
    throw "WSL 当前命中的 $Name 位于 Windows 挂载路径：$pathValue。请先在 WSL 内安装 Linux 版依赖（例如先安装 Node.js，再执行 npm i -g openclaw），然后重新验证。"
  }
  return $pathValue
}

function Wait-WslGatewayHealth {
  param(
    [int]$TimeoutMs = 30000,
    [int]$PollMs = 1000
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  $lastError = $null

  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $serviceState = [string](Invoke-WslCommand "systemctl --user is-active openclaw-gateway.service || true")
      $serviceState = $serviceState.Trim()
      if ($serviceState -eq "active") {
        return Invoke-WslGatewayCall -Method "health" -Params @{} -CliTimeoutMs 10000 -Label "gateway health"
      }
      $lastError = "Gateway 服务当前状态：$serviceState"
    } catch {
      $lastError = $_
    }

    Start-Sleep -Milliseconds $PollMs
  }

  if ($null -ne $lastError) {
    throw "Gateway 在 ${TimeoutMs}ms 内未就绪：$lastError"
  }

  throw "Gateway 在 ${TimeoutMs}ms 内未就绪。"
}

function Load-WslOpenClawConfig {
  $rawConfig = Invoke-WslCommand "cat '$configPath'"
  try {
    return $rawConfig | ConvertFrom-Json
  } catch {
    throw "无法解析 WSL 配置文件：$configPath"
  }
}

function Assert-VaultPluginEnabled {
  param($Config)
  $plugins = Get-ObjectPropertyValue -Object $Config -Name "plugins"
  $entries = Get-ObjectPropertyValue -Object $plugins -Name "entries"
  $vaultEntry = Get-ObjectPropertyValue -Object $entries -Name "openclaw-vault"
  $enabled = Get-ObjectPropertyValue -Object $vaultEntry -Name "enabled"
  if ($enabled -ne $true) {
    throw "WSL 配置缺少 plugins.entries.openclaw-vault.enabled = true，请先在 ~/.openclaw/openclaw.json 启用插件。"
  }

  $allow = Get-ObjectPropertyValue -Object $plugins -Name "allow"
  if ($allow -is [System.Array] -and $allow.Count -gt 0 -and -not ($allow -contains "openclaw-vault")) {
    throw "WSL 配置中的 plugins.allow 未包含 openclaw-vault，请先放行该插件。"
  }
}

Write-Host "[1/13] 检查 WSL Node 命令"
$nodePath = Assert-WslLinuxCommand -Name "node"
Write-Host "node: $nodePath"

Write-Host "[2/13] 检查 WSL OpenClaw 命令"
$openclawPath = Assert-WslLinuxCommand -Name "openclaw"
Write-Host "openclaw: $openclawPath"

Write-Host "[3/13] 检查插件配置已启用"
$config = Load-WslOpenClawConfig
Assert-VaultPluginEnabled -Config $config

Write-Host "[4/13] 输出 OpenClaw 版本"
$versionOutput = Invoke-WslCommand "openclaw --version"
Write-Host $versionOutput

Write-Host "[5/13] 确认插件目录已部署"
Invoke-WslCommand "test -d '$pluginRoot'"

Write-Host "[6/13] 检查插件加载状态"
$pluginsJsonPath = "/tmp/openclaw-vault-plugins.json"
Invoke-WslCommand "openclaw plugins list --json > '$pluginsJsonPath'"
$pluginsRaw = Invoke-WslCommand "cat '$pluginsJsonPath'"
try {
  $pluginsPayload = $pluginsRaw | ConvertFrom-Json
} catch {
  Write-Host $pluginsRaw
  throw "无法解析插件列表 JSON：$pluginsJsonPath"
}
Write-Host ($pluginsPayload | ConvertTo-Json -Depth 20)
$pluginsList = @(Get-ObjectPropertyValue -Object $pluginsPayload -Name "plugins")
$vaultPlugin = $pluginsList | Where-Object {
  (Get-ObjectPropertyValue -Object $_ -Name "id") -eq "openclaw-vault"
} | Select-Object -First 1
if ($null -eq $vaultPlugin) {
  throw "插件列表中未找到 openclaw-vault。"
}
$pluginStatus = [string](Get-ObjectPropertyValue -Object $vaultPlugin -Name "status")
if ($pluginStatus -ne "loaded") {
  throw "openclaw-vault 当前状态不是 loaded：$pluginStatus"
}

Write-Host "[7/13] 先确保 Gateway 就绪，再通过 gateway chat.send 执行 /s check"
$preflightRestartOutput = Invoke-WslCommand "systemctl --user restart openclaw-gateway.service && systemctl --user is-active openclaw-gateway.service"
Write-Host $preflightRestartOutput
Assert-Contains -Text ([string]$preflightRestartOutput) -Needle "active" -Label "Gateway 预热服务状态"
$preflightHealthPayload = Wait-WslGatewayHealth -TimeoutMs 30000 -PollMs 1000
Write-Host ($preflightHealthPayload | ConvertTo-Json -Depth 20)
$checkResult = Invoke-GatewayTurn -Message "/s check" -Label "/s check" -ExpectedSubstring "Vault 检查完成"

Write-Host "[8/13] 重启 WSL OpenClaw Gateway 服务以应用 /s check 写回配置"
$restartOutput = Invoke-WslCommand "systemctl --user restart openclaw-gateway.service && systemctl --user is-active openclaw-gateway.service"
Write-Host $restartOutput
Assert-Contains -Text ([string]$restartOutput) -Needle "active" -Label "Gateway 服务状态"

Write-Host "[9/13] 检查 Gateway health"
$healthPayload = Wait-WslGatewayHealth -TimeoutMs 30000 -PollMs 1000
Write-Host ($healthPayload | ConvertTo-Json -Depth 20)

Write-Host "[10/13] 执行 inline smoke"
$inlineResult = Invoke-GatewayTurn -Message "请重复这段文本：<<s:$InlineSecret>>" -Label "inline smoke" -ExpectedSubstring "<<s:$InlineSecret>>"

Write-Host "[11/13] 添加或更新 registered secret"
$addResult = Invoke-GatewayTurn -Message "/s add $RegisteredSecretName $RegisteredSecretValue" -Label "/s add" -ExpectedSubstring $RegisteredSecretName
if ($addResult.AssistantText -match [regex]::Escape("Vault 密文已存在")) {
  $updateResult = Invoke-GatewayTurn -Message "/s update $RegisteredSecretName $RegisteredSecretValue" -Label "/s update" -ExpectedSubstring "Vault 密文已更新"
}
elseif ($addResult.AssistantText -notmatch [regex]::Escape("Vault 密文已添加")) {
  throw "/s add 未返回预期结果：$($addResult.AssistantText)"
}

Write-Host "[12/13] 执行 registered smoke"
$registeredResult = Invoke-GatewayTurn -Message "请重复这段文本：$RegisteredSecretValue" -Label "registered smoke" -ExpectedSubstring $RegisteredSecretValue

Write-Host "[13/13] 输出最近 WSL 日志路径与 tail"
$latestLogCommand = @'
if [ ! -d '__LOG_DIR__' ]; then
  exit 1
fi
latest=$(find '__LOG_DIR__' -maxdepth 1 -type f -printf '%T@ %p\n' | sort -rn | head -n 1 | cut -d' ' -f2-)
test -n "${latest:-}"
printf '%s' "$latest"
'@
$latestLogCommand = $latestLogCommand.Replace("__LOG_DIR__", $logDir)
$latestLog = Invoke-WslCommand $latestLogCommand
Write-Host "最近日志: $latestLog"
$logTail = Invoke-WslCommand "tail -n 200 '$latestLog'"
Write-Host $logTail

Write-Host "WSL 验证完成。"
