' HIDDEN launcher for the hourly "DSH delegation metrics" scheduled task.
'
' MEASURED BUG (2026-10-22 23:31:01, bot\README.md): when the task action is a
' console program (powershell.exe), Task Scheduler creates a NEW, VISIBLE
' console window and the PowerShell only hides it afterwards -> half-second
' flash on every run. `-WindowStyle Hidden` in the arguments does NOT help.
'
' wscript.exe does not create a console at all: WshShell.Run's second parameter
' 0 = hidden, the third (True) = wait for exit so the task sees the real exit
' code. Same pattern as bot\run-job-hidden.vbs, which is proven on this box.
'
' Task action:
'   wscript.exe //nologo "C:\Szerver\Deepseek Harness\tools\run-hidden-metrics.vbs"
'
' Keep this file pure ASCII -- WSH reads .vbs as ANSI.
Option Explicit

Dim shell, ps, script, cmd, code

Set shell = CreateObject("WScript.Shell")
ps = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
script = "C:\Szerver\Deepseek Harness\tools\delegation-metrics.ps1"

cmd = """" & ps & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & script & """"
code = shell.Run(cmd, 0, True)
WScript.Quit code
