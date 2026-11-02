// DshLauncher - the pinnable entry point of the DeepSeek Harness tray.
//
// Why this exists: Windows 11 refuses to pin (or drag to the taskbar) any
// shortcut whose target is not a real executable - a .cmd/.bat/.ps1 target gives
// no "Pin to taskbar" verb at all. This tiny window-less launcher is the .exe
// that the desktop/Start menu/taskbar shortcuts point at.
//
// Behaviour:
//   * native tray already running -> ask it (named event) to show the window
//   * native tray not running     -> start bin\DshTray.exe (a WinExe: no console)
//
// 2026-10-31: this launcher used to start the OLD PowerShell tray
// (`powershell.exe -WindowStyle Hidden -File tray\dsh-tray.ps1`). That had two
// measured problems:
//   1. it created a *second* supervisor with its own mutex
//      (DshHarnessTrayIcon) next to bin\DshTray.exe, and the old script's 20 s
//      health check re-opened a window the user had just closed;
//   2. `powershell.exe` is a console program, so the hidden-console start still
//      flashes a window and steals focus (AGENTS.md 1.1 / 1.3, P0).
// The native tray does both jobs without a console.
//
// Build: see build.ps1.

using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class DshLauncher
{
    private const string TrayMutexName = "DshTraySingleInstance";   // a natív tálca (DshTray.exe)
    private const string WindowSignalName = "DshHarnessShowWindow";
    private const string WindowProcessName = "DshWindow";
    private const string WindowTitle = "DeepSeek Harness";

    [STAThread]
    private static int Main(string[] args)
    {
        string root = ResolveRoot();

        // Függő frissítés alkalmazása MINDEN induláskor (2026-01-XX).
        //
        // MIÉRT: a build nem tudja felülírni a bin\DshWindow.exe-t, amíg az ablak
        // fut, ezért .new néven hagyja. Eddig ezt a felhasználónak kellett kézzel
        // átmozgatnia — cmd.exe-ben ráadásul a Move-Item parancs sem létezik, így
        // a frissítés csendben elmaradt, és továbbra is a régi exe futott.
        // Most az indító a legelső dolgaként athelyezi a várakozó .new fájlt,
        // amint a célfájl már nem zárolt (azaz az ablak bezárult).
        PendingUpdate.Apply(root);

        if (args.Length > 0 && (args[0] == "--help" || args[0] == "-h" || args[0] == "/?"))
        {
            ShowHelp();
            return 0;
        }

        bool trayOnly = false;
        bool resetGeometry = false;
        foreach (string a in args)
        {
            if (a == "--tray-only") trayOnly = true;
            if (a == "--reset-geometry") resetGeometry = true;
        }

        // A `--reset-geometry` a MENTETT geometriát törli: a DshWindow a
        // state\window-geometry.txt-ből olvassa a pozíciót és a méretet, ezért a
        // fájl törlése maga a "reset" — az ablak középre kerül.
        //
        // MIÉRT ITT ÉS NEM ÁTADVA: ez a launcher a TÁLCÁT indítja (vagy jelzéssel
        // kéri az ablak megnyitását), a tálcán keresztül viszont nem lehet
        // kapcsolót átadni. A fájl törlése viszont minden úton ugyanazt éri el,
        // és a --help már eddig is kínálta ezt a kapcsolót (eddig hatás nélkül).
        if (resetGeometry) { ResetWindowGeometry(root); }

        string trayExe = Path.Combine(root, "bin", "DshTray.exe");
        if (!File.Exists(trayExe))
        {
            Fail("Nem találom a tálca programját:\n" + trayExe);
            return 2;
        }

        if (trayOnly)
        {
            StartTray(trayExe, root);
            return 0;
        }

        if (IsTrayRunning())
        {
            if (!SignalOpenWindow())
            {
                // The tray is alive but its event is missing (very old build):
                // start it again, the second instance exits on the mutex and the
                // window would never open — so fall back to the window itself.
                StartTray(trayExe, root);
            }
            return 0;
        }

        // No tray yet: start it so that it opens the window itself.
        StartTray(trayExe, root);
        return 0;
    }

    /// <summary>
    /// The launcher lives in &lt;root&gt;\bin, so the project root is one level up.
    /// </summary>
    private static string ResolveRoot()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        try
        {
            return Path.GetFullPath(Path.Combine(baseDir, ".."));
        }
        catch
        {
            return baseDir;
        }
    }

    /// <summary>
    /// A súgó. MessageBox és NEM Console: ez a program `-target:winexe`, ezért
    /// nincs konzolja — a Console.WriteLine nyomtalanul elveszne, és a --help
    /// néma lenne (mért hiba: a súgó sehol nem jelent meg).
    /// </summary>
    private static void ShowHelp()
    {
        string text =
            "DshLauncher — a DeepSeek Harness indítója (a tálcára kitűzhető exe).\r\n" +
            "\r\n" +
            "Használat: DshLauncher.exe [--tray-only] [--reset-geometry]\r\n" +
            "  (kapcsolók nélkül: megnyitja az ablakot, a tálcát is elindítja, ha kell)\r\n" +
            "  --tray-only       csak a rendszertálcát indítja el (a meglévő ablakot nem érinti)\r\n" +
            "  --reset-geometry  az ablak középre kerül (a mentett pozíció törlése)";
        try
        {
            System.Windows.Forms.MessageBox.Show(text, WindowTitle,
                System.Windows.Forms.MessageBoxButtons.OK,
                System.Windows.Forms.MessageBoxIcon.Information);
        }
        catch
        {
            // Nincs interaktív munkamenet: nincs mód üzenetet mutatni.
        }
    }

    /// <summary>
    /// A mentett ablakgeometria (pozíció + méret) törlése, hogy az ablak
    /// középre kerüljön. A DshWindow a state\window-geometry.txt-ből olvassa,
    /// ezért a fájl törlése maga a "reset".
    /// </summary>
    private static void ResetWindowGeometry(string root)
    {
        try
        {
            string file = Path.Combine(root, "state", "window-geometry.txt");
            if (File.Exists(file)) { File.Delete(file); }
        }
        catch
        {
            // Best effort: egy zárolt fájl nem akadályozhatja az indítást.
        }
    }

    private static bool IsTrayRunning()    {
        try
        {
            using (var mutex = Mutex.OpenExisting(TrayMutexName))
            {
                return true;
            }
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            // Exists but not ours to open: it is running.
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool SignalOpenWindow()
    {
        try
        {
            using (var signal = EventWaitHandle.OpenExisting(WindowSignalName))
            {
                // Clear a stale request first so the tray handles exactly one.
                signal.Reset();
                signal.Set();
                return true;
            }
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// A natív tálca elindítása (bin\DshTray.exe).
    ///
    /// MIÉRT NEM PowerShell: a `powershell.exe -WindowStyle Hidden` előbb
    /// LÉTREHOZ egy konzolablakot, és csak utána rejti el — ez látható villanás
    /// és fókuszlopás (AGENTS.md 1.1/1.3, P0). A natív tálca WinExe: egyáltalán
    /// nem hoz létre konzolt.
    /// </summary>
    private static void StartTray(string trayExe, string root)
    {
        var psi = new ProcessStartInfo
        {
            FileName = trayExe,
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        Process.Start(psi);
    }

    private static void Fail(string message)
    {
        try
        {
            System.Windows.Forms.MessageBox.Show(message, WindowTitle,
                System.Windows.Forms.MessageBoxButtons.OK,
                System.Windows.Forms.MessageBoxIcon.Error);
        }
        catch
        {
            // No interactive session: the exit code is the only signal left.
        }
    }
}
