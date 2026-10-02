// DeepSeek Harness — önálló telepítő (Setup.exe).
//
// MIÉRT SAJÁT TELEPÍTŐ: a projekt nem egyetlen bináris, hanem egy munkaterület
// (tálca, natív ablak, bővítmények, robot, szkriptek), és futásidőben a Node.js-re
// és a WebView2 futtatókörnyezetre támaszkodik. Egy .msi/Inno-hoz képest ez a
// megoldás nem igényel külső eszközt: a telepítő a projekt SAJÁT fordítójával
// készül, és a teljes munkaterületet egy beágyazott ZIP-ben viszi magával.
//
// MIT TESZ:
//   1) kibontja a beágyazott ZIP-et a célmappába (alap: %LOCALAPPDATA%\DeepSeekHarness),
//   2) ellenőrzi az előfeltételeket (node, WebView2 futtatókörnyezet),
//   3) lefuttatja a munkaterület install.ps1-ét: asztali + Start menü ikon,
//      opcionálisan bejelentkezéskori indítás,
//   4) összefoglalót ír, és hiba esetén nem hazudik sikert.
//
// KAPCSOLÓK:
//   /dir=<útvonal>   célmappa (alapértelmezés: %LOCALAPPDATA%\DeepSeekHarness)
//   /silent          nincs kérdés, nincs várakozás a végén
//   /autostart       bejelentkezéskori indítás bekapcsolása
//   /noinstall       csak kibontás (az install.ps1 nem fut le)
//   /uninstall       a telepített mappát és a parancsikonokat törli
//   /?               súgó
//
// Kilépési kód: 0 = siker, 1 = hiba, 2 = az előfeltétel hiányzik (a telepítés
// befejeződött, de a program nem indul el nélküle).

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

internal static class Setup
{
    private const string PayloadResource = "payload.zip";
    private const string ShortcutName = "DeepSeek Harness.lnk";
    private const string AutostartName = "DeepSeek Harness (talca).lnk";

    private static bool _silent;
    private static bool _noInstall;
    private static bool _autostart;

    private static int Main(string[] args)
    {
        string target = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DeepSeekHarness");
        bool uninstall = false;

        foreach (string arg in args)
        {
            if (arg.StartsWith("/dir=", StringComparison.OrdinalIgnoreCase))
            {
                target = arg.Substring(5).Trim('"');
            }
            else if (arg.Equals("/silent", StringComparison.OrdinalIgnoreCase)) _silent = true;
            else if (arg.Equals("/quiet", StringComparison.OrdinalIgnoreCase)) _silent = true;
            else if (arg.Equals("/noinstall", StringComparison.OrdinalIgnoreCase)) _noInstall = true;
            else if (arg.Equals("/autostart", StringComparison.OrdinalIgnoreCase)) _autostart = true;
            else if (arg.Equals("/uninstall", StringComparison.OrdinalIgnoreCase)) uninstall = true;
            else if (arg.Equals("/?", StringComparison.OrdinalIgnoreCase)
                  || arg.Equals("/help", StringComparison.OrdinalIgnoreCase)
                  || arg.Equals("-h", StringComparison.OrdinalIgnoreCase))
            {
                ShowHelp();
                return 0;
            }
        }

        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Header();

        if (uninstall) return Uninstall(target);

        try
        {
            Directory.CreateDirectory(target);
        }
        catch (Exception ex)
        {
            return Fail("A célmappa nem hozható létre: " + target + "\n" + ex.Message);
        }

        Console.WriteLine("Célmappa : " + target);
        Console.WriteLine();

        // --- 1) kibontás ------------------------------------------------------
        try
        {
            int files = Extract(target);
            Console.WriteLine("[1/3] Kibontva: " + files + " fájl.");
        }
        catch (Exception ex)
        {
            return Fail("A kibontás nem sikerült:\n" + ex.Message);
        }

        string launcher = Path.Combine(target, "bin", "DshLauncher.exe");
        if (!File.Exists(launcher))
        {
            // Nem hiba önmagában, de a telepítés így hiányos: a parancsikonok
            // egy nem létező exe-re mutatnának.
            return Fail("A kibontott csomagban nincs bin\\DshLauncher.exe — a csomag sérült.");
        }

        // --- 2) előfeltételek -------------------------------------------------
        int missing = CheckPrerequisites();
        Console.WriteLine();

        // --- 3) parancsikonok és indítás --------------------------------------
        if (_noInstall)
        {
            Console.WriteLine("[3/3] Kihagyva (/noinstall): a parancsikonok nem készültek el.");
        }
        else
        {
            int rc = RunInstallScript(target);
            if (rc != 0)
            {
                return Fail("Az install.ps1 hibával tért vissza (" + rc + "). A fájlok a helyükön vannak, "
                    + "a parancsikonokat kézzel is létrehozhatod:\n  "
                    + Path.Combine(target, "install.ps1"));
            }
            Console.WriteLine("[3/3] Parancsikonok kész.");
        }

        Console.WriteLine();
        Console.WriteLine("KÉSZ.");
        Console.WriteLine("  Indítás : asztali \"DeepSeek Harness\" ikon, vagy:");
        Console.WriteLine("            " + launcher);
        Console.WriteLine("  Tálcára : jobb klikk az asztali ikonra -> Megjelenítés további beállítások");
        Console.WriteLine("            -> Kitűzés a tálcára");
        Console.WriteLine("  Eltávolítás: " + Path.GetFileName(SelfPath()) + " /uninstall");
        if (missing != 0)
        {
            Console.WriteLine();
            Console.WriteLine("FIGYELEM: az előfeltétel hiányzik (lásd fent) — a program elindul, de a");
            Console.WriteLine("          hiányzó rész nélkül nem tud működni.");
        }

        Finish(missing != 0 ? 2 : 0);
        return missing != 0 ? 2 : 0;
    }

