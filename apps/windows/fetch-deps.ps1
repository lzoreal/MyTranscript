# 抓构建/运行所需的 sherpa-onnx Windows 二进制（约 13 MB，不进仓库）。
#
#   pwsh -File fetch-deps.ps1           # 只在缺文件时下
#   pwsh -File fetch-deps.ps1 -Force    # 重下
#   pwsh -File fetch-deps.ps1 -Mirror https://ghproxy.example/sherpa-onnx
#
# 识别模型不在这里管：首次开实时识别时由 asr_prepare 自动下到
# %ProgramData%\MyTranscript\sherpa-en-20M（sherpa 不认中文路径）。
param(
  [switch]$Force,
  [string]$Mirror = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $root "src-tauri\vendor\sherpa\lib"
$tmp = Join-Path $env:TEMP "myt-deps"
$dlls = @("sherpa-onnx-c-api.dll", "sherpa-onnx-c-api.lib", "onnxruntime.dll", "onnxruntime_providers_shared.dll")

if (-not $Force -and (Test-Path -LiteralPath (Join-Path $vendor "sherpa-onnx-c-api.lib"))) {
  Write-Host "已存在，跳过：$vendor"
  exit 0
}

New-Item -ItemType Directory -Force -Path $vendor, $tmp | Out-Null

# 资产名有坑：win-x64 的 shared 包带 -no-tts 后缀，写成 ...-shared.tar.bz2 会 404。
$ver = "1.12.15"
$asset = "sherpa-onnx-v$ver-win-x64-shared-no-tts.tar.bz2"
$url = if ($Mirror) { "$Mirror/releases/download/v$ver/$asset" } else { "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$ver/$asset" }
$tar = Join-Path $tmp $asset
Write-Host "下载 $url"
& curl.exe -L --retry 5 --retry-delay 2 -o $tar $url
if ($LASTEXITCODE -ne 0) { throw "下载失败：$url（可给 -Mirror 换源，或手动把 DLL 放进 $vendor）" }

$ex = Join-Path $tmp "sherpa-extract"
Remove-Item -LiteralPath $ex -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $ex | Out-Null
& tar.exe -xjf $tar -C $ex
if ($LASTEXITCODE -ne 0) { throw "解包失败：$tar" }

foreach ($f in $dlls) {
  $from = Get-ChildItem -LiteralPath $ex -Recurse -File -Filter $f | Select-Object -First 1
  if (-not $from) { throw "压缩包里没有 $f" }
  Copy-Item -LiteralPath $from.FullName -Destination (Join-Path $vendor $f) -Force
  Write-Host "  -> $f"
}
Write-Host "完成：$vendor"
