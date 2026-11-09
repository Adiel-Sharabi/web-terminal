# Drive the INBOX MENU PROBE (ai-terminal/tool/inbox_menu_probe.dart) with REAL Windows
# mouse messages and report what the questions inbox's card menu actually did (#445).
#
# Why: a widget test's tester.tap(buttons: kSecondaryButton) never passes through the
# Windows embedder, which turns WM_RBUTTONDOWN into a secondary-button pointer, nor
# through a real text field that owns its own right-click (CLAUDE.md: a widget test
# cannot prove input).
#
# How: the clicks are WM_MOUSEMOVE / WM_[LR]BUTTONDOWN / UP messages posted to the
# probe's FLUTTERVIEW window - the same messages the OS sends it - so the user's real
# cursor never moves and no keystroke can reach another app. Screenshots are
# PrintWindow captures, which work while the window is parked off-screen.
#
# Window messages do not cross sessions, and Claude runs in Session 0, so with no
# switch this script registers an on-demand Interactive task that starts the probe and
# this script (-Drive) in the user's session through wscript.exe (no console), waits
# for the verdict, and removes the task again.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rig\probe-drive-inbox-menu.ps1 -Exe <probe exe> -Out <dir> -User <account>
#
# With nobody logged on (no Session 1), start the probe yourself in Session 0 and run
# this with -Drive: messages and layout work there and the LOG is the readout, but
# PrintWindow captures blank images. Measured 2026-11-09: in Session 1, with the probe
# parked off-screen while the user's real cursor was elsewhere, a posted left click on
# a menu item closed the menu WITHOUT choosing (likely a mouse-leave cancelling the
# tap; not proven), while the same click in Session 0 chose it. Read MENU_RESULT.
#
# Each run reads only its own lines: the probe empties its log and writes
# `RUN pid=<pid>` first, and this reads what follows that line for the probe it found.
# A probe built before that line existed gives nothing to read, so the run ABORTs.
#
# Build the probe first:  ai-terminal/scripts/build-probe-windows.sh tool/inbox_menu_probe.dart
#
# It never touches the user's own companion: the probe is its own exe, with in-memory
# preferences and a fake cluster, and it exits on its own (a quit file, or 5 minutes).
# A probe that is still alive after that is stopped by the PID this script recorded.
#
# ASCII ONLY: PowerShell 5.1 reads .ps1 as ANSI; non-ASCII breaks parsing.

param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Out,
  [switch]$Drive,
  # The logged-on Windows account whose session runs the probe (no default: agent
  # shells can have an empty USERNAME). Not needed with -Drive.
  [string]$User
)

$ErrorActionPreference = 'Stop'
$verdict = Join-Path $Out 'verdict.txt'

if (-not $Drive) {
  if (-not $User) { Write-Output 'ABORT: pass -User <the logged-on Windows account>'; exit 2 }
  # ---- Session 0 side: launch in the user's session, wait, clean up ----------------
  if (-not (Test-Path $Exe)) { throw "probe exe not found: $Exe" }
  New-Item -ItemType Directory -Force $Out | Out-Null
  Remove-Item -Force -ErrorAction SilentlyContinue $verdict
  $dir = Split-Path $Exe
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $dir 'inbox-menu-probe.log'), (Join-Path $dir 'inbox-menu-probe.quit')
  $vbs = Join-Path $Out 'launch.vbs'
  $me = $MyInvocation.MyCommand.Path
  # Window style 4: shown without taking focus. The driver parks it off-screen at once.
  $lines = @(
    'Set sh = CreateObject("WScript.Shell")',
    ('sh.Run """' + $Exe + '""", 4, False'),
    ('sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""' + $me + '"" -Drive -Exe ""' + $Exe + '"" -Out ""' + $Out + '""", 0, False')
  )
  Set-Content -Path $vbs -Value $lines -Encoding ASCII
  $task = 'wt-inbox-menu-probe-gui'
  $p = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
  $a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo "' + $vbs + '"')
  Register-ScheduledTask -TaskName $task -Principal $p -Action $a -Force | Out-Null
  try {
    Start-ScheduledTask -TaskName $task
    $deadline = (Get-Date).AddSeconds(150)
    while (-not (Test-Path $verdict) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  } finally {
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
  }
  if (-not (Test-Path $verdict)) { Write-Output 'ABORT: the driver wrote no verdict within 150 s'; exit 2 }
  Get-Content $verdict
  # The driver's own exit code is lost through wscript: the verdict carries it.
  if (Select-String -Path $verdict -Pattern '^ABORT' -Quiet) { exit 2 }
  exit 0
}

