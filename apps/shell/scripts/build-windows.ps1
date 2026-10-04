# Builds jobleft for Windows so that someone else can open it: the UI, the Node sidecar tree, and an NSIS installer
# per user (installMode: currentUser; WebView2 is fetched by the bootstrapper when a machine lacks it). This is the
# local counterpart of the installer step in .github/workflows/windows.yml, and it is the Windows answer to
# build-macos.sh, which signs, notarizes and staples; none of that has a Windows equivalent yet (the installer is
# not code-signed, so SmartScreen warns; that is expected and documented in apps/shell/README.md).
#
# Usage: apps/shell/scripts/build-windows.ps1 [--skip-smoke]
#   JOBLEFT_PUBLIK_APP_TOKEN     the public publik app token (pat_jobleft_...); without it the app starts without
#                                JOBLEFT_PUBLIK_ALLOW_LIVE=1, so "Connect to publik" is refused in plain words.
#                                It can also live in the git-ignored apps/shell/publik-app-token.local.
#   --skip-smoke                 build only; do not install, start, check health and stop the app afterwards.
#
# Needs the Visual Studio Build Tools with the MSVC C++ x64/x86 build tools component for cl.exe
# (Microsoft.VisualStudio.Component.VC.Tools.x86.x64; "MSVC v143 - VS 2022 C++ x64/x86 build tools" is its name on
# VS 2022). cl.exe does not have to be on PATH: cargo finds it through the same Visual Studio detection CI relies on.
#
# Unless --skip-smoke is passed, it then smoke-tests the installer it just built: it removes the previous install,
# installs over it, starts the app against a scratch JOBLEFT_HOME under %TEMP%, checks health, and stops it again.
# Quit any running jobleft.exe first, because the single-instance plugin hands a second launch to the running one and
# this launch would then never write a run file. The install folder it replaces is %LOCALAPPDATA%\jobleft under
# installMode currentUser (%ProgramFiles%\jobleft otherwise); the data folder (%APPDATA%\jobleft) is never touched.
[CmdletBinding()]
param(
  [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$Shell = Join-Path $Root 'apps\shell'
$TauriDir = Join-Path $Shell 'src-tauri'
# Cargo output goes to the shared target folder, never into the package (apps/shell/README.md). build-macos.sh does
# the same with `export CARGO_TARGET_DIR`, and .cache/ is git-ignored.
$env:CARGO_TARGET_DIR = Join-Path $Root '.cache\cargo-target'
$SetupDir = Join-Path $env:CARGO_TARGET_DIR 'release\bundle\nsis'

function Say($message) { Write-Host "==> $message" }

# --- Prerequisites. Each failure says what to install, because a first Rust/Tauri build is slow and a wrong toolchain
# --- only shows up as a link error ten minutes in.
Say 'Checking the toolchain'
# Parsed with PowerShell, not `node -p`: PowerShell 5.1 drops the double quotes out of an argument passed to a native
# exe, so any JS here loses its string delimiters.
$nodeVersion = node -v
$nodeMajor = [int](($nodeVersion -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 24) { throw "Node 24 or newer is required (found $nodeVersion); apps/shell/package.json engines says node >=24." }
"node $nodeVersion, pnpm $(pnpm --version)"

if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
  throw 'No rustc on PATH. Install the stable toolchain (https://rustup.rs) or let CI do the first build.'
}
"rust $(rustc --version)"

# The VC tools are an installed component, not a PATH entry, so ask the installer where they are.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vcTools = if (Test-Path $vswhere) { & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath } else { $null }
if (-not $vcTools) {
  throw "No MSVC C++ build tools found (vswhere: $vswhere). Install the Visual Studio Build Tools with the MSVC C++ x64/x86 build tools component, or run: '$vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64'"
}
"MSVC tools: $vcTools"

# --- The CI sequence, in order. fetch-node is separate because it is easy to forget: pack.ts copies the sidecar
# --- Node into the tree, and without it the bundle has no runtime to start the server with.
Say 'Building the UI'
Push-Location $Root
try { pnpm --filter @jobleft/ui build | Out-Null } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "the UI build failed (exit $LASTEXITCODE)" }

Say 'Fetching the Node runtime for the sidecar'
node (Join-Path $Shell 'scripts\fetch-node.mjs') --target win-x64
if ($LASTEXITCODE -ne 0) { throw "fetch-node.mjs failed (exit $LASTEXITCODE)" }

Say 'Packing the sidecar tree'
node (Join-Path $Shell 'scripts\pack.ts') --target win-x64
if ($LASTEXITCODE -ne 0) { throw "pack.ts failed (exit $LASTEXITCODE)" }

# The Tauri CLI is run by its file in the pnpm store: `pnpm exec tauri` drops the link on this workspace's install policy.
Say 'Building the NSIS installer (the first build compiles every Rust dependency; expect several minutes)'
  $cli = $null
  $buildStart = Get-Date
  # Ensure no stale installer artifacts from previous builds remain before building
  if (Test-Path -LiteralPath $SetupDir) {
    Get-ChildItem -LiteralPath $SetupDir -Filter '*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
    }
  }
  Push-Location $Shell
  try {
    $cli = (node -p "require.resolve('@tauri-apps/cli/tauri.js', { paths: ['.'] })") | Select-Object -Last 1
    node $cli build --bundles nsis
  } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }

  $setup = Get-ChildItem -Path $SetupDir -Filter '*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $setup) { throw "No installer was produced in $SetupDir" }
  # Require the installer to have been produced by THIS build (not a leftover)
  if ($setup.LastWriteTime -lt $buildStart) {
    throw "installer $($setup.FullName) was created before this build started ($buildStart); refusing to use a stale artifact"
  }
  Say ("Installer: {0} ({1} MB)" -f $setup.FullName, [math]::Round($setup.Length / 1MB, 1))

