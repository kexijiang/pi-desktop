$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$repo = 'kexijiang/pi-desktop'
$baseline = $env:PIORA_QA_BASELINE
$target = $env:PIORA_QA_TARGET
if ($env:GITHUB_ACTIONS -ne 'true' -or $target -notmatch '^v0\.5\.11-beta\.\d+$' -or $baseline -notmatch '^v0\.5\.11-beta\.\d+$') {
  throw 'Run this verification on an isolated Windows Actions runner with a published beta tag'
}
$root = Join-Path $env:RUNNER_TEMP 'piora-installed-upgrade'
$install = Join-Path $root 'install'
$exe = Join-Path $install 'Piora.exe'
$evidence = (New-Item -ItemType Directory -Force '.verification/nsis-upgrade').FullName
New-Item -ItemType Directory $root | Out-Null
$env:PIORA_INSTALL_UPGRADE_TEST_ROOT = $root
$appEnvironment = @{
  PIORA_COMPANION_UI_TEST = '1'
  PIORA_COMPANION_UI_TEST_USER_DATA = (Join-Path $root 'profile')
  PI_CODING_AGENT_DIR = (Join-Path $root 'agent')
}
$checks = [System.Collections.Generic.List[object]]::new()
$processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SetupControls {
  public delegate bool Visit(IntPtr hwnd, IntPtr data);
  [DllImport("user32")] static extern bool EnumWindows(Visit visit, IntPtr data);
  [DllImport("user32")] static extern bool EnumChildWindows(IntPtr window, Visit visit, IntPtr data);
  [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32")] static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32")] static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32")] static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int size);
  [DllImport("user32", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wp, StringBuilder lp, uint flags, uint ms, out IntPtr result);
  [DllImport("user32")] static extern bool PostMessage(IntPtr window, uint msg, IntPtr wp, IntPtr lp);

  public sealed class Control {
    public IntPtr Handle { get; set; }
    public int Id { get; set; }
    public string Class { get; set; }
    public string Text { get; set; }
    public bool Enabled { get; set; }
  }

  static void Capture(IntPtr window, List<Control> result) {
    if (!IsWindowVisible(window)) return;
    var kind = new StringBuilder(96);
    var text = new StringBuilder(2048);
    IntPtr bytes;
    GetClassName(window, kind, kind.Capacity);
    SendMessageTimeout(window, 0x000D, (IntPtr)text.Capacity, text, 2, 250, out bytes);
    result.Add(new Control { Handle = window, Id = GetDlgCtrlID(window), Class = kind.ToString(), Text = text.ToString(), Enabled = IsWindowEnabled(window) });
  }

  public static Control[] Scan(int processId) {
    var result = new List<Control>();
    EnumWindows((window, _) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner != processId || !IsWindowVisible(window)) return true;
      Capture(window, result);
      EnumChildWindows(window, (child, __) => { Capture(child, result); return true; }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }

  public static bool Click(Control button) {
    return IsWindowVisible(button.Handle) && IsWindowEnabled(button.Handle)
      && PostMessage(GetParent(button.Handle), 0x0111, (IntPtr)button.Id, button.Handle);
  }
}
'@

function Add-Evidence($Name, $Data) {
  $entry = @{ name = $Name; utc = [DateTime]::UtcNow.ToString('o'); observed = $Data }
  $checks.Add($entry)
  $entry | ConvertTo-Json -Compress -Depth 8 | Write-Host
}

function Wait-For($Label, [scriptblock]$Condition, [int]$Seconds = 45) {
  $until = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    $value = & $Condition
    if ($value) { return $value }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $until)
  throw "Timed out waiting for $Label"
}

