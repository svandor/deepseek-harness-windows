' Általános REJTETT indító ütemezett feladatokhoz.
'
' MIÉRT: ha a feladat művelete közvetlenül konzolprogram (powershell.exe, pwsh.exe,
' cmd.exe, cscript.exe), a Task Scheduler ÚJ, LÁTHATÓ konzolablakot hoz létre, és
' a PowerShell csak utána rejti el (ShowWindow(SW_HIDE)) -> fél másodperces
' villanás, fókuszlopás. Mért hiba: 2026-10-22 23:31:01, bot\README.md.
'
' A wscript.exe viszont egyáltalán nem hoz létre konzolt (Run 2. paramétere 0).
'
' Ezt a fájlt a tools\fix-flashing-tasks.ps1 -Apply használja, ebben a formában:
'   wscript.exe //nologo "tools\run-hidden.vbs" "<exe>" <argumentumok...>
' Az 1. argumentum a futtatandó program, a többi a neki átadott argumentum.
'
' Szabály: ..\AGENTS.md 1. fejezet. KÉZZEL NE írd át a műveletet vissza
' powershell.exe-re vagy .cmd-re.
Option Explicit

Dim shell, exe, extra, i, cmd, code

If WScript.Arguments.Count = 0 Then
  WScript.Echo "Használat: wscript.exe //nologo run-hidden.vbs ""<exe>"" [argumentumok...]"
  WScript.Quit 87   ' ERROR_INVALID_PARAMETER
End If

Set shell = CreateObject("WScript.Shell")

exe = WScript.Arguments(0)
extra = ""
For i = 1 To WScript.Arguments.Count - 1
  extra = extra & " " & WScript.Arguments(i)
Next

cmd = """" & exe & """" & extra
code = shell.Run(cmd, 0, True)   ' 0 = rejtett, True = megvárja
WScript.Quit code