if ($SkipSmoke) {
  Write-Host "`nSkipped the smoke test (--skip-smoke)."
  exit 0
}

# --- The smoke test is the same one the workflow runs, so a locally built installer is proven the same way: installed
# --- silently, started, answering health, and stopped through the shutdown route (Windows has no SIGTERM).
# --- Crawling is switched off so this does not start a live crawl against real boards.
#
# --- Every check below exists because something stale can fake a green run: an old jobleft.exe a failed install left
# --- behind, a run/server.json from an earlier run, a run/shell.json naming somebody else's process, or a jobleft.exe
# --- still running that swallows this launch. So nothing here searches the disk for a jobleft.exe to fall back on, and
# --- the run files are read out of a scratch data folder that this launch is the only writer of.
$conf = Get-Content (Join-Path $TauriDir 'tauri.conf.json') -Raw | ConvertFrom-Json
$exeName = "$($conf.mainBinaryName).exe"
# installMode currentUser is the one NSIS puts under LOCALAPPDATA; perMachine and both go to Program Files, where /S
# takes the machine-wide default without asking.
$root = if ($conf.bundle.windows.nsis.installMode -eq 'currentUser') { $env:LOCALAPPDATA } else { $env:ProgramFiles }
$InstallDir = Join-Path $root $conf.productName
$Exe = Join-Path $InstallDir $exeName
# The derivation is checked rather than trusted, because productName is read out of tauri.conf.json and only a plain
# name may be joined onto the root. This is also what keeps the removal below away from %APPDATA%\jobleft, the data
# folder, which sits one folder away from the install folder and holds the actual job history.
if ((Split-Path -Parent $InstallDir) -ne $root -or $InstallDir -eq (Join-Path $env:APPDATA $conf.productName)) {
  throw "tauri.conf.json puts the install in '$InstallDir', which is not '$root\$($conf.productName)'; refusing to install or remove anything"
}

# A second launch would be handed to a running jobleft by the single-instance plugin, and that process writes its run
# files into its own data folder, so this smoke test would sit waiting for a file that is never coming.
$busy = @(Get-Process -Name $conf.mainBinaryName -ErrorAction SilentlyContinue)
if ($busy.Count) {
  throw "jobleft is already running (pid $($busy.Id -join ', ')); quit it first, or the single-instance plugin hands this launch to it"
}

