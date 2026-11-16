// DeepSeek Harness — natív rendszertálca és folyamat-felügyelet.
//
// MIÉRT VAN EZ (2026-10-22):
//   A tálca és a felügyelet eddig PowerShellben élt (tray\dsh-tray.ps1, 72 KB;
//   providers\watchdog-subagent-proxy.ps1; és a shell:startup .lnk-ek). Ez a
//   gyakorlatban három problémát okozott:
//     1. minden bejelentkezéskor egy PowerShell indul, ami egy 72 KB-os szkriptet
//        értelmez — ez lassítja a Windows indulását;
//     2. a szkriptek `MessageBox`-ot és `SetForegroundWindow`-t hívnak, ami
//        elviszi a fókuszt a felhasználó munkája elől;
//     3. a felügyelet egy 60 másodperces PowerShell-ciklus volt, ami a proxyt
//        ÉS az Ollamát is feltámasztotta — utóbbit akkor is, amikor nulla kérést
//        szolgált ki, miközben 6,6 GB VRAM-ot foglalt.
//
//   Ez a program MINDENT egy folyamatban tart: a harness node szervert, a
//   fallback proxyt, a DshWindow ablakot, az ütemezett karbantartást. Nincs
//   PowerShell, nincs .cmd, nincs ütemezett feladat, nincs konzolablak.
//
// PARANCSOK:
//   Az ablak megnyitása a tálcáról, dupla kattintással vagy a
//   `DshHarnessShowWindow` nevű esemény jelzésével (ezt használja a
//   tray\dsh-window.cmd is, ezért a meglévő parancsikonok tovább működnek).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace DshTray
{
    internal sealed class TrayConfig
    {
        public int Port = 3080;
        public int ProxyPort = 4123;
        public int RobotPort = 4180;
        public int Panes = 3;
        public double Width = 3396;
        public double Height = 1108;
        public string DshHome;
        public string DshBin;
        public string Root;

        // ── panelbeállítások (2026-11-13) ───────────────────────────────────
        // MIÉRT: a 2026-10-31-i váltásnál a launcher a natív tálcára állt át, és
        // ezzel ELVESZTEK a PowerShell-tálca panelbeállításai (felosztás, robot
        // felület). A kulcsok a tray-config.json-ban végig megvoltak, csak a
        // natív tálca nem olvasta és nem kínálta őket. Ezek a mezők pótolják.
        public bool RobotPane = false;
        public bool RobotOnly = false;
        public string RobotUrl = "http://127.0.0.1:4180/";

        public string StateDir { get { return Path.Combine(Root, "state"); } }
        public string BinDir { get { return Path.Combine(Root, "bin"); } }
        public string ProvidersDir { get { return Path.Combine(Root, "providers"); } }
        public string WindowExe { get { return Path.Combine(BinDir, "DshWindow.exe"); } }
        public string ProxyScript { get { return Path.Combine(ProvidersDir, "proxy.mjs"); } }
        public string IconFile { get { return Path.Combine(Root, "assets", "dsh.ico"); } }
        public string WindowLog { get { return Path.Combine(StateDir, "window.log"); } }

        /// <summary>A DshWindow által szabályos bezáráskor hátrahagyott jelölő.</summary>
        public string WindowClosedMarker { get { return Path.Combine(StateDir, "window.closed"); } }
        public string UrlFile { get { return Path.Combine(StateDir, "harness.url"); } }
    }

    internal static class Log
    {
        private static readonly object Gate = new object();
        private static string _path;

        public static void Init(string path)
        {
            _path = path;
            try
            {
                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            }
            catch { }
        }

        public static void Info(string message) { Write("INFO ", message); }
        public static void Error(string message) { Write("ERROR", message); }

        private static void Write(string level, string message)
        {
            if (string.IsNullOrEmpty(_path)) return;
            try
            {
                lock (Gate)
                {
                    // Egyszerű méretkorlát: 512 KB felett a fájl felére vágva
                    // indul újra, hogy egy hónap múlva se legyen olvashatatlan.
                    var info = new FileInfo(_path);
                    if (info.Exists && info.Length > 512 * 1024)
                    {
                        string[] lines = File.ReadAllLines(_path);
                        int keep = lines.Length / 2;
                        var tail = new string[lines.Length - keep];
                        Array.Copy(lines, keep, tail, 0, tail.Length);
                        File.WriteAllLines(_path, tail, new UTF8Encoding(false));
                    }
                    string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                        + " [" + level + "] " + message + Environment.NewLine;
                    File.AppendAllText(_path, line, new UTF8Encoding(false));
                }
            }
            catch { }
        }
    }

    /// <summary>Apró, függőségmentes JSON-olvasó a tray-config.json néhány kulcsához.</summary>
    internal static class TinyJson
    {
        public static int Int(string json, string key, int fallback)
        {
            Match m = Regex.Match(json ?? string.Empty, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?\\d+)");
            int v;
            return m.Success && int.TryParse(m.Groups[1].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)
                ? v : fallback;
        }

        public static double Dbl(string json, string key, double fallback)
        {
            Match m = Regex.Match(json ?? string.Empty, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?[\\d.]+)");
            double v;
            return m.Success && double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out v)
                ? v : fallback;
        }

        public static string Str(string json, string key)
        {
            Match m = Regex.Match(json ?? string.Empty, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]*)\"");
            return m.Success ? m.Groups[1].Value : string.Empty;
        }

        /// <summary>Logikai érték (`true`/`false`, illetve 1/0) a tray-config.json-ból.</summary>
        public static bool Bool(string json, string key, bool fallback)
        {
            Match m = Regex.Match(json ?? string.Empty, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(true|false|1|0)", RegexOptions.IgnoreCase);
            if (!m.Success) return fallback;
            string raw = m.Groups[1].Value.ToLowerInvariant();
            return raw == "true" || raw == "1";
        }

        /// <summary>
        /// Egy kulcs értékének cseréje a meglévő JSON-szövegben. A nem ismert
        /// kulcsokat (pl. `autostart`, `logLevel`, amit a PowerShell-tálca ír)
        /// SZÁNDÉKOSAN érintetlenül hagyja — csak a sajátunkat írjuk át, illetve
        /// fűzzük be a záró kapcsos zárójel elé, ha még nincs benne.
        /// </summary>
        public static string Set(string json, string key, string value)
        {
            string text = string.IsNullOrWhiteSpace(json) ? "{}" : json;
            string pattern = "(\"" + Regex.Escape(key) + "\"\\s*:\\s*)(\"[^\"]*\"|-?[\\d.]+|true|false)";
            var regex = new Regex(pattern, RegexOptions.IgnoreCase);
            if (regex.IsMatch(text)) return regex.Replace(text, m => m.Groups[1].Value + value, 1);
            int closing = text.LastIndexOf('}');
            if (closing < 0) return "{\n  \"" + key + "\":  " + value + "\n}";
            string head = text.Substring(0, closing).TrimEnd();
            bool empty = head.TrimEnd('{', ' ', '\r', '\n', '\t').Length == 0;
            string separator = empty ? "\n  " : ",\n  ";
            return head + separator + "\"" + key + "\":  " + value + "\n}";
        }
    }

    internal sealed class TrayApp : ApplicationContext
    {
        private readonly TrayConfig _cfg = new TrayConfig();
        private NotifyIcon _icon;
        private System.Threading.Timer _supervise;
        private System.Threading.Timer _schedule;
        private EventWaitHandle _showEvent;
        private Thread _showThread;
        private volatile bool _stopping;
        private int _windowStarts;
        private DateTime _windowWindow = DateTime.MinValue;
        private bool _closeLogged;      // a "felhasználó bezárta" esemény már naplózva
        private DateTime _lastRetune = DateTime.MinValue;
        private System.Windows.Forms.Timer _desktopWatch;   // window-desktop.txt figyelo
        private DateTime _desktopStamp;
        private int _desktop = 1;            // utoljara latott munkaasztal
        private string _windowUrl = string.Empty;
        private volatile bool _awaitToken;   // harness-újraindítás után az új tokenre várunk

        public TrayApp()
        {
            _cfg.Root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
            Log.Init(Path.Combine(_cfg.StateDir, "native-tray.log"));
            Log.Info("tálca indul (pid " + Process.GetCurrentProcess().Id + ", gyökér: " + _cfg.Root + ")");

            // Shared AppUserModelID for every DSH process: the tray and the
            // window use the same ID, so the pinned shortcut and the running
            // window share a single taskbar button.
            try
            {
                NativeMethods.SetCurrentProcessExplicitAppUserModelID("DeepSeek.Harness");
                Log.Info("AppUserModelID set: DeepSeek.Harness");
            }
            catch (Exception ex)
            {
                Log.Error("AppUserModelID set failed: " + ex.Message);
            }

            LoadConfig();
            // A tálca saját pid-je: a telepítő/ellenőrző eszközök ezt olvassák.
            // MÉRT HIBA (2026-11-16): a fájlban elavult pid maradt (61112),
            // miközben a futó tálca 31156 volt, ezért a "fut-e a tálca" kérdésre
            // a fájl hamis választ adott.
            try
            {
                Directory.CreateDirectory(_cfg.StateDir);
                File.WriteAllText(
                    Path.Combine(_cfg.StateDir, "tray.pid"),
                    Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture),
                    new UTF8Encoding(false));
            }
            catch (Exception ex) { Log.Error("tray.pid írás: " + ex.Message); }
            // FRISS INDÍTÁS (felhasználói kérés, 2026-11-16): ha a tálca
            // indulásakor EGYETLEN munkaablak sem fut, az **1. asztallal**
            // kezdünk. Korábban a fájlban maradt érték (pl. 2) nyitotta az első
            // ablakot, ezért indítás után a 2. asztal jött be.
            try
            {
                if (Process.GetProcessesByName("DshWindow").Length == 0)
                {
                    File.WriteAllText(
                        Path.Combine(_cfg.StateDir, "window-desktop.txt"), "1", new UTF8Encoding(false));
                    for (int d = 1; d <= 2; d++)
                    {
                        try { if (File.Exists(DesktopPidPath(d))) File.Delete(DesktopPidPath(d)); } catch { }
                    }
                    Log.Info("friss indítás: az 1. munkaasztal nyílik");
                }
            }
            catch (Exception ex) { Log.Error("friss indítás: " + ex.Message); }
            BuildIcon();
            // Új tálca-session (bejelentkezés, frissítés): az ablak a megszokott
            // módon megnyílik. A bezárás-jelölő csak az adott sessionre szól,
            // különben egy régi bezárás után a login után sem nyílna meg.
            ClearCloseMarker();
            StartShowListener();

            _supervise = new System.Threading.Timer(_ => Supervise(), null, 1500, 20000);
            _schedule = new System.Threading.Timer(_ => Scheduled(), null, 5000, 60000);

            // Munkaasztal-figyelo: a webes fejlec 1/2 gombja a
            // state\window-desktop.txt-t irja; 200 ms-onkent figyeljuk, es
            // valtozasra atvaltunk (4-6 panel eseten ket kulon ablak).
            // A 700 ms-os ciklus volt a valtas lassu resze (a kattintas es az
            // ablak megjelenese kozott akar 0,7 s is eltelt); a fajl apro, a
            // surubb olvasas merheto terhelese nulla.
            _desktop = ReadDesktop();
            // A figyelő csak VÁLTOZÁSRA tüzeljen: a kiinduló írásidőt is
            // megjegyezzük, különben a legelső tick (700 ms) "változásnak" látja
            // a MinValue-t, és feleslegesen indít még egy ablakot (mért eset
            // 2026-11-16: két ablak ugyanarra az asztalra).
            try
            {
                string desktopPath = Path.Combine(_cfg.StateDir, "window-desktop.txt");
                if (File.Exists(desktopPath)) _desktopStamp = File.GetLastWriteTimeUtc(desktopPath);
            }
            catch { }
            _desktopWatch = new System.Windows.Forms.Timer { Interval = 200 };
            _desktopWatch.Tick += (s, e) => DesktopWatchTick();
            _desktopWatch.Start();
            Log.Info("munkaasztal-figyelo elindult (200 ms)");
            Log.Info("felügyelet elindult (20 s), ütemező elindult (60 s)");
            HealDesktopPidFromRunningWindow();
            EnsureOtherDesktopWindows(4000);
        }

        /// <summary>
        /// A MÁSIK asztal ablakát is előre elindítja (rejtve), hogy a váltás
        /// azonnali legyen. Enélkül az első váltás új ablakot indított, a panelek
        /// betöltése pedig néhány másodpercig fehér felületet adott (mért hiba).
        ///
        /// MÉRT HIBA (2026-11-16 07:08:13, boot után): ez a szál FELTÉTEL NÉLKÜL
        /// indította a MÁSIK asztalt, még mielőtt az AKTÍV asztal ablaka
        /// létrejött volna (a harness 07:08:24-ig nem adott friss tokent) — ezért
        /// boot után a **2. asztal** nyílt meg. Ezért most előbb a harnessnek
        /// figyelnie kell ÉS az aktív asztal ablakának futnia, csak utána indul a
        /// másik, majd az aktív asztalt normalizáljuk láthatóra.
        /// </summary>
        private void EnsureOtherDesktopWindows(int delayMs)
        {
            var preparer = new Thread(() =>
            {
                try
                {
                    Thread.Sleep(delayMs);
                    int active = Math.Max(1, Math.Min(DesktopCount(), ReadDesktop()));
                    for (int attempt = 0; attempt < 40 && !_stopping; attempt++)
                    {
                        if (Listening(_cfg.Port) && RunningDesktopWindow(active) != 0)
                        {
                            for (int d = 1; d <= DesktopCount(); d++)
                            {
                                if (d == active) continue;
                                if (RunningDesktopWindow(d) != 0) continue;
                                StartDesktopWindow(d);       // nem aktiv asztalt maga rejti el
                                Log.Info("asztal " + d + " elore elinditva (rejtve)");
                            }
                            ApplyDesktopAsync(active);       // az aktiv legyen a lathato
                            return;
                        }
                        Thread.Sleep(1500);
                    }
                    Log.Info("asztal elore inditas kihagyva: a harness vagy az aktiv asztal ablaka nem indult el");
                }
                catch (Exception ex) { Log.Error("asztal elore inditas: " + ex.Message); }
            });
            preparer.IsBackground = true;
            preparer.Start();
        }

        // ── konfiguráció ───────────────────────────────────────────────────
        private void LoadConfig()
        {
            string path = Path.Combine(_cfg.StateDir, "tray-config.json");
            string json = string.Empty;
            try { if (File.Exists(path)) json = File.ReadAllText(path); }
            catch (Exception ex) { Log.Error("tray-config.json olvasás: " + ex.Message); }

            _cfg.Port = TinyJson.Int(json, "port", 3080);
            _cfg.Panes = TinyJson.Int(json, "panes", 3);
            double w = TinyJson.Dbl(json, "width", 3396);
            double h = TinyJson.Dbl(json, "height", 1108);
            if (w > 100) _cfg.Width = w;
            if (h > 100) _cfg.Height = h;
            _cfg.DshHome = TinyJson.Str(json, "dshHome");
            if (string.IsNullOrEmpty(_cfg.DshHome))
            {
                _cfg.DshHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
            }
            _cfg.DshBin = TinyJson.Str(json, "dshBin");
            if (string.IsNullOrEmpty(_cfg.DshBin)) _cfg.DshBin = FindDshBin();

            // Panelbeállítások: a PS-tálca által már használt kulcsok (a fájlban
            // eddig is ott voltak, csak a natív tálca nem olvasta őket).
            _cfg.RobotPane = TinyJson.Bool(json, "robotPane", false);
            _cfg.RobotOnly = TinyJson.Bool(json, "robotOnly", false);
            string robotUrl = TinyJson.Str(json, "robotUrl");
            if (!string.IsNullOrEmpty(robotUrl)) _cfg.RobotUrl = robotUrl;

            Log.Info("config: port=" + _cfg.Port + " panes=" + _cfg.Panes
                + " robotPane=" + _cfg.RobotPane + " robotOnly=" + _cfg.RobotOnly
                + " proxyPort=" + _cfg.ProxyPort + " dsh=" + (_cfg.DshBin ?? "?"));
        }

        /// <summary>
        /// A panelbeállítások mentése a tray-config.json-ba. Csak a saját
        /// kulcsainkat írja; a többit (autostart, logLevel, ...) érintetlenül
        /// hagyja, mert azokat a PowerShell-tálca kezeli.
        /// </summary>
        private void SaveLayoutConfig()
        {
            string path = Path.Combine(_cfg.StateDir, "tray-config.json");
            try
            {
                string json = File.Exists(path) ? File.ReadAllText(path) : "{}";
                json = TinyJson.Set(json, "panes", _cfg.Panes.ToString(CultureInfo.InvariantCulture));
                json = TinyJson.Set(json, "robotPane", _cfg.RobotPane ? "true" : "false");
                json = TinyJson.Set(json, "robotOnly", _cfg.RobotOnly ? "true" : "false");
                json = TinyJson.Set(json, "robotUrl", "\"" + _cfg.RobotUrl + "\"");
                Directory.CreateDirectory(_cfg.StateDir);
                File.WriteAllText(path, json, new UTF8Encoding(false));
                Log.Info("panelbeállítás mentve: panes=" + _cfg.Panes + " robotPane=" + _cfg.RobotPane + " robotOnly=" + _cfg.RobotOnly);
            }
            catch (Exception ex) { Log.Error("panelbeállítás mentése: " + ex.Message); }
        }

        /// <summary>A legfrissebb npx-telepítésű dsh bin.js megkeresése.</summary>
        private static string FindDshBin()
        {
            try
            {
                string cache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "npm-cache", "_npx");
                if (!Directory.Exists(cache)) return string.Empty;
                string best = string.Empty;
                DateTime bestStamp = DateTime.MinValue;
                foreach (string dir in Directory.GetDirectories(cache))
                {
                    string candidate = Path.Combine(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
                    if (!File.Exists(candidate)) continue;
                    DateTime stamp = File.GetLastWriteTimeUtc(candidate);
                    if (stamp > bestStamp) { bestStamp = stamp; best = candidate; }
                }
                return best;
            }
            catch { return string.Empty; }
        }

        // ── tálcaikon és menü ──────────────────────────────────────────────
        private void BuildIcon()
        {
            Icon icon = null;
            try { if (File.Exists(_cfg.IconFile)) icon = new Icon(_cfg.IconFile); }
            catch (Exception ex) { Log.Error("ikon betöltés: " + ex.Message); }
            if (icon == null) icon = SystemIcons.Application;

            var menu = new ContextMenuStrip();
            menu.Items.Add("Ablak megnyitása", null, (s, e) => ShowWindow(true));

            // ── panelbeállítások (HELYREÁLLÍTVA, 2026-11-13) ────────────────
            // A PS-tálcában voltak, a natív tálcára váltáskor elvesztek.
            var split = new ToolStripMenuItem("Ablak felosztása");
            for (int count = 1; count <= 6; count++)
            {
                int value = count;
                var entry = new ToolStripMenuItem(value + " panel");
                entry.Click += (s, e) => SetPanes(value);
                split.DropDownItems.Add(entry);
            }
            split.DropDownOpening += (s, e) =>
            {
                foreach (ToolStripItem item in split.DropDownItems)
                {
                    var entry = item as ToolStripMenuItem;
                    if (entry != null) entry.Checked = entry.Text.StartsWith(_cfg.Panes + " ", StringComparison.Ordinal);
                }
            };
            menu.Items.Add(split);

            // Munkaasztal-váltás: a window-desktop.txt-t írja, amit az ablak
            // 500 ms-onként figyel — így NEM kell újraindítani az ablakot.
            var desktopMenu = new ToolStripMenuItem("Munkaasztal");
            desktopMenu.ToolTipText = "4-6 panel esetén a második munkaasztal (3+3 kiosztás).";
            for (int index = 1; index <= 2; index++)
            {
                int wanted = index;
                var entry = new ToolStripMenuItem(wanted + ". munkaasztal");
                entry.Click += (s, e) => SetDesktop(wanted);
                desktopMenu.DropDownItems.Add(entry);
            }
            // A menü megnyitásakor kiderül, MELYIK asztalon vagyunk (a
            // window-desktop.txt-ből), és a címben is látszik.
            desktopMenu.DropDownOpening += (s, e) =>
            {
                int current = ReadDesktop();
                desktopMenu.Text = "Munkaasztal (" + current + ")";
                foreach (ToolStripItem item in desktopMenu.DropDownItems)
                {
                    var entry = item as ToolStripMenuItem;
                    if (entry == null) continue;
                    entry.Checked = entry.Text.StartsWith(current + ".", StringComparison.Ordinal);
                    // 3 panelnél nincs második asztal: az elem inaktív.
                    entry.Enabled = true;
                }
            };
            menu.Items.Add(desktopMenu);

            var robotPane = new ToolStripMenuItem("4. felület: robot panel");
            robotPane.ToolTipText = "A robot állapotpanelje (" + _cfg.RobotUrl + ") külön felületként.";
            robotPane.Checked = _cfg.RobotPane;
            robotPane.Click += (s, e) =>
            {
                SetRobotPane(!_cfg.RobotPane);
                robotPane.Checked = _cfg.RobotPane;
            };
            menu.Items.Add(robotPane);

            var robotOnly = new ToolStripMenuItem("Csak robot mód (1 felület)");
            robotOnly.ToolTipText = "Az ablak egyetlen felülettel nyílik: csak a robot-konzol.";
            robotOnly.Checked = _cfg.RobotOnly;
            robotOnly.Click += (s, e) =>
            {
                SetRobotOnly(!_cfg.RobotOnly);
                robotOnly.Checked = _cfg.RobotOnly;
                robotPane.Checked = _cfg.RobotPane;
            };
            menu.Items.Add(robotOnly);

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Harness újraindítása", null, (s, e) => RestartHarness());
            menu.Items.Add("Proxy újraindítása", null, (s, e) => RestartProxy());
            menu.Items.Add("Autotune most", null, (s, e) => RunMaintenance(true));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Naplók megnyitása", null, (s, e) => OpenFolder(_cfg.StateDir));
            menu.Items.Add("Kilépés", null, (s, e) => ExitApp());

            _icon = new NotifyIcon
            {
                Icon = icon,
                Text = "DeepSeek Harness",
                Visible = true,
                ContextMenuStrip = menu
            };
            _icon.DoubleClick += (s, e) => ShowWindow(true);
        }

        private void OpenFolder(string path)
        {
            try { Process.Start("explorer.exe", "\"" + path + "\""); }
            catch (Exception ex) { Log.Error("mappa megnyitás: " + ex.Message); }
        }

        // ── ablak-esemény (a régi .cmd parancsikonok kompatibilitása) ──────
        private void StartShowListener()
        {
            try
            {
                try { _showEvent = EventWaitHandle.OpenExisting("DshHarnessShowWindow"); }
                catch { _showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "DshHarnessShowWindow"); }
            }
            catch (Exception ex)
            {
                Log.Error("show-esemény nem hozható létre: " + ex.Message);
                return;
            }
            _showThread = new Thread(() =>
            {
                while (!_stopping)
                {
                    try
                    {
                        if (_showEvent.WaitOne(1000)) ShowWindow(true);
                    }
                    catch { Thread.Sleep(500); }
                }
            });
            _showThread.IsBackground = true;
            _showThread.Start();
        }

        // ── felügyelet ─────────────────────────────────────────────────────
        private void Supervise()
        {
            if (_stopping) return;
            try
            {
                EnsureProxy();
                EnsureHarness();
                EnsureRobotPanel();
                EnsureWindow();
            }
            catch (Exception ex) { Log.Error("felügyelet: " + ex.Message); }
        }

        /// <summary>
        /// A Házirobot panel szervere (bot\panel\server.mjs, 4180).
        ///
        /// MIÉRT ITT: eddig a `HáziRobot panel.lnk` indította bejelentkezéskor egy
        /// PowerShell őrfolyamon keresztül (start-robot-watchdog.ps1 →
        /// watchdog-hazi-robot.ps1, 60 s-os ciklus). Ez volt az utolsó DSH-s
        /// PowerShell-folyamat a bejelentkezési listában — a felügyeletét innen
        /// látjuk el, ugyanazzal a 20 másodperces ciklussal, ami a többit is.
        /// </summary>
        private void EnsureRobotPanel()
        {
            string server = Path.Combine(_cfg.Root, "bot", "panel", "server.mjs");
            if (!File.Exists(server)) return;              // nincs telepítve: nincs teendő
            if (Listening(_cfg.RobotPort)) return;
            Log.Info("Házirobot panel nem válaszol a " + _cfg.RobotPort + " porton — indítás");
            StartNode(server, string.Empty, Path.Combine(_cfg.Root, "bot"),
                Path.Combine(_cfg.Root, "bot", "state", "panel.out.log"),
                Path.Combine(_cfg.Root, "bot", "state", "panel.err.log"),
                null);
        }

        private static bool Listening(int port)
        {
            try
            {
                using (var client = new TcpClient())
                {
                    IAsyncResult ar = client.BeginConnect("127.0.0.1", port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(1200)) return false;
                    client.EndConnect(ar);
                    return true;
                }
            }
            catch { return false; }
        }

        private void EnsureProxy()
        {
            if (Listening(_cfg.ProxyPort)) return;
            if (!File.Exists(_cfg.ProxyScript))
            {
                Log.Error("proxy nem indul: hiányzik " + _cfg.ProxyScript);
                return;
            }
            Log.Info("proxy nem válaszol a " + _cfg.ProxyPort + " porton — indítás");
            StartNode(_cfg.ProxyScript, "--port " + _cfg.ProxyPort, _cfg.ProvidersDir,
                Path.Combine(_cfg.ProvidersDir, "proxy.out.log"),
                Path.Combine(_cfg.ProvidersDir, "proxy.err.log"),
                null);
        }

        private void EnsureHarness()
        {
            if (Listening(_cfg.Port)) return;

            // ── dupla indítás elleni védelem (2026-11-13) ───────────────────
            // MÉRT HIBA: a tálca és a `restart-harness.ps1 -Force` ugyanabban a
            // másodpercben indított egy-egy példányt ugyanarra a portra; az
            // egyik elhalt (24504 nyert, 35424 kiesett), a naplók összekeveredtek,
            // és a plugin reconcilációja rossz példányban futhatott le.
            // Két védvonal: (1) neves mutex a repo eszközeivel KÖZÖSEN, és
            // (2) friss pid-fájl esetén „éppen indul" — nem indítunk másodikat.
            bool ownsGate = false;
            Mutex gate = null;
            try
            {
                gate = new Mutex(false, "Global\\DshHarnessStart-" + _cfg.Port);
                try { ownsGate = gate.WaitOne(0); }
                catch (AbandonedMutexException) { ownsGate = true; }
            }
            catch (Exception ex)
            {
                Log.Error("indítási mutex nem hozható létre: " + ex.Message);
                gate = null;
            }

            if (gate != null && !ownsGate)
            {
                Log.Info("harness indítás kihagyva: másik indító éppen fut (mutex)");
                return;
            }

            try
            {
                try
                {
                    string pidFile = Path.Combine(_cfg.StateDir, "harness.pid");
                    if (File.Exists(pidFile) && (DateTime.Now - File.GetLastWriteTime(pidFile)).TotalSeconds < 25)
                    {
                        Log.Info("harness indítás kihagyva: a pid-fájl friss — a harness éppen indul");
                        return;
                    }
                }
                catch (Exception ex) { Log.Error("pid-fájl ellenőrzés: " + ex.Message); }

                if (string.IsNullOrEmpty(_cfg.DshBin) || !File.Exists(_cfg.DshBin))
                {
                    Log.Error("harness nem indul: nincs dsh bin.js");
                    return;
                }
                Log.Info("harness nem válaszol a " + _cfg.Port + " porton — indítás");
                int pid = StartNode(_cfg.DshBin,
                    "web --host 127.0.0.1 --port " + _cfg.Port + " --no-open",
                    Path.GetDirectoryName(_cfg.DshBin),
                    Path.Combine(_cfg.StateDir, "harness.log"),
                    Path.Combine(_cfg.StateDir, "harness.err.log"),
                    CaptureTokenUrl);
                Log.Info("harness pid=" + pid);
                _windowUrl = string.Empty;
            }
            finally
            {
                if (gate != null)
                {
                    if (ownsGate) { try { gate.ReleaseMutex(); } catch { } }
                    gate.Dispose();
                }
            }
        }

        /// <summary>
        /// A harness kimenetéből kimentett token-URL. A sor alakja:
        /// „dsh web: http://127.0.0.1:3080/?token=...".
        /// </summary>
        private void CaptureTokenUrl(string line)
        {
            const string marker = "dsh web: ";
            int idx = line.IndexOf(marker, StringComparison.Ordinal);
            if (idx < 0) return;
            string url = line.Substring(idx + marker.Length).Trim();
            if (!url.StartsWith("http://", StringComparison.Ordinal)) return;
            try
            {
                File.WriteAllText(_cfg.UrlFile, url, new UTF8Encoding(false));
                _windowUrl = url;
                Log.Info("uj token elmentve: " + url.Substring(0, Math.Min(60, url.Length)) + "...");
            }
            catch (Exception ex) { Log.Error("token mentes: " + ex.Message); }
        }

        /// <summary>
        /// Az ablak életben tartása.
        ///
        /// FONTOS: a felhasználó által becsukott ablakot NEM indítjuk újra.
        /// A DshWindow szabályos kilépéskor (Bezárás gomb, Alt+F4) hátrahagyja a
        /// state\window.closed jelölőt, és amíg az létezik, a felügyelet békén
        /// hagyja. A jelölőt az "Ablak megnyitása" menüpont, a tálcaikonra
        /// kattintás és a "Harness újraindítása" törli.
        ///
        /// Összeomlás vagy kill esetén nincs jelölő (a Closing nem fut le), tehát
        /// az automatikus helyreállítás változatlanul működik.
        /// </summary>
        private void EnsureWindow()
        {
            if (Process.GetProcessesByName("DshWindow").Length > 0)
            {
                // Élő ablak mellett a korábbi bezárás-jelölő elavult (pl. a régi
                // PowerShell-tálca hagyta itt). Ha bennmaradna, egy későbbi
                // összeomlást tévesen "felhasználói bezárásnak" minősítenénk, és
                // nem állna helyre az ablak.
                if (File.Exists(_cfg.WindowClosedMarker)) ClearCloseMarker();
                // MERT HIBA (2026-11-16): ha fut ablak, de EGY SEM LATHATO (az
                // asztalvaltas elrejtette az utolsot), a regi kod itt visszatert,
                // es az ablak soha nem jott vissza. Ilyenkor allitsuk helyre.
                if (!AnyVisibleDshWindow())
                {
                    int curDesktop = ReadDesktop();
                    StartDesktopWindow(curDesktop);
                    HealDesktopPidFromRunningWindow();
                    ShowDesktopWindow(curDesktop);
                    Log.Info("lathato ablak helyreallitasa (asztal " + curDesktop + ")");
                }
                return;
            }
            if (!Listening(_cfg.Port)) return;
            if (!File.Exists(_cfg.WindowExe))
            {
                Log.Error("ablak nem indul: hiányzik " + _cfg.WindowExe);
                return;
            }
            if (File.Exists(_cfg.WindowClosedMarker))
            {
                if (!_closeLogged)
                {
                    _closeLogged = true;
                    Log.Info("az ablakot a felhasználó bezárta — nem indítom újra "
                        + "(újranyitás: tálcaikon / Ablak megnyitása)");
                    try
                    {
                        if (_icon != null)
                        {
                            _icon.ShowBalloonTip(4000, "DeepSeek Harness",
                                "Az ablak bezárva, a háttér fut tovább. Újranyitás: kattints a tálcaikonra.",
                                ToolTipIcon.Info);
                        }
                    }
                    catch { }
                }
                return;
            }
            _closeLogged = false;
            HealDesktopPidFromRunningWindow();
            // Indítási hullám elleni korlát: 10 percenként legfeljebb három.
            DateTime now = DateTime.UtcNow;
            if (_windowWindow == DateTime.MinValue || (now - _windowWindow).TotalMinutes > 10)
            {
                _windowWindow = now;
                _windowStarts = 0;
            }
            if (_windowStarts >= 3)
            {
                Log.Error("az ablak háromszor indult 10 perc alatt — a további indítás leállítva");
                return;
            }
            _windowStarts++;
            StartWindow();
        }

        /// <summary>
        /// A "felhasználó zárta be" jelölő törlése — minden olyan útvonalon,
        /// ahol az ablakot kifejezett kérésre nyitjuk újra.
        /// </summary>
        private void ClearCloseMarker()
        {
            _closeLogged = false;
            try
            {
                if (File.Exists(_cfg.WindowClosedMarker)) File.Delete(_cfg.WindowClosedMarker);
            }
            catch (Exception ex) { Log.Error("bezárás-jelölő törlése: " + ex.Message); }
        }

        /// <summary>
        /// A jelenlegi munkaasztal ablakának indítása. MINDEN indítási útvonal
        /// ezen megy át (tálcaikon, "Ablak megnyitása", felügyelet, asztalváltás),
        /// hogy az ablak panel-száma és a pid-fájlja mindig az adott asztalhoz
        /// tartozzon.
        /// </summary>
        private void StartWindow()
        {
            StartDesktopWindow(Math.Max(1, Math.Min(2, ReadDesktop())));
        }

        /// <summary>A token URL a state\harness.url-ből, vagy a harness.log utolsó sora.</summary>
        private string CurrentUrl()
        {
            // Újraindítás után a régi URL halott: addig nem adunk vissza semmit,
            // amíg az új token meg nem érkezik (különben 401 -> újraindítási hurok).
            if (_awaitToken) return _windowUrl.Length == 0 ? string.Empty : _windowUrl;
            try
            {
                if (File.Exists(_cfg.UrlFile))
                {
                    string text = File.ReadAllText(_cfg.UrlFile).Trim();
                    if (text.StartsWith("http://", StringComparison.Ordinal)) return text;
                }
            }
            catch { }
            try
            {
                string log = Path.Combine(_cfg.StateDir, "harness.log");
                if (File.Exists(log))
                {
                    string[] lines = File.ReadAllLines(log);
                    for (int i = lines.Length - 1; i >= 0; i--)
                    {
                        string line = lines[i].Trim();
                        if (line.StartsWith("dsh web: http://", StringComparison.Ordinal))
                        {
                            return line.Substring("dsh web: ".Length).Trim();
                        }
                    }
                }
            }
            catch { }
            return string.Empty;
        }

        // ── folyamatindítás ────────────────────────────────────────────────
        /// <summary>
        /// Node-folyamat indítása rejtve, a kimenet naplóba írásával.
        ///
        /// MIÉRT KELL A KIMENET ÁTIRÁNYÍTÁSA: a harness a saját token-URL-jét
        /// a kimenetére írja („dsh web: http://...?token=..."), és a DshWindow
        /// ezt az URL-t kapja indításkor. Ha a kimenet nem olvasott, a tálca
        /// nem tudja az új tokent, és a RÉGI, halott tokennel nyitná meg az
        /// ablakot (401 -> `--restart-if-stale` -> újraindítási hurok).
        /// Ezért minden indított folyamat kimenete naplóba megy, a hívó pedig
        /// sort kaphat kézhez (`onLine`).
        /// </summary>
        private int StartNode(string script, string extraArgs, string workDir,
                              string outLog, string errLog, Action<string> onLine)
        {
            try
            {
                string outDir = Path.GetDirectoryName(outLog);
                if (!string.IsNullOrEmpty(outDir)) Directory.CreateDirectory(outDir);

                var psi = new ProcessStartInfo
                {
                    FileName = "node",
                    Arguments = "\"" + script + "\" " + extraArgs,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    WorkingDirectory = workDir,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                var proc = new Process { StartInfo = psi };
                var gate = new object();

                proc.OutputDataReceived += (s, e) =>
                {
                    if (e.Data == null) return;
                    try { lock (gate) File.AppendAllText(outLog, e.Data + Environment.NewLine, new UTF8Encoding(false)); }
                    catch { }
                    if (onLine != null) { try { onLine(e.Data); } catch { } }
                };
                proc.ErrorDataReceived += (s, e) =>
                {
                    if (e.Data == null) return;
                    try { lock (gate) File.AppendAllText(errLog, e.Data + Environment.NewLine, new UTF8Encoding(false)); }
                    catch { }
                };

                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                return proc.Id;
            }
            catch (Exception ex)
            {
                Log.Error("node indítás (" + Path.GetFileName(script) + "): " + ex.Message);
                return 0;
            }
        }

        // ── menüműveletek ──────────────────────────────────────────────────
        private void ShowWindow(bool force)
        {
            try
            {
                // Kifejezett nyitási kérés: a korábbi bezárás nem tilt tovább.
                ClearCloseMarker();
                int desktop = Math.Max(1, Math.Min(DesktopCount(), ReadDesktop()));
                if (Process.GetProcessesByName("DshWindow").Length > 0)
                {
                    // MÉRT HIBA (2026-11-16): itt az ÖSSZES DshWindow-t megjelenítette,
                    // ezért a kitűzött ikonra kattintva a rejtett munkaasztal-ablak is
                    // előjött (két ablak egyszerre). Csak az AKTÍV asztalét mutatjuk.
                    IntPtr h = WindowHandleOf(desktop);
                    if (h == IntPtr.Zero)
                    {
                        StartDesktopWindow(desktop);
                        HealDesktopPidFromRunningWindow();
                        ShowDesktopWindow(desktop);
                        h = WindowHandleOf(desktop);
                    }
                    else
                    {
                        if (NativeMethods.IsIconic(h)) NativeMethods.ShowWindow(h, NativeMethods.SW_RESTORE);
                        else NativeMethods.ShowWindow(h, NativeMethods.SW_SHOW);
                        NativeMethods.SetForegroundWindow(h);
                    }
                    HideOtherDesktopWindows(desktop, h);
                    return;
                }
                StartWindow();
            }
            catch (Exception ex) { Log.Error("ablak megnyitás: " + ex.Message); }
        }

        private void RestartHarness()
        {
            Log.Info("harness újraindítás kérés");
            try
            {
                ClearCloseMarker();      // kifejezett kérés: az ablak újra megnyílik
                _awaitToken = true;      // a régi token halott: várjuk az újat
                _windowUrl = string.Empty;
                foreach (Process p in Process.GetProcessesByName("DshWindow")) { try { p.Kill(); } catch { } }
                StopPort(_cfg.Port);
                Thread.Sleep(800);
                EnsureHarness();
            }
            catch (Exception ex) { Log.Error("harness újraindítás: " + ex.Message); }
        }

        private void RestartProxy()
        {
            Log.Info("proxy újraindítás kérés");
            try { StopPort(_cfg.ProxyPort); } catch { }
            EnsureProxy();
        }

        // ── panelbeállítások (a PS-tálcából visszaállítva, 2026-11-13) ─────
        /// <summary>Felosztás beállítása, mentés és az ablak újranyitása.</summary>
        /// <summary>A jelenlegi munkaasztal a window-desktop.txt-ből (hiba esetén 1).</summary>
        private int ReadDesktop()
        {
            try
            {
                string directory = Path.GetDirectoryName(_cfg.WindowLog);
                if (string.IsNullOrEmpty(directory)) return 1;
                string path = Path.Combine(directory, "window-desktop.txt");
                if (!File.Exists(path)) return 1;
                int value;
                return int.TryParse(File.ReadAllText(path).Trim(), out value) && value > 0 ? value : 1;
            }
            catch
            {
                return 1;
            }
        }
        /// <summary>
        /// Hány munkaasztal él: 4-6 panel esetén kettő, egyébként egy. A webes
        /// fejléc 1/2 ikonja ugyanezt a szabályt használja (devadmin: panes > 3).
        /// </summary>
        private int DesktopCount()
        {
            int total = Math.Max(1, Math.Min(6, _cfg.Panes));
            return total > 3 ? 2 : 1;
        }

        /// <summary>
        /// EGY munkaasztal-ablak paneljeinek a száma. A beállított panelszám a
        /// TELJES panelszám: 4 -> 2+2, 5 -> 3+2, 6 -> 3+3.
        /// MÉRT HIBA (2026-11-16): a főablak indítási útvonala a teljes 6-ot adta
        /// át egy ablaknak, miközben az ablak a paneleket asztalonként rakta
        /// egymásra: 3 panel takarásban élt és 3 WebView2-t fogyasztott (~3,3 GB),
        /// a fejléc pedig "2. asztal"-ként jelölte a 6 paneles ablakot.
        /// </summary>
        private int PanesForDesktop(int desktop)
        {
            int total = Math.Max(1, Math.Min(6, _cfg.Panes));
            if (_cfg.RobotOnly) return 1;
            if (total <= 3) return total;
            int first = (total + 1) / 2;            // 4 -> 2, 5 -> 3, 6 -> 3
            int panes = desktop <= 1 ? first : total - first;
            return Math.Max(1, Math.Min(3, panes));
        }

        /// <summary>Munkaasztal váltása: a state\window-desktop.txt-be ír.</summary>
        private void SetDesktop(int desktop)
        {
            try
            {
                // A plafon a BEÁLLÍTOTT panelszámból jön: 1-3 panelnél nincs
                // második asztal, ezért a 2-es kérés sem írhat 2-t a fájlba
                // (különben a fejléc "2. asztalt" jelölne egyetlen ablak mellett).
                int clamped = Math.Max(1, Math.Min(DesktopCount(), desktop));
                string directory = Path.GetDirectoryName(_cfg.WindowLog);
                if (string.IsNullOrEmpty(directory)) return;
                File.WriteAllText(
                    Path.Combine(directory, "window-desktop.txt"),
                    clamped.ToString(CultureInfo.InvariantCulture));
                Log.Info("munkaasztal: " + clamped);
                ApplyDesktopAsync(clamped);
            }
            catch (Exception ex)
            {
                Log.Error("munkaasztal: " + ex.Message);
            }
        }
        // ---- munkaasztal-ablakok (ket kulon ablak, 4-6 panel eseten) ----
        /// <summary>A munkaasztal-ablak pid-fajljanak utvonala.</summary>
        private string DesktopPidPath(int desktop)
        {
            return Path.Combine(_cfg.StateDir, "window-desktop" + desktop + ".pid");
        }

        /// <summary>
        /// A munkaasztal-ablak futo PID-je, ha a folyamat el ES a neve
        /// DshWindow; egyebkent 0. A pid-fajlbol olvasunk, es a folyamatot is
        /// ellenorizzuk, hogy egy elavult bejegyzest ne tekintsunk elonek.
        /// </summary>
        private int RunningDesktopWindow(int desktop)
        {
            try
            {
                string path = DesktopPidPath(desktop);
                if (!File.Exists(path)) return 0;
                int pid;
                if (!int.TryParse(File.ReadAllText(path).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out pid) || pid <= 0)
                    return 0;
                Process proc = Process.GetProcessById(pid);
                return string.Equals(proc.ProcessName, "DshWindow", StringComparison.Ordinal) ? pid : 0;
            }
            catch
            {
                return 0;
            }
        }

        /// <summary>
        /// Ha EGYETLEN pid-fájl sem mutat élő ablakra, de pontosan egy DshWindow
        /// fut, akkor azt az AKTÍV asztalhoz rendeljük.
        /// MÉRT HIBA (2026-11-16): a régi változat minden futó ablakot az 1-es
        /// asztalhoz írt, ezért a 2. asztal ablaka "1. asztalként" szerepelt, és a
        /// váltás nem indított új ablakot (a két asztal ugyanarra a pid-re mutatott).
        /// </summary>
        private void HealDesktopPidFromRunningWindow()
        {
            try
            {
                for (int d = 1; d <= DesktopCount(); d++)
                {
                    if (RunningDesktopWindow(d) != 0) return;   // van érvényes rekord
                }
                Process[] running = Process.GetProcessesByName("DshWindow");
                if (running.Length != 1) return;                // több ablaknál nem tudjuk, melyik melyik
                int desktop = Math.Max(1, Math.Min(DesktopCount(), ReadDesktop()));
                File.WriteAllText(DesktopPidPath(desktop),
                    running[0].Id.ToString(CultureInfo.InvariantCulture), new UTF8Encoding(false));
                Log.Info("pid fajl potolva (asztal " + desktop + "): " + running[0].Id);
            }
            catch (Exception ex) { Log.Error("pid potlas: " + ex.Message); }
        }

        /// <summary>
        /// Egy munkaasztal-ablak elinditasa: sajat DshWindow.exe folyamat,
        /// asztalonkent PanesForDesktop() panellel. Ha az adott asztal mar fut,
        /// nem inditunk masodikat; az indulas pid-jet a sajat asztal pid-fajljaba
        /// irjuk (es a DshWindow is elmenti a sajat pid-jet).
        /// </summary>
        private void StartDesktopWindow(int desktop)
        {
            desktop = Math.Max(1, Math.Min(DesktopCount(), desktop));
            if (RunningDesktopWindow(desktop) != 0) return;
            // BOOT-SORREND GARANCIA (2026-11-16, mért hiba): a NEM aktív asztal
            // ablaka nem indulhat el az aktív asztal ablaka ELŐTT — különben boot
            // után a másik asztal lesz a látható ablak. Ha az aktív asztal ablaka
            // még nincs meg, ezt a kérést a felügyelet/az előkészítő szál
            // később újra kiadja.
            int activeNow = Math.Max(1, Math.Min(DesktopCount(), ReadDesktop()));
            if (desktop != activeNow && RunningDesktopWindow(activeNow) == 0)
            {
                Log.Info("munkaasztal " + desktop + " inditas halasztva: elobb az aktiv asztal ("
                    + activeNow + ") ablakanak kell elindulnia");
                return;
            }
            string url = CurrentUrl();
            if (string.IsNullOrEmpty(url))
            {
                Log.Info("munkaasztal " + desktop + " inditas halasztva: meg nincs token URL");
                return;
            }
            int paneCount = PanesForDesktop(desktop);
            bool robotPane = _cfg.RobotPane || _cfg.RobotOnly;
            string args = "--port " + _cfg.Port
                + " --panes " + paneCount
                + " --desktop " + desktop
                + " --no-boot --width " + _cfg.Width.ToString(CultureInfo.InvariantCulture)
                + " --height " + _cfg.Height.ToString(CultureInfo.InvariantCulture)
                + " --log \"" + _cfg.WindowLog + "\""
                + " --icon \"" + _cfg.IconFile + "\""
                + " --dsh-home \"" + _cfg.DshHome + "\""
                + " --dsh-bin \"" + _cfg.DshBin + "\""
                + " --url \"" + url + "\" --restart-if-stale";
            if (robotPane)
            {
                args += " --pane-url \"" + paneCount + "=" + _cfg.RobotUrl + "\"";
                Log.Info("robot felület: a " + paneCount + ". panel tolti be (" + _cfg.RobotUrl + ")"
                    + (_cfg.RobotOnly ? " [CSAK ROBOT MOD]" : string.Empty));
            }

            // Az indulo ablak "nyitva van": a korabbi bezaras jeloloje nem elhet tovabb.
            ClearCloseMarker();
            try
            {
                Log.Info("munkaasztal " + desktop + " inditas (" + paneCount + " panel)");
                Process proc = Process.Start(new ProcessStartInfo
                {
                    FileName = _cfg.WindowExe,
                    Arguments = args,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    WorkingDirectory = _cfg.Root
                });
                if (proc == null) return;
                File.WriteAllText(DesktopPidPath(desktop), proc.Id.ToString(CultureInfo.InvariantCulture), new UTF8Encoding(false));
                Log.Info("munkaasztal " + desktop + " pid=" + proc.Id);
                // A NEM aktiv asztal ablaka rejtve maradjon: kulonben ket ablak
                // lathato egyszerre. A rejtést csak a WebView2-k inicializalasa
                // UTAN vegezzuk (addig a rejtett ablak 0 meretu paneleket adna),
                // ezert a hatterben megvarjuk a fogantyut.
                if (desktop != Math.Max(1, Math.Min(DesktopCount(), ReadDesktop())))
                {
                    int pid = proc.Id;
                    var hider = new Thread(() => HideWhenReady(pid, desktop));
                    hider.IsBackground = true;
                    hider.Start();
                }
            }
            catch (Exception ex) { Log.Error("munkaasztal " + desktop + " inditas: " + ex.Message); }
        }

        /// <summary>
        /// A nem aktiv asztal ablakat a inicializalas utan elrejti. Addig var, amig
        /// a folyamatnak van top-level ablaka ES a naploban meg nem jelent meg a
        /// pane-airas (max ~15 s), hogy a WebView2 panelek valodi merettel jöjjenek
        /// letre; utana ShowWindow(SW_HIDE) — a panelekhez nem nyulunk.
        /// </summary>
        private void HideWhenReady(int pid, int desktop)
        {
            try
            {
                IntPtr h = IntPtr.Zero;
                for (int i = 0; i < 150; i++)
                {
                    Thread.Sleep(100);
                    try
                    {
                        Process p = Process.GetProcessById(pid);
                        if (p.HasExited) return;
                    }
                    catch { return; }
                    h = FindWindowForProcess(pid);
                    if (h != IntPtr.Zero && i >= 60) break;  // legalabb 6 s inicializalas
                }
                if (h == IntPtr.Zero) return;
                // Ha kozben ezt valasztotta a felhasznalo, ne rejtsuk el.
                if (desktop == Math.Max(1, Math.Min(DesktopCount(), ReadDesktop()))) return;
                NativeMethods.ShowWindow(h, NativeMethods.SW_HIDE);
                Log.Info("munkaasztal " + desktop + " elrejtve (nem aktiv)");
            }
            catch (Exception ex) { Log.Error("munkaasztal " + desktop + " elrejtes: " + ex.Message); }
        }

        /// <summary>A kivalasztott munkaasztal ablakenak eloterbe hozasa.</summary>
        private void BringToFront(int desktop)
        {
            // A Process.MainWindowHandle rejtett ablaknal IntPtr.Zero, ezert az
            // EnumWindows-alapu keresest hasznaljuk (WindowHandleOf).
            IntPtr hwnd = WindowHandleOf(desktop);
            if (hwnd == IntPtr.Zero) return;
            try
            {
                if (NativeMethods.IsIconic(hwnd)) NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);
                NativeMethods.SetForegroundWindow(hwnd);
            }
            catch (Exception ex) { Log.Error("munkaasztal " + desktop + " eloterbe hozas: " + ex.Message); }
        }

        /// <summary>
        /// A pid-hez tartozo legfelso szintu ablak megkeresese EnumWindows-lal.
        /// REJTETT ablaknal is megtalalja a fogantyut (a Process.MainWindowHandle
        /// rejtett ablaknal IntPtr.Zero-t ad, ez volt a hiba forrasa).
        /// </summary>
        private static IntPtr FindWindowForProcess(int pid)
        {
            var windows = new List<IntPtr>();
            NativeMethods.EnumWindows((hWnd, lParam) =>
            {
                uint windowPid;
                NativeMethods.GetWindowThreadProcessId(hWnd, out windowPid);
                if (windowPid == (uint)pid) windows.Add(hWnd);
                return true;
            }, IntPtr.Zero);
            if (windows.Count == 0) return IntPtr.Zero;

            // MÉRT HIBA (2026-11-16): a WPF/IME segédablakok is top-level, címzett
            // ablakok (CiceroUIWndFrame, SystemResourceNotifyWindow,
            // MediaContextNotificationWindow) ÉS ugyanúgy "HwndWrapper[...]" az
            // osztályuk, ezért bármelyik osztály/cím-alapú szűrő melléfoghatott:
            // a tálca a segédablakot mutatta/rejtette a valódi ablak helyett.
            // Mért következmény: mindkét munkaablak ablakszinten rejtve maradt
            // (a felhasználó üres asztalt látott), miközben a folyamatok éltek.
            // Ezért ELSŐBBSÉGET élvez a pontos termékcím; a többi csak tartalék.
            IntPtr byTitle = IntPtr.Zero, byTitleVisible = IntPtr.Zero;
            IntPtr byClass = IntPtr.Zero, lastText = IntPtr.Zero;
            foreach (IntPtr h in windows)
            {
                if (NativeMethods.GetWindowTextLength(h) > 0) lastText = h;
                if (NativeMethods.GetWindow(h, NativeMethods.GW_OWNER) != IntPtr.Zero) continue;
                string title = NativeMethods.GetWindowTextString(h);
                string cls = NativeMethods.GetClassNameString(h);
                if (string.Equals(title, "DeepSeek Harness", StringComparison.Ordinal))
                {
                    byTitle = h;
                    if (NativeMethods.IsWindowVisible(h)) byTitleVisible = h;
                    continue;
                }
                if (cls.StartsWith("HwndWrapper", StringComparison.Ordinal)) byClass = h;
            }
            if (byTitleVisible != IntPtr.Zero) return byTitleVisible;
            if (byTitle != IntPtr.Zero) return byTitle;
            if (byClass != IntPtr.Zero) return byClass;
            return lastText != IntPtr.Zero ? lastText : windows[0];
        }

        /// <summary>A munkaasztal-ablak ablakfogantyuja, ha a folyamat el.</summary>
        private IntPtr WindowHandleOf(int desktop)
        {
            int pid = RunningDesktopWindow(desktop);
            if (pid == 0) return IntPtr.Zero;
            IntPtr h = FindWindowForProcess(pid);
            if (h != IntPtr.Zero) return h;
            try
            {
                Process p = Process.GetProcessById(pid);
                p.Refresh();
                IntPtr hwnd = p.MainWindowHandle;
                if (hwnd == IntPtr.Zero)
                {
                    try { p.WaitForInputIdle(200); } catch { }
                    p.Refresh();
                    hwnd = p.MainWindowHandle;
                }
                return hwnd;
            }
            catch
            {
                return IntPtr.Zero;
            }
        }

        /// <summary>
        /// A munkaasztal-ablak megjelenitese es ELOTERBE hozasa.
        ///
        /// MÉRT HIBA (2026-11-16): a `SetForegroundWindow` a háttérben futó
        /// tálcából a Windows foreground-lock miatt NEM adja át a fókuszt, ezért
        /// az új ablak „a háttérben nyílt meg". A SetForegroundWindow után
        /// ellenőrizzük a GetForegroundWindow-ot, és ha nem sikerült, a
        /// SwitchToThisWindow-nal (legacy, de működik) kényszerítjük ki.
        /// </summary>
        private void ShowDesktopWindow(int desktop)
        {
            IntPtr h = WindowHandleOf(desktop);
            if (h == IntPtr.Zero) return;
            Activate(h);
        }

        private static void Activate(IntPtr h)
        {
            try
            {
                if (NativeMethods.IsIconic(h)) NativeMethods.ShowWindow(h, NativeMethods.SW_RESTORE);
                else NativeMethods.ShowWindow(h, NativeMethods.SW_SHOW);
                NativeMethods.BringWindowToTop(h);
                NativeMethods.SetForegroundWindow(h);
                if (NativeMethods.GetForegroundWindow() == h) return;

                // A Windows foreground-lock miatt a háttérben futó tálca
                // SetForegroundWindow hívása hatástalan. A dokumentált trükk:
                // az előtér-szál bemeneti sorához csatlakozunk, átadjuk a
                // fókuszt, majd leválunk.
                // MÉRT HIBA (2026-11-16): előbb a SwitchToThisWindow-t használtam,
                // de az Alt+Tab-szerűen viselkedik, és a felhasználónál MÁS
                // programot hozott előtérbe — ezt kivettem.
                IntPtr foreground = NativeMethods.GetForegroundWindow();
                if (foreground == IntPtr.Zero) return;
                uint fgThread = NativeMethods.GetWindowThreadProcessId(foreground, out uint _);
                uint myThread = NativeMethods.GetCurrentThreadId();
                if (fgThread == 0 || fgThread == myThread) return;
                if (NativeMethods.AttachThreadInput(fgThread, myThread, true))
                {
                    try
                    {
                        NativeMethods.BringWindowToTop(h);
                        NativeMethods.SetForegroundWindow(h);
                    }
                    finally
                    {
                        NativeMethods.AttachThreadInput(fgThread, myThread, false);
                    }
                }
            }
            catch (Exception ex) { Log.Error("ablak eloterbe hozas: " + ex.Message); }
        }

        /// <summary>A munkaasztal-ablak elrejtese ablakszinten (a paneleket nem bantjuk).</summary>
        private void HideDesktopWindow(int desktop)
        {
            IntPtr h = WindowHandleOf(desktop);
            if (h == IntPtr.Zero) return;
            NativeMethods.ShowWindow(h, NativeMethods.SW_HIDE);
        }

        /// <summary>Az aktivon kivul minden masik munkaasztal-ablak elrejtese.</summary>
        private void HideOtherDesktopWindows(int active, IntPtr activeHandle)
        {
            if (activeHandle == IntPtr.Zero) return;
            for (int other = 1; other <= 2; other++)
            {
                if (other == active) continue;
                IntPtr h = WindowHandleOf(other);
                if (h == IntPtr.Zero) continue;
                if (h == activeHandle) continue;
                NativeMethods.ShowWindow(h, NativeMethods.SW_HIDE);
            }
        }

        /// <summary>
        /// Igaz, ha legalabb egy DshWindow folyamatnak van lathato ablaka.
        /// REJTETT ablaknal a FindWindowForProcess is megtalalja a fogantyut,
        /// de az IsWindowVisible hamisat ad ra.
        /// </summary>
        private static bool AnyVisibleDshWindow()
        {
            return VisibleDesktopWindows().Count > 0;
        }

        /// <summary>A LÁTHATÓ munkaablakok pid-jei (ellenőrzéshez és naplóhoz).</summary>
        private static List<string> VisibleDesktopWindows()
        {
            var pids = new List<string>();
            foreach (Process p in Process.GetProcessesByName("DshWindow"))
            {
                try
                {
                    IntPtr h = FindWindowForProcess(p.Id);
                    if (h != IntPtr.Zero && NativeMethods.IsWindowVisible(h))
                        pids.Add(p.Id.ToString(CultureInfo.InvariantCulture));
                }
                catch { }
            }
            pids.Sort(StringComparer.Ordinal);
            return pids;
        }

        /// <summary>
        /// A window-desktop.txt figyeloje: a webes fejlec 1/2 gombja irja a
        /// fajlt; ha a tartalom elter a megjegyzett ertektol, atvaltunk.
        /// </summary>
        private void DesktopWatchTick()
        {
            if (_stopping) return;
            try
            {
                int current = Math.Max(1, Math.Min(DesktopCount(), ReadDesktop()));
                // Nem csak az ERTEK valtozasa szamit: ha a felulet ugyanazt a
                // szamot irja ujra (pl. 2 -> 2), a valtasnak akkor is meg kell
                // tortennie. Ezert a fajl irasidejet is figyeljuk.
                DateTime stamp = DateTime.MinValue;
                try
                {
                    string path = Path.Combine(_cfg.StateDir, "window-desktop.txt");
                    if (File.Exists(path)) stamp = File.GetLastWriteTimeUtc(path);
                }
                catch { }
                if (current != _desktop || stamp != _desktopStamp)
                {
                    _desktop = current;
                    _desktopStamp = stamp;
                    // FIGYELEM: itt NEM SetDesktop-et hivunk, mert az IRJA a
                    // window-desktop.txt-t -> az irasido valtozik -> a figyelo
                    // ujra tuzel -> vegtelen ciklus (mert hibaja, 2026-11-15).
                    // A figyelo csak ALKALMAZZA a valasztast.
                    ApplyDesktopAsync(current);
                }
            }
            catch (Exception ex) { Log.Error("munkaasztal-figyelo: " + ex.Message); }
        }

        // ── munkaasztal-váltás: ellenőrzött, háttérszálas végrehajtás ──────
        //
        // MÉRT HIBA (2026-11-16): a váltás egyetlen, nem ellenőrzött lépés volt
        // (Start + Show + Hide egy menetben). Ha a cél-ablak éppen indult, a
        // fogantyúja még nem létezett, ezért a „mutatás" és a „rejtés" is
        // elmaradt: a felhasználó néhány kattintásig nem látott változást, majd
        // a régi ablak eltűnt és az új „a háttérben" jelent meg. Ezért a váltás
        // mostantól: (1) megvárja a cél-ablak fogantyúját, (2) megjeleníti és
        // fókuszba hozza, (3) csak UTÁNA rejti el a többit, (4) ellenőrzi az
        // eredményt, és ha nem stimmel, egyszer megismétli.
        private readonly object _applyGate = new object();
        private int _applyTarget;
        private bool _applyRunning;

        private void ApplyDesktopAsync(int target)
        {
            target = Math.Max(1, Math.Min(DesktopCount(), target));
            lock (_applyGate)
            {
                _applyTarget = target;
                if (_applyRunning) return;      // a futó szál a legfrissebb célt veszi fel
                _applyRunning = true;
            }
            var worker = new Thread(() =>
            {
                try
                {
                    while (true)
                    {
                        int want;
                        lock (_applyGate) { want = _applyTarget; }
                        ApplyDesktopOnce(want);
                        lock (_applyGate)
                        {
                            if (_applyTarget == want) { _applyRunning = false; return; }
                        }
                    }
                }
                catch (Exception ex) { Log.Error("asztalvaltas: " + ex.Message); }
                finally { lock (_applyGate) { _applyRunning = false; } }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        /// <summary>Egy asztalváltás végrehajtása és ellenőrzése (max ~15 s).</summary>
        private void ApplyDesktopOnce(int target)
        {
            Log.Info("asztalvaltas -> " + target);
            bool shown = false;
            for (int i = 0; i < 100; i++)
            {
                if (RunningDesktopWindow(target) == 0 && i % 10 == 0) StartDesktopWindow(target);
                IntPtr h = WindowHandleOf(target);
                if (h != IntPtr.Zero)
                {
                    Activate(h);
                    shown = NativeMethods.IsWindowVisible(h);
                    if (shown) break;
                }
                Thread.Sleep(150);
            }
            if (!shown)
            {
                Log.Error("asztalvaltas: a(z) " + target + ". asztal ablaka nem jelent meg");
                return;
            }
            // A régi ablak rejtése CSAK a cél megjelenése után, hogy a képernyő
            // ne maradjon üresen (ez volt a „bezár, aztán kinyit" élmény).
            IntPtr activeHandle = WindowHandleOf(target);
            HideOtherDesktopWindows(target, activeHandle);
            // ELLENŐRZÉS (2026-11-16): a felhasználó két ablakot látott egyszerre,
            // mert a régi ablak rejtése elmaradhatott. Ezért megszámoljuk a
            // látható munkaablakokat, és ha nem pontosan egy van, megismételjük.
            List<string> visible = VisibleDesktopWindows();
            if (visible.Count != 1 || !NativeMethods.IsWindowVisible(activeHandle))
            {
                HideOtherDesktopWindows(target, activeHandle);
                Thread.Sleep(150);
                if (activeHandle != IntPtr.Zero && !NativeMethods.IsWindowVisible(activeHandle)) Activate(activeHandle);
                visible = VisibleDesktopWindows();
            }
            Log.Info("asztalvaltas kesz: aktiv=" + target
                + " lathato=[" + string.Join(",", visible.ToArray()) + "]");
        }

        private void SetPanes(int panes)
        {
            int clamped = Math.Max(1, Math.Min(6, panes));
            if (_cfg.Panes == clamped) return;
            _cfg.Panes = clamped;
            SaveLayoutConfig();
            RestartWindowForLayout();
        }

        /// <summary>A robot felület (4. panel) ki-/bekapcsolása.</summary>
        private void SetRobotPane(bool enabled)
        {
            if (_cfg.RobotPane == enabled) return;
            _cfg.RobotPane = enabled;
            SaveLayoutConfig();
            RestartWindowForLayout();
        }

        /// <summary>Csak robot mód: egyetlen, teljes szélességű robot-felület.</summary>
        private void SetRobotOnly(bool enabled)
        {
            if (_cfg.RobotOnly == enabled) return;
            _cfg.RobotOnly = enabled;
            if (enabled) _cfg.RobotPane = true;
            SaveLayoutConfig();
            RestartWindowForLayout();
        }

        /// <summary>
        /// Az ablak bezárása és újranyitása a mostani panelbeállításokkal.
        /// A harness-hez NEM nyúlunk: csak a megjelenítés változik, tehát nincs
        /// token-újragenerálás és nincs szükségtelen leállás.
        /// </summary>
        private void RestartWindowForLayout()
        {
            try
            {
                // CSAK az aktiv asztal ablakát zárjuk be: a másik asztal ablaka
                // érintetlen marad (korábban az összes DshWindow-t ölte, tehát egy
                // panelszám-váltás a másik asztalt is elvitte).
                int desktop = Math.Max(1, Math.Min(DesktopCount(), ReadDesktop()));
                var victims = new List<Process>();
                int pid = RunningDesktopWindow(desktop);
                if (pid != 0)
                {
                    try { victims.Add(Process.GetProcessById(pid)); } catch { }
                }
                if (victims.Count == 0)
                {
                    Process newest = null;
                    foreach (Process p in Process.GetProcessesByName("DshWindow"))
                    {
                        try { if (newest == null || p.StartTime > newest.StartTime) newest = p; } catch { }
                    }
                    if (newest != null) victims.Add(newest);
                }
                foreach (Process p in victims) { try { p.Kill(); } catch { } }
                for (int i = 0; i < 30; i++)
                {
                    bool any = false;
                    foreach (Process p in victims) { try { if (!p.HasExited) any = true; } catch { } }
                    if (!any) break;
                    Thread.Sleep(100);
                }
                try { if (File.Exists(DesktopPidPath(desktop))) File.Delete(DesktopPidPath(desktop)); } catch { }
                ClearCloseMarker();
                StartDesktopWindow(desktop);
            }
            catch (Exception ex) { Log.Error("ablak újranyitás: " + ex.Message); }
        }

        private static void StopPort(int port)
        {
            // FONTOS: NEM öljük le az összes node folyamatot — az a harness-t és a
            // DSH gyermekfolyamatait is elvinné. Csak a PORTOT hallgató PID-et.
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "netstat.exe",
                    Arguments = "-ano -p tcp",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true
                };
                var proc = new Process { StartInfo = psi };
                proc.Start();
                string output = proc.StandardOutput.ReadToEnd();
                proc.WaitForExit(5000);

                string needle = ":" + port.ToString(CultureInfo.InvariantCulture);
                foreach (string raw in output.Split('\n'))
                {
                    string line = raw.Trim();
                    if (line.Length == 0) continue;
                    if (line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    string[] parts = Regex.Split(line, "\\s+");
                    if (parts.Length < 5) continue;
                    string local = parts[1];
                    if (!local.EndsWith(needle, StringComparison.Ordinal)) continue;
                    int pid;
                    if (!int.TryParse(parts[parts.Length - 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid)) continue;
                    if (pid <= 4) continue; // rendszerfolyamatot soha
                    try
                    {
                        Process.GetProcessById(pid).Kill();
                        Log.Info("port " + port + ": PID " + pid + " leállítva");
                    }
                    catch (Exception ex) { Log.Error("port " + port + " leállítás: " + ex.Message); }
                }
            }
            catch (Exception ex) { Log.Error("netstat: " + ex.Message); }
        }

        // ── ütemezett karbantartás ─────────────────────────────────────────
        /// <summary>
        /// Naponta 09:00-kor: retune.mjs + chain-doctor.mjs (riport módban).
        /// Ez váltja ki a PowerShell scheduled taskokat — a szkriptek .mjs-ek,
        /// tehát PowerShell nélkül futtathatók.
        /// </summary>
        private void Scheduled()
        {
            if (_stopping) return;
            try
            {
                DateTime now = DateTime.Now;
                if (now.Hour != 9 || now.Minute > 5) return;
                if (_lastRetune.Date == now.Date) return;
                _lastRetune = now;
                RunMaintenance(false);
            }
            catch (Exception ex) { Log.Error("ütemező: " + ex.Message); }
        }

        private void RunMaintenance(bool manual)
        {
            try
            {
                string retune = Path.Combine(_cfg.ProvidersDir, "retune.mjs");
                string doctor = Path.Combine(_cfg.ProvidersDir, "chain-doctor.mjs");
                string log = Path.Combine(_cfg.ProvidersDir, "reports", "native-retune.log");
                Directory.CreateDirectory(Path.GetDirectoryName(log));
                var sb = new StringBuilder();
                sb.AppendLine();
                sb.AppendLine("===== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                    + (manual ? "  (kézi)" : "  (ütemezett)") + " =====");
                File.AppendAllText(log, sb.ToString(), new UTF8Encoding(false));

                RunNodeLogged(retune, string.Empty, log);
                if (File.Exists(doctor)) RunNodeLogged(doctor, string.Empty, log);
                File.AppendAllText(log, "vege" + Environment.NewLine, new UTF8Encoding(false));
                Log.Info("karbantartás kész" + (manual ? " (kézi)" : string.Empty));
            }
            catch (Exception ex) { Log.Error("karbantartás: " + ex.Message); }
        }

        private void RunNodeLogged(string script, string args, string logFile)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "node",
                    Arguments = "\"" + script + "\" " + args,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    WorkingDirectory = _cfg.ProvidersDir
                };
                var proc = new Process { StartInfo = psi };
                var buffer = new StringBuilder();
                proc.OutputDataReceived += (s, e) => { if (e.Data != null) buffer.AppendLine(e.Data); };
                proc.ErrorDataReceived += (s, e) => { if (e.Data != null) buffer.AppendLine(e.Data); };
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                proc.WaitForExit(180000);
                File.AppendAllText(logFile, buffer.ToString(), new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                try { File.AppendAllText(logFile, "KIVETEL: " + ex.Message + Environment.NewLine, new UTF8Encoding(false)); }
                catch { }
            }
        }

        // ── leállítás ──────────────────────────────────────────────────────
        /// <summary>
        /// Kilepeskor a munkaasztal-ablakok leallitasa: csak azokat a
        /// DshWindow folyamatokat oljuk meg, amelyek pid-je a pid-fajlban
        /// szerepel. A foablaknak nincs pid-fajlja, ezert erintetlen marad.
        /// </summary>
        private void StopDesktopWindows()
        {
            for (int desktop = 1; desktop <= 2; desktop++)
            {
                string pidPath = DesktopPidPath(desktop);
                try
                {
                    if (!File.Exists(pidPath)) continue;
                    int pid;
                    if (int.TryParse(File.ReadAllText(pidPath).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out pid) && pid > 0)
                    {
                        try
                        {
                            Process proc = Process.GetProcessById(pid);
                            if (string.Equals(proc.ProcessName, "DshWindow", StringComparison.Ordinal))
                            {
                                proc.Kill();
                                Log.Info("munkaasztal " + desktop + " (pid " + pid + ") leallitva");
                            }
                        }
                        catch { }
                    }
                    File.Delete(pidPath);
                }
                catch (Exception ex) { Log.Error("munkaasztal " + desktop + " pid-takaritas: " + ex.Message); }
            }
        }

        private void ExitApp()
        {
            Log.Info("tálca kilépés");
            _stopping = true;
            // FONTOS (2026-11-16, mért hiba): itt korábban StopDesktopWindows()
            // állt, ezért a tálca leállítása (frissítés, "Kilépés") MINDEN
            // munkaablakot megölt — a felhasználó ezt "minden bezárult"-ként élte
            // meg. A munkaablakok önálló folyamatok: a tálca kilépése nem zárja be
            // őket, és a következő tálca a pid-fájlokból (illetve a futó
            // folyamatokból) átveszi őket.
            try
            {
                int alive = Process.GetProcessesByName("DshWindow").Length;
                if (alive > 0) Log.Info("a munkaablakok nyitva maradnak (" + alive + " ablak)");
            }
            catch { }
            try { if (_supervise != null) _supervise.Dispose(); } catch { }
            try { if (_schedule != null) _schedule.Dispose(); } catch { }
            try { if (_desktopWatch != null) { _desktopWatch.Stop(); _desktopWatch.Dispose(); } } catch { }
            try { if (_icon != null) { _icon.Visible = false; _icon.Dispose(); } } catch { }
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { _stopping = true; }
            base.Dispose(disposing);
        }
    }

    internal static class NativeMethods
    {
        public const int SW_HIDE = 0;
        public const int SW_SHOW = 5;
        public const int SW_RESTORE = 9;
        public const uint GW_OWNER = 4;

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hWnd);

        /// <summary>
        /// Legacy (dokumentálatlan) API, de ez az egyetlen, ami háttérfolyamatból
        /// is át tudja venni a fókuszt a Windows foreground-lock ellenére.
        /// NEM használjuk: Alt+Tab-szerűen viselkedik, és MÁS programot hozhat
        /// előtérbe (mért hiba 2026-11-16) — helyette AttachThreadInput.
        /// </summary>
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [System.Runtime.InteropServices.UnmanagedFunctionPointer(System.Runtime.InteropServices.CallingConvention.StdCall)]
        internal delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        internal static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        internal static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        internal static extern bool IsWindow(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        internal static extern int GetWindowTextLength(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        internal static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        internal static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);

        /// <summary>Az ablak címe — a WPF-főablak és a segédablakok megkülönböztetéséhez.</summary>
        internal static string GetWindowTextString(IntPtr hWnd)
        {
            var text = new StringBuilder(512);
            GetWindowText(hWnd, text, text.Capacity);
            return text.ToString();
        }

        /// <summary>Az ablak osztályneve ("HwndWrapper[...]" = WPF-főablak).</summary>
        internal static string GetClassNameString(IntPtr hWnd)
        {
            var name = new StringBuilder(512);
            GetClassName(hWnd, name, name.Capacity);
            return name.ToString();
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        internal static extern int SetCurrentProcessExplicitAppUserModelID(string appID);
    }

    internal static class Program
    {
        private static Mutex _mutex;

        [STAThread]
        private static void Main()
        {
            // Függő frissítés alkalmazása: a build által hátrahagyott
            // *.exe.new fájlok cseréje, amint a célfájl nincs zárolva.
            try
            {
                string root = System.IO.Path.GetFullPath(
                    System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
                PendingUpdate.Apply(root);
            }
            catch { }

            // Egyetlen tálca-példány: a második indítás egyszerűen kilép.
            bool created;
            _mutex = new Mutex(true, "DshTraySingleInstance", out created);
            if (!created)
            {
                try
                {
                    // Ha már fut, csak jelezzük neki, hogy nyissa meg az ablakot.
                    using (EventWaitHandle ev = EventWaitHandle.OpenExisting("DshHarnessShowWindow")) ev.Set();
                }
                catch { }
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApp());
        }
    }
}
