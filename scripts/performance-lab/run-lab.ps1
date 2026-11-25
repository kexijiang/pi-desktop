$ErrorActionPreference = 'Stop'
$base = (Resolve-Path .).Path
$summary = Join-Path $base '.verification\lab-summary'
$raw = Join-Path $base '.verification\lab-raw'
$null = New-Item -ItemType Directory -Path $summary,$raw -Force
$expectedCommit = 'e83d503267698800b8e1cfa987024d7c7c10a9ad'
git merge-base --is-ancestor $expectedCommit HEAD
if ($LASTEXITCODE -ne 0) { throw 'Harness must descend from the exact packaged commit' }
$hostInfo = [ordered]@{
  testedPackageSource = $expectedCommit
  sourceWorkflowRun = 45574358646
  sourceWorkflowArtifact = 'installer-benchmark-after-1'
  sourceWorkflowArtifactId = 15003654991
  harnessCommit = (git rev-parse HEAD).Trim()
  variant = $env:PIORA_PERF_LAB_VARIANT
  machine = 'GitHub-hosted Windows runner'
  computer = (Get-CimInstance Win32_ComputerSystem | Select-Object Model,TotalPhysicalMemory)
  os = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version)
  processors = @(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors)
  harnessNode = (node -v)
}
$hostInfo | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $summary 'host.json') -Encoding utf8NoBOM
$kit = Join-Path $base 'scripts\performance-lab'
$targetDir = Join-Path $env:RUNNER_TEMP 'piora-perf-installer'
$extraction = Join-Path $env:RUNNER_TEMP 'piora-perf-payload'
$setupFiles = @(Get-ChildItem -LiteralPath $targetDir -Filter '*-setup.exe' -File)
if ($setupFiles.Count -ne 1) { throw 'Expected one NSIS installer in the benchmark artifact' }
$metadata = Join-Path $targetDir 'beta.yml'
& (Join-Path $kit 'expand-nsis.ps1') -Installer $setupFiles[0].FullName -UpdatesYaml $metadata -OutputDirectory $extraction
Copy-Item -LiteralPath (Join-Path $extraction 'payload-identity.json') -Destination $summary
$extractedApp = Join-Path $extraction 'app'
if ($env:PIORA_PERF_LAB_VARIANT -eq 'instrumented') {
  $env:PIORA_PERF_PACKAGED_CONTROL = Join-Path $kit 'packaged-node-control.mjs'
  $env:PIORA_PERF_PACKAGED_COLD_SWEEP = Join-Path $kit 'packaged-cold-sweep.mjs'
  $env:PIORA_PERF_PACKAGED_ATTACH_LATE = '1'
  node --input-type=module -e "import {pathToFileURL} from 'node:url'; const control=await import(pathToFileURL(process.argv[1])); console.log(JSON.stringify(await control.preparePackagedNodeProbe(process.argv[2])));" $env:PIORA_PERF_PACKAGED_CONTROL $extractedApp
  if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare the isolated runtime probe' }
}
$executable = Join-Path $extractedApp 'Piora.exe'
node scripts/run-performance-diagnostic.mjs --executable $executable
$scenarioExit = $LASTEXITCODE
$run = Get-ChildItem -LiteralPath (Join-Path $base '.verification') -Directory -Filter 'desktop-e2e-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$run) { throw 'Scenario did not create a diagnostics run' }
$dir = $run.FullName
$markers = @('result.json','report.md','progress.json','ui-evidence.json','network.json','renderer.json','cold-warm-raw.json','desktop.log')
foreach ($name in $markers) {
  $from = Join-Path $dir $name
  if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $raw }
}
foreach ($name in @('result.json','report.md','progress.json')) {
  $from = Join-Path $dir $name
  if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $summary }
}
Get-ChildItem -LiteralPath $dir -File | Where-Object Name -match '\.(png|cpuprofile)$|\.trace\.json$' | Copy-Item -Destination $raw
$server = Join-Path $dir 'server'
if (Test-Path -LiteralPath $server) {
  $serverRaw = Join-Path $raw 'server'
  $null = New-Item -ItemType Directory -Path $serverRaw
  Get-ChildItem -LiteralPath $server -File | Where-Object Name -match '\.(jsonl|cpuprofile)$' | Copy-Item -Destination $serverRaw
  node (Join-Path $kit 'server-analysis.mjs') $dir *> (Join-Path $raw 'server-analysis.log')
  if ($LASTEXITCODE -eq 0) { Copy-Item -LiteralPath (Join-Path $dir 'server-summary.json') -Destination $summary }
}
$renderer = Join-Path $dir 'renderer.json'
if (Test-Path -LiteralPath $renderer) { node (Join-Path $kit 'summarize-renderer.mjs') $renderer (Join-Path $summary 'renderer-summary.json') }
$ui = Join-Path $dir 'ui-evidence.json'
if (Test-Path -LiteralPath $ui) { node (Join-Path $kit 'summarize-ui.mjs') $ui (Join-Path $summary 'ui-summary.json') }
$network = Join-Path $dir 'network.json'
$netlog = Join-Path $dir 'netlog.raw.json'
if (Test-Path -LiteralPath $network) {
  $netlogSummary = '-'
  if ((Test-Path -LiteralPath $netlog) -and (Get-Item -LiteralPath $netlog).Length -gt 0) {
    $netlogEvidence = Join-Path $raw 'netlog-evidence.json'
    node (Join-Path $kit 'perf-netlog.mjs') $netlog $network $netlogEvidence
    if ($LASTEXITCODE -eq 0) { $netlogSummary = $netlogEvidence }
  }
  node (Join-Path $kit 'summarize-network.mjs') $network $netlogSummary (Join-Path $summary 'network-summary.json')
}
$identity = Get-Content -Raw -LiteralPath (Join-Path $summary 'payload-identity.json') | ConvertFrom-Json
$postRunDigests = @(
  foreach ($baseline in $identity.baselinePayloadDigests) {
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $extractedApp $baseline.file)
    [ordered]@{ file = $baseline.file; unchanged = ($hash.Hash -ieq $baseline.sha256); sha256 = $hash.Hash.ToLowerInvariant() }
  }
)
$postRunDigests | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $summary 'post-run-digests.json') -Encoding utf8NoBOM
Write-Output ('Diagnostic run exit status ' + $scenarioExit)
if ($scenarioExit -ne 0) { exit $scenarioExit }
