' DSH model retune — az ÜTEMEZETT FELADAT rejtett indítója.
'
' MIÉRT KELL: a feladat művelete korábban a run-retune.cmd shimre mutatott.
' A Task Scheduler a .cmd-hez KONZOLT hoz létre (fekete cmd.exe), a shim pedig
' újabb látható powershell.exe-t indított (kék ablak) — 2026-10-28 09:00:01-kor
' két ablak vette el a fókuszt, és 09:09-ig látszott. A -WindowStyle Hidden
' önmagában nem segít: az csak a létrehozás UTÁN rejti el a konzolt.
'
' A wscript.exe viszont egyáltalán nem hoz létre konzolt: a WshShell.Run
' második paramétere 0 = rejtett, a harmadik (True) = megvárjuk a végét, hogy a
' Task Scheduler a valódi exit kódot lássa.
'
' Használat (a feladat művelete):
'   wscript.exe //nologo "<providers>\run-retune-hidden.vbs" apply
'   wscript.exe //nologo "<providers>\run-retune-hidden.vbs" report
Option Explicit

Dim shell, fso, root, ps, script, mode, cmd, code

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
ps = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
script = root & "\run-retune.ps1"

' Alapértelmezés: apply (a napi ütemezett futás javítson is).
mode = "apply"
If WScript.Arguments.Count > 0 Then mode = WScript.Arguments(0)

cmd = """" & ps & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass" & _
      " -WindowStyle Hidden -File """ & script & """ -Mode " & Quote(mode)

code = shell.Run(cmd, 0, True)
WScript.Quit code

Function Quote(value)
  Quote = """" & Replace(value, """", """""") & """"
End Function