function Get-Asset([string]$Tag) {
  $folder = New-Item -ItemType Directory -Force (Join-Path $root $Tag)
  $name = "Piora-$($Tag.Substring(1))-win-x64-setup.exe"
  $release = gh release view $Tag --repo $repo --json tagName,isDraft,isPrerelease,assets | ConvertFrom-Json
  $asset = $release.assets | Where-Object name -eq $name
  if ($release.tagName -ne $Tag -or $release.isDraft -or !$release.isPrerelease -or !$asset) {
    throw "The expected published installer is absent for $Tag"
  }
  gh release download $Tag --repo $repo --pattern $name --pattern 'SHA256SUMS.txt' --dir $folder.FullName
  $path = Join-Path $folder.FullName $name
  $sum = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  $expected = '^' + $sum + '\s+\*?' + [regex]::Escape($name) + '\s*$'
  if (($asset.digest -and $asset.digest -ne "sha256:$sum") -or
      (Get-Item -LiteralPath $path).Length -ne $asset.size -or
      !(Select-String -LiteralPath (Join-Path $folder.FullName 'SHA256SUMS.txt') -Pattern $expected -Quiet)) {
    throw "Downloaded installer size or SHA-256 did not match release metadata for $Tag"
  }
  Add-Evidence 'published-installer-verified' @{ tag = $Tag; sha256 = $sum; asset = $asset.url }
  return $path
}

function Get-AppVersion { return (Get-Item -LiteralPath $exe).VersionInfo.FileVersion }

function Start-App([string]$Label) {
  $program = Start-Process -FilePath $exe -ArgumentList '--inspect=127.0.0.1:28191','--remote-debugging-port=28192' -Environment $appEnvironment -PassThru
  $processes.Add($program)
  node scripts/installed-upgrade-probe.mjs $Label | Write-Host
  if ($program.HasExited) { throw "The installed application exited too early ($Label)" }
  return $program
}

function Close-App($Program) {
  node scripts/installed-upgrade-probe.mjs quit
  if (!$Program.WaitForExit(45000)) { throw 'The old application did not quit through its own handler' }
  Wait-For 'all test application processes to exit' {
    -not (Get-Process Piora -ErrorAction SilentlyContinue | Where-Object Path -eq $exe)
  } | Out-Null
}

function Start-Setup([string]$Path) {
  $program = Start-Process -FilePath $Path -PassThru
  $processes.Add($program)
  return $program
}

function Get-Prompt($Program) {
  $controls = @([SetupControls]::Scan($Program.Id))
  $message = $controls | Where-Object { $_.Text -match 'is still running|仍在运行|仍在執行' } | Select-Object -First 1
  $retry = $controls | Where-Object { $_.Class -eq 'Button' -and $_.Id -eq 4 -and $_.Enabled } | Select-Object -First 1
  $cancel = $controls | Where-Object { $_.Class -eq 'Button' -and $_.Id -eq 2 -and $_.Enabled -and ($_.Text -replace '&') -match 'Cancel|取消' } | Select-Object -First 1
  if ($message -and $retry -and $cancel) { return @{ message = $message.Text; retry = $retry; cancel = $cancel } }
  if ($Program.HasExited) { throw "Installer exited before the expected prompt ($($Program.ExitCode))" }
  return $null
}

function Require-Prompt($Program, [string]$Label) {
  try { $prompt = Wait-For $Label { Get-Prompt $Program } }
  catch {
    Add-Evidence 'native-controls-on-failure' @([SetupControls]::Scan($Program.Id) | Select-Object Id,Class,Text,Enabled)
    throw
  }
  Add-Evidence $Label @{ message = $prompt.message; buttons = @($prompt.retry.Text,$prompt.cancel.Text); version = (Get-AppVersion) }
  return $prompt
}

function Click-Control($Control) {
  if (![SetupControls]::Click($Control)) { throw "Could not invoke the visible button $($Control.Text)" }
}

function Await-InstallButton($Program) {
  for ($index = 0; $index -lt 5; $index++) {
    $button = Wait-For 'the installation wizard' {
      [SetupControls]::Scan($Program.Id) | Where-Object {
        $_.Class -eq 'Button' -and $_.Enabled -and ($_.Text -replace '&') -match '^(Next\s*>?|I Agree|Install|下一步|同意|安装)$'
      } | Select-Object -First 1
    }
    if (($button.Text -replace '&') -match '^(Install|安装)$') { return $button }
    Click-Control $button
    Start-Sleep -Milliseconds 500
  }
  throw 'The wizard did not reach the installation page'
}

