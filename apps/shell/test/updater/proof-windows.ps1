# Updater proof on a Windows GitHub runner (updater-proof.yml), adapted from the publik template (GSpot): installs
# jobleft N with its NSIS installer, runs N's updater self-test against a good feed and three bad ones, and checks what
# is on disk after each. Uses the release tool for the feed (apps/shell/scripts/updater-latest-json.mjs).
# jobleft: the good update runs with the local service (node.exe from the install folder) up, as for a person, and
# the installer must still replace the app.
#
#   pwsh -File apps/shell/test/updater/proof-windows.ps1 -N <N setup.exe> -N1 <N+1 setup.exe> -Out <dir>
# Env: FEED_PORT (the port the test builds were compiled to use). N+1's .sig must sit next to it (written by
# `tauri build` with the update key, as in windows.yml).
param(
  [Parameter(Mandatory = $true)][string]$N,
  [Parameter(Mandatory = $true)][string]$N1,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..\..\..").Path
$ShellDir = Join-Path $Root "apps\shell"
$Port = $env:FEED_PORT
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$Feed = Join-Path $env:RUNNER_TEMP "feed"
New-Item -ItemType Directory -Force $Feed | Out-Null
$InstallDir = Join-Path $env:LOCALAPPDATA "jobleft"
$script:pass = 0; $script:fails = 0
$results = Join-Path $Out "results.md"
"| Check | Result | Detail |`n|---|---|---|" | Set-Content $results
function Check([string]$name, [bool]$ok, [string]$detail = "") {
  if ($ok) { $script:pass++; Write-Host "PASS  $name ($detail)"; "| $name | PASS | $detail |" | Add-Content $results }
  else { $script:fails++; Write-Host "FAIL  $name ($detail)"; "| $name | **FAIL** | $detail |" | Add-Content $results }
}
function Last([string]$file) {
  if (-not (Test-Path $file)) { return $null }
  $lines = @(Get-Content $file | Where-Object { $_.Trim() })
  if ($lines.Count -eq 0) { return $null }
  return $lines[-1] | ConvertFrom-Json
}
function Shot([string]$name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
  } catch { Write-Host "screenshot $name failed: $_" }
}
function Version-Of([string]$base) { return ($base -replace '^jobleft_', '' -replace '_x64-setup\.exe$', '') }
# The install folder holds jobleft.exe and the sidecar's node.exe: the app is jobleft.exe, by name.
function Installed-Exe { Get-Item (Join-Path $InstallDir "jobleft.exe") -ErrorAction SilentlyContinue }
function Disk-Version { $e = Installed-Exe; if ($e) { return $e.VersionInfo.ProductVersion } else { return "" } }
function Reg-Version { $r = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "jobleft*" } | Select-Object -First 1; if ($r) { return $r.DisplayVersion } else { return "" } }
# The updater writes the installer to %TEMP%\<App>-<version>-updater-*\<App>-<version>-installer.exe and runs it from
# there (names from tauri-plugin-updater).
function Updater-Installers { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*-$vN1-installer" } }
function Updater-TempDirs { Get-ChildItem $env:TEMP -Directory -Filter "*-$vN1-updater-*" -ErrorAction SilentlyContinue }
function Sidecars { @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$InstallDir\*" }) }
function Stop-App {
  Get-Process -Name jobleft -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Sidecars | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 1
}
# Runs the installed app's self-test; returns the exit code (124 on a 180 s timeout).
function SelfTest([string]$mode, [string]$report) {
  Remove-Item $report -ErrorAction SilentlyContinue
  $env:PUBLIK_UPDATE_SELF_TEST = $mode
  $env:PUBLIK_UPDATE_SELF_TEST_OUT = $report
  $exe = Installed-Exe
  $p = Start-Process -FilePath $exe.FullName -PassThru -RedirectStandardOutput "$report.stdout" -RedirectStandardError "$report.log"
  $null = $p.Handle
  $done = $p.WaitForExit(180000)
  Remove-Item Env:PUBLIK_UPDATE_SELF_TEST, Env:PUBLIK_UPDATE_SELF_TEST_OUT -ErrorAction SilentlyContinue
  if (-not $done) { $p.Kill(); return 124 }
  return $p.ExitCode
}

$vN = Version-Of (Split-Path $N -Leaf)
$vN1 = Version-Of (Split-Path $N1 -Leaf)
Write-Host "N=$vN  N+1=$vN1"
Push-Location $ShellDir
$cliJs = node -p "require.resolve('@tauri-apps/cli/tauri.js', { paths: ['.'] })"
Pop-Location

Write-Host "==> The feeds, with the release tool"
$pkg = Split-Path $N1 -Leaf
Copy-Item $N1 (Join-Path $Feed $pkg)
Copy-Item "$N1.sig" (Join-Path $Feed "$pkg.sig")
& node "$ShellDir\scripts\updater-latest-json.mjs" --version $vN1 --allow-http --base-url "http://127.0.0.1:$Port/" --platform "windows-x86_64=$Feed\$pkg" --notes "updater proof" --out "$Feed\latest-good.json"
if ($LASTEXITCODE -ne 0) { throw "updater-latest-json refused the N+1 installer" }
& node "$ShellDir\scripts\updater-latest-json.mjs" --version $vN1 --base-url "https://github.com/$env:GITHUB_REPOSITORY/releases/download/v$vN1/" --platform "windows-x86_64=$Feed\$pkg" --notes "updater proof" --out "$Out\latest-release-form.json"
$rel = Get-Content "$Out\latest-release-form.json" -Raw | ConvertFrom-Json
Check "release feed has the absolute GitHub asset URL" ($rel.platforms.'windows-x86_64'.url -eq "https://github.com/$env:GITHUB_REPOSITORY/releases/download/v$vN1/$pkg") "$($rel.platforms.'windows-x86_64'.url)"
# A signature over the same installer from another key. The throwaway key has a password, given on the command line:
# without one, Tauri CLI 2.11 waits for a password prompt (the first run of this proof hung there).
$other = Join-Path $env:RUNNER_TEMP "other"
New-Item -ItemType Directory -Force $other | Out-Null
$null | & node $cliJs signer generate --ci -w "$other\other.key" -p proof-other | Out-Null
Copy-Item $N1 "$other\$pkg"
$savedKey = $env:TAURI_SIGNING_PRIVATE_KEY; $savedPw = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
$null | & node $cliJs signer sign -f "$other\other.key" -p proof-other --app-version $vN1 "$other\$pkg" | Out-Null
$env:TAURI_SIGNING_PRIVATE_KEY = $savedKey; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $savedPw
if (-not (Test-Path "$other\$pkg.sig")) { throw "no foreign signature was made" }
& node "$ShellDir\test\updater\make-feeds.mjs" $Feed windows-x86_64 $pkg "$other\$pkg.sig"
if ($LASTEXITCODE -ne 0) { throw "make-feeds failed" }
Copy-Item "$Feed\latest-*.json" $Out

Write-Host "==> Install N"
$inst = Start-Process -FilePath $N -ArgumentList "/S" -PassThru -Wait
Check "N installs silently" ($inst.ExitCode -eq 0) "exit $($inst.ExitCode)"
Stop-App
$exe = Installed-Exe
Check "N is on disk" ($null -ne $exe -and (Disk-Version) -like "$vN*" -and (Test-Path (Join-Path $InstallDir "node.exe"))) "$($exe.FullName) $(Disk-Version), node.exe: $(Test-Path (Join-Path $InstallDir 'node.exe'))"

$server = Start-Process -FilePath python -ArgumentList "-m", "http.server", $Port, "--bind", "127.0.0.1", "--directory", $Feed -PassThru -RedirectStandardError "$Out\feed-server.log"
for ($i = 0; $i -lt 20; $i++) { try { Invoke-WebRequest "http://127.0.0.1:$Port/latest-good.json" -UseBasicParsing | Out-Null; break } catch { Start-Sleep 1 } }

$rc = SelfTest "version" "$Out\r-version-N.jsonl"; $r = Last "$Out\r-version-N.jsonl"
Check "N reports its version" ($r.version -eq $vN) "$($r.version)"
Copy-Item "$Feed\latest-good.json" "$Feed\latest.json" -Force
$rc = SelfTest "check" "$Out\r-check-N.jsonl"; $r = Last "$Out\r-check-N.jsonl"
Check "N finds N+1 on the feed" ($r.result -eq "available" -and $r.new_version -eq $vN1) "result=$($r.result) new=$($r.new_version)"

$reasons = @{ badsig = "created with a different key"; tampered = "signature verification failed"; version = "signed for version $vN1 but the update endpoint announced" }
foreach ($case in @("badsig", "tampered", "version")) {
  Copy-Item "$Feed\latest-$case.json" "$Feed\latest.json" -Force
  $hashBefore = (Get-FileHash (Installed-Exe).FullName).Hash
  $rc = SelfTest "install" "$Out\r-$case.jsonl"; $r = Last "$Out\r-$case.jsonl"
  Start-Sleep 3
  Check "[$case] the update is refused (exit 2)" ($rc -eq 2 -and $r.result -eq "error") "exit=$rc; $($r.error)"
  Check "[$case] refused for the right reason" ("$($r.error)" -like "*$($reasons[$case])*") $reasons[$case]
  $dirs = @(Updater-TempDirs)
  Check "[$case] no installer was written or started" ($null -eq (Updater-Installers) -and $dirs.Count -eq 0) "temp dirs: $($dirs.Count)"
  Check "[$case] the app on disk is still N" ((Disk-Version) -like "$vN*" -and (Get-FileHash (Installed-Exe).FullName).Hash -eq $hashBefore) "$(Disk-Version)"
}

Write-Host "==> The good feed, with the local service of N up (node.exe from the install folder)"
Copy-Item "$Feed\latest-good.json" "$Feed\latest.json" -Force
# The self-test starts the local service first (PUBLIK_UPDATE_SELF_TEST_SIDECAR, src/lib.rs). The installer inherits
# this environment and so does the app it reopens. These builds carry no publik app token: no sign-in gate, nothing
# sent.
$jlHome = Join-Path $env:RUNNER_TEMP "jobleft-home"
Remove-Item $jlHome -Recurse -Force -ErrorAction SilentlyContinue
$env:PUBLIK_UPDATE_SELF_TEST_SIDECAR = "1"; $env:JOBLEFT_HOME = $jlHome; $env:JOBLEFT_AUTO_CRAWL = "0"; $env:JOBLEFT_SEED_BOARDS = "none"
$rc = SelfTest "install" "$Out\r-install.jsonl"; $r = Last "$Out\r-install.jsonl"
$selfTestPid = $r.pid
$sideFile = Join-Path $jlHome "run\self-test-sidecar.json"
$side = if (Test-Path $sideFile) { Get-Content $sideFile -Raw | ConvertFrom-Json } else { $null }
if ($side) { Copy-Item $sideFile "$Out\sidecar-N.json" }
Check "[sidecar] the local service of N was up when the update started" ($null -ne $side -and $side.pid -gt 0) "pid $($side.pid) port $($side.port)"
Check "[good] N downloads and verifies N+1, then starts its installer and exits" ($rc -eq 0 -and $r.result -eq "installing" -and $r.new_version -eq $vN1) "exit=$rc result=$($r.result) new=$($r.new_version)"
# The installer (passive: a progress bar, no questions) replaces the app and opens it again.
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline) {
  $busy = Updater-Installers
  if ((Disk-Version) -like "$vN1*" -and -not $busy) { break }
  Start-Sleep 2
}
Get-Process -Name jobleft, node, "*-$vN1-installer" -ErrorAction SilentlyContinue | Select-Object Name, Id, Path, StartTime | Format-Table -AutoSize | Out-String | Set-Content "$Out\processes-after-install.txt"
Start-Sleep 10
# The installer reopens the app with the same environment, so the reopened app runs the self-test too and appends its
# own line (evidence of the restart).
$lines = @(Get-Content "$Out\r-install.jsonl" | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
$reopened = $lines | Where-Object { $_.version -eq $vN1 } | Select-Object -First 1
Write-Host "reopened by the installer: $(if ($reopened) { "yes, reported $($reopened.version) result=$($reopened.result)" } else { 'no self-test line (the app may have opened normally)' })"
"reopened_report=$(if ($reopened) { $reopened | ConvertTo-Json -Compress } else { 'none' })" | Set-Content "$Out\reopen.txt"
$again = @(Get-Process -Name jobleft -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $selfTestPid -and $_.Path -like "$InstallDir\*" })
Check "[good] the installer opened jobleft again (restart after install)" ($again.Count -ge 1 -or $null -ne $reopened) "pids: $(($again | ForEach-Object Id) -join ','); reopened report: $(if ($reopened) { $reopened.result } else { 'none' })"
Check "[good] the installer has finished" ($null -eq (Updater-Installers)) ""
Check "[sidecar] the local service of N has stopped" ($null -ne $side -and $null -eq (Get-Process -Id $side.pid -ErrorAction SilentlyContinue)) "pid $($side.pid)"
# The service stopped on the shell's request (POST /api/v1/shutdown), not because it lost its parent.
$serverLog = Join-Path $jlHome "logs\server.log"
if (Test-Path $serverLog) { Copy-Item $serverLog "$Out\server-N.log" }
$parentGone = @(Select-String -Path $serverLog -Pattern 'parent\.gone' -ErrorAction SilentlyContinue).Count
Check "[sidecar] the update stopped it (no parent.gone in server.log)" ((Test-Path $serverLog) -and $parentGone -eq 0) "parent.gone lines: $parentGone"
Remove-Item Env:PUBLIK_UPDATE_SELF_TEST_SIDECAR, Env:JOBLEFT_HOME, Env:JOBLEFT_AUTO_CRAWL, Env:JOBLEFT_SEED_BOARDS -ErrorAction SilentlyContinue
Stop-App
Check "[good] the exe on disk is N+1" ((Disk-Version) -like "$vN1*") "$(Disk-Version)"
Check "[good] the uninstall entry says N+1" ((Reg-Version) -eq $vN1) "$(Reg-Version)"
Check "[good] node.exe is in place" (Test-Path (Join-Path $InstallDir "node.exe")) ""
$rc = SelfTest "version" "$Out\r-version-after.jsonl"; $r = Last "$Out\r-version-after.jsonl"
Check "[good] the app on disk reports N+1" ($r.version -eq $vN1) "$($r.version)"
$rc = SelfTest "check" "$Out\r-check-after.jsonl"; $r = Last "$Out\r-check-after.jsonl"
Check "[good] N+1 finds no newer version" ($r.result -eq "none") "$($r.result)"
$copies = @(Get-ChildItem $InstallDir -Recurse -Filter jobleft.exe -ErrorAction SilentlyContinue) + @(Get-ChildItem (Join-Path $env:LOCALAPPDATA "Programs") -Recurse -Filter jobleft.exe -ErrorAction SilentlyContinue)
Check "[good] one install of jobleft, not two" ($copies.Count -eq 1) "$(($copies | ForEach-Object FullName) -join ', ')"

Write-Host "==> The restart question, from N again (the background check as users get it)"
Stop-App
$un = Join-Path $InstallDir "uninstall.exe"
if (Test-Path $un) { Start-Process $un -ArgumentList "/S" -Wait }
Start-Sleep 2
Start-Process -FilePath $N -ArgumentList "/S" -Wait
Stop-App
$hashN = (Get-FileHash (Installed-Exe).FullName).Hash
$report = "$Out\r-prompt.jsonl"
Remove-Item $report -ErrorAction SilentlyContinue
$env:PUBLIK_UPDATE_SELF_TEST = "prompt"; $env:PUBLIK_UPDATE_SELF_TEST_OUT = $report
$p = Start-Process -FilePath (Installed-Exe).FullName -PassThru -RedirectStandardOutput "$report.stdout" -RedirectStandardError "$report.log"
Remove-Item Env:PUBLIK_UPDATE_SELF_TEST, Env:PUBLIK_UPDATE_SELF_TEST_OUT
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline -and -not $p.HasExited -and -not ((Test-Path $report) -and ((Get-Content $report -Raw) -match '"asking"'))) { Start-Sleep 1 }
Start-Sleep 5
$r = Last $report
$p.Refresh()
Check "[prompt] N asks and keeps running (no forced restart)" ($r.result -eq "asking" -and -not $p.HasExited -and $r.version -eq $vN) "result=$($r.result) running=$(-not $p.HasExited) version=$($r.version)"
Check "[prompt] nothing is installed before a yes" ((Disk-Version) -like "$vN*" -and (Get-FileHash (Installed-Exe).FullName).Hash -eq $hashN -and $r.install_waits_for_yes -eq $true) "$(Disk-Version), waits_for_yes=$($r.install_waits_for_yes)"
Check "[prompt] the question is on screen" ("$($p.MainWindowTitle)" -like "*update*") "window title '$($p.MainWindowTitle)'"
Shot "prompt-windows"
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue

Stop-App
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
if (Test-Path $un) { Start-Process $un -ArgumentList "/S" -Wait }
Write-Host ""
Write-Host "$($script:pass) passed, $($script:fails) failed"
if ($env:GITHUB_STEP_SUMMARY) { "### Windows updater proof: $($script:pass) passed, $($script:fails) failed`n" | Add-Content $env:GITHUB_STEP_SUMMARY; Get-Content $results | Add-Content $env:GITHUB_STEP_SUMMARY }
if ($script:fails -gt 0) { exit 1 }
exit 0
