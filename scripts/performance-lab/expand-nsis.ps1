param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$UpdatesYaml,
  [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$manifestPath = (Resolve-Path -LiteralPath $UpdatesYaml).Path
$expected = [regex]::Match([IO.File]::ReadAllText($manifestPath), '(?m)^sha512:\s*(\S+)\s*$').Groups[1].Value
if (!$expected) { throw 'Missing installer SHA512 in beta.yml' }
$sum = Get-FileHash -Algorithm SHA512 -LiteralPath $installerPath
$actual = [Convert]::ToBase64String([Convert]::FromHexString($sum.Hash))
if ($actual -cne $expected) { throw 'Installer SHA512 does not match beta.yml' }

$out = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $out) { throw "The extraction destination already exists: $out" }
$null = New-Item -ItemType Directory -Path $out
$stage = Join-Path $out 'nsis-payload'
$app = Join-Path $out 'app'
$null = New-Item -ItemType Directory -Path $stage, $app
$archiveTool = 'C:\Program Files\7-Zip\7z.exe'
$inventory = & $archiveTool l -slt $installerPath
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect NSIS payload' }
$inner = @($inventory | ForEach-Object { if ($_ -match '^Path = (.*[\\/]app-64\.7z)$') { $Matches[1] } })
if ($inner.Count -ne 1) { throw "Expected exactly one Windows x64 payload archive (found $($inner.Count))" }
& $archiveTool e -y ('-o' + $stage) $installerPath $inner[0] | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to extract the NSIS app-64.7z archive' }
$payload = Join-Path $stage 'app-64.7z'
& $archiveTool x -y ('-o' + $app) $payload | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to expand the Windows x64 application files' }
$paths = @('Piora.exe', 'resources\app.asar', 'resources\web\server.js', 'resources\web\runtime.asar')
$digests = @(
  foreach ($entry in $paths) {
    $resolved = Join-Path $app $entry
    if (!(Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Missing expected payload file: $entry" }
    $sha = Get-FileHash -Algorithm SHA256 -LiteralPath $resolved
    [ordered]@{ file = $entry; bytes = (Get-Item -LiteralPath $resolved).Length; sha256 = $sha.Hash.ToLowerInvariant() }
  }
)
Set-Content -LiteralPath (Join-Path $app '.piora-perf-owned') -Encoding utf8NoBOM -Value 'isolated verification copy'
$record = [ordered]@{
  installer = $installerPath; installerBytes = (Get-Item -LiteralPath $installerPath).Length
  installerSha512 = $sum.Hash.ToLowerInvariant(); updatesManifest = $manifestPath
  extractor = $archiveTool; x64Payload = $inner[0]; runMode = 'extracted NSIS application payload'
  extractedApp = $app; baselinePayloadDigests = $digests
}
$record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $out 'payload-identity.json') -Encoding utf8NoBOM
$record | ConvertTo-Json -Depth 6
