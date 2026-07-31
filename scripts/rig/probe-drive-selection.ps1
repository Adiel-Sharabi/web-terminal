# Drive the SELECTION PROBE with a REAL Windows mouse drag and report what the
# chat lens's rendering stack actually selected (#83).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rig\probe-drive-selection.ps1 [-Mode markdown]
#
# Build the probe first:
#   ai-terminal/scripts/build-probe-windows.sh tool/selection_probe.dart
#
# WHY: issue #83 disproved eight hypotheses with widget tests and all eight passed.
# Synthetic pointer events are injected into Flutter's gesture arena directly and
# never traverse the Windows pointer path, so those tests cannot see this bug. This
# sends real SendInput mouse events at the real window.
#
# SAFETY: input goes to the FOREGROUND window. This launches its OWN probe process,
# verifies via GetForegroundWindow that the probe is foreground before every send,
# and aborts otherwise -- so a drag can never land in another app. It never touches
# the user's installed companion.
#
# ASCII ONLY: PowerShell 5.1 reads .ps1 as ANSI; non-ASCII breaks parsing.

param(
  [string]$Mode = 'markdown',
  [string]$Exe  = '',
  # Send Ctrl+C after the drag and report the clipboard. Required for the modes
  # that mount the real ConversationView (it owns its own SelectionArea, so the
  # probe cannot log onSelectionChanged) -- and it doubles as the test for the
  # missing chat-lens copy path #83 also reports.
  [switch]$Copy,
  # Save a PNG of the probe window just before the drag. Without this, "nothing
  # selected" cannot be distinguished from "nothing was RENDERED to select" -- an
  # empty state or a spinner would look exactly like a reproduction.
  [string]$Shot = '',
  # Save a PNG while the button is still DOWN and the selection is live.
  #
  # This is not a nicety. For a mode that mounts the real ConversationView there
  # is no onSelectionChanged to log, so the only other readback is Ctrl+C -- and
  # #83 reports the chat lens has NO copy path, which would make a perfectly good
  # selection indistinguishable from a dead one. The highlight in this image is
  # the only trustworthy evidence for those modes.
  [string]$ShotDuring = ''
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT {
  public int    dx;
  public int    dy;
  public uint   mouseData;
  public uint   dwFlags;
  public uint   time;
  public IntPtr dwExtraInfo;
}

// x64: 4-byte type, 4 bytes padding, union at offset 8. Size MUST be 40 -- the
// union is sized by MOUSEINPUT. Get it wrong and SendInput silently returns 0
// and NOTHING is delivered, which reads exactly like "the app ignored the drag".
[StructLayout(LayoutKind.Explicit, Size = 40)]
public struct INPUT {
  [FieldOffset(0)] public uint type;
  [FieldOffset(8)] public MOUSEINPUT mi;
}

[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }

public class Mouse {
  // PRIVATE on purpose, and it is not a style choice. PowerShell binds `::`
  // members CASE-INSENSITIVELY, so a public const LEFTDOWN makes [Mouse]::LeftDown
  // resolve to the FIELD rather than the method, and the call dies with
  // "does not contain a method named 'LeftDown'" while reflection happily lists it.
  // MoveTo worked throughout only because no const collides with that name.
  const uint MOVE        = 0x0001;
  const uint LEFTDOWN    = 0x0002;
  const uint LEFTUP      = 0x0004;
  const uint ABSOLUTE    = 0x8000;
  const uint VIRTUALDESK = 0x4000;

  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  // Windows refuses SetForegroundWindow from a process that is not already
  // foreground; attaching to the foreground thread's input queue lifts that.
  public static bool Force(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    if (fg == h) return true;
    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fgThread, true);
    ShowWindow(h, 9);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    AttachThreadInput(me, fgThread, false);
    return ok;
  }

  static void Send(uint flags, int nx, int ny) {
    INPUT[] i = new INPUT[1];
    i[0].type = 0; // INPUT_MOUSE
    i[0].mi.dx = nx;
    i[0].mi.dy = ny;
    i[0].mi.dwFlags = flags;
    uint sent = SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    if (sent == 0) throw new Exception("SendInput delivered nothing (flags=" + flags + ")");
  }

  // Screen pixels -> the 0..65535 normalised space ABSOLUTE|VIRTUALDESK expects.
  public static void MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);   // SM_XVIRTUALSCREEN/Y
    int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);   // SM_CXVIRTUALSCREEN/CY
    int nx = (int)(((double)(x - vx) * 65535.0) / (double)(vw - 1));
    int ny = (int)(((double)(y - vy) * 65535.0) / (double)(vh - 1));
    Send(MOVE | ABSOLUTE | VIRTUALDESK, nx, ny);
  }
  public static void LeftDown() { Send(LEFTDOWN, 0, 0); }
  public static void LeftUp()   { Send(LEFTUP,   0, 0); }

  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);

  // Ctrl+C.
  //
  // The SCAN CODE is mandatory, not cosmetic. Sent with scan code 0, Flutter's
  // Windows embedder derives the physical key from the scan code, fails to
  // recognise Control, and the following C arrives with isControlPressed FALSE
  // -- so a perfectly correct shortcut looks broken and the probe blames the
  // app. MapVirtualKey(vk, MAPVK_VK_TO_VSC) supplies the real one.
  public static void SendCopyKeys() {
    const byte VK_CONTROL = 0x11;
    const byte VK_C       = 0x43;
    const uint KEYUP      = 0x0002;
    byte scanCtrl = (byte)MapVirtualKey(VK_CONTROL, 0);
    byte scanC    = (byte)MapVirtualKey(VK_C, 0);
    keybd_event(VK_CONTROL, scanCtrl, 0,     UIntPtr.Zero);
    keybd_event(VK_C,       scanC,    0,     UIntPtr.Zero);
    keybd_event(VK_C,       scanC,    KEYUP, UIntPtr.Zero);
    keybd_event(VK_CONTROL, scanCtrl, KEYUP, UIntPtr.Zero);
  }
}
"@

