# Drive the COMPOSE PROBE with REAL Windows keystrokes and report what the compose
# bar actually did. Widget tests cannot tell you this: they inject synthetic key
# events that never touch the OS text input, which is the thing that was eating
# Enter and inserting newlines.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rig\probe-drive-windows.ps1
#
# Build the probe first:  ai-terminal/scripts/build-probe-windows.sh
#
# SAFETY: SendKeys goes to the FOREGROUND window. Every send re-verifies via Win32
# GetForegroundWindow that the probe is still foreground, and aborts otherwise, so
# keystrokes can never leak into another app.
#
# ASCII ONLY: PowerShell 5.1 reads .ps1 as ANSI; non-ASCII breaks parsing.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT {
  public ushort wVk;
  public ushort wScan;
  public uint   dwFlags;
  public uint   time;
  public IntPtr dwExtraInfo;
}

// x64: 4-byte type, 4 bytes padding, then the union at offset 8. Size MUST be 40 --
// the union is sized by MOUSEINPUT, not KEYBDINPUT. Getting this wrong makes
// SendInput silently reject the call (returns 0) and NO key is delivered.
[StructLayout(LayoutKind.Explicit, Size = 40)]
public struct INPUT {
  [FieldOffset(0)] public uint type;
  [FieldOffset(8)] public KEYBDINPUT ki;
}

public class Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  // Windows refuses SetForegroundWindow from a process that isn't already
  // foreground. Attach to the current foreground thread's input queue first, which
  // lifts that restriction, then raise the window. Retried by the caller.
  public static bool Force(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    if (fg == h) return true;
    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fgThread, true);
    ShowWindow(h, 9);          // SW_RESTORE
    BringWindowToTop(h);
    SetForegroundWindow(h);
    AttachThreadInput(me, fgThread, false);
    return GetForegroundWindow() == h;
  }

  // Use the LEFT-SPECIFIC modifier VKs. The generic VK_CONTROL (0x11) is a virtual
  // aggregate: injected via keybd_event it did NOT register as a held modifier in
  // the app (Enter still arrived with ctrl=false), whereas a real keyboard sends
  // VK_LCONTROL. Getting this wrong made Ctrl+Enter look like a plain Enter.
  public const byte VK_CONTROL = 0xA2;  // VK_LCONTROL
  public const byte VK_SHIFT   = 0xA0;  // VK_LSHIFT
  public const byte VK_RETURN  = 0x0D;
  public const uint KEYUP      = 0x0002;

  // Inject with SendInput (what real drivers use), NOT keybd_event.
  //
  // keybd_event did not reliably update the key state Flutter reconciles against:
  // the Control DOWN registered (ctrl=true), but the very next Enter arrived with
  // ctrl=FALSE -- Flutter had synthesized the modifier away. Ctrl+Enter therefore
  // looked exactly like a plain Enter and "submitted". That is a HARNESS artifact,
  // and mistaking it for an app bug would have caused a wrong fix.
  public const uint SCANCODE = 0x0008;

  // Scan code for each VK we drive. Injecting BOTH the vk and its scan code is the
  // most faithful form (closest to what a physical keyboard/driver produces); a
  // vk-only inject left Flutter reconciling the Ctrl modifier away.
  static ushort ScanOf(ushort vk) {
    if (vk == 0xA2) return 0x1D; // Left Ctrl
    if (vk == 0xA0) return 0x2A; // Left Shift
    if (vk == 0x0D) return 0x1C; // Enter
    return 0;
  }

  static void Key(ushort vk, bool up) {
    INPUT[] i = new INPUT[1];
    i[0].type = 1; // INPUT_KEYBOARD
    i[0].ki.wVk = vk;
    i[0].ki.wScan = ScanOf(vk);
    i[0].ki.dwFlags = (up ? KEYUP : 0);
    uint sent = SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    if (sent == 0) throw new Exception("SendInput failed (vk=" + vk + ")");
  }

  public static void ModEnter(byte mod) {
    Key(mod, false);
    System.Threading.Thread.Sleep(90);
    Key(VK_RETURN, false);
    System.Threading.Thread.Sleep(90);
    Key(VK_RETURN, true);
    System.Threading.Thread.Sleep(90);
    Key(mod, true);
    System.Threading.Thread.Sleep(90);
  }

  public static void PlainEnter() {
    Key(VK_RETURN, false);
    System.Threading.Thread.Sleep(90);
    Key(VK_RETURN, true);
    System.Threading.Thread.Sleep(90);
  }

  /// True while the OS reports the modifier physically held -- sanity check that
  /// the injection actually took.
  public static bool IsDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
}
"@

$exe = 'C:\dev\ai-terminal-probe\build\windows\x64\runner\Release\ai_terminal.exe'
$log = Join-Path $env:TEMP 'compose-probe.log'
if (-not (Test-Path $exe)) { throw "probe not built: $exe" }

Remove-Item $log -ErrorAction SilentlyContinue
$proc = Start-Process $exe -PassThru
Start-Sleep -Seconds 5
$proc.Refresh()

$h = $proc.MainWindowHandle
if ($h -eq 0) { Stop-Process -Id $proc.Id -Force; throw "probe has no window" }

function Focus() {
  for ($i = 0; $i -lt 12; $i++) {
    if ([Fg]::Force($h)) { return }
    Start-Sleep -Milliseconds 250
  }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  throw "could not bring the probe window to the foreground. Refusing to send keys."
}

Focus
Start-Sleep -Milliseconds 600

function SendText([string]$text, [int]$pause = 350) {
  Focus
  [System.Windows.Forms.SendKeys]::SendWait($text)
  Start-Sleep -Milliseconds $pause
}

function Enter([int]$pause = 700)     { Focus; [Fg]::PlainEnter();                Start-Sleep -Milliseconds $pause }
function CtrlEnter([int]$pause = 700) { Focus; [Fg]::ModEnter([Fg]::VK_CONTROL);  Start-Sleep -Milliseconds $pause }
function ShiftEnter([int]$pause = 700){ Focus; [Fg]::ModEnter([Fg]::VK_SHIFT);    Start-Sleep -Milliseconds $pause }

function Case([string]$name) {
  Add-Content -Path $log -Value "---- CASE $name"
  Start-Sleep -Milliseconds 150
}

# 1. Plain Enter -> should SUBMIT (desktop rule) and leave NO newline behind.
Case 'enter-submits'
SendText 'hello'
Enter

# 2. Ctrl+Enter -> should insert a NEWLINE (FIELD gains <LF>) and must NOT submit.
Case 'ctrl-enter-newline'
SendText 'abc'
CtrlEnter

# 3. Continue that same buffer, then Enter -> submits the MULTI-LINE buffer.
Case 'multiline-then-enter'
SendText 'two'
Enter

# 4. Long text -> soft wraps; the value must never gain a newline.
Case 'long-line-wraps'
SendText 'a long prompt that should soft wrap and never gain a newline'
Enter

# 5. Shift+Enter -> not part of the model; must NOT submit silently by accident.
Case 'shift-enter'
SendText 'shifty'
ShiftEnter

Start-Sleep -Milliseconds 500
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue

Write-Output "===== compose-probe.log ====="
Get-Content $log
Write-Output "===== end ====="
