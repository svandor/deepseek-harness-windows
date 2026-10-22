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

        public string StateDir { get { return Path.Combine(Root, "state"); } }
        public string BinDir { get { return Path.Combine(Root, "bin"); } }
        public string ProvidersDir { get { return Path.Combine(Root, "providers"); } }
        public string WindowExe { get { return Path.Combine(BinDir, "DshWindow.exe"); } }
        public string ProxyScript { get { return Path.Combine(ProvidersDir, "proxy.mjs"); } }
        public string IconFile { get { return Path.Combine(Root, "assets", "dsh.ico"); } }
        public string WindowLog { get { return Path.Combine(StateDir, "window.log"); } }
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
        private DateTime _lastRetune = DateTime.MinValue;
        private string _windowUrl = string.Empty;
        private volatile bool _awaitToken;   // harness-újraindítás után az új tokenre várunk

        public TrayApp()
        {
            _cfg.Root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
            Log.Init(Path.Combine(_cfg.StateDir, "native-tray.log"));
            Log.Info("tálca indul (pid " + Process.GetCurrentProcess().Id + ", gyökér: " + _cfg.Root + ")");

            LoadConfig();
            BuildIcon();
            StartShowListener();

            _supervise = new System.Threading.Timer(_ => Supervise(), null, 1500, 20000);
            _schedule = new System.Threading.Timer(_ => Scheduled(), null, 5000, 60000);
            Log.Info("felügyelet elindult (20 s), ütemező elindult (60 s)");
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
            Log.Info("config: port=" + _cfg.Port + " panes=" + _cfg.Panes
                + " proxyPort=" + _cfg.ProxyPort + " dsh=" + (_cfg.DshBin ?? "?"));
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

        private void EnsureWindow()
        {
            if (_windowStarts > 0 && Process.GetProcessesByName("DshWindow").Length > 0) return;
            if (Process.GetProcessesByName("DshWindow").Length > 0) return;
            if (!Listening(_cfg.Port)) return;
            if (!File.Exists(_cfg.WindowExe))
            {
                Log.Error("ablak nem indul: hiányzik " + _cfg.WindowExe);
                return;
            }
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

        private void StartWindow()
        {
            string url = CurrentUrl();
            if (string.IsNullOrEmpty(url))
            {
                // A token még nem készült el: a következő körben újra próbáljuk.
                Log.Info("ablak indítás halasztva: még nincs token URL");
                return;
            }
            string args = "--port " + _cfg.Port
                + " --panes " + _cfg.Panes
                + " --no-boot --width " + _cfg.Width.ToString(CultureInfo.InvariantCulture)
                + " --height " + _cfg.Height.ToString(CultureInfo.InvariantCulture)
                + " --log \"" + _cfg.WindowLog + "\""
                + " --icon \"" + _cfg.IconFile + "\""
                + " --dsh-home \"" + _cfg.DshHome + "\""
                + " --dsh-bin \"" + _cfg.DshBin + "\""
                + " --url \"" + url + "\" --restart-if-stale";
            try
            {
                Log.Info("ablak indítás");
                Process.Start(new ProcessStartInfo
                {
                    FileName = _cfg.WindowExe,
                    Arguments = args,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    WorkingDirectory = _cfg.Root
                });
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
        private void ExitApp()
        {
            Log.Info("tálca kilépés");
            _stopping = true;
            try { if (_supervise != null) _supervise.Dispose(); } catch { }
            try { if (_schedule != null) _schedule.Dispose(); } catch { }
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
        public const int SW_RESTORE = 9;

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
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
