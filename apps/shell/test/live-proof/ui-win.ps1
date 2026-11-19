# UI driver for the live update proof on a GitHub Windows runner (apps/shell/test/live-proof/windows.ps1), with UI
# Automation (Windows PowerShell 5.1). It reads the app's dialogs and clicks their buttons, as a person does.
#   powershell -NoProfile -File ui-win.ps1 dump  <process id>            top-level windows; the elements of dialogs
#   powershell -NoProfile -File ui-win.ps1 click <process id> <button>   clicks the button in a dialog of the process
# The update question is a task dialog (class #32770) titled "jobleft update". The main window (WebView2) is listed
# by name only: its web content is not walked.
# A click uses the button's Invoke pattern; a button that UI Automation shows without one (on the runner a message
# box's buttons come as panes) gets BM_CLICK, the message a mouse click on a Win32 button sends.
param(
  [Parameter(Mandatory = $true)][string]$Cmd,
  [Parameter(Mandatory = $true)][int]$ProcId,
  [string]$Name = ""
)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace LiveProof -Name Win32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, int msg, System.IntPtr wParam, System.IntPtr lParam);'
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
      if ($e.Current.Name) { "  $($e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') | $($e.Current.Name) | $($e.Current.ClassName)" }
    }
  }
  exit 0
}
if ($Cmd -eq 'click') {
  $named = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Name)
  foreach ($w in $dialogs) {
    $found = @($w.FindAll($TS::Descendants, $named))
    foreach ($e in $found) {
      $p = $null
      if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
        $p.Invoke()
        "clicked $Name in '$($w.Current.Name)' (invoke)"
        exit 0
      }
    }
    foreach ($e in $found) {
      $h = $e.Current.NativeWindowHandle
      if ($h -ne 0) {
        [void][LiveProof.Win32]::PostMessage([IntPtr]$h, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
        "clicked $Name in '$($w.Current.Name)' (BM_CLICK to a $($e.Current.ClassName) window)"
        exit 0
      }
    }
  }
  "no button $Name in $($dialogs.Count) dialog(s)"
  exit 1
}
"unknown command $Cmd"
exit 2