function Assert-Foreground([IntPtr]$h, [string]$what) {
  if ([Mouse]::GetForegroundWindow() -ne $h) {
    throw "ABORT: probe is not the foreground window (before $what). Nothing was sent."
  }
}

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Exe) {
  $scratch = & node (Join-Path $repo 'scripts\scratch-dirs.js') probe
  $Exe = Join-Path $scratch 'build\windows\x64\runner\Release\ai_terminal.exe'
}
if (-not (Test-Path $Exe)) {
  throw "probe exe not found: $Exe`nBuild it: ai-terminal/scripts/build-probe-windows.sh tool/selection_probe.dart"
}

$log = Join-Path $env:TEMP 'selection-probe.log'
if (Test-Path $log) { Remove-Item $log -Force }

Write-Host "== launching probe (mode=$Mode)"
Write-Host "   $Exe"
$env:SELPROBE_MODE = $Mode
$proc = Start-Process -FilePath $Exe -PassThru

try {
  $h = [IntPtr]::Zero
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $h = $proc.MainWindowHandle; break }
  }
  if ($h -eq [IntPtr]::Zero) { throw "probe window never appeared" }
  Write-Host "== window handle $h"

  for ($i = 0; $i -lt 10; $i++) {
    if ([Mouse]::Force($h)) { }
    Start-Sleep -Milliseconds 300
    if ([Mouse]::GetForegroundWindow() -eq $h) { break }
  }
  Assert-Foreground $h 'drag'

  $r = New-Object RECT
  [void][Mouse]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left
  $ht = $r.Bottom - $r.Top
  Write-Host ("== window rect {0},{1} {2}x{3}" -f $r.Left, $r.Top, $w, $ht)

  # Stay well inside the transcript area: the probe puts a header at the top and a
  # log panel across the bottom, so 30%..52% of height is text in every DPI mode.
  $x1 = $r.Left + [int]($w * 0.10)
  $y1 = $r.Top  + [int]($ht * 0.30)
  $x2 = $r.Left + [int]($w * 0.80)
  $y2 = $r.Top  + [int]($ht * 0.52)

  Add-Type -AssemblyName System.Drawing
  function Save-Shot([string]$dest) {
    $b = New-Object System.Drawing.Bitmap($w, $ht)
    $gg = [System.Drawing.Graphics]::FromImage($b)
    $gg.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $ht)))
    $b.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $gg.Dispose(); $b.Dispose()
    Write-Host "== screenshot: $dest"
  }

  if ($Shot) { Save-Shot $Shot }

  Write-Host ("== drag {0},{1} -> {2},{3}" -f $x1, $y1, $x2, $y2)

  [Mouse]::MoveTo($x1, $y1)
  Start-Sleep -Milliseconds 400
  Assert-Foreground $h 'button down'
  [Mouse]::LeftDown()
  Start-Sleep -Milliseconds 150

  # Many small steps: one big jump can be coalesced into a single move, which some
  # drag recognisers never treat as a drag at all.
  $steps = 24
  for ($s = 1; $s -le $steps; $s++) {
    $x = $x1 + [int](($x2 - $x1) * $s / $steps)
    $y = $y1 + [int](($y2 - $y1) * $s / $steps)
    [Mouse]::MoveTo($x, $y)
    Start-Sleep -Milliseconds 25
  }
  Start-Sleep -Milliseconds 250
  # Still mid-drag: whatever is highlighted here is real selection, whether or
  # not any copy path exists.
  if ($ShotDuring) { Save-Shot $ShotDuring }
  Assert-Foreground $h 'button up'
  [Mouse]::LeftUp()
  Start-Sleep -Milliseconds 700

  if ($Copy) {
    # Park a sentinel first: an EMPTY clipboard and "Ctrl+C did nothing" are
    # indistinguishable otherwise, and the previous run's text still sitting there
    # would read as a false success.
    Set-Clipboard -Value '<<probe-sentinel>>'
    Start-Sleep -Milliseconds 200
    Assert-Foreground $h 'ctrl+c'
    [Mouse]::SendCopyKeys()
    Start-Sleep -Milliseconds 600
    $script:clip = (Get-Clipboard -Raw)
  }
}
finally {
  if ($proc -and -not $proc.HasExited) { $proc.Kill() | Out-Null }
}

