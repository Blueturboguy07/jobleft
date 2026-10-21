# Installs the NSIS installer the way a user does, opens the app, saves the reporter's first-run preferences (this is
# what starts the first crawl of the seeded boards: app.ts afterProfileSaved), then watches the local service for
# 6 minutes: health from outside every 5 s, whether the sidecar process is still alive, and what the window shows
# (the UI's own fetch('api/v1/health') right after open, and a screenshot of the desktop at the end).
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path lab-out | Out-Null
$setup = Get-ChildItem -Path apps/shell/src-tauri/target/release/bundle/nsis -Filter '*.exe' | Select-Object -First 1
"installer: $($setup.Name)"
# A Windows account whose folder name has a space and accented letters ("Zo\u00eb Garc\u00eda"): the installer, the
# program folder and the data folder (APPDATA) all sit under it, as for a real user with such a name.
$userRoot = 'C:\Users\Zo' + [char]0xEB + ' Garc' + [char]0xED + 'a'
New-Item -ItemType Directory -Force -Path "$userRoot\AppData\Roaming", "$userRoot\AppData\Local" | Out-Null
$env:APPDATA = "$userRoot\AppData\Roaming"
$env:LOCALAPPDATA = "$userRoot\AppData\Local"
"user folder: $userRoot"
Start-Process -FilePath $setup.FullName -ArgumentList "/S /D=$userRoot\AppData\Local\jobleft" -Wait
$exe = "$env:LOCALAPPDATA\jobleft\jobleft.exe"
if (-not (Test-Path $exe)) { $exe = (Get-ChildItem -Path "$env:LOCALAPPDATA","$env:ProgramFiles" -Recurse -Filter 'jobleft.exe' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }
"installed at: $exe"
$probe = (Resolve-Path lab-out).Path + '\probe.js'
@'
(async () => {
  const r = {};
  try { const h = await fetch('api/v1/health', { cache: 'no-store' }); r.healthStatus = h.status; }
  catch (e) { r.healthError = String(e); }
  await new Promise(s => setTimeout(s, 12000));
  r.bannerShown = /local service is not answering/.test(document.body.innerText);
  r.text = document.body.innerText.slice(0, 200);
  location.hash = '#probe=' + encodeURIComponent(JSON.stringify(r));
})();
'@ | Set-Content -Path $probe -Encoding utf8
$env:JOBLEFT_SHELL_PROBE = $probe
$p = Start-Process -FilePath $exe -PassThru
$run = "$env:APPDATA\jobleft\run\server.json"
$deadline = (Get-Date).AddSeconds(60)
while (-not (Test-Path $run) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
$verdict = $null
if (-not (Test-Path $run)) {
  "BUGFIX_LAB_NOTE: no run/server.json after 60 s (the sidecar never started)"
  Get-Content "$env:APPDATA\jobleft\logs\sidecar.log" -ErrorAction SilentlyContinue | Select-Object -Last 40
  $verdict = 'PRESENT'
} else {
  $j = Get-Content $run | ConvertFrom-Json
  "server on port $($j.port) pid $($j.pid)"
  $base = "http://127.0.0.1:$($j.port)/api/v1"
  $hdr = @{ 'x-jobleft-token' = $j.token }
  # the reporter's first-run preferences (screenshot: Canada, Mechanical Engineering, Intern/New Grad, Internship, Hybrid)
  try {
    $prof = Invoke-RestMethod -Uri "$base/profile" -Headers $hdr
    foreach ($k in 'id','version','updatedAt') { $prof.PSObject.Properties.Remove($k) }
    $prof.preferences.jobFunctions = @('Mechanical Engineering')
    $prof.preferences.levels = @('intern_new_grad')
    $prof.preferences.employmentTypes = @('internship')
    $prof.preferences.workModels = @('hybrid')
    $prof.preferences.countries = @('CA')
    $body = $prof | ConvertTo-Json -Depth 30
    $r = Invoke-RestMethod -Method Put -Uri "$base/profile" -Headers $hdr -ContentType 'application/json' -Body $body
    "profile saved with preferences"
  } catch { "BUGFIX_LAB_NOTE: profile save failed: $_" }
  $fails = 0; $consec = 0; $maxConsec = 0
  for ($i = 1; $i -le 60; $i++) {
    Start-Sleep -Seconds 5
    $alive = [bool](Get-Process -Id $j.pid -ErrorAction SilentlyContinue)
    $mem = if ($alive) { [math]::Round((Get-Process -Id $j.pid).WorkingSet64/1MB) } else { 0 }
    try { $null = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 8; $ok = $true; $consec = 0 }
    catch { $ok = $false; $fails++; $consec++; if ($consec -gt $maxConsec) { $maxConsec = $consec }; $err = "$_" }
    if ($ok) { if ($i % 6 -eq 0 -or $i -le 4) { "t+$($i*5)s health ok, sidecar alive=$alive, ${mem} MB" } }
    else { "t+$($i*5)s health FAILED (alive=$alive): $err" }
    if (-not $alive) { "t+$($i*5)s sidecar pid $($j.pid) is GONE"; break }
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path (Resolve-Path lab-out).Path 'final.png'))
  } catch { "screenshot failed: $_" }
  $pj = "$env:APPDATA\jobleft\run\probe.json"
  $probeBanner = $false
  if (Test-Path $pj) { $raw = Get-Content $pj -Raw; "probe.json: $raw"; $pr = $raw | ConvertFrom-Json; if ($pr.bannerShown -or $pr.healthError) { $probeBanner = $true } }
  else { "BUGFIX_LAB_NOTE: no run/probe.json" }
  $gone = -not (Get-Process -Id $j.pid -ErrorAction SilentlyContinue)
  "summary: failedChecks=$fails maxConsecutiveFails=$maxConsec sidecarGone=$gone probeBanner=$probeBanner"
  if ($gone -or $maxConsec -ge 2 -or $probeBanner) { $verdict = 'PRESENT' } elseif ($pr -or $fails -eq 0) { $verdict = 'ABSENT' }
}
"--- sidecar.log (tail)"
Get-Content "$env:APPDATA\jobleft\logs\sidecar.log" -ErrorAction SilentlyContinue | Select-Object -Last 40
Get-ChildItem "$env:APPDATA\jobleft\logs" -ErrorAction SilentlyContinue | ForEach-Object { "log file: $($_.Name) $($_.Length) bytes" }
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
if ($verdict -eq 'PRESENT') { 'BUGFIX_LAB_PRESENT'; exit 1 }
if ($verdict -eq 'ABSENT') { 'BUGFIX_LAB_ABSENT'; exit 0 }
'BUGFIX_LAB_INCONCLUSIVE'; exit 3
