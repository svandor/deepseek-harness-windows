using System;
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
        try
        {
            string bin = Path.Combine(root, "bin");
            if (!Directory.Exists(bin)) return;

            foreach (string name in Managed)
            {
                ApplyOne(bin, name);
            }
        }
        catch
        {
            // Frissítés-alkalmazás soha nem akadályozhatja az indítást.
        }
    }

    private static void ApplyOne(string bin, string name)
    {
        string target = Path.Combine(bin, name);
        string pending = target + ".new";
        if (!File.Exists(pending)) return;

        // A saját folyamat exe-jét nem lehet futás közben kicserélni; a
        // zárolás-próba ezt is helyesen jelzi.
        if (IsLocked(target)) return;

        try
        {
            if (File.Exists(target))
            {
                string backup = target + ".old-"
                    + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture);
                File.Replace(pending, target, backup, true);
                PruneBackups(bin, name);
            }
            else
            {
                File.Move(pending, target);
            }
        }
        catch
        {
            // Ha most nem sikerült (pl. épp indul a zárolás), a következő
            // indítás újra megpróbálja — a .new fájl sértetlenül megmarad.
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
    /// bin mappa évek alatt tele lett több tucat másolattal.
    /// </summary>
    private static void PruneBackups(string bin, string name)
    {
        try
        {
            var backups = new System.Collections.Generic.List<FileInfo>();
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
