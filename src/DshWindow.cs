// DshWindow - native WebView2 window for the DeepSeek Harness Web GUI.
//
// The window is a real desktop application window (WPF chrome + WebView2),
// so no terminal has to stay open and no browser tab is used.
//
// Design notes that matter:
//   * The window process is a pure client. It only boots the background
//     `dsh web` server when nothing is listening on the port yet; the tray
//     controller keeps that server alive independently.
//   * WebView2 is driven through the Core API on the window's own HWND rather
//     than through the WPF wrapper control. The wrapper hides too much of the
//     startup handshake, and when it fails it only reports a generic
//     E_UNEXPECTED; the Core API reports the real HRESULT and lets the browser
//     arguments be tuned from the command line (--browser-args).
//   * dsh is started with ProcessStartInfo.Arguments built by explicit Windows
//     quoting rules, so paths containing spaces survive intact.
//   * Everything is wrapped: this is a GUI process without a console, so any
//     failure must land in the log file instead of vanishing.
//
// Build: see build.ps1 (Roslyn csc.exe, references are passed explicitly).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;

namespace DshWindow
{
    internal static class Program
    {
        internal const string WindowTitle = "DeepSeek Harness";

        /// <summary>
        /// Upper bound for the side-by-side panes. Each pane is a complete client
        /// (its own WebView2 profile, cookies, storage and workspace selection),
        /// so the bound is about screen room and memory, not about correctness.
        /// </summary>
        internal const int MaxPanes = 4;

        /// <summary>Width of the draggable divider between two panes (WPF units).</summary>
        internal const double SplitterWidth = 7;

        /// <summary>
        /// The authenticated (token-carrying) URL announced by `dsh web` on its
        /// stdout. dsh refuses requests without the session cookie, and that
        /// cookie can only be minted by opening this URL, so the window must use
        /// it for its first navigation.
        /// </summary>
        private static volatile string _announcedUrl;

        internal static string AnnouncedUrl { get { return _announcedUrl; } }

        // Match the dark surface the Web UI paints, so the first frame of the
        // window is not a white flash.
        internal static readonly Brush DarkBackground = new SolidColorBrush(Color.FromRgb(0x15, 0x15, 0x17));

        // The divider between panes: slightly lighter than the page so it reads
        // as a handle, dark enough not to draw attention.
        internal static readonly Brush SplitterBrush = new SolidColorBrush(Color.FromRgb(0x33, 0x33, 0x38));

        [STAThread]
        private static int Main(string[] args)
        {
            var opts = Options.Parse(args);
            Logger.Init(opts.LogFile);
            Logger.Info("launcher start: pid=" + Process.GetCurrentProcess().Id + " args=" + string.Join(" ", args));

            // A futo peldany kora: a hibakeresesnel ez donti el, hogy a javitott
            // vagy egy korabbi exe fut-e (a talca "Megnyitas" gombja ugyanis a
            // MAR futo ablakot hozza eloterbe, uj ablakot nem nyit).
            try
            {
                string own = System.Reflection.Assembly.GetExecutingAssembly().Location;
                if (!string.IsNullOrEmpty(own) && File.Exists(own))
                {
                    Logger.Info("build: " + File.GetLastWriteTime(own).ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                        + " (" + own + ")");
                }
            }
            catch
            {
            }

            try
            {
                return Run(opts);
            }
            catch (Exception ex)
            {
                Logger.Error("fatal: " + ex);
                return 1;
            }
        }

        private static int Run(Options opts)
        {
            string url = opts.Url ?? ("http://127.0.0.1:" + opts.Port.ToString(CultureInfo.InvariantCulture));

            // 1) Make sure the background harness is up, unless the caller (the
            //    tray) already guaranteed it.
            if (!opts.NoBoot)
            {
                if (PortProbe.IsListening(opts.Port))
                {
                    Logger.Info("harness already listening on port " + opts.Port);
                    if (opts.RestartIfStale && !HasUsableToken(opts))
                    {
                        // The running server predates this window and its token
                        // is unknown, so the only way to get one is to restart
                        // it. The tray passes --restart-if-stale for this case.
                        Logger.Info("no stored token for the running harness; restarting it");
                        int killed = HarnessBoot.StopListeningProcess(opts.Port);
                        if (killed > 0)
                        {
                            Thread.Sleep(1200);
                            int restarted = HarnessBoot.Start(opts, OnHarnessUrlAnnounced);
                            Logger.Info("harness restarted, pid=" + restarted);
                            if (PortProbe.WaitForListening(opts.Port, TimeSpan.FromSeconds(opts.BootTimeoutSeconds)))
                            {
                                WaitForAnnouncedUrl(TimeSpan.FromSeconds(15));
                            }
                        }
                        else
                        {
                            Logger.Error("could not stop the running harness for a token refresh");
                        }
                    }
                }
                else
                {
                    int pid = HarnessBoot.Start(opts, OnHarnessUrlAnnounced);
                    Logger.Info("harness started, pid=" + pid + ", waiting for 127.0.0.1:" + opts.Port);
                    bool listening = PortProbe.WaitForListening(opts.Port, TimeSpan.FromSeconds(opts.BootTimeoutSeconds));
                    if (!listening)
                    {
                        Logger.Error("harness did not start listening within " + opts.BootTimeoutSeconds + "s");
                    }
                    else
                    {
                        // The token URL is printed right around the bind; give it
                        // a moment so the first navigation is authenticated.
                        WaitForAnnouncedUrl(TimeSpan.FromSeconds(10));
                    }
                }
            }

            if (!string.IsNullOrEmpty(_announcedUrl))
            {
                url = _announcedUrl;
                Logger.Info("using authenticated url for the first navigation");
            }
            else if (opts.Url != null)
            {
                Logger.Info("using url from the caller");
            }
            else if (PortProbe.IsListening(opts.Port) && !opts.RestartIfStale)
            {
                // The server was already running and we did not start it, so its
                // token is unknown here. --restart-if-stale lets the window
                // recover from that on a 401 instead of dead-ending.
                Logger.Info("harness was already running; pass --restart-if-stale to self-heal a missing token");
            }

            return ShowWindow(opts, url);
        }

        /// <summary>Captures the "dsh web: &lt;url&gt;" line the harness prints.</summary>
        private static void OnHarnessUrlAnnounced(string line)
        {
            // The line may carry a second "(LAN: http://...)" URL, so the match
            // must stop at whitespace or a closing parenthesis.
            Match match = Regex.Match(line, @"https?://[^\s)]+");
            if (!match.Success) return;
            string candidate = match.Value.TrimEnd('.', ',');
            if (candidate.IndexOf("token=", StringComparison.OrdinalIgnoreCase) < 0) return;
            _announcedUrl = candidate;
            Logger.Info("harness announced url: " + candidate);
            PersistToken(candidate);
        }

        /// <summary>
        /// Stores the token URL next to the launcher (state\harness.url) so the
        /// tray, and later window launches, can authenticate without restarting
        /// the harness again. The file is per-user and the server is loopback
        /// only, so this does not widen the exposure dsh already has.
        /// </summary>
        private static void PersistToken(string url)
        {
            try
            {
                string stateDir = DshPaths.ResolveStateDir();
                Directory.CreateDirectory(stateDir);
                File.WriteAllText(Path.Combine(stateDir, "harness.url"), url, new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                Logger.Info("token url not persisted: " + ex.Message);
            }
        }

        /// <summary>True when a token URL for this port is already on disk.</summary>
        private static bool HasUsableToken(Options opts)
        {
            try
            {
                string file = Path.Combine(DshPaths.ResolveStateDir(), "harness.url");
                if (!File.Exists(file)) return false;
                string value = File.ReadAllText(file).Trim();
                return value.StartsWith("http://127.0.0.1:" + opts.Port.ToString(CultureInfo.InvariantCulture) + "/?token=",
                    StringComparison.Ordinal);
            }
            catch
            {
                return false;
            }
        }

        private static void WaitForAnnouncedUrl(TimeSpan timeout)
        {
            DateTime deadline = DateTime.UtcNow + timeout;
            while (_announcedUrl == null && DateTime.UtcNow < deadline)
            {
                Thread.Sleep(150);
            }
        }

        private static int ShowWindow(Options opts, string url)
        {
            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            app.DispatcherUnhandledException += (s, e) =>
            {
                Logger.Error("dispatcher: " + e.Exception);
                e.Handled = true;
            };

            // One pane is the classic single window. Two or more panes put
            // complete, independent clients side by side: each pane owns its own
            // WebView2 profile, so every panel keeps its own workspace and
            // session selection, and two workspaces can run in parallel inside
            // this one application window.
            int paneCount = Math.Max(1, Math.Min(MaxPanes, opts.Panes));
            double[] paneRatios = PaneLayout.Load(paneCount);
            var hosts = new List<DshWebViewHost>(paneCount);
            var content = new Grid { Background = DarkBackground };

            for (int i = 0; i < paneCount; i++)
            {
                if (i > 0)
                {
                    content.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(SplitterWidth) });
                }

                content.ColumnDefinitions.Add(new ColumnDefinition
                {
                    Width = new GridLength(paneRatios[i], GridUnitType.Star),
                    MinWidth = 320
                });

                string paneUrl = url;
                bool isHarnessPane = true;
                string paneUrlOverride;
                if (opts.PaneUrls != null
                    && opts.PaneUrls.TryGetValue(i + 1, out paneUrlOverride)
                    && !string.IsNullOrWhiteSpace(paneUrlOverride))
                {
                    paneUrl = paneUrlOverride;
                    isHarnessPane = false;
                    Logger.Info("pane " + (i + 1) + ": URL override -> " + paneUrl
                        + " (nincs token-figyelo es 401-kezeles: nem a Harness klienst tolti)");
                }

                var pane = new DshWebViewHost(paneUrl, opts, OnHarnessUrlAnnounced, i, isHarnessPane);
                hosts.Add(pane);
                FocusKeeper.RegisterPane(i, pane);
                if (opts.FocusProbe) Probe.RegisterPane(i, pane);
                Grid.SetColumn(pane, i * 2);
                content.Children.Add(pane);

                if (i > 0)
                {
                    var splitter = new GridSplitter
                    {
                        Width = SplitterWidth,
                        HorizontalAlignment = HorizontalAlignment.Stretch,
                        VerticalAlignment = VerticalAlignment.Stretch,
                        ResizeBehavior = GridResizeBehavior.PreviousAndNext,
                        ResizeDirection = GridResizeDirection.Columns,
                        ShowsPreview = false,
                        Background = SplitterBrush,
                        Cursor = System.Windows.Input.Cursors.SizeWE
                    };
                    Grid.SetColumn(splitter, i * 2 - 1);
                    content.Children.Add(splitter);
                }
            }

            if (paneCount > 1)
            {
                Logger.Info("panes: " + paneCount + " (each pane has its own WebView2 profile)");
            }

            // Remember the last position/size: every new window opens where the
            // previous one was left (important on a 32:9 desktop, where the
            // useful place is rarely the screen centre).
            var geometry = opts.IgnoreSavedGeometry ? new WindowGeometry() : WindowGeometry.Load();
            bool restoreGeometry = geometry.IsOnScreen();

            var window = new Window
            {
                Title = WindowTitle,
                Width = restoreGeometry ? geometry.Width.Value : opts.Width,
                Height = restoreGeometry ? geometry.Height.Value : opts.Height,
                MinWidth = 640,
                MinHeight = 480,
                Background = DarkBackground,
                WindowStartupLocation = restoreGeometry || (opts.X.HasValue && opts.Y.HasValue)
                    ? WindowStartupLocation.Manual
                    : (opts.Center ? WindowStartupLocation.CenterScreen : WindowStartupLocation.Manual),
                Content = content,
                ShowInTaskbar = true
            };

            if (restoreGeometry)
            {
                window.Left = geometry.Left.Value;
                window.Top = geometry.Top.Value;
                Logger.Info("restored window geometry: "
                    + window.Left.ToString("0", CultureInfo.InvariantCulture) + ","
                    + window.Top.ToString("0", CultureInfo.InvariantCulture) + " "
                    + window.Width.ToString("0", CultureInfo.InvariantCulture) + "x"
                    + window.Height.ToString("0", CultureInfo.InvariantCulture));
            }
            else if (opts.X.HasValue && opts.Y.HasValue)
            {
                window.Left = opts.X.Value;
                window.Top = opts.Y.Value;
            }

            // Save on close. RestoreBounds is used so a maximized window still
            // reports the rectangle the user will get when un-maximizing.
            bool geometrySaved = false;
            window.Closing += (s, e) =>
            {
                if (geometrySaved) return;
                geometrySaved = true;
                try
                {
                    Rect bounds = window.RestoreBounds;
                    if (bounds.Width > 0 && bounds.Height > 0)
                    {
                        geometry.Save(bounds.Left, bounds.Top, bounds.Width, bounds.Height);
                        Logger.Info("window geometry saved: "
                            + bounds.Left.ToString("0", CultureInfo.InvariantCulture) + ","
                            + bounds.Top.ToString("0", CultureInfo.InvariantCulture) + " "
                            + bounds.Width.ToString("0", CultureInfo.InvariantCulture) + "x"
                            + bounds.Height.ToString("0", CultureInfo.InvariantCulture));
                        PaneLayout.Save(hosts);
                    }
                }
                catch (Exception ex)
                {
                    Logger.Info("geometry save failed: " + ex.Message);
                }
            };

