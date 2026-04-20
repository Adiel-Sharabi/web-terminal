Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*web-terminal*' } | Select-Object ProcessId,CommandLine | Format-Table -AutoSize -Wrap