# ---- Session 1 side: drive the probe ---------------------------------------------------
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr after, string cls, string name);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  // The probe's top-level window: a visible one, else (Session 0, where nothing is
  // shown) the one hosting a FLUTTERVIEW - messages and layout work there all the same.
  public static IntPtr TopOf(uint pid) {
    IntPtr found = IntPtr.Zero;
    IntPtr hosting = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      if (IsWindowVisible(h)) { found = h; return false; }
      if (hosting == IntPtr.Zero && FindWindowEx(h, IntPtr.Zero, "FLUTTERVIEW", null) != IntPtr.Zero) hosting = h;
      return true;
    }, IntPtr.Zero);
    return found != IntPtr.Zero ? found : hosting;
  }

  static IntPtr Pt(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }

  // The messages the OS sends for a click: a move (so the embedder adds the pointer),
  // a down carrying the button's MK_ flag, and an up.
  public static void Click(IntPtr view, int x, int y, bool right) {
    PostMessage(view, 0x0200, IntPtr.Zero, Pt(x, y));
    System.Threading.Thread.Sleep(60);
    PostMessage(view, right ? 0x0204u : 0x0201u, (IntPtr)(right ? 0x2 : 0x1), Pt(x, y));
    System.Threading.Thread.Sleep(90);
    PostMessage(view, right ? 0x0205u : 0x0202u, IntPtr.Zero, Pt(x, y));
  }
}
"@

$result = New-Object System.Collections.Generic.List[string]
function Say([string]$s) { $result.Add($s) }
# An abort inside the try exits through its finally, which calls Finish again: keep
# the worst code, so the finally's call can never turn an abort into a pass.
$script:exitCode = 0
function Finish([int]$code) {
  if ($code -gt $script:exitCode) { $script:exitCode = $code }
  Set-Content -Path $verdict -Value $result -Encoding ASCII
  exit $script:exitCode
}

$dir = Split-Path $Exe
$logFile = Join-Path $dir 'inbox-menu-probe.log'
$quit = Join-Path $dir 'inbox-menu-probe.quit'

