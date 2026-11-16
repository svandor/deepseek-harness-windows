<#
.SYNOPSIS
  A kitűzött DSH-hivatkozás AppUserModelID-jának beállítása, hogy a tálcán
  EGY ikon legyen (a kitűzött indító és a futó ablak ne különüljön el).

.DESCRIPTION
  A Windows a tálcagombokat AppUserModelID (AUMID) szerint csoportosítja.
  A DshWindow.exe / DshTray.exe futásidőben beállítja a saját AUMID-ját
  (DeepSeek.Harness), de a kitűzött .lnk-hez tartozó identitás a parancsikon
  System.AppUserModel.ID tulajdonságából jön. Ha ez hiányzik, az identitás a
  célfájl útvonalából származik (bin\DshLauncher.exe) — ez MÁS, ezért a tálcán
  két elem látszik.

  Ez a szkript a .lnk tulajdonságát állítja be (IPropertyStore), és opcionálisan
  eltávolítja a rossz, közvetlen ablak-pint (DshWindow.lnk): azt a felhasználó
  nem indíthatja kézzel (duplikált tálcagomb, hiányzó pid-fájl).

.PARAMETER Check
  Csak kiírja az érintett hivatkozások jelenlegi AUMID-ját (nem módosít).

.PARAMETER Apply
  Beállítja az AUMID-t (mentés: D:\Szerver\DSH-backup\pins-<időbélyeg>\), és
  visszaolvasással ellenőrzi.

.PARAMETER RemoveBogusPin
  Eltávolítja a kitűzött tálcaelemek közül a DshWindow.exe-re mutató pint.

.PARAMETER Aumid
  A beállítandó identitás (alapértelmezés: DeepSeek.Harness).

.EXAMPLE
  .\tools\set-pinned-aumid.ps1 -Check
  .\tools\set-pinned-aumid.ps1 -Apply -RemoveBogusPin
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Apply,
  [switch]$RemoveBogusPin,
  [string]$Aumid = 'DeepSeek.Harness'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pinnedDir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$launcher = Join-Path $root 'bin\DshLauncher.exe'
$windowExe = Join-Path $root 'bin\DshWindow.exe'

$targets = @()
foreach ($name in @('Deepseek Harness.lnk', 'DeepSeek Harness.lnk')) {
  $candidate = Join-Path $pinnedDir $name
  if (Test-Path $candidate) { $targets += $candidate }
}
$desktop = Join-Path $env:USERPROFILE 'Desktop\Deepseek Harness.lnk'
if (Test-Path $desktop) { $targets += $desktop }
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk'
if (Test-Path $startMenu) { $targets += $startMenu }
$bogusPin = Join-Path $pinnedDir 'DshWindow.lnk'

if (-not ('LnkAumid' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class CShellLink { }

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
public interface IShellLinkW
{
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Explicit)]
public struct PROPVARIANT
{
    // A PROPVARIANT x64-en 24 byte: vt(2) + 3 fenntartott WORD, majd a
    // unio a 8. ofszettol. A 16 byte-os valtozat STACKET RONTOTT (a COM 24
    // byte-ot ir), ezert a zerus padding benne van (mert hiba, 2026-11-16).
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointer;
    [FieldOffset(16)] public IntPtr padding;
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
public interface IPropertyStore
{
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PROPERTYKEY pkey);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    void Commit();
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
public interface IPersistFile
{
    void GetClassID(out Guid pClassID);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
}

public static class LnkAumid
{
    private const ushort VT_LPWSTR = 31;

    private static PROPERTYKEY PkeyAumid()
    {
        var key = new PROPERTYKEY();
        key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");  // System.AppUserModel
        key.pid = 5;                                                    // .ID
        return key;
    }

    /// <summary>A hivatkozás System.AppUserModel.ID értéke (null, ha nincs).</summary>
    public static string Get(string path)
    {
        object link = new CShellLink();
        try
        {
            ((IPersistFile)link).Load(path, 0);
            var store = (IPropertyStore)link;
            var key = PkeyAumid();
            PROPVARIANT pv;
            store.GetValue(ref key, out pv);
            string value = null;
            if (pv.vt == VT_LPWSTR && pv.pointer != IntPtr.Zero) value = Marshal.PtrToStringUni(pv.pointer);
            PropVariantClear(ref pv);
            return value;
        }
        finally { Marshal.ReleaseComObject(link); }
    }

    /// <summary>Beállítja a hivatkozás System.AppUserModel.ID értékét.</summary>
    public static void Set(string path, string aumid)
    {
        object link = new CShellLink();
        try
        {
            // STGM_READWRITE (2) KELL: STGM_READ mellett az IPersistFile.Save
            // STG_E_ACCESSDENIED (0x80030005) hibát ad (mért hiba, 2026-11-16).
            ((IPersistFile)link).Load(path, 2);
            var store = (IPropertyStore)link;
            SetString(store, 5, aumid);                       // System.AppUserModel.ID
            store.Commit();
            ((IPersistFile)link).Save(path, true);
        }
        finally { Marshal.ReleaseComObject(link); }
    }

    /// <summary>
    /// A kitűzött (nem futó) alkalmazás ÚJRAINDÍTÁSÁHOZ szükséges tulajdonságok:
    /// Windows ezekből tudja, mit indítson, ha a felhasználó a tálca-elemre
    /// kattint. Nélkülük a pin „Nem nyitható meg az elem" hibát ad, amint az
    /// ablak bezárul (mért hiba, 2026-11-16).
    /// </summary>
    public static void SetRelaunch(string path, string relaunchCommand, string displayName, string iconResource)
    {
        object link = new CShellLink();
        try
        {
            ((IPersistFile)link).Load(path, 2);
            var store = (IPropertyStore)link;
            if (!string.IsNullOrEmpty(relaunchCommand)) SetString(store, 2, relaunchCommand);   // RelaunchCommand
            if (!string.IsNullOrEmpty(displayName)) SetString(store, 4, displayName);           // RelaunchDisplayNameResource
            if (!string.IsNullOrEmpty(iconResource)) SetString(store, 3, iconResource);         // RelaunchIconResource
            store.Commit();
            ((IPersistFile)link).Save(path, true);
        }
        finally { Marshal.ReleaseComObject(link); }
    }

    private static void SetString(IPropertyStore store, uint pid, string value)
    {
        var key = new PROPERTYKEY();
        key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");  // System.AppUserModel
        key.pid = pid;
        var pv = new PROPVARIANT();
        pv.vt = VT_LPWSTR;
        pv.pointer = Marshal.StringToCoTaskMemUni(value);
        try
        {
            store.SetValue(ref key, ref pv);
        }
        finally { Marshal.FreeCoTaskMem(pv.pointer); }
    }

    /// <summary>Egy System.AppUserModel.* tulajdonság olvasása (ellenőrzéshez).</summary>
    public static string GetString(string path, uint pid)
    {
        object link = new CShellLink();
        try
        {
            ((IPersistFile)link).Load(path, 0);
            var store = (IPropertyStore)link;
            var key = new PROPERTYKEY();
            key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
            key.pid = pid;
            PROPVARIANT pv;
            store.GetValue(ref key, out pv);
            string value = null;
            if (pv.vt == VT_LPWSTR && pv.pointer != IntPtr.Zero) value = Marshal.PtrToStringUni(pv.pointer);
            PropVariantClear(ref pv);
            return value;
        }
        finally { Marshal.ReleaseComObject(link); }
    }

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PROPVARIANT pv);
}
'@
}