Say "Smoke: install $Exe, start, health, stop"
# The old install goes first so the executable that appears below can only be this one's. It is an app directory, not
# a data folder: the guard refuses to remove anything that does not look like an install of this app.
if (Test-Path -LiteralPath $InstallDir) {
  $left = @(Get-ChildItem -LiteralPath $InstallDir -Force)
  if ($left.Count -and -not (Test-Path -LiteralPath $Exe)) {
    throw "refusing to remove $InstallDir : it is not empty and holds no $exeName, so it is not an install of this app"
  }
  "removing the previous install ($($left.Count) entries)"
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

$installer = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -PassThru -Wait
$code = try { $installer.ExitCode } catch { $null }
"installer exit code: $code"
if ($code -ne 0) {
  throw "the installer did not report success (exit code: '$code'), so there is nothing to smoke test. Stopping here on purpose: going looking for a jobleft.exe now would only find whatever an earlier build installed, and a green run against that would say nothing about this build"
}
if (-not (Test-Path -LiteralPath $Exe)) {
  $wrote = if (Test-Path -LiteralPath $InstallDir) { (Get-ChildItem -LiteralPath $InstallDir -Force | ForEach-Object { $_.Name }) -join ', ' } else { "$InstallDir does not exist" }
  throw "the installer exited 0 but there is no $Exe (it wrote: $wrote)"
}
"installed at $Exe ($([math]::Round((Get-Item -LiteralPath $Exe).Length / 1MB, 1)) MB, from $($setup.Name))"

# A scratch data folder, new for this run: the run files checked below are then this launch's own, and the real
# %APPDATA%\jobleft is neither read nor written. Both ends honour JOBLEFT_HOME - data_home() in
# src-tauri/src/lib.rs and resolveHome() in apps/server/src/home.ts.
$DataHome = Join-Path $env:TEMP "jobleft-smoke-$PID-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$env:JOBLEFT_HOME = $DataHome
$env:JOBLEFT_AUTO_CRAWL = '0'
$env:JOBLEFT_SEED_BOARDS = 'none'
$RunDir = Join-Path $DataHome 'run'
$RunFile = Join-Path $RunDir 'server.json'
$ShellFile = Join-Path $RunDir 'shell.json'
New-Item -ItemType Directory -Path $RunDir -Force | Out-Null
foreach ($stale in @($RunFile, $ShellFile, (Join-Path $RunDir 'server.lock'))) {
  if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force; "removed the stale $stale" }
}

