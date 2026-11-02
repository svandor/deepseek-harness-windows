' A helyi fallback proxy (127.0.0.1:4123) ujrainditasa REJTETTEN.
'
' AGENTS.md 1.2 KOTELEZO MINTA: a wscript Run(cmd, 0, True) EGYALTALAN nem
' hoz letre konzolt (0 = rejtett, True = megvarja es visszaadja az exit kodot).
' Kozvetlen powershell.exe inditas LATHATO konzolvillanast okozna (1.1/1.3).
'
' Miert kell: a proxy a sajat kodjat csak indulasnal tolti be, a config.json-t
' viszont hot-reloadolja. Code-valtozas -> ujrainditas.
Option Explicit

Dim sh, fso, here, ps1, cmd, rc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\run-proxy-service.ps1"

If Not fso.FileExists(ps1) Then
  WScript.Echo "HIBA: nem talalom: " & ps1
  WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass " & _
      "-WindowStyle Hidden -Command ""& '" & ps1 & "' -Stop; " & _
      "Start-Sleep -Seconds 2; & '" & ps1 & "'"""

rc = sh.Run(cmd, 0, True)
WScript.Quit rc
