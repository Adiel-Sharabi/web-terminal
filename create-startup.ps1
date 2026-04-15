$ws = New-Object -ComObject WScript.Shell
$startupPath = [Environment]::GetFolderPath('Startup')
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sc = $ws.CreateShortcut("$startupPath\WebTerminal.lnk")
$sc.TargetPath = "wscript.exe"
$sc.Arguments = "$scriptDir\start-server.vbs"
$sc.WorkingDirectory = $scriptDir
$sc.Save()
Write-Output "Startup shortcut created at $startupPath\WebTerminal.lnk"
