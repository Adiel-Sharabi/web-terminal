$ws = New-Object -ComObject WScript.Shell
$startupPath = [Environment]::GetFolderPath('Startup')
$sc = $ws.CreateShortcut("$startupPath\WebTerminal.lnk")
$sc.TargetPath = "wscript.exe"
$sc.Arguments = "C:\dev\web-terminal\start-server.vbs"
$sc.WorkingDirectory = "C:\dev\web-terminal"
$sc.Save()
Write-Output "Startup shortcut created at $startupPath\WebTerminal.lnk"
