' Elfogadási próba (elárvult folyamat helyreállítása) REJTETT indítása.
'
' MIÉRT külön VBS: a `run-hidden.vbs` az argumentumokat szóközzel fűzi össze és
' csak az exe-et idézi, ezért egy szóközt tartalmazó útvonal
' (D:\Szerver\Deepseek Harness\...) szétesne. Itt az útvonal a szkript SAJÁT
' helyéből épül, így szóköz nem probléma.
'
' A próba durván leállítja a harness-t, ezért NEM futhat a harness
' folyamatfájában — a wscript viszont a fán kívül van.
'
' HASZNÁLAT:
'   wscript.exe //nologo tools\run-orphan-test.vbs [késleltetés-mp]
Option Explicit

Dim shell, fso, here, repoRoot, script, delaySeconds, cmd, logFile, logStream

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(here)
script = fso.BuildPath(here, "test-orphan-recovery.ps1")

delaySeconds = 150
If WScript.Arguments.Count >= 1 Then
  If IsNumeric(WScript.Arguments(0)) Then delaySeconds = CLng(WScript.Arguments(0))
End If

logFile = fso.BuildPath(repoRoot, "state\orphan-test.log")
Set logStream = fso.OpenTextFile(logFile, 8, True)
logStream.WriteLine Now & " indult; késleltetés " & delaySeconds & " s; szkript: " & script
logStream.Close

If Not fso.FileExists(script) Then
  Set logStream = fso.OpenTextFile(logFile, 8, True)
  logStream.WriteLine Now & " HIBA: nem találom a szkriptet: " & script
  logStream.Close
  WScript.Quit 2
End If

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """ -DelaySeconds " & delaySeconds
shell.Run cmd, 0, False
