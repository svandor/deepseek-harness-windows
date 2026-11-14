' Dev-kornyezet rejtett inditasa/leallitasa (AGENTS.md 1.2 minta).
'
' Miert kell: a DSH eszkozbol inditott folyamat a harness job-objektumaban
' van, ezert a hivo lezarasaig (vagy idotullepesig) varja a gyerekeket.
' A wscript WshShell.Run(cmd, 0, False) NEM hoz letre konzolt es NEM var:
' a dev szerver a hivastol fuggetlenul el.
'
' Hasznalat:
'   cscript //nologo tools\dev-hidden.vbs start
'   cscript //nologo tools\dev-hidden.vbs stop
'   cscript //nologo tools\dev-hidden.vbs restart
Dim sh, action, scriptRoot, cmd, logPath
Set sh = CreateObject("WScript.Shell")
scriptRoot = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
action = "status"
If WScript.Arguments.Count > 0 Then action = WScript.Arguments(0)
logPath = scriptRoot & "\..\state\dev\logs\dev-" & action & ".log"

' A naplo-atiranyitast a PowerShellnek kell vegeznie (a WshShell.Run nem
' ertelmezi a *>> operatort, az csak a cmd.exe-ben / PS-ben letezik).
cmd = "pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ""& '" & _
      scriptRoot & "\dev.ps1' " & action & " *>> '" & logPath & "'"""

sh.Run cmd, 0, False