            try
            {
                window.Icon = LoadWindowIcon(opts.IconFile);
            }
            catch (Exception ex)
            {
                Logger.Info("icon not applied: " + ex.Message);
            }

            window.SourceInitialized += (s, e) =>
            {
                IntPtr hwnd = new WindowInteropHelper(window).Handle;
                try { DarkTitleBar.Apply(hwnd); }
                catch (Exception ex) { Logger.Info("dark title bar not applied: " + ex.Message); }

                // A WPF saját aktiválás-eseménye: minden visszatérésnél megjön
                // (a WM_ACTIVATE hook néha nem fut le — mért eset), ezért innen
                // is elindítjuk a fókusz helyreállítását.
                window.Activated += (ws, we) =>
                {
                    try
                    {
                        DshWebViewHost target = FocusKeeper.PendingPane;
                        Logger.Info("window activated (WPF): target="
                            + (target == null ? "-" : (target.PaneIndex + 1).ToString(CultureInfo.InvariantCulture)));
                        // Csak késleltetve állítunk vissza: a korai (0 ms-os) próba
                        // egybeesik a WPF saját fókusz-áthelyezésével, ezért az
                        // mindig felülírta (mért hiba).
                        FocusKeeper.RestoreTargetSoon(target, "window activated (WPF)");
                    }
                    catch (Exception ex)
                    {
                        Logger.Info("focus restore on Activated failed: " + ex.Message);
                    }
                };
                window.Deactivated += (ws, we) =>
                {
                    FocusKeeper.Freeze();
                    if (Probe.Enabled) Probe.Note("window deactivated (WPF)", IntPtr.Zero);
                };

                // Amikor a felhasználó visszatér az ablakhoz (Alt+Tab, tálca),
                // a WebView2 gyermekablak nem biztos, hogy visszakapja a
                // fókuszt — a kurzor ezért tűnt el a chat mezőből. Itt adjuk
                // vissza, még az aktiválás feldolgozása előtt.
                try
                {
                    var source = HwndSource.FromHwnd(hwnd);
                    if (source != null)
                    {
                        source.AddHook((IntPtr h, int msg, IntPtr wParam, IntPtr lParam, ref bool handled) =>
                        {
                            // A lap azt jelezte, hogy visszaaktiválás után is
                            // veszített fókuszt; ez a sor mondja meg, hogy az
                            // ABLAK szintjén történt-e (WM_ACTIVATE 0 = inaktív).
                            if ((msg == Win32.WM_ACTIVATE || msg == Win32.WM_NCACTIVATE) && Probe.Enabled)
                            {
                                Probe.Note("top " + Probe.MsgName(msg) + " wparam="
                                    + wParam.ToInt64().ToString(CultureInfo.InvariantCulture), IntPtr.Zero);
                            }
                            if (msg == Win32.WM_ACTIVATE
                                && (wParam.ToInt64() & 0xFFFF) != 0)
                            {
                                // AKTIVÁLÁS: a cél a fókuszvesztés pillanatában
                                // rögzített panel. A zár csak később oldódik,
                                // mert a WPF az aktiválás közben az ELSŐ panelre
                                // teszi a fókuszt, és annak jelzése felülírná a
                                // célunkat (mért hiba).
                                DshWebViewHost target = FocusKeeper.PendingPane;
                                Logger.Info("window activated (hook): target="
                                    + (target == null ? "-" : (target.PaneIndex + 1).ToString(CultureInfo.InvariantCulture)));
                                FocusKeeper.RestoreTargetSoon(target, "window activated");
                                if (Probe.Enabled) Probe.ScheduleDump();
                            }
                            else if (msg == Win32.WM_KILLFOCUS || msg == Win32.WM_NCACTIVATE
                                || msg == Win32.WM_ACTIVATE)
                            {
                                // DEAKTIVÁLÁS: lezárjuk a célt.
                                FocusKeeper.Freeze();
                            }
                            return IntPtr.Zero;
                        });
                    }
                }
                catch (Exception ex)
                {
                    Logger.Info("focus hook not installed: " + ex.Message);
                }
            };

            ScheduleAutoClose(window, opts.CloseAfterSeconds);
            app.MainWindow = window;
            app.Run(window);
            foreach (DshWebViewHost pane in hosts)
            {
                try { pane.Dispose(); } catch { }
            }
            return 0;
        }