function Show-Link([string]$path) {
  if (-not (Test-Path $path)) { "  [nincs] $path"; return }
  $aumid = [LnkAumid]::Get($path)
  $relaunch = [LnkAumid]::GetString($path, 2)
  $sh = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  "  {0}`n      cel: {1}`n      AUMID: {2}`n      RelaunchCommand: {3}" -f (Split-Path $path -Leaf), $sh.TargetPath, $(if ($aumid) { $aumid } else { '<nincs>' }), $(if ($relaunch) { $relaunch } else { '<nincs>' })
}

"=== Jelenlegi állapot ==="
"tálcaelemek mappa: $pinnedDir"
foreach ($t in $targets) { Show-Link $t }
Show-Link $bogusPin
"futó ablak AUMID-ja: DeepSeek.Harness (a program állítja be)"
"kívánt AUMID: $Aumid"

if (-not $Apply) {
  if (-not $Check) { "`n(Módosításhoz: -Apply [-RemoveBogusPin])" }
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "D:\Szerver\DSH-backup\pins-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach ($t in ($targets + $bogusPin)) {
  if (Test-Path $t) { Copy-Item $t (Join-Path $backup (Split-Path $t -Leaf)) -Force }
}
"`nMentés: $backup"

$changed = 0
$iconFile = Join-Path $root 'assets\dsh.ico'
$displayName = 'DeepSeek Harness'
foreach ($t in $targets) {
  if (-not (Test-Path $t)) { continue }
  $before = [LnkAumid]::Get($t)
  $beforeRelaunch = [LnkAumid]::GetString($t, 2)
  if ($before -eq $Aumid -and $beforeRelaunch -eq $launcher) {
    "  változatlan (már jó): $(Split-Path $t -Leaf)"
    continue
  }
  [LnkAumid]::Set($t, $Aumid)
  [LnkAumid]::SetRelaunch($t, $launcher, $displayName, $iconFile)
  $after = [LnkAumid]::Get($t)
  $afterRelaunch = [LnkAumid]::GetString($t, 2)
  if ($after -ne $Aumid) { throw "Nem sikerült beállítani: $t (olvasott: '$after')" }
  if ($afterRelaunch -ne $launcher) { throw "Nem sikerült a RelaunchCommand: $t (olvasott: '$afterRelaunch')" }
  $changed++
  "  beállítva: $(Split-Path $t -Leaf)  ID: '$before' -> '$after'  relaunch: '$beforeRelaunch' -> '$afterRelaunch'"
}

if ($RemoveBogusPin -and (Test-Path $bogusPin)) {
  $sh = (New-Object -ComObject WScript.Shell).CreateShortcut($bogusPin)
  if ($sh.TargetPath -match 'DshWindow\.exe$') {
    Remove-Item $bogusPin -Force
    "  eltávolítva a rossz pin: $(Split-Path $bogusPin -Leaf) (DshWindow.exe)"
  } else {
    "  FIGYELEM: a DshWindow.lnk nem a DshWindow.exe-re mutat, ezért nem töröltem"
  }
}

"`nKész: $changed hivatkozás módosítva. A tálcaelem-cache miatt szükség lehet"
"az Explorer újraindítására:  taskkill /F /IM explorer.exe ; start explorer.exe"
