using System;
using System.Diagnostics;
using System.IO;
using System.Collections.Generic;

/// <summary>
/// A build által hátrahagyott *.exe.new fájlok automatikus alkalmazása.
///
/// MIÉRT KELL: a futó ablak (és a tálca) zárolja a saját exe-jét, ezért a
/// build nem tudja felülírni — ilyenkor DshWindow.exe.new néven készül el.
/// Korábban ezt a felhasználónak kellett kézzel átmozgatnia, ami gyakran
/// elmaradt (főleg cmd.exe-ben, ahol a Move-Item nem is létezik), és a régi
/// exe futott tovább a javítások ellenére is.
///
/// Ez az osztály minden induláskor végigmegy a várakozó fájlokon, és amelyik
/// célfájl éppen nem zárolt, azt kicseréli (előbb .old-&lt;időbélyeg&gt; mentést
/// készítve). Így a következő indítás már a friss programot futtatja, kézi
/// parancs nélkül.
///
/// MÉRT HIBA (2026-11-20): a `bin\DshTray.exe.new` (2026-11-18 15:32, a halott
/// tokenre navigálás javítása) **két napig nem lépett életbe**, mert a
/// bejelentkezéskori autostart közvetlenül a `DshTray.exe`-t indítja, az pedig
/// a SAJÁT futó képét nem tudta kicserélni (a zárolás-próba kihagyta) — a
/// frissítés csak a `DshLauncher`-en át jutott volna be. Következmény a
/// 2026-11-20 04:02-es booton: az ablak a boot ELŐTTI, halott tokennel nyílt
/// meg (HTTP 404), ezért a panelek fehér felülettel indultak.
///
/// Ezért a saját futó lemezképet (Process.MainModule) ÁTNEVEZÉSSEL cseréljük:
/// a Windows a leképezett lemezképet megtartja, a fájlNÉV viszont szabad, tehát
/// a futó tálca/ablak alatt is be lehet tenni az új példányt — a következő
/// indítás már azzal fut. Hiba esetén a mentés visszakerül a helyére.
/// </summary>
internal static class PendingUpdate
{
    /// <summary>
    /// A bin mappában kezelt programok. A sorrend nem számít: mindegyik
    /// függetlenül, zárolás-ellenőrzéssel cserélődik.
    /// </summary>
    private static readonly string[] Managed =
    {
        "DshWindow.exe",
        "DshTray.exe",
        "DshLauncher.exe"
    };

    public static void Apply(string root)
    {
        Apply(root, null);
    }

    /// <summary>
    /// Függő frissítések alkalmazása; a `log` (ha van) megkapja az eredményt is,
    /// hogy a naplóból kiderüljön, melyik exe melyik indításkor cserélődött.
    /// </summary>
    public static void Apply(string root, Action<string> log)
    {
        try
        {
            string bin = Path.Combine(root, "bin");
            if (!Directory.Exists(bin)) return;

            foreach (string name in Managed)
            {
                ApplyOne(bin, name, log);
            }
        }
        catch
        {
            // Frissítés-alkalmazás soha nem akadályozhatja az indítást.
        }
    }

    private static void ApplyOne(string bin, string name, Action<string> log)
    {
        string target = Path.Combine(bin, name);
        string pending = target + ".new";
        if (!File.Exists(pending)) return;

        bool locked = IsLocked(target);
        bool own = locked && IsOwnImage(target);
        if (locked && !own)
        {
            // Másik folyamat fut belőle: futás közben nem cserélhető, a
            // következő indítás újra megpróbálja (a .new sértetlen marad).
            return;
        }

        string backup = null;
        bool targetMoved = false;
        try
        {
            if (File.Exists(target))
            {
                backup = target + ".old-"
                    + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture);
                if (!own)
                {
                    File.Replace(pending, target, backup, true);
                    PruneBackups(bin, name);
                    Report(log, "pending update applied: " + name);
                    return;
                }
                // SAJÁT futó kép: felülírni nem lehet, ÁTNEVEZNI viszont igen.
                File.Move(target, backup);
                targetMoved = true;
            }
            File.Move(pending, target);
            PruneBackups(bin, name);
            Report(log, "pending update applied while running (own image renamed, the NEXT start uses it): "
                + name + " (backup: " + Path.GetFileName(backup ?? "-") + ")");
        }
        catch (Exception ex)
        {
            RollBack(target, pending, backup, targetMoved);
            Report(log, "pending update failed: " + name + ": " + ex.Message);
        }
    }

    /// <summary>
    /// Ha az átnevezés sikerült, de az új fájl behelyezése nem, a futó kép
    /// mentését visszatesszük a helyére — különben a következő indításnak nem
    /// lenne mit futtatnia.
    /// </summary>
    private static void RollBack(string target, string pending, string backup, bool targetMoved)
    {
        if (!targetMoved || string.IsNullOrEmpty(backup)) return;
        try
        {
            if (!File.Exists(target) && File.Exists(backup)) File.Move(backup, target);
        }
        catch
        {
        }
        try
        {
            if (!File.Exists(pending) && File.Exists(backup) && !File.Exists(target))
            {
                File.Move(backup, target);
            }
        }
        catch
        {
        }
    }

    private static void Report(Action<string> log, string message)
    {
        if (log == null) return;
        try { log(message); } catch { }
    }

    /// <summary>Igaz, ha a fájl a most futó folyamat saját lemezképe.</summary>
    private static bool IsOwnImage(string path)
    {
        try
        {
            string own = Process.GetCurrentProcess().MainModule.FileName;
            if (string.IsNullOrEmpty(own)) return false;
            return string.Equals(
                Path.GetFullPath(own).TrimEnd('\\'),
                Path.GetFullPath(path).TrimEnd('\\'),
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Igaz, ha a fájl létezik és más folyamat használja.</summary>
    private static bool IsLocked(string path)
    {
        if (!File.Exists(path)) return false;
        try
        {
            using (var probe = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                probe.Close();
            }
            return false;
        }
        catch (IOException)
        {
            return true;
        }
        catch (UnauthorizedAccessException)
        {
            return true;
        }
        catch
        {
            return true;
        }
    }

    /// <summary>
    /// A .old-* biztonsági mentésekből csak az utolsó néhányat tartja meg: a
    /// bin mappa évek alatt tele lett több tucat másolattal. A most futó kép
    /// mentése (a legfrissebb) mindig megmarad; a futó lemezkép törlése
    /// egyébként is sikertelen lenne, ezt a hívás elnyeli.
    /// </summary>
    private static void PruneBackups(string bin, string name)
    {
        try
        {
            var backups = new List<FileInfo>();
            foreach (string file in Directory.GetFiles(bin, name + ".old-*"))
            {
                backups.Add(new FileInfo(file));
            }
            backups.Sort((a, b) => b.LastWriteTimeUtc.CompareTo(a.LastWriteTimeUtc));
            for (int i = 5; i < backups.Count; i++)
            {
                try { backups[i].Delete(); } catch { }
            }
        }
        catch
        {
        }
    }
}