        /// <summary>Test hook: closes the window after N seconds (geometry check).</summary>
        private static void ScheduleAutoClose(Window window, int seconds)
        {
            if (seconds <= 0) return;
            var timer = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(seconds)
            };
            timer.Tick += (s, e) =>
            {
                timer.Stop();
                Logger.Info("auto-close after " + seconds + "s (test hook)");
                window.Close();
            };
            timer.Start();
        }

        private static ImageSource LoadWindowIcon(string iconFile)
        {
            if (string.IsNullOrEmpty(iconFile) || !File.Exists(iconFile)) return null;
            using (var stream = File.OpenRead(iconFile))
            {
                var decoder = new System.Windows.Media.Imaging.IconBitmapDecoder(
                    stream,
                    System.Windows.Media.Imaging.BitmapCreateOptions.PreservePixelFormat,
                    System.Windows.Media.Imaging.BitmapCacheOption.OnLoad);
                if (decoder.Frames.Count == 0) return null;
                ImageSource best = null;
                foreach (var frame in decoder.Frames)
                {
                    if (best == null || frame.PixelWidth > ((System.Windows.Media.Imaging.BitmapFrame)best).PixelWidth)
                    {
                        best = frame;
                    }
                }
                return best;
            }
        }
    }

    // ------------------------------------------------------- WebView2 host pane

    /// <summary>
    /// Hosts the CoreWebView2 controller inside the WPF window.
    /// HwndHost gives the WebView2 controller a real child HWND to live in, and
    /// forwards WM_SIZE/WM_DPICHANGED so the web content follows the window.
    /// </summary>
    internal sealed class DshWebViewHost : HwndHost
    {
        // Not readonly: the token watch reloads the window onto a fresh sign-in
        // URL when the server is restarted underneath it.
        private string _url;
        private readonly Options _opts;
        private readonly Action<string> _onHarnessOutput;
        private readonly int _paneIndex;
        // A `--pane-url` overriddal nyitott panel NEM a Harness klienst tolti
        // (pl. a robot panel a 4180-at), ezert nala NINCS token-figyelo es nincs
        // 401-kezeles. Enelkul a friss token megjelenesekor ez a panel is a
        // Harness URL-jere navigalt — mert hiba: a robot helyere duplikalt DSH
        // panel kerult, es az ablak "kéretlenul" ujratoltott minden panelt.
        private readonly bool _isHarnessPane;
        private CoreWebView2Controller _controller;
        private IntPtr _child;
        private bool _disposed;
        private bool _authRetried;
        private bool _restarting;
        private System.Windows.Threading.DispatcherTimer _tokenWatch;
        private DateTime _tokenWatchSince;

        /// <summary>The child HWND WebView2 renders into (focus target).</summary>
        internal IntPtr ChildHandle { get { return _child; } }

        /// <summary>The pane's root window in its own OS window tree.</summary>
        internal IntPtr RootHandle
        {
            get { return _child == IntPtr.Zero ? IntPtr.Zero : Win32.GetAncestor(_child, Win32.GA_ROOT); }
        }

        /// <summary>The pane's WebView2 core, or null before it is ready.</summary>
        internal CoreWebView2 Core
        {
            get { return _controller == null ? null : _controller.CoreWebView2; }
        }

        /// <summary>The pane's controller, or null before it is ready.</summary>
        internal CoreWebView2Controller Controller { get { return _controller; } }

        /// <summary>Zero-based pane position; it selects this pane's profile folder.</summary>
        public int PaneIndex { get { return _paneIndex; } }

        public DshWebViewHost(string url, Options opts, Action<string> onHarnessOutput, int paneIndex, bool isHarnessPane)
        {
            _url = url;
            _opts = opts;
            _onHarnessOutput = onHarnessOutput;
            _paneIndex = paneIndex;
            _isHarnessPane = isHarnessPane;
        }

        protected override HandleRef BuildWindowCore(HandleRef hwndParent)
        {
            // A plain child window; WebView2 renders into it.
            _child = Win32.CreateWindowEx(
                0, "static", string.Empty,
                Win32.WS_CHILD | Win32.WS_VISIBLE | Win32.WS_CLIPCHILDREN,
                0, 0, 1, 1,
                hwndParent.Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);

            if (_child == IntPtr.Zero)
            {
                Logger.Error("BuildWindowCore failed: " + Marshal.GetLastWin32Error());
                return new HandleRef(this, IntPtr.Zero);
            }

            // Follow the parent window's resizes.
            var source = HwndSource.FromHwnd(hwndParent.Handle);
            if (source != null) source.AddHook(ParentWndProc);

            var dispatcher = System.Windows.Threading.Dispatcher.CurrentDispatcher;
            dispatcher.BeginInvoke(new Action(async () => await InitializeAsync()));
            return new HandleRef(this, _child);
        }

        private IntPtr ParentWndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == Win32.WM_SIZE || msg == Win32.WM_DPICHANGED)
            {
                Resize();
            }

            if (Probe.Enabled && msg != Win32.WM_SIZE && msg != Win32.WM_DPICHANGED)
            {
                Probe.Note("pane " + (_paneIndex + 1) + " host-proc " + Probe.MsgName(msg), _child);
            }
            return IntPtr.Zero;
        }

        protected override void OnWindowPositionChanged(Rect rcBoundingBox)
        {
            // HwndHost moves the hosted child window itself; the controller's
            // bounds then have to follow it. Without this a dragged pane divider
            // (or a DPI change) would leave the WebView painting its old size.
            base.OnWindowPositionChanged(rcBoundingBox);
            Resize();
            try
            {
                Dispatcher.BeginInvoke(
                    new Action(Resize), System.Windows.Threading.DispatcherPriority.Loaded);
            }
            catch (Exception ex)
            {
                Logger.Info("pane resize deferral: " + ex.Message);
            }
        }

        protected override void DestroyWindowCore(HandleRef hwnd)
        {
            Dispose();
            if (hwnd.Handle != IntPtr.Zero)
            {
                Win32.DestroyWindow(hwnd.Handle);
            }
        }

        /// <summary>
        /// Panes initialize one after another. Creating WebView2 environments and
        /// controllers concurrently is not safe — the runtime answers the second
        /// attempt with a generic E_UNEXPECTED / E_ABORT — so every pane takes
        /// this gate, initializes, and releases it.
        /// </summary>
        private static readonly SemaphoreSlim WebViewGate = new SemaphoreSlim(1, 1);

        private async System.Threading.Tasks.Task InitializeAsync()
        {
            bool gateHeld = await WebViewGate.WaitAsync(TimeSpan.FromSeconds(20)).ConfigureAwait(true);
            if (!gateHeld)
            {
                // A stuck pane must not starve the ones behind it.
                Logger.Error("webview2 init (pane " + (_paneIndex + 1)
                    + "): another pane is still initializing after 20s; continuing without the gate");
            }
            try
            {
                Logger.Info("webview2 init start (pane " + (_paneIndex + 1) + ")");
                var options = new CoreWebView2EnvironmentOptions();
                if (_opts.BrowserArgs != null)
                {
                    options.AdditionalBrowserArguments = _opts.BrowserArgs;
                }

                CoreWebView2Environment environment = null;
                Exception lastError = null;

                // A locked profile (0x800700AA) happens when a previous window
                // was killed instead of closed and its browser processes are
                // still shutting down. WebView2 cannot take the profile over, so
                // retry on a fresh sibling directory instead of failing; the
                // last attempt moves under %TEMP%, which stays writable even in
                // locked-down environments.
                for (int attempt = 0; attempt < 3 && environment == null; attempt++)
                {
                    string userDataFolder = ResolveUserDataFolder(attempt);
                    try
                    {
                        Directory.CreateDirectory(userDataFolder);
                        Logger.Info("webview2 user data (pane " + (_paneIndex + 1) + "): "
                            + userDataFolder + " (attempt " + (attempt + 1) + ")");
                        environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, options);
                    }
                    catch (Exception ex)
                    {
                        lastError = ex;
                        Logger.Error("webview2 environment attempt " + (attempt + 1) + " failed: " + ex.Message);
                        if (attempt < 2) await System.Threading.Tasks.Task.Delay(1500);
                    }
                }

                if (environment == null)
                {
                    throw lastError ?? new InvalidOperationException("a WebView2 környezet nem jött létre");
                }

                Logger.Info("webview2 environment ready: " + environment.BrowserVersionString);

                _controller = await environment.CreateCoreWebView2ControllerAsync(_child);
                Logger.Info("webview2 controller ready (pane " + (_paneIndex + 1) + ")");

                var core = _controller.CoreWebView2;
                Configure(core);
                FocusKeeper.Attach(this, core);

                // A vezérlő saját fókusz-eseményei: a WebView2 hivatalos jelzése
                // arról, hogy ez a panel vette át a billentyűzet-fókuszt.
                try
                {
                    _controller.GotFocus += (s, e) =>
                    {
                        // A WebView2 saját jelzése: ez a panel vette át a
                        // fókuszt. Ebből tartunk nyilván EGY aktív panelt, és a
                        // visszatéréskor ide adjuk vissza — nincs kérdezősködés,
                        // nincs koordináta-számítás, nincs versenyhelyzet.
                        FocusKeeper.NoteActive(this);
                        Logger.Info("controller focus: pane " + (_paneIndex + 1) + " got focus");
                    };
                    _controller.LostFocus += (s, e) =>
                    {
                        FocusKeeper.NoteLost(this);
                        Logger.Info("controller focus: pane " + (_paneIndex + 1) + " lost focus");
                    };
                    _controller.MoveFocusRequested += (s, e) =>
                    {
                        Logger.Info("controller focus: pane " + (_paneIndex + 1)
                            + " requests move (" + e.Reason + ")");
                    };
                }
                catch (Exception ex)
                {
                    Logger.Info("controller focus events not attached: " + ex.Message);
                }

                _controller.BoundsMode = CoreWebView2BoundsMode.UseRawPixels;

                // The surface WebView2 paints before (and outside) the page
                // canvas must be dark: at some zoom levels and window heights a
                // sliver between the page and the controller edge stayed
                // unpainted and showed up as a light strip at the bottom.
                try
                {
                    _controller.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0xFF, 0x15, 0x15, 0x17);
                }
                catch (Exception ex)
                {
                    Logger.Info("DefaultBackgroundColor not applied: " + ex.Message);
                }

                Resize();

                core.Navigate(_url);
                Logger.Info("navigating to " + _url + " (pane " + (_paneIndex + 1) + ")");
                // A token-figyelo CSAK a Harness klienst toltő paneleken fut: egy
                // `--pane-url` overriddal nyitott panel (robot panel) soha nem
                // navigálhat a Harness token-URL-jére.
                if (_isHarnessPane) StartTokenWatch(core);
            }
            catch (Exception ex)
            {
                Logger.Error("webview2 init failed (pane " + (_paneIndex + 1) + "): " + ex);
                ShowErrorPage("A beépített WebView2 ablak nem tudott elindulni: " + ex.Message);
            }
            finally
            {
                if (gateHeld) WebViewGate.Release();
            }
        }

        /// <summary>
        /// Picks the profile directory for this pane: the configured generation
        /// folder first, a timestamped sibling next, and finally a folder under
        /// %TEMP% for environments where the project folder is not writable.
        ///
        /// Every pane owns a stable subfolder (pane-1, pane-2, ...) instead of a
        /// throw-away per-launch folder. That is what makes a split window
        /// useful: the WebView2 profile carries the client's own storage, so a
        /// pane keeps its workspace, its selected session and its drafts when
        /// the window is closed and opened again.
        /// </summary>
        private string ResolveUserDataFolder(int attempt)
        {
            string baseDir = _opts.UserDataDir;
            if (string.IsNullOrEmpty(baseDir)) baseDir = DshPaths.ResolveUserDataDir();

            if (attempt >= 2)
            {
                baseDir = Path.Combine(Path.GetTempPath(), "DSH Harness", "WebView2");
            }

            string folder = baseDir;
            if (!string.IsNullOrEmpty(_opts.ProfileGeneration))
            {
                folder = Path.Combine(folder, _opts.ProfileGeneration);
            }

            folder = Path.Combine(folder, "pane-" + (_paneIndex + 1).ToString(CultureInfo.InvariantCulture));

            // A profile another (killed) window still holds open cannot be taken
            // over; a timestamped sibling starts anyway and the locked folder is
            // reused by the next launch once its owner is gone.
            if (attempt == 1)
            {
                folder += "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
            }
            return folder;
        }

        private void Configure(CoreWebView2 core)
        {
            try
            {
                var settings = core.Settings;
                settings.AreDefaultContextMenusEnabled = true;
                settings.IsStatusBarEnabled = false;
                settings.IsZoomControlEnabled = true;
                settings.AreDevToolsEnabled = true;
                settings.IsPasswordAutosaveEnabled = false;
                settings.IsGeneralAutofillEnabled = false;
            }
            catch (Exception ex)
            {
                Logger.Info("settings: " + ex.Message);
            }

            // The window is dark by construction; tell the page so any
            // prefers-color-scheme styling agrees with the chrome.
            //
            // CSAK a Harness paneleken: a 4. felület (robot panel) a SAJÁT témáját
            // hozza a szerveréről, és a világos módja világos `color-scheme`-et
            // kér. A kényszerített sötét itt fekete hátteret és vastag fekete
            // görgetősávot rajzolt a világos panel alá (mért hiba, 2026-10-02).
            if (_isHarnessPane)
            {
                try
                {
                    core.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Dark;
                }
                catch (Exception ex)
                {
                    Logger.Info("PreferredColorScheme unavailable: " + ex.Message);
                }
            }

            core.NavigationCompleted += (s, e) =>
            {
                if (e.IsSuccess)
                {
                    Logger.Info("navigation completed: " + _url + " (http " + e.HttpStatusCode + ")");
                    if (_isHarnessPane) ApplyThemeHint(core);
                }
                else if (e.HttpStatusCode == 401 && _isHarnessPane && !_authRetried && !_restarting)
                {
                    // dsh only serves the UI to a request carrying its session
                    // cookie, and that cookie is minted by the token URL dsh
                    // prints when it starts. If that URL is not known here (the
                    // server was already running when the window opened), the
                    // only self-healing move is to restart the server so the
                    // token can be captured.
                    _authRetried = true;
                    string announced = Program.AnnouncedUrl;
                    if (!string.IsNullOrEmpty(announced))
                    {
                        Logger.Info("401 without session cookie; retrying with the authenticated url");
                        try { core.Navigate(announced); return; }
                        catch (Exception ex) { Logger.Error("auth retry failed: " + ex.Message); }
                    }
                    else if (_opts.RestartIfStale && !_opts.NoBoot)
                    {
                        Logger.Info("401 and no token: restarting the harness to obtain one");
                        RestartHarnessThenNavigate(core);
                        return;
                    }

                    Logger.Error("navigation failed: authentication required (http 401) " + _url);
                    ShowErrorPage("A háttér-GUI belépési tokent vár, ami csak a harness indításakor " +
                        "keletkezik. A tálcáról indítva ezt automatikusan megkapja az ablak; ha ide jutottál, " +
                        "válaszd a tálcaikonon az \"Újraindítás\" pontot, és nyisd meg újra az ablakot.");
                }
                else
                {
                    Logger.Error("navigation failed: status=" + e.WebErrorStatus + " http=" + e.HttpStatusCode + " " + _url);
                    string detail = e.HttpStatusCode > 0
                        ? "A háttér-GUI HTTP " + e.HttpStatusCode + " választ adott."
                        : "A háttér-GUI nem válaszolt: " + e.WebErrorStatus;
                    ShowErrorPage(detail);
                }
            };

            core.ProcessFailed += (s, e) =>
            {
                Logger.Error("webview2 process failed: kind=" + e.ProcessFailedKind
                    + " reason=" + e.Reason + " exitCode=" + e.ExitCode);
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                {
                    ShowErrorPage("A WebView2 böngészőfolyamat leállt (" + e.Reason + ").");
                }
            };

            // Guarantee the dark theme even if the stored UI preference is
            // missing: the frontend keys off body[data-ds-dark-theme].
            //
            // CSAK a Harness paneleken! A robot panel (4. felület) a saját
            // témáját a saját szerveréről kapja; ide injektálva a `!important`
            // sötét háttér a világos mód alatt maradt (mért hiba, 2026-10-02:
            // fekete háttér és vastag fekete keretek a világos panelen).
            if (_isHarnessPane)
            {
                try
                {
                    core.AddScriptToExecuteOnDocumentCreatedAsync(ThemeScript);
                }
                catch (Exception ex)
                {
                    Logger.Info("theme script: " + ex.Message);
                }
            }
        }

        /// <summary>
        /// Watch for a new sign-in token and reload onto it.
        ///
        /// This window stays open for days, while the Harness server is
        /// restarted from time to time (the restart/deploy buttons, the tray
        /// auto-heal, a crash). A restarted server mints a NEW token, so the page
        /// already on screen holds a dead one: its socket never reconnects and it
        /// sits on "Reconnecting" forever, because the page cannot learn the new
        /// token by itself.
        ///
        /// The window can, and it must do so WITHOUT depending on whoever ran the
        /// restart: a restart performed from a terminal or an agent session can be
        /// interrupted halfway, and a window that waits for that helper's file
        /// never recovers. It therefore reads two independent sources and takes
        /// the newest — the saved URL, and the server's own log line, which the
        /// server writes itself.
        /// </summary>
        private void StartTokenWatch(CoreWebView2 core)
        {
            try
            {
                _tokenWatchSince = DateTime.Now;
                _tokenWatch = new System.Windows.Threading.DispatcherTimer
                {
                    Interval = TimeSpan.FromSeconds(4)
                };
                _tokenWatch.Tick += (s, e) =>
                {
                    try
                    {
                        string candidate = NewestTokenUrl();
                        if (candidate.Length == 0) return;
                        if (string.Equals(TokenOf(candidate), TokenOf(_url), StringComparison.Ordinal)) return;

                        Logger.Info("a fresh sign-in token appeared; reloading the window onto it");
                        _authRetried = false;
                        _url = candidate;
                        core.Navigate(candidate);
                    }
                    catch (Exception ex)
                    {
                        Logger.Info("token watch: " + ex.Message);
                    }
                };
                _tokenWatch.Start();
                Logger.Info("token watch started (4s)");
            }
            catch (Exception ex)
            {
                Logger.Info("token watch not started: " + ex.Message);
            }
        }

        /// <summary>
        /// The freshest sign-in URL this window can find, or an empty string.
        ///
        /// A source older than this window is ignored: it belongs to a previous
        /// server, and reloading onto it would jump backwards rather than forwards.
        /// </summary>
        private string NewestTokenUrl()
        {
            string best = string.Empty;
            DateTime bestStamp = DateTime.MinValue;

            CollectTokenCandidate(Path.Combine(DshPaths.ResolveStateDir(), "harness.url"), ref best, ref bestStamp);

            string home = Environment.GetEnvironmentVariable("DSH_HOME");
            if (string.IsNullOrEmpty(home))
            {
                home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
            }
            CollectTokenCandidate(Path.Combine(home, "dsh-web", "harness.log"), ref best, ref bestStamp);
            return best;
        }

        /// <summary>Take one source's last token URL when it is newer than the current best.</summary>
        private void CollectTokenCandidate(string path, ref string best, ref DateTime bestStamp)
        {
            try
            {
                if (!File.Exists(path)) return;
                DateTime stamp = File.GetLastWriteTime(path);
                if (stamp < _tokenWatchSince || stamp <= bestStamp) return;

                if (path.EndsWith("harness.url", StringComparison.OrdinalIgnoreCase))
                {
                    string value = File.ReadAllText(path).Trim();
                    if (value.StartsWith("http://127.0.0.1:", StringComparison.Ordinal))
                    {
                        best = value;
                        bestStamp = stamp;
                    }
                    return;
                }

                // A log holds many lines; the LAST match is the newest server.
                string[] lines = File.ReadAllLines(path);
                for (int i = lines.Length - 1; i >= 0; i--)
                {
                    int at = lines[i].IndexOf("http://127.0.0.1:", StringComparison.Ordinal);
                    if (at < 0) continue;
                    int end = lines[i].IndexOf(' ', at);
                    string url = end < 0 ? lines[i].Substring(at) : lines[i].Substring(at, end - at);
                    if (url.IndexOf("token=", StringComparison.Ordinal) < 0) continue;
                    best = url.Trim();
                    bestStamp = stamp;
                    return;
                }
            }
            catch (Exception ex)
            {
                Logger.Info("token source " + Path.GetFileName(path) + ": " + ex.Message);
            }
        }

        /// <summary>The `token` query parameter of a URL, or the URL when absent.</summary>
        private static string TokenOf(string url)
        {
            if (string.IsNullOrEmpty(url)) return string.Empty;
            const string marker = "token=";
            int at = url.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (at < 0) return url;
            int start = at + marker.Length;
            int end = url.IndexOf('&', start);
            if (end < 0) end = url.Length;
            return url.Substring(start, end - start);
        }

        /// <summary>
        /// Pre-paint hint for a Harness pane: dark background and a dark
        /// `color-scheme` until the app's own theme loads.
        ///
        /// MIÉRT NINCS `!important` ÉS MIÉRT TŰNIK EL: a stílus az `&lt;html&gt;`
        /// végére kerül, ezért minden fejlécbeli szabálynál KÉSŐBB van — a DSH
        /// világos témáját felülírná. 3 másodperc után eltávolítjuk, így csak a
        /// betöltés előtti villanást fogja meg, a végleges témát nem bántja.
        /// </summary>
        private const string ThemeScript =
            "(function(){try{" +
            "if(document.body&&!document.body.hasAttribute('data-ds-dark-theme'))" +
            "document.body.setAttribute('data-ds-dark-theme','');" +
            "if(document.getElementById('dsh-theme-hint'))return;" +
            "var s=document.createElement('style');s.id='dsh-theme-hint';" +
            "s.textContent='html,body{background:#151517;color-scheme:dark}';" +
            "document.documentElement.appendChild(s);" +
            "setTimeout(function(){var n=document.getElementById('dsh-theme-hint');" +
            "if(n&&n.parentNode)n.parentNode.removeChild(n);},3000);" +
            "}catch(e){}})();";

        private static void ApplyThemeHint(CoreWebView2 core)
        {
            try { core.ExecuteScriptAsync(ThemeScript); } catch { }
        }

        private void Resize()
        {
            if (_controller == null || _child == IntPtr.Zero) return;
            try
            {
                Win32.RECT rect;
                if (!Win32.GetClientRect(_child, out rect)) return;
                int width = rect.Right - rect.Left;
                int height = rect.Bottom - rect.Top;
                if (width <= 0 || height <= 0) return;

                // One pixel of overlap on the right and bottom edges: at
                // fractional DPI scaling / zoom levels the controller rectangle
                // otherwise leaves a hairline of unpainted (light) surface that
                // shows up as a strip along the bottom.
                const int overlap = 1;
                _controller.Bounds = new System.Drawing.Rectangle(0, 0, width + overlap, height + overlap);
            }
            catch (Exception ex)
            {
                Logger.Info("resize: " + ex.Message);
            }
        }

        /// <summary>
        /// Last-resort recovery for a 401 with no known token: kill whatever
        /// listens on the port, boot a fresh harness (which prints a new token)
        /// and navigate to that URL.
        /// </summary>
        private async void RestartHarnessThenNavigate(CoreWebView2 core)
        {
            _restarting = true;
            try
            {
                int killed = HarnessBoot.StopListeningProcess(_opts.Port);
                Logger.Info("stale harness stopped (pid " + killed + "), starting a fresh one");
                if (killed > 0)
                {
                    await System.Threading.Tasks.Task.Delay(1200);
                }

                HarnessBoot.Start(_opts, _onHarnessOutput);
                bool listening = await System.Threading.Tasks.Task.Run(
                    () => PortProbe.WaitForListening(_opts.Port, TimeSpan.FromSeconds(_opts.BootTimeoutSeconds)));
                if (!listening)
                {
                    Logger.Error("restarted harness did not come up");
                    ShowErrorPage("A harness újraindítása nem sikerült. Nézd meg a naplót a tálcáról.");
                    return;
                }

                DateTime deadline = DateTime.UtcNow.AddSeconds(15);
                while (Program.AnnouncedUrl == null && DateTime.UtcNow < deadline)
                {
                    await System.Threading.Tasks.Task.Delay(150);
                }

                string announced = Program.AnnouncedUrl;
                if (string.IsNullOrEmpty(announced))
                {
                    Logger.Error("restarted harness announced no token url");
                    ShowErrorPage("A harness elindult, de nem sikerült kiolvasni a belépési tokent. " +
                        "Próbáld újra a tálcaikonról.");
                    return;
                }

                Logger.Info("navigating with the fresh token url");
                core.Navigate(announced);
            }
            catch (Exception ex)
            {
                Logger.Error("restart recovery failed: " + ex);
                ShowErrorPage("A belépési token frissítése nem sikerült: " + ex.Message);
            }
        }

        private void ShowErrorPage(string message)
        {
            try
            {
                if (_controller != null)
                {
                    _controller.CoreWebView2.NavigateToString(
                        ErrorPage.Build(_url, message, Logger.Path));
                }
            }
            catch (Exception ex)
            {
                Logger.Error("error page failed: " + ex.Message);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (_disposed) return;
            _disposed = true;
            try { if (_tokenWatch != null) _tokenWatch.Stop(); } catch { }
            try { if (_controller != null) _controller.Close(); } catch { }
            try { if (_controller != null) Marshal.ReleaseComObject(_controller); } catch { }
            base.Dispose(disposing);
        }
    }

    // ----------------------------------------------------------- focus keeper

    /// <summary>
    /// Keeps the text cursor in the field the user was typing in.
    ///
    /// MIÉRT KELL: a beépített WebView2 ablak elveszti a lap szintű fókuszt, ha
    /// a felhasználó átvált egy másik programra, majd visszatér. A panel
    /// HwndHost-gyermekablaka a visszaaktiváláskor már fókuszt kap, ezért a
    /// natív `SetFocus` önmagában NEM hozza vissza a kurzort: a böngésző a
    /// DOM-szintű fókuszt nem állítja vissza, és a chat beviteli mezőjébe újra
    /// bele kell kattintani. A javítás a lapon jegyzi meg az utolsó
    /// szövegbeviteli elemet, és amikor az ablak visszakapja a fókuszt
    /// (miközben semmi mást nem jelölt ki a felhasználó), visszaadja neki a
    /// fókuszt — pontosan úgy, mintha odakattintott volna.
    ///
    /// WHY: switching to another Windows task and back lost the caret in the
    /// chat input; the pane's child HWND regains focus but the page-level focus
    /// is not restored, so the user had to click the field again. This layer
    /// remembers the last text-editable element per pane and restores it when
    /// the window regains activation.
    /// </summary>
    internal static class FocusKeeper
    {
        private static readonly List<DshWebViewHost> Panes = new List<DshWebViewHost>();
        private static readonly object Sync = new object();
        private static DshWebViewHost _lastPane;

        /// <summary>
        /// A fókusz elvesztésének pillanatában fókuszban lévő panel. Ezt kell
        /// visszakapnia a fókusznak — NEM a lap oldaláról jelentett „aktív"
        /// panelt, mert az megbízhatatlan (mért hiba: a robot panel és a
        /// munka-panelek is jelentkeztek, és a visszatérés mindig az 1. panelre
        /// ment).
        /// </summary>
        private static DshWebViewHost _pendingPane;

        /// <summary>Az aktiválási zaj ablaka: eddig nem írja felül a fókusz-jelzés a célt.</summary>
        private static DateTime _freezeAt = DateTime.MinValue;

        /// <summary>A fókuszvesztés pillanatában rögzített célpanel.</summary>
        private static DshWebViewHost _frozenPane;

        /// <summary>Az utolsó „nálad van-e a fókusz?" kérdésre válaszoló panel.</summary>
        private static DshWebViewHost _queryPane;

        /// <summary>Turns the restore layer off (--no-focus-restore).</summary>
        public static bool Enabled = true;

        /// <summary>Set once the command line has been read.</summary>
        public static void Disable() { Enabled = false; }

        /// <summary>
        /// A lap figyelője: megjegyzi az utolsó szövegbeviteli elemet, és
        /// jelenti a lap fókusz-eseményeit. Beavatkozás NINCS benne — a fókusz
        /// visszaadása a natív oldal dolga, mert az a megbízható forrás.
        ///
        /// MIÉRT NINCS BENNE blur/focus ciklus: a korábbi változat másodpercenként
        /// ismételte, és elrejtette a karétát meg az egérkurzort a felület fölött
        /// (mért hiba, 2026-10-04).
        /// </summary>
        public const string Script =
            "(function(){try{" +
            "if(window.__dshFocusKeeper)return;window.__dshFocusKeeper=1;" +
            "var last=null;" +
            "function ident(el){try{return {tag:el.tagName,ce:el.contentEditable,id:el.id||''," +
            "cls:(el.className&&el.className.toString?el.className.toString():'').slice(0,80)," +
            "ph:(el.getAttribute&&el.getAttribute('placeholder'))||''};}catch(e){return null;}}" +
            "function send(o){try{if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(JSON.stringify(o));}catch(e){}}" +
            "function editable(el){try{if(!el||el.nodeType!==1)return false;" +
            "var t=el.tagName;if(t==='TEXTAREA')return true;if(t==='INPUT'){" +
            "var ty=(el.type||'text').toLowerCase();" +
            "return ty!=='checkbox'&&ty!=='radio'&&ty!=='button'&&ty!=='submit'&&ty!=='file'&&ty!=='range';}" +
            "return el.isContentEditable===true;}catch(e){return false;}}" +
            "function hasCaret(el){try{return !!(el&&document.contains(el)&&document.activeElement===el);}catch(e){return false;}}" +
            "function docOn(){try{return !!document.hasFocus();}catch(e){return false;}}" +
            "document.addEventListener('focusin',function(e){try{" +
            "if(editable(e.target)&&e.target!==last){last=e.target;window.__dshFocusKeeperLast=last;send({k:'remember',el:ident(last)});}" +
            "}catch(x){}},true);" +
            "window.addEventListener('focus',function(){try{" +
            "send({k:'win-focus',doc:docOn(),caret:hasCaret(last),el:last?ident(last):null});" +
            "}catch(x){}});" +
            "window.addEventListener('blur',function(){try{send({k:'win-blur'});}catch(x){}});" +
            // A mező pozíciója a lapon (CSS-pixelben): a natív oldal ebből
            // számolja ki, hova küldje a szintetikus kattintást.
            "window.__dshFocusKeeperRect=function(){try{" +
            "function ok(e){return !!(e&&e.nodeType===1&&document.contains(e)&&e.getBoundingClientRect);}" +
            "function area(e){var r=e.getBoundingClientRect();return r.width*r.height;}" +
            "var el=window.__dshFocusKeeperLast;" +
            // Ha nincs megjegyzett mező (friss betöltésnél nem volt focusin
            // esemény), az éppen fókuszált elemet használjuk.
            "if(!ok(el))el=document.activeElement;" +
            "if(!ok(el)||el===document.body||el===document.documentElement){" +
            // Végső eset: a legnagyobb területű szerkeszthető mező.
            "el=null;var cands=document.querySelectorAll('textarea,[contenteditable=\"true\"],input[type=\"text\"]');" +
            "var best=0;for(var i=0;i<cands.length;i++){var a=area(cands[i]);" +
            "if(ok(cands[i])&&a>best){best=a;el=cands[i];}}}" +
            "if(!ok(el))return '{\"w\":0,\"why\":\"nincs mezo\"}';" +
            "var r=el.getBoundingClientRect();" +
            "return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height,dpr:window.devicePixelRatio||1});" +
            "}catch(e){return '{\"w\":0,\"why\":\"hiba\"}';}};" +
            "send({k:'ready'});" +
            "}catch(e){}})();";

        /// <summary>Az aktiváláskor futtatott, ártalmatlan jelzés a lapnak.</summary>
        public const string ApproachScript =
            "(function(){try{window.__dshFocusKeeperPing=(window.__dshFocusKeeperPing||0)+1;}catch(e){}})();";

        /// <summary>Lekérdezi a lapról az utolsó beviteli mező pozícióját (JSON).</summary>
        public const string MeasureScript =
            "(function(){try{return (typeof window.__dshFocusKeeperRect==='function')?window.__dshFocusKeeperRect():'{\"w\":0}';}catch(e){return '{\"w\":0}';}})();";

        /// <summary>
        /// A kattintás utáni helyreállítás a lapon: a karéta a mező végére
        /// kerül, és a kijelölést megszüntetjük.
        ///
        /// MIÉRT KELL: a szintetikus kattintás néhány mezőben (pl. a robot panel
        /// `input id="msg"` mezőjében) KIJELÖLI a meglévő szöveget, amitől a
        /// következő gépelés felülírná azt. Ugyanazt tesszük, amit egy
        /// sor-végi kattintás tenne.
        /// </summary>
        public const string CollapseCaretScript =
            "(function(){try{" +
            "var el=window.__dshFocusKeeperLast;" +
            "function ok(e){return !!(e&&e.nodeType===1&&document.contains(e)&&e.getBoundingClientRect);}" +
            "if(!ok(el))el=document.activeElement;" +
            "if(!ok(el)||el===document.body)return 'none';" +
            "try{el.focus();}catch(e){}" +
            "try{if(el.tagName==='TEXTAREA'||el.tagName==='INPUT'){" +
            "var n=(el.value||'').length;el.setSelectionRange(n,n);}" +
            "else{var w=window.getSelection();if(w){w.removeAllRanges();" +
            "var r=document.createRange();r.selectNodeContents(el);r.collapse(false);w.addRange(r);}}" +
            "}catch(e){}" +
            "return 'collapsed';" +
            "}catch(e){return 'error';}})();";

        /// <summary>
        /// Célzott újrarajzolás a fókusz visszaadása UTÁN.
        ///
        /// MIÉRT KELL: a napló szerint a mező fókuszban van (`caret:true`), a
        /// karéta mégsem látszik — a beágyazott WebView2 renderelője a
        /// visszaaktiválás után nem rajzolja újra a karétát. Ezért a lapon a
        /// meglévő fókuszt MEGTARTVA „megmozdítjuk" a DOM-ot (kijelölés
        /// visszaírása + kényszerű újratördelés + egy ismételt fókusz-esemény),
        /// ami újrarajzolásra készteti a szerkesztőt. Egyszeri és idempotens:
        /// nem blur-el és nem ciklusol, ezért nem tudja elrejteni a karétát
        /// vagy az egérkurzort (azt a korábbi, ismétlődő blur/focus tette).
        /// </summary>
        public const string ResyncScript =
            "(function(){try{" +
            "if(!window.__dshFocusKeeperLast)return;" +
            "var el=window.__dshFocusKeeperLast;" +
            "if(!document.contains(el)||document.activeElement!==el)return;" +
            "var n=0,before=null;" +
            "try{if(el.tagName==='TEXTAREA'||el.tagName==='INPUT'){n=(el.value||'').length;}" +
            "else{var w=window.getSelection();if(w&&w.rangeCount>0)before=w.getRangeAt(0).cloneRange();}}" +
            "catch(e){}" +
            "try{el.focus();}catch(e){}" +
            "try{var disp=el.style.display;el.style.display='none';" +
            "void el.offsetHeight;el.style.display=disp;}catch(e){}" +
            "try{if(el.tagName==='TEXTAREA'||el.tagName==='INPUT'){el.setSelectionRange(n,n);}" +
            "else{var w2=window.getSelection();if(w2){w2.removeAllRanges();" +
            "if(before){w2.addRange(before);}else{" +
            "var r=document.createRange();r.selectNodeContents(el);r.collapse(false);w2.addRange(r);}}}}catch(e){}" +
            "try{el.dispatchEvent(new FocusEvent('focus'));}catch(e){}" +
            "}catch(e){}})();";

        public static void RegisterPane(int index, DshWebViewHost host)
        {
            lock (Sync)
            {
                while (Panes.Count <= index) Panes.Add(null);
                Panes[index] = host;
            }
        }

        public static void Attach(DshWebViewHost host, CoreWebView2 core)
        {
            RegisterPane(host.PaneIndex, host);
            if (!Enabled) return;
            try
            {
                core.WebMessageReceived += (s, e) =>
                {
                    string json = null;
                    try { json = e.TryGetWebMessageAsString(); }
                    catch { }
                    if (string.IsNullOrEmpty(json)) return;
                    Logger.Info("focus keeper (pane " + (host.PaneIndex + 1) + "): " + json);
                    if (Probe.Enabled) Probe.Note("focus keeper " + json, host.ChildHandle);
                };
                core.AddScriptToExecuteOnDocumentCreatedAsync(Script);
                Logger.Info("focus keeper installed (pane " + (host.PaneIndex + 1) + ")");
            }
            catch (Exception ex)
            {
                Logger.Info("focus keeper not installed (pane " + (host.PaneIndex + 1) + "): " + ex.Message);
            }
        }

        /// <summary>The pane whose child window last received focus.</summary>
        public static void NotePane(DshWebViewHost host)
        {
            lock (Sync) { _lastPane = host; }
        }

        /// <summary>
        /// A WebView2 jelezte, hogy ez a panel vette át a fókuszt: ez a
        /// visszatérés célja. Ez a jelzés a napló szerint minden panelváltásnál
        /// megjön, ezért nem kell semmit kérdezni vagy számítani.
        /// </summary>
        public static void NoteActive(DshWebViewHost host)
        {
            if (!Enabled || host == null) return;
            bool changed = false;
            lock (Sync)
            {
                // A CÉL SOHA NEM LEHET ÜRES: az első jelzés beállítja, különben a
                // helyreállításnak nincs hova mennie (mért hiba: `target=-` maradt,
                // és a visszatéréskor semmi nem történt).
                if ((object)_pendingPane == null)
                {
                    _pendingPane = host;
                    changed = true;
                }
                else if (NoiseFromActivation())
                {
                    // A WPF az aktiválás után az ELSŐ panelre teszi a fókuszt; az
                    // abból származó jelzés nem a felhasználó választása, ezért
                    // rövid ideig nem írja felül a célt.
                }
                else if (!ReferenceEquals(_pendingPane, host))
                {
                    _pendingPane = host;
                    changed = true;
                }
            }
            if (changed)
            {
                Logger.Info("focus target: pane " + (host.PaneIndex + 1));
            }
        }

        /// <summary>
        /// Igaz, ha az aktiválás utáni rövid ablakban vagyunk: ilyenkor a
        /// fókusz-jelzések a WPF saját fókusz-áthelyezéséből származnak, nem a
        /// felhasználó választásából.
        /// </summary>
        private static bool NoiseFromActivation()
        {
            return _freezeAt != DateTime.MinValue
                && (DateTime.UtcNow - _freezeAt).TotalMilliseconds < 1500;
        }

        /// <summary>Az ablak deaktiválásakor elindul az aktiválási zaj ablaka.</summary>
        public static void Freeze()
        {
            lock (Sync) { _freezeAt = DateTime.UtcNow; }
        }

        /// <summary>Az ablak aktiválásakor nincs teendő: az időzített zár lejár.</summary>
        public static void Unfreeze()
        {
            lock (Sync) { _freezeAt = DateTime.MinValue; }
        }

        /// <summary>
        /// A panel elvesztette a fókuszt. A meglévő cél MEGMARAD (az ablak
        /// deaktiválásakor is ez a helyes cél); új cél csak `NoteActive`-ból
        /// születik.
        /// </summary>
        public static void NoteLost(DshWebViewHost host)
        {
            // Szándékosan nem írunk semmit: a fókusz elvesztése nem változtatja
            // meg, hova kell visszatérni.
        }

        public static DshWebViewHost LastPane
        {
            get { lock (Sync) { return _lastPane; } }
        }

        /// <summary>Minden panel, hogy egy másik panelhoz tartozó fókuszt fel lehessen ismerni.</summary>
        public static DshWebViewHost[] AllPanes
        {
            get { lock (Sync) { return Panes.ToArray(); } }
        }

        /// <summary>
        /// A késleltetett helyreállítás: az aktiválás után a WPF/Windows maga is
        /// oszt fókuszt, méghozzá jellemzően az ELSŐ panelra (mért eset:
        /// „focus restore skipped ... native focus is elsewhere" — a fókusz a
        /// 2. panel helyett az 1.-en kötött ki). Ezért itt NEM lépünk vissza
        /// akkor sem, ha a fókusz épp egy MÁSIK panelre került: az aktiválás
        /// utáni helyreállítás a felhasználó legutóbb használt paneljéé.
        /// </summary>
        public static void RestoreTarget(string reason)
        {
            if (!Enabled) return;
            try
            {
                DshWebViewHost root = PendingPane;
                if (root == null) return;
                DshWebViewHost pane = PaneOf(root);
                IntPtr child = pane.ChildHandle;
                if (child == IntPtr.Zero) return;

                Logger.Info("focus restore at " + (pane.PaneIndex + 1) + ". panel (" + reason + ")"
                    + " focused=" + Win32.Describe(Win32.GetFocus())
                    + " target=" + Win32.Describe(child));

                IntPtr previous = Win32.SetFocus(child);
                Logger.Info("focus restore took pane " + (pane.PaneIndex + 1)
                    + " previous=" + Win32.Describe(previous)
                    + " now=" + Win32.Describe(Win32.GetFocus()));

                try
                {
                    CoreWebView2 core = pane.Core;
                    if (core != null) core.ExecuteScriptAsync(ApproachScript);
                }
                catch (Exception ex)
                {
                    Logger.Info("focus restore script: " + ex.Message);
                }
            }
            catch (Exception ex)
            {
                Logger.Info("focus restore (target) failed: " + ex.Message);
            }
        }

        /// <summary>
        /// A megadott panel önmaga.
        ///
        /// MÉRT HIBA VOLT: ez a függvény a `RootHandle`-t hasonlította össze, de
        /// az MINDEN panelnél ugyanaz a főablak (`HwndWrapper[DshWindow.exe…]`),
        /// ezért mindig az első találatot — az 1. panelt — adta vissza. Így a
        /// helyesen rögzített cél (`target=3`) ellenére a fókusz mindig az 1.
        /// panelre ment.
        /// </summary>
        public static DshWebViewHost PaneOf(DshWebViewHost host)
        {
            return host;
        }

        /// <summary>A rögzített célpanel, vagy a régi jelzés, ha nincs rögzített.</summary>
        public static DshWebViewHost PendingPane
        {
            get
            {
                lock (Sync)
                {
                    if ((object)_frozenPane != null) return _frozenPane;
                    return (object)_pendingPane != null ? _pendingPane : _lastPane;
                }
            }
        }

        /// <summary>
        /// A fókusz elvesztésének pillanatában rögzíti a fókuszban lévő panelt.
        /// Ekkor az OS pontosan tudja, melyik gyermekablak van fókuszban — a
        /// panelek ablaka igennel válaszol a kérdésre, és a válaszoló lesz a
        /// visszatérés célja. Ez a pillanat az egyetlen írási pont, ezért az
        /// aktiválás közbeni események nem tudják felülírni (mért hiba volt,
        /// hogy a cél mindig az 1. panelre váltott).
        /// </summary>
        public static void FreezeTarget()
        {
            if (!Enabled) return;
            try
            {
                DshWebViewHost owner = IdentifyFocus();
                if (owner == null) return;
                bool changed;
                lock (Sync)
                {
                    changed = !ReferenceEquals(_frozenPane, owner);
                    _frozenPane = owner;
                }
                if (changed)
                {
                    Logger.Info("focus target frozen: pane " + (owner.PaneIndex + 1));
                }
            }
            catch (Exception ex)
            {
                Logger.Info("focus target freeze failed: " + ex.Message);
            }
        }

        /// <summary>
        /// Megkérdezi az ÖSSZES panel ablakát, hogy melyiküknél van a fókusz.
        /// A válasz a `_queryPane`-be kerül; ha egyik panel sem válaszol, a
        /// korábbi rögzítés marad érvényben.
        /// </summary>
        public static DshWebViewHost IdentifyFocus()
        {
            if (!Enabled) return null;
            try
            {
                bool any = false;
                foreach (DshWebViewHost pane in AllPanes)
                {
                    if (pane == null) continue;
                    IntPtr child = pane.ChildHandle;
                    if (child == IntPtr.Zero) continue;
                    any = true;
                    IntPtr unused;
                    Win32.SendMessageTimeout(child, Win32.WM_DSH_WHO_HAS_FOCUS,
                        IntPtr.Zero, IntPtr.Zero, Win32.SMTO_ABORTIFHUNG, 300, out unused);
                }
                if (!any) return null;
                lock (Sync) { return _queryPane; }
            }
            catch (Exception ex)
            {
                Logger.Info("focus identification failed: " + ex.Message);
                return null;
            }
        }

        /// <summary>
        /// Az egyik panel ablaka igennel válaszolt a „nálad van-e a fókusz?"
        /// kérdésre: ez az aktív panel.
        /// </summary>
        public static void ReportFocusOwner(DshWebViewHost host)
        {
            if (!Enabled || host == null) return;
            try
            {
                lock (Sync) { _queryPane = host; }
            }
            catch (Exception ex)
            {
                Logger.Info("focus owner report failed: " + ex.Message);
            }
        }

        /// <summary>
        /// Re-focuses the WebView2 child of the pane that last had focus, so the
        /// page sees activation. Harmless when the OS already restored it, and
        /// the web-side keeper decides whether the caret itself must come back.
        /// </summary>
        public static void Restore(string reason)
        {
            if (!Enabled) return;
            try
            {
                DshWebViewHost pane = PaneOf(PendingPane);
                if (pane == null) return;

                IntPtr focused = Win32.GetFocus();
                IntPtr child = pane.ChildHandle;
                if (child == IntPtr.Zero) return;

                Logger.Info("focus restore (" + reason + "): target=" + (pane.PaneIndex + 1)
                    + " focused=" + Win32.Describe(focused));

                // CSAK akkor lépünk vissza, ha a fókusz egy NEM panelhez tartozó
                // natív felületen van. A 300/800 ms-os próbák ezt a védőfeltételt
                // már nem használják (RestoreTo), mert a WPF aktiváláskor az első
                // panelra teszi a fókuszt, és azt felül kell írni.
                IntPtr root = Win32.GetAncestor(child, Win32.GA_ROOT);
                bool ours = focused == IntPtr.Zero
                    || focused == child
                    || focused == root
                    || Win32.IsChild(child, focused);
                if (!ours)
                {
                    Logger.Info("focus restore skipped (" + reason + "): native focus is elsewhere (0x"
                        + focused.ToInt64().ToString("X", CultureInfo.InvariantCulture) + ")");
                    return;
                }

                IntPtr previous = Win32.SetFocus(child);
                Logger.Info("focus restore (window activated): " + (pane.PaneIndex + 1) + ". panel"
                    + " child=" + Win32.Describe(child)
                    + " previous=" + Win32.Describe(previous)
                    + " fg=" + Win32.Describe(Win32.GetForegroundWindow()));

                // A karéta kirajzolásának kényszerítése: a mező fókuszban van, de
                // a WebView2 renderelője nem rajzolja újra a karétát (mért hiba).
                try
                {
                    CoreWebView2 core0 = pane.Core;
                    if (core0 != null) core0.ExecuteScriptAsync(ResyncScript);
                }
                catch (Exception ex)
                {
                    Logger.Info("focus resync: " + ex.Message);
                }

                // A WebView2-nek szóló, dokumentált "vedd át a fókuszt" hívás:
                // a SetFocus a gyermekablakot fókuszálná, de a vezérlő ettől
                // még nem biztos, hogy aktívnak látja a lapot (mért eset:
                // doc=false maradt egy sikeres SetFocus után is).
                try
                {
                    CoreWebView2Controller controller = pane.Controller;
                    if (controller != null) controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
                }
                catch (Exception ex)
                {
                    Logger.Info("focus restore MoveFocus: " + ex.Message);
                }

                try
                {
                    CoreWebView2 core = pane.Core;
                    if (core != null)
                    {
                        core.ExecuteScriptAsync(ApproachScript);
                        core.ExecuteScriptAsync(ResyncScript);
                    }
                }
                catch (Exception ex)
                {
                    Logger.Info("focus restore script: " + ex.Message);
                }
            }
            catch (Exception ex)
            {
                Logger.Info("focus restore failed: " + ex.Message);
            }
        }

        /// <summary>
        /// A rögzített célpanelt állítja vissza 300 ms és 800 ms múlva.
        ///
        /// MIÉRT RÖGZÍTETT CÉLLAL: az aktiválás pillanatában a Windows/WPF maga
        /// is oszt fókuszt, és a közben befutó lapoldali jelzések átírják a
        /// „legutolsó panelt" — mért hiba volt, hogy a késleltetett próba ezért
        /// mindig az 1. panelre ment, hiába volt a 2. az aktív.
        /// </summary>
        public static void RestoreTargetSoon(DshWebViewHost target, string reason)
        {
            if (!Enabled || target == null) return;
            int[] delays = new int[] { 400, 1200 };
            foreach (int delay in delays)
            {
                try
                {
                    var timer = new System.Windows.Threading.DispatcherTimer
                    {
                        Interval = TimeSpan.FromMilliseconds(delay)
                    };
                    timer.Tick += (s, e) =>
                    {
                        timer.Stop();
                        RestoreTo(target, reason);
                        if (delay == 1200)
                        {
                            // Egér NÉLKÜL adjuk át a fókuszt (a szintetikus
                            // kattintás kijelölte a szöveget és elrontotta az
                            // egérmutatót).
                            FocusAtPoint(target);
                            Unfreeze();
                        }
                    };
                    timer.Start();
                }
                catch (Exception ex)
                {
                    Logger.Info("focus restore (delayed) not scheduled: " + ex.Message);
                }
            }
        }

        /// <summary>
        /// Ugyanaz, rövid késleltetéssel: az aktiválás pillanatában a Windows
        /// még maga is fókuszt oszt (és a WPF is beállíthatja a sajátját), ezért
        /// a korai SetFocus-t felülírhatja. A késleltetett második próba a
        /// végleges állapotot állítja be.
        /// </summary>
        public static void RestoreSoon(string reason)
        {
            if (!Enabled) return;
            try
            {
                var timer = new System.Windows.Threading.DispatcherTimer
                {
                    Interval = TimeSpan.FromMilliseconds(300)
                };
                timer.Tick += (s, e) =>
                {
                    timer.Stop();
                    RestoreTarget(reason);
                };
                timer.Start();
            }
            catch (Exception ex)
            {
                Logger.Info("focus restore (delayed) not scheduled: " + ex.Message);
            }
        }

        /// <summary>Fókusz visszaadása egy KONKRÉT panelnek, ellenőrzés nélkül.</summary>
        public static void RestoreTo(DshWebViewHost host, string reason)
        {
            if (!Enabled || host == null) return;
            try
            {
                DshWebViewHost pane = PaneOf(host);
                IntPtr child = pane.ChildHandle;
                if (child == IntPtr.Zero) return;

                Logger.Info("focus restore at " + (pane.PaneIndex + 1) + ". panel (" + reason + ")"
                    + " focused=" + Win32.Describe(Win32.GetFocus())
                    + " target=" + Win32.Describe(child));

                IntPtr previous = Win32.SetFocus(child);
                Logger.Info("focus restore took pane " + (pane.PaneIndex + 1)
                    + " previous=" + Win32.Describe(previous)
                    + " now=" + Win32.Describe(Win32.GetFocus()));

                try
                {
                    CoreWebView2 core = pane.Core;
                    if (core != null) core.ExecuteScriptAsync(ApproachScript);
                }
                catch (Exception ex)
                {
                    Logger.Info("focus restore script: " + ex.Message);
                }
            }
            catch (Exception ex)
            {
                Logger.Info("focus restore (to pane) failed: " + ex.Message);
            }
        }

        /// <summary>
        /// Egér nélküli fókusz-adás a panelnek.
        ///
        /// MIÉRT NEM KATTINTÁS: a szintetikus kattintás kétszeresen ártott — a
        /// robot panelben kijelölte a meglévő szöveget, és az egérmutató
        /// eltűnését/megbízhatatlanságát okozta. Ezért a WebView2 saját,
        /// dokumentált mechanizmusát használjuk: a legutóbbi egérpozícióra
        /// rákérdezünk (`HitTest`), és ha az a lap tartalma, a vezérlőtől kérünk
        /// fókuszt (`MoveFocus`).
        /// </summary>
        public static void FocusAtPoint(DshWebViewHost host)
        {
            if (!Enabled || host == null) return;
            try
            {
                DshWebViewHost pane = PaneOf(host);
                CoreWebView2Controller controller = pane.Controller;
                IntPtr child = pane.ChildHandle;
                if (controller == null || child == IntPtr.Zero) return;

                IntPtr previous = Win32.SetFocus(child);
                string moved = "nem";
                try
                {
                    controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
                    moved = "igen";
                }
                catch (Exception ex)
                {
                    moved = "hiba: " + ex.Message;
                }
                Logger.Info("focus handover: pane " + (pane.PaneIndex + 1)
                    + " previous=" + Win32.Describe(previous)
                    + " now=" + Win32.Describe(Win32.GetFocus())
                    + " MoveFocus=" + moved);

                // Az egérmutató „beragadhat": a WebView2 a visszaaktiválás után
                // nem rajzolja újra a kurzort, ezért eltűnik a panel fölött.
                // Egy 1 képpontos mozdítás és vissza WM_SETCURSOR-t vált ki,
                // amitől a kurzor újrarajzolódik — kattintás és kijelölés nélkül.
                Win32.POINT cursor;
                if (Win32.GetCursorPos(out cursor))
                {
                    Win32.SetCursorPos(cursor.X + 1, cursor.Y);
                    System.Threading.Thread.Sleep(15);
                    Win32.SetCursorPos(cursor.X, cursor.Y);
                }
            }
            catch (Exception ex)
            {
                Logger.Info("focus handover failed: " + ex.Message);
            }
        }

        /// <summary>
        /// A lapról kapott JSON (CSS-pixel) átváltása képernyő-koordinátára. A
        /// lap JSON-ként, idézőjelek között jön vissza, ezért a számokat
        /// kiolvassuk belőle.
        /// </summary>
        private static bool TryParseFieldRect(string json, DshWebViewHost pane, out Win32.POINT point)
        {
            point = new Win32.POINT();
            if (string.IsNullOrEmpty(json)) return false;

            // Az ExecuteScriptAsync a visszatérési értéket JSON-ként adja vissza,
            // ezért a beágyazott JSON idézőjelei escape-elve jönnek
            // (\"x\":...). Ezt visszaalakítjuk, hogy egységesen olvashassuk.
            string text = json.Replace("\\\"", "\"").Replace("\\\\", "\\");
            if (text.IndexOf("\"w\"", StringComparison.Ordinal) < 0) return false;

            Match match = Regex.Match(text,
                "\\{\"x\":([-0-9.]+),\"y\":([-0-9.]+),\"w\":([-0-9.]+),\"h\":([-0-9.]+),\"dpr\":([-0-9.]+)");
            if (!match.Success) return false;

            double x = double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
            double y = double.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
            double w = double.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
            double h = double.Parse(match.Groups[4].Value, CultureInfo.InvariantCulture);
            double dpr = double.Parse(match.Groups[5].Value, CultureInfo.InvariantCulture);
            if (w <= 0 || h <= 0 || dpr <= 0) return false;

            IntPtr child = pane.ChildHandle;
            if (child == IntPtr.Zero) return false;

            // A panel kliens-területének bal felső sarka képernyőn.
            Win32.POINT origin = new Win32.POINT();
            if (!Win32.ClientToScreen(child, ref origin)) return false;

            // A mező közepe, fizikai képpontban (a lap CSS-pixelben mér).
            point.X = origin.X + (int)Math.Round((x + w / 2.0) * dpr);
            point.Y = origin.Y + (int)Math.Round((y + h / 2.0) * dpr);
            return true;
        }
    }

    // ------------------------------------------------------------- focus probe

    /// <summary>
    /// Diagnostic only (--focus-probe): writes every OS-level and DOM-level
    /// focus transition to `state\focus-probe\probe-*.log`, so a lost caret can
    /// be told apart from a lost HWND focus without guessing.
    /// </summary>
    internal static class Probe
    {
        private static readonly List<DshWebViewHost> Panes = new List<DshWebViewHost>();
        private static readonly object Sync = new object();
        private static string _path;
        private static bool _enabled;

        public static bool Enabled { get { return _enabled; } }

        public static void Init(bool enabled)
        {
            _enabled = enabled;
            if (!enabled) return;
            try
            {
                string dir = Path.Combine(DshPaths.ResolveStateDir(), "focus-probe");
                Directory.CreateDirectory(dir);
                _path = Path.Combine(dir, "probe-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + ".log");
                Note("probe start", IntPtr.Zero);
            }
            catch
            {
                _path = null;
            }
        }

        public static void RegisterPane(int index, DshWebViewHost host)
        {
            if (!_enabled) return;
            lock (Sync)
            {
                while (Panes.Count <= index) Panes.Add(null);
                Panes[index] = host;
            }
        }

        public static string MsgName(int msg)
        {
            switch (msg)
            {
                case Win32.WM_ACTIVATE: return "WM_ACTIVATE";
                case Win32.WM_NCACTIVATE: return "WM_NCACTIVATE";
                case Win32.WM_SETFOCUS: return "WM_SETFOCUS";
                case Win32.WM_KILLFOCUS: return "WM_KILLFOCUS";
                default: return "msg-0x" + msg.ToString("X", CultureInfo.InvariantCulture);
            }
        }

        /// <summary>One line per event: the message plus the whole focus picture.</summary>
        public static void Note(string what, IntPtr hwnd)
        {
            if (!_enabled || _path == null) return;
            try
            {
                IntPtr fg = Win32.GetForegroundWindow();
                IntPtr focus = Win32.GetFocus();
                var text = new StringBuilder();
                text.Append(DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture));
                text.Append(" | ").Append(what);
                text.Append(" | hwnd=0x").Append(hwnd.ToInt64().ToString("X", CultureInfo.InvariantCulture));
                text.Append(" fg=0x").Append(fg.ToInt64().ToString("X", CultureInfo.InvariantCulture));
                text.Append(" (").Append(Win32.ClassName(fg)).Append(")");
                text.Append(" focus=0x").Append(focus.ToInt64().ToString("X", CultureInfo.InvariantCulture));
                text.Append(" (").Append(Win32.ClassName(focus)).Append(")");
                lock (Sync)
                {
                    text.Append(" lastPane=");
                    text.Append(FocusKeeper.LastPane == null
                        ? "-"
                        : (FocusKeeper.LastPane.PaneIndex + 1).ToString(CultureInfo.InvariantCulture));
                }
                text.Append(" children=");
                lock (Sync)
                {
                    foreach (DshWebViewHost pane in Panes)
                    {
                        text.Append(pane == null
                            ? "-"
                            : pane.ChildHandle.ToInt64().ToString("X", CultureInfo.InvariantCulture));
                        text.Append(',');
                    }
                }
                lock (Sync)
                {
                    try { File.AppendAllText(_path, text.ToString() + Environment.NewLine, new UTF8Encoding(false)); }
                    catch { }
                }
            }
            catch
            {
            }
        }

        /// <summary>Dumps the focus picture again shortly after activation settles.</summary>
        public static void ScheduleDump()
        {
            if (!_enabled) return;
            try
            {
                var timer = new System.Windows.Threading.DispatcherTimer
                {
                    Interval = TimeSpan.FromMilliseconds(700)
                };
                timer.Tick += (s, e) =>
                {
                    timer.Stop();
                    Note("post-activate dump", IntPtr.Zero);
                };
                timer.Start();
            }
            catch
            {
            }
        }
    }

    // ------------------------------------------------------------- native helpers

    internal static class Win32
    {
        public const int WM_SIZE = 0x0005;
        public const int WM_DPICHANGED = 0x02E0;
        public const int WM_SETFOCUS = 0x0007;
        public const int WM_KILLFOCUS = 0x0008;
        public const int WM_ACTIVATE = 0x0006;
        public const int WM_NCACTIVATE = 0x0086;
        public const int WM_PARENTNOTIFY = 0x0210;
        public const int WM_LBUTTONDOWN = 0x0201;
        public const uint GA_ROOT = 2;

        [DllImport("user32.dll")]
        public static extern IntPtr GetFocus();

        [DllImport("user32.dll")]
        public static extern IntPtr SetFocus(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

        // FONTOS: a visszatérési típus LRESULT (IntPtr), NEM BOOL. Hibás
        // deklarációval a hívás csendben elhalt — mért hiba: egyetlen panel sem
        // válaszolt a „nálad van-e a fókusz?" kérdésre.
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam,
            uint flags, uint timeout, out IntPtr result);

        /// <summary>Ne várjunk egy nem válaszoló panelra.</summary>
        public const uint SMTO_ABORTIFHUNG = 0x0002;

        /// <summary>
        /// Saját kérdés a panelek ablakaihoz: „nálad van-e a fókusz?" A
        /// válaszoló panel az aktív.
        /// </summary>
        public const int WM_DSH_WHO_HAS_FOCUS = 0x8037;   // WM_APP + 55

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsChild(IntPtr hWndParent, IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        public static string ClassName(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return "0";
            var buffer = new StringBuilder(256);
            GetClassName(hwnd, buffer, buffer.Capacity);
            return buffer.ToString();
        }

        /// <summary>Rövid, naplózható leírás egy ablakfogantyúról.</summary>
        public static string Describe(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return "null";
            return "0x" + hwnd.ToInt64().ToString("X", CultureInfo.InvariantCulture) + "(" + ClassName(hwnd) + ")";
        }

        public const int WS_CHILD = 0x40000000;
        public const int WS_VISIBLE = 0x10000000;
        public const int WS_CLIPCHILDREN = 0x02000000;

        public const int AF_INET = 2;
        public const int TCP_TABLE_OWNER_PID_LISTENER = 3;
        public const uint ERROR_INSUFFICIENT_BUFFER = 122;

        [StructLayout(LayoutKind.Sequential)]
        public struct MIB_TCPROW_OWNER_PID
        {
            public uint State;
            public uint LocalAddr;
            public uint LocalPort;
            public uint RemoteAddr;
            public uint RemotePort;
            public uint OwningPid;
        }

        [DllImport("iphlpapi.dll", SetLastError = true)]
        public static extern uint GetExtendedTcpTable(IntPtr tcpTable, ref int size, bool order,
            int addressFamily, int tableClass, int reserved);

        /// <summary>Encodes a port the way the TCP table stores it (network order).</summary>
        public static uint PortToNetworkOrder(int port)
        {
            return (uint)(((port & 0xFF) << 8) | ((port >> 8) & 0xFF));
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetCursorPos(int x, int y);

        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;

        [DllImport("user32.dll")]
        public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateWindowEx(
            int dwExStyle, string lpClassName, string lpWindowName, int dwStyle,
            int x, int y, int nWidth, int nHeight,
            IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool DestroyWindow(IntPtr hWnd);
    }

    internal static class DarkTitleBar
    {
        private const int DwmwaUseImmersiveDarkMode = 20;
        private const int DwmwaUseImmersiveDarkModeBefore20H1 = 19;
        private const int DwmwaBorderColor = 34;
        private const int DwmwaCaptionColor = 35;

        [DllImport("dwmapi.dll", PreserveSig = true)]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        public static void Apply(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            int on = 1;
            int hr = DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref on, sizeof(int));
            if (hr != 0)
            {
                DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkModeBefore20H1, ref on, sizeof(int));
            }

            // COLORREF is 0x00BBGGRR: a dark grey that matches the UI surface.
            int caption = 0x00171715;
            DwmSetWindowAttribute(hwnd, DwmwaCaptionColor, ref caption, sizeof(int));
            DwmSetWindowAttribute(hwnd, DwmwaBorderColor, ref caption, sizeof(int));
        }
    }

    // ------------------------------------------------------------------ options

    internal sealed class Options
    {
        public int Port = 3080;
        public string Url;              // attaches to an existing server instead of booting
        public bool NoBoot;             // never boot the server from the window
        public int Panes = 1;           // side-by-side panels, each its own client

        /// <summary>
        /// Per-pane URL overrides, keyed by 1-based pane index
        /// (<c>--pane-url 4=http://127.0.0.1:4180/</c>). A pane without an
        /// override keeps loading the harness client, so the default behaviour
        /// is unchanged; the robot panel is the first surface that needs one.
        /// </summary>
        public Dictionary<int, string> PaneUrls = new Dictionary<int, string>();
        public int BootTimeoutSeconds = 90;
        public double Width = 1280;
        public double Height = 840;
        public double? X;
        public double? Y;
        public bool Center = true;
        public string DshBin;
        public string DshHome;
        public string NodeExe;
        public string LogFile;
        public string IconFile;
        public string UserDataDir;
        public string BrowserArgs;
        public string ProfileGeneration;   // per-launch profile folder under UserDataDir
        public bool RestartIfStale;     // on 401, restart the harness to get a fresh token
        public bool IgnoreSavedGeometry; // always use the given/default size and position
        public int CloseAfterSeconds;   // test hook: close the window after N seconds
        public bool FocusProbe;         // diagnostic: log every focus transition

        public static Options Parse(string[] args)
        {
            var o = new Options();
            bool noFocusRestore = false;
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                string next = i + 1 < args.Length ? args[i + 1] : null;
                switch (a)
                {
                    case "--port": o.Port = ParseInt(next, o.Port); i++; break;
                    case "--url": o.Url = next; i++; break;
                    case "--no-boot": o.NoBoot = true; break;
                    case "--no-focus-restore": noFocusRestore = true; break;
                    case "--focus-probe": o.FocusProbe = true; break;
                    case "--panes": o.Panes = ParseInt(next, o.Panes); i++; break;
                    case "--pane-url": ParsePaneUrl(o, next); i++; break;
                    case "--boot-timeout": o.BootTimeoutSeconds = ParseInt(next, o.BootTimeoutSeconds); i++; break;
                    case "--width": o.Width = ParseDouble(next, o.Width); i++; break;
                    case "--height": o.Height = ParseDouble(next, o.Height); i++; break;
                    case "--x": o.X = ParseDouble(next, 0); i++; break;
                    case "--y": o.Y = ParseDouble(next, 0); i++; break;
                    case "--no-center": o.Center = false; break;
                    case "--dsh-bin": o.DshBin = next; i++; break;
                    case "--dsh-home": o.DshHome = next; i++; break;
                    case "--node": o.NodeExe = next; i++; break;
                    case "--log": o.LogFile = next; i++; break;
                    case "--icon": o.IconFile = next; i++; break;
                    case "--user-data-dir": o.UserDataDir = next; i++; break;
                    case "--profile-generation": o.ProfileGeneration = next; i++; break;
                    case "--browser-args": o.BrowserArgs = next; i++; break;
                    case "--restart-if-stale": o.RestartIfStale = true; break;
                    case "--reset-geometry": o.IgnoreSavedGeometry = true; break;
                    case "--close-after": o.CloseAfterSeconds = ParseInt(next, 0); i++; break;
                }
            }

            if (noFocusRestore) FocusKeeper.Disable();

            if (string.IsNullOrEmpty(o.LogFile))
            {
                o.LogFile = Path.Combine(DshPaths.ResolveLogDir(o.DshHome), "dsh-window.log");
            }
            return o;
        }

        private static int ParseInt(string s, int fallback)
        {
            int v;
            return int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : fallback;
        }

        /// <summary>
        /// Parses one <c>--pane-url &lt;index&gt;=&lt;url&gt;</c> override. An
        /// unparsable value is ignored on purpose: a typo in the tray config must
        /// not stop the window from opening. An index beyond the pane count is
        /// harmless — the pane loop simply never asks for it.
        /// </summary>
        private static void ParsePaneUrl(Options o, string spec)
        {
            if (string.IsNullOrWhiteSpace(spec)) return;

            int separator = spec.IndexOf('=');
            if (separator <= 0) return;

            int index;
            if (!int.TryParse(spec.Substring(0, separator).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out index)) return;
            if (index < 1) return;

            string value = spec.Substring(separator + 1).Trim();
            if (value.Length == 0) return;

            o.PaneUrls[index] = value;
        }

        private static double ParseDouble(string s, double fallback)
        {
            double v;
            return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v) ? v : fallback;
        }
    }

    // ------------------------------------------------------------------ logging

    internal static class Logger
    {
        private static readonly object Gate = new object();
        public static string Path { get; private set; }

        public static void Init(string path)
        {
            Path = path;
            try
            {
                string dir = System.IO.Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            }
            catch { }
        }

        public static void Info(string message) { Write("INFO ", message); }
        public static void Error(string message) { Write("ERROR", message); }

        private static void Write(string level, string message)
        {
            if (string.IsNullOrEmpty(Path)) return;
            try
            {
                lock (Gate)
                {
                    string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                        + " [" + level + "] " + message + Environment.NewLine;
                    File.AppendAllText(Path, line, new UTF8Encoding(false));
                    Trim();
                }
            }
            catch { }
        }

        // Keep the log bounded: this file is appended on every window open.
        private static void Trim()
        {
            try
            {
                var info = new FileInfo(Path);
                if (info.Exists && info.Length > 512 * 1024)
                {
                    string old = Path + ".1";
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(Path, old);
                }
            }
            catch { }
        }
    }

    // ---------------------------------------------------------------- port probe

    internal static class PortProbe
    {
        public static bool IsListening(int port)
        {
            try
            {
                var listeners = System.Net.NetworkInformation.IPGlobalProperties
                    .GetIPGlobalProperties().GetActiveTcpListeners();
                for (int i = 0; i < listeners.Length; i++)
                {
                    if (listeners[i].Port == port) return true;
                }
            }
            catch (Exception ex)
            {
                Logger.Info("port probe failed: " + ex.Message);
            }
            return false;
        }

        public static bool WaitForListening(int port, TimeSpan timeout)
        {
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                if (IsListening(port)) return true;
                Thread.Sleep(400);
            }
            return IsListening(port);
        }

        /// <summary>Owning process of the first TCP listener on the port, or 0.</summary>
        public static int FindListenerPid(int port)
        {
            IntPtr table = IntPtr.Zero;
            try
            {
                int size = 0;
                uint result = Win32.GetExtendedTcpTable(IntPtr.Zero, ref size, false,
                    Win32.AF_INET, Win32.TCP_TABLE_OWNER_PID_LISTENER, 0);
                if (result != Win32.ERROR_INSUFFICIENT_BUFFER && size <= 0) return 0;

                table = Marshal.AllocHGlobal(size);
                result = Win32.GetExtendedTcpTable(table, ref size, false,
                    Win32.AF_INET, Win32.TCP_TABLE_OWNER_PID_LISTENER, 0);
                if (result != 0) return 0;

                int rowCount = Marshal.ReadInt32(table);
                long rowStart = table.ToInt64() + 4;
                int rowSize = Marshal.SizeOf(typeof(Win32.MIB_TCPROW_OWNER_PID));
                for (int i = 0; i < rowCount; i++)
                {
                    var row = (Win32.MIB_TCPROW_OWNER_PID)Marshal.PtrToStructure(
                        new IntPtr(rowStart + (long)i * rowSize), typeof(Win32.MIB_TCPROW_OWNER_PID));
                    // LocalPort arrives in network byte order, so it is not equal
                    // to the port number until the bytes are swapped.
                    if (row.LocalPort == Win32.PortToNetworkOrder(port)) return (int)row.OwningPid;
                }
            }
            catch (Exception ex)
            {
                Logger.Info("listener lookup failed: " + ex.Message);
            }
            finally
            {
                if (table != IntPtr.Zero) Marshal.FreeHGlobal(table);
            }
            return 0;
        }
    }

    // ------------------------------------------------------------- harness boot

    internal static class HarnessBoot
    {
        /// <summary>
        /// Starts `node &lt;dsh-bin&gt; web --host 127.0.0.1 --port N --no-open`
        /// hidden, with the child's output written to dsh-web.log / dsh-web.err.log.
        /// </summary>
        public static int Start(Options opts, Action<string> onOutputLine = null)
        {
            string bin = opts.DshBin;
            if (string.IsNullOrEmpty(bin) || !File.Exists(bin))
            {
                throw new FileNotFoundException(
                    "A dsh CLI nem található" + (string.IsNullOrEmpty(bin) ? "." : ": " + bin) +
                    "\nAdd meg a --dsh-bin kapcsolóval a @deepseek-ai/dsh/lib/bin.js útvonalát.");
            }

            string node = string.IsNullOrEmpty(opts.NodeExe) ? "node" : opts.NodeExe;
            string logDir = DshPaths.ResolveLogDir(opts.DshHome);
            Directory.CreateDirectory(logDir);

            var psi = new ProcessStartInfo
            {
                FileName = node,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(bin),
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                // ArgumentList does not exist on .NET Framework, so the command
                // line is built with explicit Windows quoting rules instead.
                Arguments = BuildCommandLine(
                    bin, "web",
                    "--host", "127.0.0.1",
                    "--port", opts.Port.ToString(CultureInfo.InvariantCulture),
                    "--no-open")
            };

            var env = psi.Environment;
            if (!string.IsNullOrEmpty(opts.DshHome)) env["DSH_HOME"] = opts.DshHome;
            env["DSH_WEB_URL"] = "http://127.0.0.1:" + opts.Port.ToString(CultureInfo.InvariantCulture);

            var proc = new Process { StartInfo = psi };
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            proc.OutputDataReceived += (s, e) =>
            {
                if (e.Data == null) return;
                Append(stdout, e.Data);
                if (onOutputLine != null)
                {
                    try { onOutputLine(e.Data); } catch { }
                }
            };
            proc.ErrorDataReceived += (s, e) => { if (e.Data != null) Append(stderr, e.Data); };

            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            File.WriteAllText(
                Path.Combine(logDir, "dsh-web.pid"),
                proc.Id.ToString(CultureInfo.InvariantCulture),
                new UTF8Encoding(false));

            // Flush whatever the child printed to the log files once it settles.
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    proc.WaitForExit(120000);
                    if (stdout.Length > 0)
                    {
                        File.AppendAllText(Path.Combine(logDir, "dsh-web.log"), stdout.ToString(), new UTF8Encoding(false));
                    }
                    if (stderr.Length > 0)
                    {
                        File.AppendAllText(Path.Combine(logDir, "dsh-web.err.log"), stderr.ToString(), new UTF8Encoding(false));
                    }
                    if (proc.HasExited && proc.ExitCode != 0)
                    {
                        Logger.Error("harness exited early with code " + proc.ExitCode + "; see " + logDir);
                    }
                }
                catch { }
            });

            return proc.Id;
        }

        private static void Append(StringBuilder sb, string line)
        {
            lock (sb)
            {
                sb.AppendLine(line);
            }
        }

        /// <summary>
        /// Stops whatever process currently listens on the port. Used only as a
        /// recovery step when the harness we are attached to will not hand out a
        /// session (its token is unknown), so killing it is acceptable.
        /// </summary>
        public static int StopListeningProcess(int port)
        {
            int pid = PortProbe.FindListenerPid(port);
            if (pid <= 0) return 0;
            try
            {
                Process.GetProcessById(pid).Kill();
                return pid;
            }
            catch (Exception ex)
            {
                Logger.Error("could not stop pid " + pid + ": " + ex.Message);
                return 0;
            }
        }

        /// <summary>
        /// Builds a Windows command line using the documented quoting rules
        /// (the same ones .NET Core's ArgumentList applies internally).
        /// </summary>
        private static string BuildCommandLine(params string[] args)
        {
            var sb = new StringBuilder();
            for (int i = 0; i < args.Length; i++)
            {
                if (i > 0) sb.Append(' ');
                sb.Append(QuoteArgument(args[i]));
            }
            return sb.ToString();
        }

        private static string QuoteArgument(string value)
        {
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                return value;
            }

            var sb = new StringBuilder();
            sb.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                int backslashes = 0;
                while (i < value.Length && value[i] == '\\')
                {
                    backslashes++;
                    i++;
                }

                if (i == value.Length)
                {
                    // Escape trailing backslashes so the closing quote survives.
                    sb.Append('\\', backslashes * 2);
                    break;
                }

                if (value[i] == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes);
                    sb.Append(value[i]);
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }

    internal static class DshPaths
    {
        public static string ResolveLogDir(string dshHome)
        {
            if (!string.IsNullOrEmpty(dshHome)) return Path.Combine(dshHome, "dsh-web");
            string home = Environment.GetEnvironmentVariable("DSH_HOME");
            if (!string.IsNullOrEmpty(home)) return Path.Combine(home, "dsh-web");

            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(local, "DSH Harness", "logs");
        }

        public static string ResolveUserDataDir()
        {
            // The WebView2 profile lives inside the project state folder: it is
            // always writable for the user running the window, and it keeps all
            // per-install data in one place (%LOCALAPPDATA% is used only as a
            // fallback when the project folder is not writable).
            string stateDir = ResolveStateDir();
            try
            {
                Directory.CreateDirectory(stateDir);
                return Path.Combine(stateDir, "webview2");
            }
            catch
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DSH Harness", "WebView2");
            }
        }

        /// <summary>
        /// The launcher's own state folder: bin\DshWindow.exe lives in
        /// &lt;root&gt;\bin, so the shared state is &lt;root&gt;\state.
        /// </summary>
        public static string ResolveStateDir()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "state");
        }
    }

    // ---------------------------------------------------------- window geometry

    /// <summary>
    /// Remembers the divider positions of a split window, so a pane the user
    /// widened stays wide on the next launch. One tiny key=value file next to
    /// the other state; the pane COUNT is not stored here because the tray owns
    /// it, and a stored ratio set is used only when the counts agree.
    /// </summary>
    internal static class PaneLayout
    {
        private static string FilePath
        {
            get { return Path.Combine(DshPaths.ResolveStateDir(), "pane-layout.txt"); }
        }

        /// <summary>
        /// Star widths for the panes: the stored ones when the file describes the
        /// same pane count, otherwise equal shares.
        /// </summary>
        public static double[] Load(int paneCount)
        {
            var equal = new double[paneCount];
            for (int i = 0; i < paneCount; i++) equal[i] = 1.0 / paneCount;

            try
            {
                if (paneCount <= 1) return equal;

                string path = FilePath;
                if (!File.Exists(path)) return equal;

                int storedCount = 0;
                var ratios = new double[paneCount];
                bool complete = true;

                foreach (string rawLine in File.ReadAllLines(path))
                {
                    string line = rawLine.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;

                    int separator = line.IndexOf('=');
                    if (separator <= 0) continue;

                    string key = line.Substring(0, separator).Trim().ToLowerInvariant();
                    string value = line.Substring(separator + 1).Trim();

                    if (key == "panes")
                    {
                        int parsedCount;
                        if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsedCount))
                        {
                            storedCount = parsedCount;
                        }
                        continue;
                    }

                    if (!key.StartsWith("ratio")) continue;
                    int index;
                    if (!int.TryParse(key.Substring(5), NumberStyles.Integer, CultureInfo.InvariantCulture, out index)) continue;
                    if (index < 1 || index > paneCount) continue;

                    double parsed;
                    if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) || parsed <= 0)
                    {
                        complete = false;
                        break;
                    }
                    ratios[index - 1] = parsed;
                }

                if (storedCount != paneCount || !complete) return equal;

                double total = 0;
                for (int i = 0; i < paneCount; i++)
                {
                    if (ratios[i] <= 0) return equal;
                    total += ratios[i];
                }
                if (total <= 0) return equal;

                for (int i = 0; i < paneCount; i++) ratios[i] = ratios[i] / total;
                Logger.Info("pane layout restored: " + Describe(ratios));
                return ratios;
            }
            catch (Exception ex)
            {
                Logger.Info("pane layout not loaded: " + ex.Message);
                return equal;
            }
        }

        /// <summary>Persists the panes' current relative widths.</summary>
        public static void Save(IList<DshWebViewHost> panes)
        {
            try
            {
                if (panes == null || panes.Count <= 1) return;

                var widths = new double[panes.Count];
                double total = 0;
                for (int i = 0; i < panes.Count; i++)
                {
                    double width = panes[i].ActualWidth;
                    if (width <= 0) return;
                    widths[i] = width;
                    total += width;
                }
                if (total <= 0) return;

                var text = new StringBuilder();
                text.AppendLine("# A DeepSeek Harness ablak paneljeinek relativ szelessege.");
                text.AppendLine("# Torold ezt a fajlt, ha egyenlo felosztast szeretnel.");
                text.AppendLine("panes=" + panes.Count.ToString(CultureInfo.InvariantCulture));
                for (int i = 0; i < widths.Length; i++)
                {
                    text.AppendLine("ratio" + (i + 1).ToString(CultureInfo.InvariantCulture) + "="
                        + (widths[i] / total).ToString("0.####", CultureInfo.InvariantCulture));
                }

                File.WriteAllText(FilePath, text.ToString(), new UTF8Encoding(false));
                Logger.Info("pane layout saved: " + Describe(widths));
            }
            catch (Exception ex)
            {
                Logger.Info("pane layout not saved: " + ex.Message);
            }
        }

        private static string Describe(double[] values)
        {
            var parts = new List<string>(values.Length);
            for (int i = 0; i < values.Length; i++)
            {
                parts.Add(values[i].ToString("0.###", CultureInfo.InvariantCulture));
            }
            return string.Join(",", parts.ToArray());
        }
    }

    /// <summary>
    /// Remembers where the user left the window, so every new window opens at
    /// the same place on the (possibly very wide) desktop. Stored as a tiny
    /// key=value text file next to the other state, which keeps it readable and
    /// needs no JSON parser.
    /// </summary>
    internal sealed class WindowGeometry
    {
        public double? Left;
        public double? Top;
        public double? Width;
        public double? Height;

        private static string FilePath
        {
            get { return Path.Combine(DshPaths.ResolveStateDir(), "window-geometry.txt"); }
        }

        public static WindowGeometry Load()
        {
            var geometry = new WindowGeometry();
            try
            {
                string path = FilePath;
                if (!File.Exists(path)) return geometry;

                foreach (string rawLine in File.ReadAllLines(path))
                {
                    string line = rawLine.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;

                    int separator = line.IndexOf('=');
                    if (separator <= 0) continue;

                    string key = line.Substring(0, separator).Trim().ToLowerInvariant();
                    string value = line.Substring(separator + 1).Trim();
                    double parsed;
                    if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed)) continue;

                    switch (key)
                    {
                        case "left": geometry.Left = parsed; break;
                        case "top": geometry.Top = parsed; break;
                        case "width": geometry.Width = parsed; break;
                        case "height": geometry.Height = parsed; break;
                    }
                }
            }
            catch (Exception ex)
            {
                Logger.Info("window geometry not loaded: " + ex.Message);
            }
            return geometry;
        }

        public void Save(double left, double top, double width, double height)
        {
            try
            {
                string path = FilePath;
                Directory.CreateDirectory(Path.GetDirectoryName(path));

                var text = new StringBuilder();
                text.AppendLine("# A DeepSeek Harness ablak utolso pozicioja es merete (WPF egeszegysegek).");
                text.AppendLine("# Torold ezt a fajlt, ha kozepre szeretned tenni az ablakot.");
                text.AppendLine("left=" + left.ToString("0.##", CultureInfo.InvariantCulture));
                text.AppendLine("top=" + top.ToString("0.##", CultureInfo.InvariantCulture));
                text.AppendLine("width=" + width.ToString("0.##", CultureInfo.InvariantCulture));
                text.AppendLine("height=" + height.ToString("0.##", CultureInfo.InvariantCulture));

                File.WriteAllText(path, text.ToString(), new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                Logger.Info("window geometry not saved: " + ex.Message);
            }
        }

        /// <summary>
        /// Keeps a saved rectangle only when it still lands on a connected
        /// screen: an unplugged monitor must not leave the window invisible.
        /// </summary>
        public bool IsOnScreen()
        {
            if (!Left.HasValue || !Top.HasValue || !Width.HasValue || !Height.HasValue) return false;
            if (Width.Value < 320 || Height.Value < 200) return false;

            double virtualLeft = SystemParameters.VirtualScreenLeft;
            double virtualTop = SystemParameters.VirtualScreenTop;
            double virtualRight = virtualLeft + SystemParameters.VirtualScreenWidth;
            double virtualBottom = virtualTop + SystemParameters.VirtualScreenHeight;

            // Require a decent slice of the title bar to be reachable.
            double overlapX = Math.Min(Left.Value + Width.Value, virtualRight) - Math.Max(Left.Value, virtualLeft);
            double overlapY = Math.Min(Top.Value + 60, virtualBottom) - Math.Max(Top.Value, virtualTop);
            return overlapX >= 120 && overlapY >= 30;
        }
    }

    // --------------------------------------------------------------- error page

    internal static class ErrorPage
    {
        public static string Build(string url, string message, string logFile)
        {
            return "<!doctype html><html lang=\"hu\"><head><meta charset=\"utf-8\">" +
                   "<title>DeepSeek Harness</title><style>" +
                   "html,body{height:100%;margin:0;background:#151517;color:#f9fafb;" +
                   "font:14px/1.6 'Segoe UI',system-ui,sans-serif;display:grid;place-items:center}" +
                   ".card{max-width:620px;padding:28px 32px;border:1px solid rgba(255,255,255,.12);" +
                   "border-radius:14px;background:#1c1c1f}" +
                   "h1{font-size:16px;margin:0 0 10px}p{margin:0 0 10px;color:#cfd3d6}" +
                   "code{font-family:Consolas,monospace;color:#f9fafb;background:#101012;" +
                   "padding:2px 6px;border-radius:5px}" +
                   ".hint{color:#adb2b8;font-size:12px;margin-top:14px}" +
                   "</style></head><body><div class=\"card\">" +
                   "<h1>Nem indult el a DeepSeek Harness ablaka</h1>" +
                   "<p>" + Escape(message) + "</p>" +
                   "<p>Cím, amit nyitni próbáltam: <code>" + Escape(url) + "</code></p>" +
                   "<p class=\"hint\">Napló: <code>" + Escape(logFile ?? "") + "</code><br>" +
                   "A tálcaikon menüjében: <b>Naplók megnyitása</b>. " +
                   "Ha a port foglalt, állíts be másikat a tálcáról, majd indítsd újra.</p>" +
                   "</div></body></html>";
        }

        private static string Escape(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
        }
    }
}