$completed = $false
try {
  $oldPackage = Get-Asset $baseline
  $newPackage = if ($target -eq $baseline) { $oldPackage } else { Get-Asset $target }
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  $baseInstall = Start-Process -FilePath $oldPackage -ArgumentList "/S /D=$install" -Wait -PassThru
  if ($baseInstall.ExitCode -ne 0 -or (Get-AppVersion) -ne $baseline.Substring(1)) { throw 'Could not install the verified old beta' }
  $originalHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
  node scripts/installed-upgrade-probe.mjs prepare
  $oldApp = Start-App 'before'
  node scripts/installed-upgrade-probe.mjs close-window
  Start-Sleep -Milliseconds 700
  if ($oldApp.HasExited) { throw 'Closing the old window unexpectedly exited the old instance' }

  $setup = Start-Setup $newPackage
  $prompt = Require-Prompt $setup 'old-tray-instance-blocks-setup'
  Click-Control $prompt.retry
  Start-Sleep -Seconds 1
  $prompt = Require-Prompt $setup 'retry-while-old-version-runs'
  Click-Control $prompt.cancel
  if (!$setup.WaitForExit(30000) -or $setup.ExitCode -eq 0 -or $oldApp.HasExited -or
      (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $originalHash) {
    throw 'Cancel changed the installed application or its running process'
  }
  Add-Evidence 'cancel-preserves-version-and-process' @{ version = (Get-AppVersion); sha256 = $originalHash; oldProcessAlive = $true }
  if ($target -eq $baseline) {
    Close-App $oldApp
    $completed = $true
    return
  }

  $setup = Start-Setup $newPackage
  $prompt = Require-Prompt $setup 'prompt-before-upgrade'
  Close-App $oldApp
  Click-Control $prompt.retry
  $installButton = Await-InstallButton $setup
  $controls = @([SetupControls]::Scan($setup.Id))
  $directory = $controls | Where-Object { $_.Class -eq 'Edit' -and $_.Text.TrimEnd('\') -ieq $install.TrimEnd('\') }
  if (!$directory) {
    Add-Evidence 'directory-page-controls' @($controls | Select-Object Id,Class,Text,Enabled)
    throw 'The guided installer did not select the existing installation directory'
  }
  $oldApp = Start-App 'before'
  Click-Control $installButton
  $prompt = Require-Prompt $setup 'install-page-rechecks-old-process'
  if ($oldApp.HasExited -or (Get-AppVersion) -ne $baseline.Substring(1) -or
      (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $originalHash) {
    throw 'The old process or executable changed before the second confirmation'
  }
  Close-App $oldApp
  Click-Control $prompt.retry
  $finish = Wait-For 'the installation to finish' {
    if ($setup.HasExited) { return @{ finished = $true } }
    $visible = @([SetupControls]::Scan($setup.Id))
    $button = $visible | Where-Object { $_.Class -eq 'Button' -and $_.Enabled -and ($_.Text -replace '&') -match '^(Finish|完成)$' } | Select-Object -First 1
    if ($button) { return @{ button = $button; launch = ($visible | Where-Object { $_.Class -eq 'Button' -and ($_.Text -replace '&') -match '^Run Piora|^运行 Piora' } | Select-Object -First 1) } }
  } 240
  if ($finish.button) {
    if ($finish.launch) { Click-Control $finish.launch }
    Click-Control $finish.button
  }
  if (!$setup.WaitForExit(45000) -or $setup.ExitCode -ne 0 -or (Get-AppVersion) -ne $target.Substring(1)) {
    throw 'The guided installer did not replace the existing installation with the new beta'
  }
  $installedHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
  if ($installedHash -eq $originalHash) { throw 'The installer reported success without replacing the binary' }
  Add-Evidence 'in-place-upgrade' @{ directory = $install; from = $baseline; to = (Get-AppVersion); sha256 = $installedHash }
  $newApp = Start-App 'after'
  Add-Evidence 'same-profile-chat-visible-after-upgrade' @{ version = (Get-AppVersion) }
  Close-App $newApp
  $completed = $true
}
finally {
  foreach ($proc in $processes) {
    if (!$proc.HasExited) { Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue }
  }
  @{ status = $(if ($completed) { 'passed' } else { 'failed' }); baseline = $baseline; target = $target; checks = $checks } |
    ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $evidence 'upgrade-result.json') -Encoding utf8
}