$app = $null
$serverPid = $null
$clean = $false
try {
  $launchedAt = Get-Date
  $app = Start-Process -FilePath $Exe -PassThru
  "launched pid $($app.Id) at $launchedAt, data folder $DataHome"
  $deadline = (Get-Date).AddSeconds(40)
  while (-not (Test-Path -LiteralPath $RunFile) -and (Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $RunFile)) {
    if (-not (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) { throw "the launched jobleft.exe exited before writing run/server.json" }
    throw "no run/server.json in $RunDir within 40 s"
  }
  if ((Get-Item -LiteralPath $RunFile).LastWriteTime -lt $launchedAt) {
    throw "run/server.json is older than this launch, so it belongs to an earlier run and says nothing about this one"
  }
  $j = Get-Content -LiteralPath $RunFile -Raw | ConvertFrom-Json
  $port = if ($j.PSObject.Properties['port']) { $j.port } else { $null }
  $serverPid = if ($j.PSObject.Properties['pid']) { $j.pid } else { $null }
  if (-not $port -or -not $serverPid) { throw 'run/server.json has no port and pid' }
  # Ensure the server PID we read is still alive and belongs to the Node sidecar (not the shell)
  $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
  if (-not $proc) { throw "server pid $serverPid from run/server.json is not running" }
  $procName = $proc.ProcessName
  # Node sidecar process name on Windows is 'node' (node.exe)
  $expectedServerName = 'node'
  if ($procName -ne $expectedServerName) { throw "server pid $serverPid is $procName (expected $expectedServerName); possible PID reuse" }
  # Path validation for server is optional; we don't have the exact sidecar path in this script.
  # The launch token is printed nowhere in this script: it is the x-jobleft-token header value and grants full access to
  # the loopback API for as long as the app runs.
  "server on port $port, pid $serverPid"

  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/v1/health"
  "health: $($health | ConvertTo-Json -Compress)"
  $healthApp = if ($health.PSObject.Properties['app']) { $health.app } else { $null }
  if ($healthApp -ne 'jobleft') { throw "health did not answer jobleft (app: '$healthApp')" }

  # shell.json is written by the shell process itself once the window is up, so its pid is the one to compare against:
  # a file belonging to another jobleft would carry that one's pid, not the one this script started.
  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Test-Path -LiteralPath $ShellFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Path -LiteralPath $ShellFile)) { throw "the window never opened: no run/shell.json within 20 s" }
  $s = Get-Content -LiteralPath $ShellFile -Raw | ConvertFrom-Json
  $shellPid = if ($s.PSObject.Properties['pid']) { $s.pid } else { $null }
  if ($shellPid -ne $app.Id) { throw "run/shell.json names shell pid $shellPid but this script launched $($app.Id)" }
  "window opened by that same pid, on port $($s.port)"

  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/v1/shutdown" -Headers @{ 'x-jobleft-token' = $j.token } -ContentType 'application/json' -Body '{}' | Out-Null
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Process -Id $serverPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) { throw "the server (pid $serverPid) is still running 15 s after the shutdown route" }
  "the server stopped itself and took its run file with it: $(-not (Test-Path -LiteralPath $RunFile))"

  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  try { $null = $app.WaitForExit(15000) } catch { }
  if (Get-Process -Id $app.Id -ErrorAction SilentlyContinue) { throw "the launched jobleft.exe (pid $($app.Id)) is still running after the smoke test" }
  $clean = $true
}
finally {
  # Best effort, and deliberately silent about its own failures: a throw in here would replace whatever went wrong
  # above, which is the one thing a cleanup block must never do.
    if ($serverPid) {
      $sp = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
      # Server is the Node sidecar; only kill if it looks like node (or if we cannot determine) as a last resort.
      if ($sp) {
        $spName = $sp.ProcessName
        if ($spName -eq 'node') {
          $shouldKill = $true
        } else {
          # If it's not 'node', do not auto-kill to avoid collateral damage
          $shouldKill = $false
        }
        if ($shouldKill) {
          try { Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue; "killed the leftover server (pid $serverPid)" } catch { }
        }
      }
    }
   if ($app -and (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) {
     $ap = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
     if ($ap -and $ap.ProcessName -eq $conf.mainBinaryName) {
       $shouldKill = $false
       try {
         $apPath = $ap.Path
         if ($apPath -and (Test-Path -LiteralPath $Exe)) {
           $expectedPath = [System.IO.Path]::GetFullPath($Exe)
           $actualPath = [System.IO.Path]::GetFullPath($apPath)
           if ($actualPath -eq $expectedPath) { $shouldKill = $true }
         }
       } catch {
         $shouldKill = $false
       }
       if ($shouldKill) {
         try { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue; "killed the leftover jobleft (pid $($app.Id))" } catch { }
       }
     }
   }
  if ($clean) {
    try { Remove-Item -LiteralPath $DataHome -Recurse -Force -ErrorAction SilentlyContinue; "removed the scratch data folder $DataHome" } catch { }
  }
  else {
    $log = Join-Path $DataHome 'logs\sidecar.log'
    if (Test-Path -LiteralPath $log) { "`n--- sidecar.log, last 30 lines ---"; Get-Content -LiteralPath $log -Tail 30 }
    "`nthe scratch data folder is left for diagnosis: $DataHome"
  }
}

Write-Host "`nInstaller: $($setup.FullName)"
Write-Host "Install folder: $InstallDir"
