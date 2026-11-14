' Dev-kornyezet rejtett inditasa/leallitasa (AGENTS.md 1.2 minta).
'
' Miert kell: a DSH eszkozbol (vagy a host pluginbol) inditott folyamat a
' harness job-objektumaban van, ezert a hivo addig var, amig a gyerekek elnek.
' A php-cgi munkasok hosszu eletuek, tehat a hivas idotullepessel zarulna
' (MERVE: 180 s). A wscript WshShell.Run(cmd, 0, False) NEM hoz letre konzolt
' es NEM var: a dev szerver a hivastol fuggetlenul el.
'
' Hasznalat:
'   cscript //nologo tools\dev-hidden.vbs start
'   cscript //nologo tools\dev-hidden.vbs stop
'   cscript //nologo tools\dev-hidden.vbs restart
'   cscript //nologo tools\dev-hidden.vbs service caddy restart
'   cscript //nologo tools\dev-hidden.vbs service php:termeszetgyogyaszoktatas-l12.test stop
'   cscript //nologo tools\dev-hidden.vbs service all restart
Dim sh, action, scriptRoot, cmd, logPath, psArgs, logName
Set sh = CreateObject("WScript.Shell")
scriptRoot = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
action = "status"
If WScript.Arguments.Count > 0 Then action = WScript.Arguments(0)

psArgs = "-Action " & action
logName = "dev-" & action & ".log"
If LCase(action) = "service" Then
  logName = "dev-service.log"
  If WScript.Arguments.Count > 1 Then psArgs = psArgs & " -Service '" & WScript.Arguments(1) & "'"
  If WScript.Arguments.Count > 2 Then psArgs = psArgs & " -ServiceAction '" & WScript.Arguments(2) & "'"
End If

logPath = scriptRoot & "\..\state\dev\logs\" & logName

' A naplo-atiranyitast a PowerShellnek kell vegeznie (a WshShell.Run nem
' ertelmezi a *>> operatort, az csak a cmd.exe-ben / PS-ben letezik).
cmd = "pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ""& '" & _
      scriptRoot & "\dev.ps1' " & psArgs & " *>> '" & logPath & "'"""

sh.Run cmd, 0, False
