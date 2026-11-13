' Késleltetett, REJTETT harness-újraindítás.
'
' MIÉRT: az újraindítás megszakítja a futó munkamenetet, ezért néha előbb a
' válasznak/hibajegyzésnek ki kell mennie. Ez a szkript rejtetten vár N
' másodpercet, majd a repó saját restart-harness.ps1-jét hívja — így nem kell
' látható konzolt nyitni (AGENTS.md 1. fejezet: tilos a fókuszvétele).
'
' HASZNÁLAT:
'   wscript.exe //nologo tools\restart-later.vbs [másodperc] [port]
'     másodperc : várakozás indítás előtt (alapértelmezés: 180)
'     port      : a harness portja (alapértelmezés: 3080)
'
' A wscript GUI-alkalmazás, ezért a hívó PowerShell nem várja meg — a hívás
' azonnal visszatér, a várakozás a háttérben fut, konzolablak nélkül.
Option Explicit

Dim shell, fso, here, seconds, port, repoRoot, script, cmd, logFile, logStream
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(here)

seconds = 180
port = 3080
If WScript.Arguments.Count >= 1 Then
  If IsNumeric(WScript.Arguments(0)) Then seconds = CLng(WScript.Arguments(0))
End If
If WScript.Arguments.Count >= 2 Then
  If IsNumeric(WScript.Arguments(1)) Then port = CLng(WScript.Arguments(1))
End If

script = fso.BuildPath(here, "restart-harness.ps1")
If Not fso.FileExists(script) Then
  WScript.Echo "Nem találom: " & script
  WScript.Quit 2
End If

' Napló: bizonyíték arra, hogy az ütemező tényleg lefutott (a hívó sandbox
' ugyanis csendben el is nyelve a folyamatindítást — ezt egyszer már láttuk).
logFile = fso.BuildPath(repoRoot, "state\restart-later.log")
Set logStream = fso.OpenTextFile(logFile, 8, True)
logStream.WriteLine Now & " indult; varakozas " & seconds & " s; port " & port & "; script: " & script
logStream.Close

WScript.Sleep seconds * 1000

' A -Force azért kell, mert a NATÍV DshTray.exe nem tartja a 'DshHarnessTrayIcon'
' mutexet (mért: 2026-11-13), ezért a szkript tálca-útja halottnak veszi a futó
' tálcát, és nem csinál semmit. A -Force a WMI-val indított leválasztott
' másolatot használja, ami a hívó folyamatfáján kívül fut.
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """ -Port " & port & " -Force"
shell.Run cmd, 0, False   ' 0 = rejtett, False = nem várja meg

Set logStream = fso.OpenTextFile(logFile, 8, True)
logStream.WriteLine Now & " restart-harness.ps1 -Force elinditva (rejtve)"
logStream.Close
