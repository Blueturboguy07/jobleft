# Live update proof on a GitHub Windows runner (.github/workflows/live-update-proof.yml). Never run it on a desk PC: it
# installs jobleft, starts it and clicks its dialogs.
#
#   pwsh -NoProfile -File apps/shell/test/live-proof/windows.ps1 -FromTag v0.1.9 -Expect 0.1.10 -Out out
#
# Downloads the installer of -FromTag from the GitHub release (the file publik's listing links), installs it silently
# as a user's copy (per user, %LOCALAPPDATA%\jobleft), and starts jobleft.exe with no test hook and no feed override:
# the release build reads its feed URL (https://publikhq.com/api/updates/jobleft/latest.json) from its own config.
# The app gets DO_NOT_TRACK=1 (a runner is not a user) and PUBLIK_ORIGIN=http://127.0.0.1:9, so that the sign-in gate of
# the local service makes no install on publik; neither touches the updater. Nobody signs in.
# -Expect equal to the -FromTag version: the app must find no update and stay as it is.
# -Expect higher: "Later" must leave the app running on the old version; then, at the next start, "Restart and Install"
# must bring jobleft back by itself as -Expect. (The tray menu is not driven on Windows: macos.sh drives
# "Check for Updates..." in the macOS menu bar item.)
param(
  [Parameter(Mandatory = $true)][string]$FromTag,
  [Parameter(Mandatory = $true)][string]$Expect,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = "Continue"
$From = $FromTag -replace '^v', ''
if ($From -notmatch '^\d+\.\d+\.\d+$' -or $Expect -notmatch '^\d+\.\d+\.\d+$') { Write-Host "from_tag must be v<x.y.z> and expect_version x.y.z"; exit 2 }
$Update = $Expect -ne $From
$Repo = if ($env:GITHUB_REPOSITORY) { $env:GITHUB_REPOSITORY } else { "Blueturboguy07/jobleft" }
$FeedUrl = "https://publikhq.com/api/updates/jobleft/latest.json"
$InstallDir = Join-Path $env:LOCALAPPDATA "jobleft"
$Exe = Join-Path $InstallDir "jobleft.exe"
$Data = Join-Path $env:APPDATA "jobleft"
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$Dl = Join-Path $env:RUNNER_TEMP "live-proof-download"
New-Item -ItemType Directory -Force $Dl | Out-Null
$results = Join-Path $Out "results.md"
"| Check | Result | Detail |`n|---|---|---|" | Set-Content $results
$script:pass = 0; $script:fails = 0
function Check([string]$name, [bool]$ok, [string]$detail = "") {
  if ($ok) { $script:pass++; Write-Host "PASS  $name ($detail)"; "| $name | PASS | $detail |" | Add-Content $results }
  else { $script:fails++; Write-Host "FAIL  $name ($detail)"; "| $name | **FAIL** | $detail |" | Add-Content $results }
}
function Info([string]$name, [string]$detail = "") { Write-Host "INFO  $name ($detail)"; "| $name | info | $detail |" | Add-Content $results }
function Shot([string]$name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
  } catch { Write-Host "screenshot ${name}: $_" }
}
function Disk-Version { $e = Get-Item $Exe -ErrorAction SilentlyContinue; if ($e) { $e.VersionInfo.ProductVersion } else { "" } }
function Reg-Version {
  $r = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "jobleft*" } | Select-Object -First 1
  if ($r) { $r.DisplayVersion } else { "" }
}
function App-Procs { @(Get-Process -Name jobleft -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$InstallDir\*" }) }
function Sidecars { @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$InstallDir\*" }) }
function Shell-Json { $f = Join-Path $Data "run\shell.json"; if (Test-Path $f) { try { Get-Content $f -Raw | ConvertFrom-Json } catch { $null } } else { $null } }
function Health-Version {
  $j = Shell-Json
  if (-not $j) { return "" }
  try { (Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$($j.port)/api/v1/health").version } catch { "" }
}
function UI([string]$cmd, [int]$procId, [string]$name = "") {
  $a = @("-NoProfile", "-File", (Join-Path $PSScriptRoot "ui-win.ps1"), $cmd, $procId)
  if ($name) { $a += $name }
  (& powershell.exe @a 2>&1 | Out-String).Trim()
}
function Wait-Log([string]$file, [string]$pattern, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if ((Test-Path $file) -and (Select-String -Path $file -Pattern $pattern -Quiet)) { return $true }
    Start-Sleep 1
  }
  return $false
}
function Wait-Dialog([int]$procId, [string]$text, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    $d = UI dump $procId
    if ($d -like "*$text*") { return $d }
    Start-Sleep 1
  }
  return (UI dump $procId)
}
function Stop-All {
  App-Procs | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 15 -and (Sidecars).Count -gt 0; $i++) { Start-Sleep 1 }
  Sidecars | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 1
}
# Starts jobleft.exe as a person's launch does, with its stdout and stderr in files. Returns the process.
function Launch([string]$name) {
  Remove-Item (Join-Path $Data "run\shell.json") -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $Exe -PassThru -RedirectStandardOutput "$Out\$name.out" -RedirectStandardError "$Out\$name.err"
  for ($i = 0; $i -lt 120; $i++) { $j = Shell-Json; if ($j -and $j.pid -eq $p.Id) { break }; Start-Sleep 1 }
  return $p
}
function Updates-Lines([string]$file) { if (Test-Path $file) { @(Select-String -Path $file -Pattern '^updates: ' | ForEach-Object { $_.Line }) -join '; ' } else { "" } }

Write-Host "$([System.Environment]::OSVersion.VersionString); from $FromTag, expect $Expect"

Write-Host "==> 0. What the live feed announces now"
$feedV = ""
try { $feed = Invoke-RestMethod -TimeoutSec 20 $FeedUrl; $feedV = $feed.version; $feed | ConvertTo-Json -Depth 5 | Set-Content "$Out\live-feed.json" } catch { Write-Host "feed: $_" }
Check "the live feed ($FeedUrl) announces $Expect" ($feedV -eq $Expect) "it announces $feedV"

Write-Host "==> 1. Download and install $FromTag"
$setupName = "jobleft_$($From)_x64-setup.exe"
$setupUrl = "https://github.com/$Repo/releases/download/$FromTag/$setupName"
$setup = Join-Path $Dl $setupName
try { Invoke-WebRequest -UseBasicParsing -Uri $setupUrl -OutFile $setup } catch { Write-Host "download: $_" }
Check "downloaded $setupName from the release" (Test-Path $setup) "$setupUrl, sha256 $(if (Test-Path $setup) { (Get-FileHash $setup).Hash.Substring(0, 16) })"
Stop-All
$inst = Start-Process -FilePath $setup -ArgumentList "/S" -PassThru -Wait
Stop-All
Check "the installer ran silently (exit 0)" ($inst.ExitCode -eq 0) "exit $($inst.ExitCode)"
Check "jobleft $From is installed (jobleft.exe version, uninstall entry)" ((Disk-Version) -eq $From -and (Reg-Version) -eq $From) "$Exe $(Disk-Version), registry $(Reg-Version)"
$hashBefore = if (Test-Path $Exe) { (Get-FileHash $Exe).Hash } else { "" }

Write-Host "==> 1b. The UI driver reads and clicks a Win32 dialog (the same kind of window as the update question)"
# A message box of another process, titled like the question: ui-win.ps1 must find it by process id, read its text
# and click a button by name. The app's own question is clicked with the same two commands below.
$probe = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @("-NoProfile", "-Command",
  "Add-Type -AssemblyName System.Windows.Forms; exit [int][System.Windows.Forms.MessageBox]::Show('jobleft 0.0.0 is ready. (the harness checks its UI driver)', 'jobleft update', 'OKCancel')")
$d = Wait-Dialog $probe.Id "is ready" 30
$r = UI click $probe.Id "Cancel"
$exited = $probe.WaitForExit(15000)
Check "the UI driver reads a dialog's text and clicks its button" ($d -like "*jobleft 0.0.0 is ready*" -and $r -like "clicked*" -and $exited -and $probe.ExitCode -eq 2) "$($d -replace "`r?`n", ' / '); $r; exit $(if ($exited) { $probe.ExitCode })"
if (-not $exited) { Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue }

Write-Host "==> 2. Start jobleft.exe the normal way"
Remove-Item Env:PUBLIK_NO_AUTO_UPDATE, Env:PUBLIK_UPDATE_SELF_TEST, Env:PUBLIK_UPDATE_SELF_TEST_OUT -ErrorAction SilentlyContinue
$env:DO_NOT_TRACK = "1"
$env:PUBLIK_ORIGIN = "http://127.0.0.1:9"
$p1 = Launch "app-1"
$j = Shell-Json
Check "jobleft started; its window opened and its local service answers" ($null -ne $j -and $j.pid -eq $p1.Id -and $j.windowShown -eq $true -and (Health-Version) -ne "") "pid $($p1.Id), windowShown $($j.windowShown), service $(Health-Version)"
Start-Sleep 3; Shot "launched"

Write-Host "==> 3. The updater's first check (10 s after launch) against the live feed"
$null = Wait-Log "$Out\app-1.err" '^updates: ' 180
$lines = Updates-Lines "$Out\app-1.err"
Write-Host "log: $lines"
Check "no check failed" (-not ($lines -like "*the check failed*")) $lines
if (-not $Update) {
  Check "the updater asked the live feed: $From is the latest version" (Select-String -Path "$Out\app-1.err" -Pattern "^updates: $([regex]::Escape($From)) is the latest version$" -Quiet) $lines
  Start-Sleep 5
  $d = UI dump $p1.Id
  $d | Set-Content "$Out\windows-after-check.txt"
  Check "no update question" (-not ($d -like "*is ready*")) ($d -replace "`r?`n", " / ")
  $p1.Refresh()
  Check "the app keeps running as $From" (-not $p1.HasExited -and (Disk-Version) -eq $From -and (Health-Version) -eq $From -and (Get-FileHash $Exe).Hash -eq $hashBefore) "running $(-not $p1.HasExited), disk $(Disk-Version), service $(Health-Version)"
  Info "Check for Updates... (tray menu) is not driven on Windows" "macOS drives it in the menu bar item"
  Stop-All
} else {
  Check "the updater downloaded and verified $Expect" (Select-String -Path "$Out\app-1.err" -Pattern "^updates: jobleft $([regex]::Escape($Expect)) is ready$" -Quiet) $lines
  $d = Wait-Dialog $p1.Id "is ready" 30
  $d | Set-Content "$Out\question-1.txt"; Shot "question-1"
  Check "the question is on screen: jobleft $Expect is ready, Restart and Install or Later" ($d -like "*jobleft $Expect is ready*" -and $d -like "*Restart and Install*" -and $d -like "*Later*") ($d -replace "`r?`n", " / ")
  Check "nothing is installed before the answer" ((Disk-Version) -eq $From -and (Get-FileHash $Exe).Hash -eq $hashBefore) "$(Disk-Version)"

  Write-Host "==> 4a. The answer Later"
  $r = UI click $p1.Id "Later"
  Check "Later is clicked" ($r -like "clicked*") $r
  Start-Sleep 5
  $d = UI dump $p1.Id
  $p1.Refresh()
  Check "Later: the question closes" (-not ($d -like "*is ready*")) ($d -replace "`r?`n", " / ")
  Check "Later: the app keeps running, on $From" (-not $p1.HasExited -and (Disk-Version) -eq $From -and (Get-FileHash $Exe).Hash -eq $hashBefore -and (Health-Version) -eq $From) "running $(-not $p1.HasExited), disk $(Disk-Version), service $(Health-Version)"
  Shot "after-later"

  Write-Host "==> 4b. Quit, start again: the question comes back with the first check; the answer Restart and Install"
  # The tray menu's Quit is not driven on Windows: the process is ended, and the local service ends with its parent.
  Stop-All
  $p2 = Launch "app-2"
  $null = Wait-Log "$Out\app-2.err" "^updates: jobleft $([regex]::Escape($Expect)) is ready$" 180
  $d = Wait-Dialog $p2.Id "is ready" 30
  $d | Set-Content "$Out\question-2.txt"; Shot "question-2"
  Check "after a new start the question comes back" ($d -like "*jobleft $Expect is ready*") (Updates-Lines "$Out\app-2.err")
  $tempBefore = @(Get-ChildItem $env:TEMP -Directory -Filter "*-$Expect-updater-*" -ErrorAction SilentlyContinue).Count
  $r = UI click $p2.Id "Restart and Install"
  Check "Restart and Install is clicked" ($r -like "clicked*") $r

  Write-Host "==> 4c. The installer of the app's own updater, then jobleft $Expect"
  $seenInstaller = ""
  $newProc = $null
  $deadline = (Get-Date).AddSeconds(300)
  while ((Get-Date) -lt $deadline) {
    $i = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*-$Expect-installer" } | Select-Object -First 1
    if ($i -and -not $seenInstaller) { $seenInstaller = "$($i.Name) $($i.Path)" }
    $newProc = App-Procs | Where-Object { $_.Id -ne $p2.Id } | Select-Object -First 1
    if ($newProc -and (Disk-Version) -eq $Expect -and -not $i) { break }
    Start-Sleep 1
  }
  $tempDirs = @(Get-ChildItem $env:TEMP -Directory -Filter "*-$Expect-updater-*" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  Check "the app's own updater fetched the installer (%TEMP%\\jobleft-$Expect-updater-*)" ($seenInstaller -like "*-$Expect-updater-*" -or $tempDirs.Count -gt $tempBefore) "installer process: $seenInstaller; temp dirs: $($tempDirs -join ', ')"
  Check "the old process ($From) has ended" ($p2.HasExited -or $null -eq (Get-Process -Id $p2.Id -ErrorAction SilentlyContinue)) "pid $($p2.Id)"
  Check "jobleft started again by itself, as a new process" ($null -ne $newProc) "new pid $($newProc.Id) $($newProc.Path)"
  for ($k = 0; $k -lt 90; $k++) { $j = Shell-Json; if ($j -and $newProc -and $j.pid -eq $newProc.Id) { break }; Start-Sleep 1 }
  Check "jobleft.exe on disk and the uninstall entry say $Expect" ((Disk-Version) -eq $Expect -and (Reg-Version) -eq $Expect) "disk $(Disk-Version), registry $(Reg-Version)"
  $runV = if ($newProc) { try { $newProc.MainModule.FileVersionInfo.ProductVersion } catch { "" } } else { "" }
  Check "the running process is $Expect (its main module's version)" ($runV -eq $Expect) "pid $($newProc.Id): $runV"
  Check "the running app's window and local service are up, and the service reports $Expect" ($j -and $j.windowShown -eq $true -and (Health-Version) -eq $Expect) "windowShown $($j.windowShown), service $(Health-Version)"
  $copies = @(Get-ChildItem $InstallDir -Recurse -Filter jobleft.exe -ErrorAction SilentlyContinue)
  Check "one install of jobleft, not two" ($copies.Count -eq 1) "$(($copies | ForEach-Object FullName) -join ', ')"
  $downloads = @(Get-ChildItem $Dl -File | ForEach-Object Name)
  Check "no manual download: the only jobleft file this job downloaded is $setupName" ($downloads.Count -eq 1 -and $downloads[0] -eq $setupName) ($downloads -join ', ')
  Shot "restarted"

  Write-Host "==> 5. Quit and start again: the background check of $Expect itself"
  Stop-All
  $p3 = Launch "app-3"
  $null = Wait-Log "$Out\app-3.err" '^updates: ' 120
  Check "after a new start, $Expect asks the live feed: $Expect is the latest version" (Select-String -Path "$Out\app-3.err" -Pattern "^updates: $([regex]::Escape($Expect)) is the latest version$" -Quiet) (Updates-Lines "$Out\app-3.err")
  Info "Check for Updates... (tray menu) is not driven on Windows" "macOS drives it in the menu bar item"
  Stop-All
}

Copy-Item (Join-Path $Data "logs") (Join-Path $Out "app-data-logs") -Recurse -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "$($script:pass) passed, $($script:fails) failed"
if ($env:GITHUB_STEP_SUMMARY) { "### Windows live update proof: $FromTag -> ${Expect}: $($script:pass) passed, $($script:fails) failed`n" | Add-Content $env:GITHUB_STEP_SUMMARY; Get-Content $results | Add-Content $env:GITHUB_STEP_SUMMARY }
if ($script:fails -gt 0) { exit 1 }
exit 0
