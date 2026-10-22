' Subagent fallback proxy orokodes inditasa REJTETT ablakkal.
'
' MIERT VBS ES MIERT NEM KOZVETLENUL A FELADATBOL (mert hiba, 2026-10-07):
' a Feladatutemezoben ez a parancs
'     powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
'                    -WindowStyle Hidden -File watchdog-subagent-proxy.ps1 -Quiet
' a Windows Terminalt (ezen a gepen az alapertelmezett terminal volt) megjelenitette,
' majd a tálcára minimalizálta, es elvette a fokuszt. A valodi megoldas a terminal
' visszaallitasa Windows konzol gazdagepre (HKCU:\Console\%%Startup); ez a burkolo
' a masodik vedelmi vonal, es egyben a duplikalt ciklusok elleni vedelem.
'
' MIERT VAN ITT "MAR FUT?" ELLENORZES: a wscript a ciklus elinditasa utan azonnal
' kilep, ezert a Feladatutemezoben a muvelet 1-2 masodperc alatt lezarul, es az
' IgnoreNew beallitas tobbe nem ved a parhuzamos ciklusoktol. Enelkul 5
' percenkent uj, soha le nem zaro orokodes indulna (memoria-szivargas).
'
' OPCIONALIS ELSO ARGUMENTUM: az orokodes ellenorzesi gyakorisaga masodpercben
' (a Start menü / parancsikon adja at; alapertelmezes a szkriptben: 60).
' ASCII-only szandekosan: a wscript a .vbs-t ANSI-kent olvassa.
Option Explicit
Dim sh, fso, root, script, pidFile, cmd, raw, pid, alive, svc, col, extra
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = Replace(WScript.ScriptFullName, WScript.ScriptName, "")
root = Left(root, Len(root) - 1)              ' trailing backslash le
script = root & "\watchdog-subagent-proxy.ps1"
pidFile = root & "\reports\proxy-watchdog.pid"
If Not fso.FileExists(script) Then
  WScript.Quit 1
End If

extra = ""
If WScript.Arguments.Count >= 1 Then
  If IsNumeric(WScript.Arguments(0)) Then
    extra = " -IntervalSeconds " & CLng(WScript.Arguments(0))
  End If
End If

' --- mar fut-e ciklus? -------------------------------------------------------
alive = False
If fso.FileExists(pidFile) Then
  On Error Resume Next
  raw = Trim(fso.OpenTextFile(pidFile, 1).ReadAll)
  On Error GoTo 0
  If IsNumeric(raw) Then
    pid = CLng(raw)
    On Error Resume Next
    Set svc = GetObject("winmgmts:\\.\root\cimv2")
    Set col = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)
    If Err.Number = 0 Then
      If col.Count > 0 Then alive = True
    End If
    Err.Clear
    On Error GoTo 0
  End If
End If
If alive Then
  WScript.Quit 0        ' fut mar orokodes: nem inditunk masodikat
End If

' --- inditas rejtve ---------------------------------------------------------
sh.CurrentDirectory = root
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass" _
    & " -WindowStyle Hidden -File """ & script & """ -Quiet" & extra
sh.Run cmd, 0, False
