' Shadow cluster launcher (office) — isolated pipe, own config/state.
Set objFSO = CreateObject("Scripting.FileSystemObject")
Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = objFSO.GetParentFolderName(WScript.ScriptFullName)
objShell.Environment("PROCESS")("WT_WORKER_PIPE") = "\\.\pipe\web-terminal-shadow-office"
objShell.Environment("PROCESS")("WT_LATENCY_DEBUG") = "1"
objShell.Run "node monitor.js", 0, False
