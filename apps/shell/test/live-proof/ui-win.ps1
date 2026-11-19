# UI driver for the live update proof on a GitHub Windows runner (apps/shell/test/live-proof/windows.ps1), with UI
# Automation (Windows PowerShell 5.1). It reads the app's dialogs and clicks their buttons, as a person does.
#   powershell -NoProfile -File ui-win.ps1 dump  <process id>            top-level windows; the elements of dialogs
#   powershell -NoProfile -File ui-win.ps1 click <process id> <button>   clicks the button in a dialog of the process
# The update question is a task dialog (class #32770) titled "jobleft update". The main window (WebView2) is listed
# by name only: its web content is not walked.
param(
  [Parameter(Mandatory = $true)][string]$Cmd,
  [Parameter(Mandatory = $true)][int]$ProcId,
  [string]$Name = ""
)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $ProcId)
$windows = @($AE::RootElement.FindAll($TS::Children, $cond))
$dialogs = @($windows | Where-Object { $_.Current.ClassName -eq '#32770' })

if ($Cmd -eq 'dump') {
  "process ${ProcId}: $($windows.Count) window(s)"
  foreach ($w in $windows) {
    "window: $($w.Current.Name) [$($w.Current.ClassName)]"
    if ($w.Current.ClassName -ne '#32770') { continue }
    foreach ($e in $w.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($e.Current.Name) { "  $($e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') | $($e.Current.Name)" }
    }
  }
  exit 0
}
if ($Cmd -eq 'click') {
  $isButton = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $named = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Name)
  $both = New-Object System.Windows.Automation.AndCondition($isButton, $named)
  foreach ($w in $dialogs) {
    $b = $w.FindFirst($TS::Descendants, $both)
    if ($b) {
      $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      "clicked $Name in '$($w.Current.Name)'"
      exit 0
    }
  }
  "no button $Name in $($dialogs.Count) dialog(s)"
  exit 1
}
"unknown command $Cmd"
exit 2