    /* ------------------------------------------------------------------ lépések */

    /// <summary>Kibontja a beágyazott ZIP-et a célmappába, és visszaadja a fájlok számát.</summary>
    private static int Extract(string target)
    {
        Assembly self = Assembly.GetExecutingAssembly();
        using (Stream payload = self.GetManifestResourceStream(PayloadResource))
        {
            if (payload == null)
            {
                throw new InvalidOperationException("a beágyazott " + PayloadResource + " nem található");
            }

            // ZipArchive a streamről: nem kell temp fájl, és nem marad szemét.
            using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                int count = 0;
                string full = Path.GetFullPath(target) + Path.DirectorySeparatorChar;
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    if (entry.FullName.EndsWith("/", StringComparison.Ordinal)) continue; // könyvtár
                    string destination = Path.GetFullPath(Path.Combine(target, entry.FullName));

                    // Zip-slip védelem: a bejegyzés nem írhat a célmappán kívülre.
                    if (!destination.StartsWith(full, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("a csomag a célmappán kívülre mutat: " + entry.FullName);
                    }

                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    // A futó példány foghatja a fájlt; ilyenkor a telepítés nem
                    // áll meg, csak jelzi (a felhasználó bezárhatja és újrafuttathatja).
                    try
                    {
                        entry.ExtractToFile(destination, true);
                        count++;
                    }
                    catch (IOException ex)
                    {
                        Console.WriteLine("      (foglalt, kihagyva: " + entry.FullName + " — " + ex.Message + ")");
                    }
                }
                return count;
            }
        }
    }

    /// <summary>Node.js és WebView2 jelenlétének ellenőrzése. A hiányzók számát adja.</summary>
    private static int CheckPrerequisites()
    {
        int missing = 0;

        bool node = false;
        try
        {
            var psi = new ProcessStartInfo("node", "--version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using (Process p = Process.Start(psi))
            {
                string version = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(5000);
                node = p.ExitCode == 0 && version.Length > 0;
                if (node) Console.WriteLine("[2/3] Node.js: " + version);
            }
        }
        catch
        {
            node = false;
        }
        if (!node)
        {
            missing++;
            Console.WriteLine("[2/3] Node.js: HIÁNYZIK — a háttér-GUI nem indul el.");
            Console.WriteLine("      Telepítés: https://nodejs.org/  (LTS)");
        }

        // WebView2 futtatókörnyezet: a natív ablak ehhez kötődik. A gépen a
        // telepített Edge részeként általában megvan, ezért csak a kliens DLL
        // kulcsát nézzük (nem a Edge verzióját).
        bool webview = false;
        try
        {
            using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"))
            {
                webview = key != null;
            }
            if (!webview)
            {
                using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                    @"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"))
                {
                    webview = key != null;
                }
            }
        }
        catch
        {
            webview = false;
        }
        Console.WriteLine("[2/3] WebView2: " + (webview ? "megvan" : "nem található (az ablak nem indul el)"));
        if (!webview)
        {
            missing++;
            Console.WriteLine("      Telepítés: https://developer.microsoft.com/microsoft-edge/webview2/");
        }

        return missing;
    }

    /// <summary>A munkaterület install.ps1-ének futtatása (parancsikonok).</summary>
    private static int RunInstallScript(string target)
    {
        string script = Path.Combine(target, "install.ps1");
        if (!File.Exists(script))
        {
            Console.WriteLine("[3/3] Nincs install.ps1 a csomagban — parancsikonok nélkül.");
            return 0;
        }

        string arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -PinToTaskbar -Yes"
            + (_autostart ? " -AutoStart" : "");
        var psi = new ProcessStartInfo("powershell.exe", arguments)
        {
            WorkingDirectory = target,
            UseShellExecute = false,
        };
        using (Process p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    private static int Uninstall(string target)
    {
        Console.WriteLine("Eltávolítás: " + target);

        // 1) előbb a parancsikonok, hogy ne maradjon halott ikon.
        //
        // CSAK AKKOR töröljük, ha a parancsikon EBBE a mappába mutat: egy másik
        // (pl. portable) telepítés ikonját nem szabad elvinni. Ez teszi
        // biztonságossá azt is, hogy egy próbatelepítést a saját mappájára
        // futtatva a valódi ikon a helyén marad.
        RemoveShortcutIfOwned(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Desktop), ShortcutName), target);
        RemoveShortcutIfOwned(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            @"Microsoft\Windows\Start Menu\Programs", ShortcutName), target);
        RemoveShortcutIfOwned(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), AutostartName), target);

        // 2) a futó példány leállítása (különben a fájlok fogva maradnak).
        foreach (string name in new[] { "DshWindow", "DshLauncher" })
        {
            foreach (Process p in Process.GetProcessesByName(name))
            {
                try { p.Kill(); p.WaitForExit(5000); } catch { }
            }
        }

        if (!Directory.Exists(target))
        {
            Console.WriteLine("A mappa már nem létezett. Kész.");
            Finish(0);
            return 0;
        }

        try
        {
            Directory.Delete(target, true);
        }
        catch (Exception ex)
        {
            Finish(1);
            return Fail("A mappa nem törölhető (lehet, hogy egy folyamat még használja):\n" + ex.Message);
        }

        Console.WriteLine("Kész: a mappa és a parancsikonok törölve. A munkamenetek és a");
        Console.WriteLine("beállítások a %USERPROFILE%\\.dsh mappában maradtak (ezek nem a telepítéshez tartoznak).");
        Finish(0);
        return 0;
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) { File.Delete(path); Console.WriteLine("  törölve: " + path); }
        }
        catch (Exception ex)
        {
            Console.WriteLine("  nem sikerült törölni (" + path + "): " + ex.Message);
        }
    }

    /// <summary>
    /// A parancsikont csak akkor törli, ha a célpontja a megadott mappába mutat.
    ///
    /// MIÉRT: a vak törlés egy MÁSIK telepítés ikonját is elvinné (pl. ha a
    /// felhasználó portable példányt is használ). Ha a célpont nem olvasható ki
    /// (nincs WScript.Shell COM), akkor sem törölünk — a biztonságos irány az,
    /// hogy a fájl a helyén marad, és a felhasználó kézzel törli.
    /// </summary>
    private static void RemoveShortcutIfOwned(string linkPath, string target)
    {
        if (!File.Exists(linkPath))
        {
            return;
        }
        try
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null)
            {
                Console.WriteLine("  meghagyva (a parancsikon célpontja nem ellenőrizhető): " + linkPath);
                return;
            }
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember(
                "CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
            Type shortcutType = shortcut.GetType();
            string actual = Convert.ToString(shortcutType.InvokeMember(
                "TargetPath", BindingFlags.GetProperty, null, shortcut, null));
            string prefix = target.TrimEnd('\\') + "\\";
            if (!string.IsNullOrEmpty(actual)
                && actual.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                TryDelete(linkPath);
            }
            else
            {
                Console.WriteLine("  meghagyva (más telepítésre mutat): " + linkPath);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("  meghagyva (" + ex.Message + "): " + linkPath);
        }
    }

    /* ------------------------------------------------------------------ kimenet */

    private static void Header()
    {
        Console.WriteLine("DeepSeek Harness — telepítő");
        Console.WriteLine("===========================");
        Console.WriteLine("MIT licenc, szerző: Varga Sándor (svandor)");
        Console.WriteLine();
    }

    private static int Fail(string message)
    {
        Console.WriteLine();
        Console.WriteLine("HIBA: " + message);
        Finish(1);
        return 1;
    }

    /// <summary>A végén megvárja a felhasználót — dupla kattintva a konzol másképp eltűnik.</summary>
    private static void Finish(int code)
    {
        if (_silent) return;
        Console.WriteLine();
        Console.WriteLine("(Enter a bezáráshoz)");
        try { Console.ReadLine(); } catch { }
    }

    private static string SelfPath()
    {
        try { return Assembly.GetExecutingAssembly().Location; } catch { return "Setup.exe"; }
    }

    private static void ShowHelp()
    {
        MessageBox.Show(
            "DeepSeek Harness telepítő\r\n\r\n"
            + "  /dir=<útvonal>   célmappa (alap: %LOCALAPPDATA%\\DeepSeekHarness)\r\n"
            + "  /silent          nincs kérdés, nincs várakozás a végén\r\n"
            + "  /autostart       bejelentkezéskori indítás bekapcsolása\r\n"
            + "  /noinstall       csak kibontás, parancsikonok nélkül\r\n"
            + "  /uninstall       a telepített mappa és a parancsikonok törlése\r\n"
            + "  /?               ez a súgó\r\n\r\n"
            + "MIT licenc — Varga Sándor (svandor)",
            "DeepSeek Harness telepítő",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }
}
