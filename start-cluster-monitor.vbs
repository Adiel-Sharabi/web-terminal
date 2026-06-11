' start-cluster-monitor.vbs — Launch cluster-monitor.js hidden (no console flash).
' Usage:  wscript start-cluster-monitor.vbs
Set sh = CreateObject("WScript.Shell")
dim here
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
sh.Run "node.exe cluster-monitor.js", 0, False
