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
            BuildIcon();
            // Új tálca-session (bejelentkezés, frissítés): az ablak a megszokott
            // módon megnyílik. A bezárás-jelölő csak az adott sessionre szól,
            // különben egy régi bezárás után a login után sem nyílna meg.
            ClearCloseMarker();
            StartShowListener();

            _supervise = new System.Threading.Timer(_ => Supervise(), null, 1500, 20000);
            _schedule = new System.Threading.Timer(_ => Scheduled(), null, 5000, 60000);

            // Munkaasztal-figyelo: a webes fejlec 1/2 gombja a
            // state\window-desktop.txt-t irja; 700 ms-onkent figyeljuk, es
            // valtozasra atvaltunk (4-6 panel eseten ket kulon ablak).
            _desktop = ReadDesktop();
            _desktopWatch = new System.Windows.Forms.Timer { Interval = 700 };
            _desktopWatch.Tick += (s, e) => DesktopWatchTick();
            _desktopWatch.Start();
            Log.Info("munkaasztal-figyelo elindult (700 ms)");
            Log.Info("felügyelet elindult (20 s), ütemező elindult (60 s)");
            HealDesktopPidFromRunningWindow();
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

        private void StartWindow()
        {
            string url = CurrentUrl();
            if (string.IsNullOrEmpty(url))
            {
                // A token még nem készült el: a következő körben újra próbáljuk.
                Log.Info("ablak indítás halasztva: még nincs token URL");
                return;
            }
            // Robot felület: a PS-tálca `--pane-url "<panes>=<url>"` alakban adta
            // át, a DshWindow ezt értelmezi a 4. (utolsó) panelként.
            // MÉRT HIBA (2026-11-15): itt még a régi 3-as plafon állt, ezért a
            // tálcán beállított 6 panelből 3-at indított (`window.log: panes: 3`).
            int paneCount = Math.Max(1, Math.Min(6, _cfg.Panes));
            bool robotPane = _cfg.RobotPane || _cfg.RobotOnly;
            if (_cfg.RobotOnly) paneCount = 1;

            string args = "--port " + _cfg.Port
                + " --panes " + paneCount
                + " --desktop " + ReadDesktop()
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

            // Az induló ablak "nyitva van": a korábbi bezárás jelölője nem élhet tovább.
            ClearCloseMarker();
            try
            {
                Log.Info("ablak indítás");
                Process proc = Process.Start(new ProcessStartInfo
                {
                    FileName = _cfg.WindowExe,
                    Arguments = args,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    WorkingDirectory = _cfg.Root
                });
                if (proc != null)
                {
                    File.WriteAllText(DesktopPidPath(1), proc.Id.ToString(CultureInfo.InvariantCulture), new UTF8Encoding(false));
                    Log.Info("foablak pid=" + proc.Id + " (munkaasztal 1)");
                }
            }
            catch (Exception ex) { Log.Error("ablak indítás: " + ex.Message); }
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
                Process[] panes = Process.GetProcessesByName("DshWindow");
                if (panes.Length > 0)
                {
                    foreach (Process p in panes)
                    {
                        try
                        {
                            IntPtr hwnd = p.MainWindowHandle;
                            if (hwnd != IntPtr.Zero)
                            {
                                NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);
                                NativeMethods.SetForegroundWindow(hwnd);
                            }
                        }
                        catch { }
                    }
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
        /// <summary>Munkaasztal váltása: a state\window-desktop.txt-be ír.</summary>
        private void SetDesktop(int desktop)
        {
            try
            {
                int clamped = Math.Max(1, Math.Min(2, desktop));
                string directory = Path.GetDirectoryName(_cfg.WindowLog);
                if (string.IsNullOrEmpty(directory)) return;
                File.WriteAllText(
                    Path.Combine(directory, "window-desktop.txt"),
                    clamped.ToString(CultureInfo.InvariantCulture));
                Log.Info("munkaasztal: " + clamped);
                // 4-6 panel eseten ket kulon ablak van: a kivalasztottat
                // eloterbe hozzuk, es ha meg nem fut, elinditjuk. 1-3 panelnel
                // a regi viselkedes marad: csak a fajlt irjuk.
                if (true)
                {
                    StartDesktopWindow(clamped);
                    ShowDesktopWindow(clamped);
                    IntPtr activeHandle = WindowHandleOf(clamped);
                    HideOtherDesktopWindows(clamped, activeHandle);
                    if (!AnyVisibleDshWindow()) ShowDesktopWindow(clamped);
                }
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
        /// If the desktop-1 pid file is missing or stale but a DshWindow process
        /// is actually running, point the file at the newest such process.
        /// </summary>
        private void HealDesktopPidFromRunningWindow()
        {
            if (RunningDesktopWindow(1) != 0) return;
            try
            {
                Process newest = null;
                foreach (Process p in Process.GetProcessesByName("DshWindow"))
                {
                    try
                    {
                        if (newest == null || p.StartTime > newest.StartTime) newest = p;
                    }
                    catch { }
                }
                if (newest == null) return;
                File.WriteAllText(DesktopPidPath(1), newest.Id.ToString(CultureInfo.InvariantCulture), new UTF8Encoding(false));
                Log.Info("pid fajl potolva: " + newest.Id);
            }
            catch (Exception ex) { Log.Error("pid potlas: " + ex.Message); }
        }

        /// <summary>
        /// Egy munkaasztal-ablak elinditasa: sajat DshWindow.exe --panes 3
        /// folyamat. Ha az adott asztal mar fut, nem inditunk masodikat; az
        /// indulas pid-jet a pid-fajlba irjuk.
        /// </summary>
        private void StartDesktopWindow(int desktop)
        {
            if (RunningDesktopWindow(desktop) != 0) return;
            string url = CurrentUrl();
            if (string.IsNullOrEmpty(url))
            {
                Log.Info("munkaasztal " + desktop + " inditas halasztva: meg nincs token URL");
                return;
            }
            string args = "--port " + _cfg.Port
                + " --panes 3"
                + " --desktop " + desktop
                + " --no-boot --width " + _cfg.Width.ToString(CultureInfo.InvariantCulture)
                + " --height " + _cfg.Height.ToString(CultureInfo.InvariantCulture)
                + " --log \"" + _cfg.WindowLog + "\""
                + " --icon \"" + _cfg.IconFile + "\""
                + " --dsh-home \"" + _cfg.DshHome + "\""
                + " --dsh-bin \"" + _cfg.DshBin + "\""
                + " --url \"" + url + "\" --restart-if-stale";
            try
            {
                Log.Info("munkaasztal " + desktop + " inditas (3 panel)");
                Process proc = Process.Start(new ProcessStartInfo
                {
                    FileName = _cfg.WindowExe,
                    Arguments = args,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    WorkingDirectory = _cfg.Root
                });
                if (proc != null)
                {
                    File.WriteAllText(DesktopPidPath(desktop), proc.Id.ToString(CultureInfo.InvariantCulture), new UTF8Encoding(false));
                    Log.Info("munkaasztal " + desktop + " pid=" + proc.Id);
                }
            }
            catch (Exception ex) { Log.Error("munkaasztal " + desktop + " inditas: " + ex.Message); }
        }

        /// <summary>A kivalasztott munkaasztal ablakenak eloterbe hozasa.</summary>
        private void BringToFront(int desktop)
        {
            int pid = RunningDesktopWindow(desktop);
            if (pid == 0) return;
            try
            {
                Process proc = Process.GetProcessById(pid);
                proc.Refresh();
                IntPtr hwnd = proc.MainWindowHandle;
                if (hwnd != IntPtr.Zero) NativeMethods.SetForegroundWindow(hwnd);
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
            IntPtr lastCandidate = IntPtr.Zero, strict = IntPtr.Zero, lastText = IntPtr.Zero;
            int candidates = 0;
            foreach (IntPtr h in windows)
            {
                if (NativeMethods.GetWindowTextLength(h) > 0) lastText = h;
                bool topLevelText = NativeMethods.GetWindow(h, NativeMethods.GW_OWNER) == IntPtr.Zero
                    && NativeMethods.GetWindowTextLength(h) > 0;
                if (topLevelText) { candidates++; lastCandidate = h; }
                if (topLevelText && NativeMethods.IsWindowVisible(h)) strict = h;
            }
            if (candidates == 1) return lastCandidate;
            if (strict != IntPtr.Zero) return strict;
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

        /// <summary>A munkaasztal-ablak megjelenitese es eloterbe hozasa.</summary>
        private void ShowDesktopWindow(int desktop)
        {
            IntPtr h = WindowHandleOf(desktop);
            if (h == IntPtr.Zero) return;
            if (NativeMethods.IsIconic(h)) NativeMethods.ShowWindow(h, NativeMethods.SW_RESTORE);
            else NativeMethods.ShowWindow(h, NativeMethods.SW_SHOW);
            NativeMethods.SetForegroundWindow(h);
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
            foreach (Process p in Process.GetProcessesByName("DshWindow"))
            {
                try
                {
                    IntPtr h = FindWindowForProcess(p.Id);
                    if (h != IntPtr.Zero && NativeMethods.IsWindowVisible(h)) return true;
                }
                catch { }
            }
            return false;
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
                int current = ReadDesktop();
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
                    StartDesktopWindow(current);
                    ShowDesktopWindow(current);
                    IntPtr activeHandle = WindowHandleOf(current);
                    HideOtherDesktopWindows(current, activeHandle);
                    if (!AnyVisibleDshWindow()) ShowDesktopWindow(current);
                }
            }
            catch (Exception ex) { Log.Error("munkaasztal-figyelo: " + ex.Message); }
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
                foreach (Process p in Process.GetProcessesByName("DshWindow")) { try { p.Kill(); } catch { } }
                Thread.Sleep(600);
                ClearCloseMarker();
                StartWindow();
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
            StopDesktopWindows();
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
