Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "C:\dev\web-terminal"
objShell.Run "node server.js", 0, False
