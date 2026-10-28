' DSH-AutoTune — az ÜTEMEZETT FELADAT rejtett indítója.
'
' MIÉRT KELL: a feladat művelete korábban közvetlenül a run-autotune.cmd shimre
' mutatott. A Task Scheduler a .cmd-hez LÁTHATÓ konzolt hoz létre (fekete
' cmd.exe), és a fókusz elkerül a felhasználó munkájától.
' A -WindowStyle Hidden NEM véd, mert csak a létrehozás után fut le.
' Szabály: ..\AGENTS.md 1. fejezet.
'
' A wscript.exe `Run(cmd, 0, True)` hívása egyáltalán nem hoz létre konzolt:
' 0 = rejtett, True = megvárja a végét, hogy a Task Scheduler a valódi exit
' kódot lássa. A .cmd logikája (ASCII, kimenet-átirányítás) változatlan marad.
'
' Használat (a feladat művelete):
'   wscript.exe //nologo "<providers>\run-autotune-hidden.vbs"
Option Explicit

Dim shell, fso, root, shim, code

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
shim = root & "\run-autotune.cmd"

If Not fso.FileExists(shim) Then
  WScript.Echo "Hiányzik: " & shim
  WScript.Quit 2
End If

' cmd.exe /c a .cmd-hez, de a Run ablaka 0 = rejtett -> nem jön létre konzol.
code = shell.Run("cmd.exe /c """ & shim & """", 0, True)
WScript.Quit code