Write-Host ""
if ($Copy) {
  if ($null -eq $script:clip -or $script:clip -eq '<<probe-sentinel>>') {
    Write-Host "== CLIPBOARD: unchanged -- Ctrl+C copied NOTHING"
  } else {
    Write-Host "== CLIPBOARD: $($script:clip)"
  }
}
Write-Host "== probe log ($log)"
if (Test-Path $log) {
  Get-Content $log | ForEach-Object { Write-Host "   $_" }
  $lines = Get-Content $log
  # SEL comes from a probe-owned SelectionArea; SINK from the real widget's
  # selectionSink. Counting only SEL made every real-widget run print
  # "NO SELECTION" while the selection was demonstrably working -- a verdict that
  # is wrong is worse than none, so both channels count.
  $sel = $lines | Where-Object {
    ($_ -like 'SEL*' -or $_ -like 'SINK*') -and $_ -notlike '*<empty>*'
  }
  $ptr = $lines | Where-Object { $_ -like 'PTR*' }
  Write-Host ""
  if ($ptr.Count -eq 0) {
    Write-Host "RESULT: INCONCLUSIVE - no pointer events reached the app; the driver failed, not the app."
  } elseif ($sel.Count -gt 0) {
    Write-Host "RESULT: SELECTED - a real OS mouse drag DID select text in this tree."
  } else {
    Write-Host "RESULT: NO SELECTION - pointer events arrived but nothing selected."
    Write-Host "        (If this mode mounts the real widget, confirm with -ShotDuring before believing it:"
    Write-Host "         a missing copy path looks identical to a dead selection.)"
  }
} else {
  Write-Host "   (no log written)"
}
