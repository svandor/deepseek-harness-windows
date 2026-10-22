' Házirobot — az ÜTEMEZETT FELADAT rejtett indítója.
'
' MÉRT HIBA (2026-10-22, 23:31:01): a Task Scheduler közvetlenül a
'   powershell.exe ... -WindowStyle Hidden -File ...\run-job.ps1 due
' parancsot indította, és a konzolablak LÁTHATÓAN létrejött, elvette a fókuszt
' (ConsoleWindowClass, a foreground a powershell lett), majd a PowerShell
' elrejtette — 15 percenként egy fél másodperces villanás. A -WindowStyle
' Hidden ugyanis csak a létrehozás UTÁN hívja a ShowWindow(SW_HIDE)-ot.
'
' A wscript.exe viszont egyáltalán nem hoz létre konzolt: a WshShell.Run
' második paramétere 0 = rejtett ablak, a harmadik (True) = megvárjuk a végét,
' hogy a Task Scheduler a valódi exit kódot lássa.
'
' Használat (a feladat művelete):
'   wscript.exe //nologo "<bot>\run-job-hidden.vbs" due
Option Explicit

Dim shell, fso, root, ps, script, extra, i, cmd, code

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
script = root & "\run-job.ps1"

extra = ""
For i = 0 To WScript.Arguments.Count - 1
  extra = extra & " " & Quote(WScript.Arguments(i))
Next

cmd = """" & ps & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & script & """" & extra
code = shell.Run(cmd, 0, True)
WScript.Quit code

Function Quote(value)
  Quote = """" & Replace(value, """", """""") & """"
End Function