# Only THIS run's lines: those after the probe's own `RUN pid=<its pid>` line. Before the
# probe is found, or if its RUN line is not there (an older log), there are none, so
# every wait times out into an ABORT instead of reading another run's verdicts.
$script:runPid = 0
function LogLines {
  if ($script:runPid -eq 0 -or -not (Test-Path $logFile)) { return @() }
  $all = @(Get-Content $logFile)
  $at = -1
  for ($i = $all.Count - 1; $i -ge 0; $i--) { if ($all[$i] -eq "RUN pid=$($script:runPid)") { $at = $i; break } }
  if ($at -lt 0) { return @() }
  return @($all | Select-Object -Skip ($at + 1))
}
# The probe's pixel ratio now: its latest DPR line (0 when none).
function LastDpr {
  $l = LogLines | Where-Object { $_ -like 'DPR *' } | Select-Object -Last 1
  $v = 0.0
  if ($l -and [double]::TryParse($l.Substring(4), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$v)) { return $v }
  return 0.0
}
function LastPos {
  $p = LogLines | Where-Object { $_ -like 'POS *' } | Select-Object -Last 1
  if (-not $p) { return @{} }
  $o = $p.Substring(4) | ConvertFrom-Json
  $h = @{}
  foreach ($n in $o.PSObject.Properties) { $h[$n.Name] = $n.Value }
  return $h
}
function WaitFor([scriptblock]$cond, [int]$ms) {
  $deadline = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $deadline) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 150 }
  return $false
}
function Shot([string]$name) {
  $r = New-Object W+RECT
  [W]::GetWindowRect($script:top, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [W]::PrintWindow($script:top, $hdc, 2) | Out-Null
  $g.ReleaseHdc($hdc); $g.Dispose()
  $path = Join-Path $Out $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Say "SHOT $path"
}
# The probe logs LOGICAL pixels; a posted mouse message carries PHYSICAL client pixels.
# $script:dpr is read from the probe's READY line before the window is sized.
$script:dpr = 0
function Center($rect) {
  return @([int](($rect[0] + $rect[2] / 2) * $script:dpr), [int](($rect[1] + $rect[3] / 2) * $script:dpr))
}
function MenuKeys { (LastPos).Keys | Where-Object { $_ -like 'inbox-menu-*' } | ForEach-Object { $_.Substring(11) } | Sort-Object }
function PushCount { @(LogLines | Where-Object { $_ -like 'PUSH *' }).Count }

$proc = $null
try {
  # The probe is the process running THIS exe, by full path: never anything else.
  if (-not (WaitFor { $null -ne (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe }) } 20000)) {
    Say 'ABORT: the probe process never started'; Finish 2
  }
  $proc = Get-Process | Where-Object { $_.Path -eq $Exe } | Select-Object -First 1
  Say "PROBE pid=$($proc.Id) session=$($proc.SessionId)"
  $script:runPid = $proc.Id
  if (-not (WaitFor { [W]::TopOf([uint32]$proc.Id) -ne [IntPtr]::Zero } 20000)) { Say 'ABORT: no probe window'; Finish 2 }
  $script:top = [W]::TopOf([uint32]$proc.Id)
  # Off-screen and unactivated first; sized once the probe says its pixel ratio.
  [W]::SetWindowPos($script:top, [IntPtr]::Zero, -4000, 40, 1300, 900, 0x0014) | Out-Null
  # The probe logs LOGICAL pixels and a window is sized in PHYSICAL ones: read its ratio
  # after the move (which can land on another monitor's scale) before sizing anything.
  if (-not (WaitFor { @(LogLines | Where-Object { $_ -like 'READY dpr=*' }).Count -gt 0 } 20000)) {
    Say 'ABORT: the probe never drew its first frame'; Finish 2
  }
  Start-Sleep -Milliseconds 600
  $script:dpr = LastDpr
  if ($script:dpr -le 0) { Say 'ABORT: no device pixel ratio from the probe'; Finish 2 }
  Say "PROBE dpr=$($script:dpr)"
  # 1300x900 LOGICAL: the wide layout (the list beside the focused item) at any scale.
  [W]::SetWindowPos($script:top, [IntPtr]::Zero, -4000, 40, [int](1300 * $script:dpr), [int](900 * $script:dpr), 0x0014) | Out-Null
  $view = [W]::FindWindowEx($script:top, [IntPtr]::Zero, 'FLUTTERVIEW', [NullString]::Value)
  if ($view -eq [IntPtr]::Zero) { Say 'ABORT: no FLUTTERVIEW child'; Finish 2 }
  $cardC = 'inbox-card-http://probe.invalid:7681|c'
  $cardQ = 'inbox-card-http://probe.invalid:7681|q'
  $replyD = 'inbox-reply-http://probe.invalid:7681|d'
  if (-not (WaitFor { $pp = LastPos; $pp.ContainsKey($cardC) -and $pp.ContainsKey($cardQ) } 30000)) {
    Say 'ABORT: the cards never appeared'; Shot 'abort.png'; Finish 2
  }
  # Prove the WIDE layout before relying on it: there the oldest wait (the reported
  # card) opens beside the list and hides its own reply box. In the narrow layout the
  # box shows from the start, a click opens a full-screen route over the cards, and
  # every later step would report a negative instead of a setup failure.
  Start-Sleep -Milliseconds 700
  if ((LastPos).ContainsKey($replyD)) {
    Say 'ABORT: not the wide layout (the reported card shows its reply box before any click)'; Shot 'abort.png'; Finish 2
  }
  # Every click converts with this ratio: it must still be the one the window was sized by.
  if ((LastDpr) -ne $script:dpr) {
    Say "ABORT: the pixel ratio changed after sizing ($($script:dpr) -> $(LastDpr))"; Finish 2
  }
  # The wide layout opens the oldest wait (the reported one) beside the list, and an
  # open card hides its own reply box. Open the question instead (a left click opens
  # it; nothing is answered), so the reported card shows its reply field.
  $q0 = Center (LastPos)[$cardQ]
  [W]::Click($view, $q0[0], $q0[1], $false)
  if (-not (WaitFor { (LastPos).ContainsKey($replyD) } 5000)) {
    Say 'ABORT: the reported card never showed its reply field'; Shot 'abort.png'; Finish 2
  }
  Start-Sleep -Milliseconds 800
  Shot '1-before.png'

  # 1. Right-click the prose card: its menu.
  $pos = LastPos
  $c = Center $pos[$cardC]
  $pushes = PushCount
  [W]::Click($view, $c[0], $c[1], $true)
  $opened = WaitFor { (PushCount) -gt $pushes -and @(MenuKeys).Count -gt 0 } 5000
  $rdown = @(LogLines | Where-Object { $_ -like 'PTR down *buttons=2' }).Count
  Say "RCLICK_DELIVERED (prose card): $($rdown -gt 0)"
  if ($rdown -eq 0) { Say 'ABORT: the right button never reached the app'; Shot 'abort.png'; Finish 2 }
  Start-Sleep -Milliseconds 500
  Shot '2-menu-prose.png'
  Say "PROSE_MENU_OPENED: $opened"
  Say ("PROSE_MENU: " + ((MenuKeys) -join ','))

  # 2. Pick "Not a question".
  $pos = LastPos
  if ($pos.ContainsKey('inbox-menu-notAQuestion')) {
    $m = Center $pos['inbox-menu-notAQuestion']
    [W]::Click($view, $m[0], $m[1], $false)
    $patched = WaitFor { @(LogLines | Where-Object { $_ -like 'HTTP PATCH /api/sessions/c/brief*inboxDismiss*add*' }).Count -gt 0 } 5000
    $gone = WaitFor { -not (LastPos).ContainsKey($cardC) } 5000
    Start-Sleep -Milliseconds 400
    Shot '3-after-dismiss.png'
    Say ("MENU_RESULT: " + ((LogLines | Where-Object { $_ -like 'POPPED *' }) -join ' | '))
    Say "DISMISS_PATCH_SENT: $patched"
    Say "PROSE_CARD_GONE: $gone"
    Say ("DISMISSED_SECTION_SHOWN: " + (LastPos).ContainsKey('inbox-dismissed-toggle'))
    Say ("UNDO_SHOWN: " + (LastPos).ContainsKey('inbox-undo'))
  } else {
    Say 'DISMISS: skipped, the menu had no Not a question'
  }

  # 3. Right-click INSIDE the reported card's reply field: the field's own menu, not the card's.
  $pos = LastPos
  $f = $pos[$replyD]
  $pushes = PushCount
  $fc = Center @(($f[0] + 30), $f[1], 0, $f[3]); [W]::Click($view, $fc[0], $fc[1], $true)
  Start-Sleep -Milliseconds 1500
  Shot '4-rclick-in-reply-field.png'
  Say ("FIELD_RCLICK_OPENED_CARD_MENU: " + (((PushCount) -gt $pushes) -or (@(MenuKeys).Count -gt 0)))
  # Close whatever the field opened: a left click on the app bar's title.
  $t = Center @(60, 28, 0, 0); [W]::Click($view, $t[0], $t[1], $false)
  Start-Sleep -Milliseconds 600

  # 4. Right-click the blocking question card: no Dismiss.
  $pos = LastPos
  $q = Center $pos[$cardQ]
  $pushes = PushCount
  [W]::Click($view, $q[0], $q[1], $true)
  $opened = WaitFor { (PushCount) -gt $pushes -and @(MenuKeys).Count -gt 0 } 5000
  Start-Sleep -Milliseconds 500
  Shot '5-menu-question.png'
  Say "QUESTION_MENU_OPENED: $opened"
  Say ("QUESTION_MENU: " + ((MenuKeys) -join ','))
  $t = Center @(60, 28, 0, 0); [W]::Click($view, $t[0], $t[1], $false)
  Start-Sleep -Milliseconds 500

  $typed = @(LogLines | Where-Object { $_ -like 'INPUT *' }).Count
  Say "KEYS_TYPED_INTO_SESSIONS: $typed"
  Say ("HTTP_WRITES: " + ((LogLines | Where-Object { $_ -like 'HTTP *' }) -join ' | '))
} catch {
  Say "ABORT: $($_.Exception.Message)"
  $script:exitCode = 2
} finally {
  # Ask the probe to leave; stop it by its recorded PID only if it will not.
  Set-Content -Path $quit -Value 'quit' -Encoding ASCII
  if ($proc) {
    if (-not (WaitFor { $proc.Refresh(); $proc.HasExited } 8000)) {
      Stop-Process -Id $proc.Id -Force
      Say "PROBE stopped by pid $($proc.Id)"
    } else {
      Say 'PROBE exited on its own'
    }
  }
  Finish 0
}
