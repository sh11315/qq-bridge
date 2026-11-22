using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("QQ Bridge 控制台")]
[assembly: AssemblyDescription("QQ Bridge 统一控制台（托盘 + 打开控制台页面）")]
[assembly: AssemblyProduct("QQ Bridge")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]
[assembly: AssemblyInformationalVersion("1.1.0")]

namespace QQBridgeConsole
{
    internal static class Program
    {
        private const int ConsolePort = 7788;
        private const int HealthTimeoutMs = 3000;
        private const int StartupWaitMs = 30000;
        private const int StartGateTimeoutMs = 45000;
        private const string AppVersion = "1.1.0";
        private const string MutexName = @"Local\QQBridgeConsoleDesktop_5_0";
        private const string StartMutexName = @"Local\QQBridgeConsoleDesktop_5_0_Start";

        private static string appDir;
        private static string projectDir;
        private static string nodeExe;
        private static string edgeExe;
        private static string edgeProfile;
        private static NotifyIcon tray;
        private static Icon trayIcon;
        private static bool trayIconOwned;
        private static Mutex instanceMutex;
        private static System.Windows.Forms.Timer watchdog;
        private static Control uiMarshal;
        private static int quitting;
        private static int exiting;
        private static int watchdogBusy;
        private static int actionBusy;
        private static readonly object logLock = new object();

        [STAThread]
        private static void Main(string[] args)
        {
            try
            {
                InitPaths();
            }
            catch (Exception ex)
            {
                try { MessageBox.Show("初始化失败：" + ex.Message, "QQ Bridge 控制台", MessageBoxButtons.OK, MessageBoxIcon.Error); }
                catch { }
                Environment.ExitCode = 2;
                return;
            }

            bool autoStart = HasArg(args, "--autostart");
            bool created = false;
            try
            {
                instanceMutex = new Mutex(true, MutexName, out created);
            }
            catch (Exception ex)
            {
                Log("create instance mutex failed: " + ex);
                try { MessageBox.Show("单实例检查失败：" + ex.Message, "QQ Bridge 控制台", MessageBoxButtons.OK, MessageBoxIcon.Error); }
                catch { }
                Environment.ExitCode = 3;
                return;
            }

            if (!created)
            {
                // 已有托盘实例：本实例只负责把控制台页面打开，然后退出。
                // 开机自启重复触发时保持静默，不要给用户弹一个页面。
                if (autoStart)
                {
                    Environment.ExitCode = 0;
                    return;
                }
                Environment.ExitCode = OpenPageSecondInstance() ? 0 : 1;
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
            {
                Log("UI exception: " + e.Exception);
                ReportError("程序异常", e.Exception.Message);
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                Log("unhandled exception: " + e.ExceptionObject);
            };

            // 创建一个隐藏控件，仅用于把后台线程的结果安全地切回 UI 线程。
            try
            {
                uiMarshal = new Control();
                IntPtr unused = uiMarshal.Handle;
            }
            catch (Exception ex)
            {
                Log("ui marshal init failed: " + ex.Message);
            }

            try
            {
                SetupTray(autoStart);
            }
            catch (Exception ex)
            {
                Log("tray init failed: " + ex);
                try { MessageBox.Show("托盘初始化失败：" + ex.Message, "QQ Bridge 控制台", MessageBoxButtons.OK, MessageBoxIcon.Error); }
                catch { }
                CleanupInstance();
                Environment.ExitCode = 4;
                return;
            }

            Log("launcher started (v" + AppVersion + "): appDir=" + appDir + "; projectDir=" + projectDir
                + "; node=" + (nodeExe ?? "(not found)") + "; edge=" + (edgeExe ?? "(not found)"));

            if (autoStart)
            {
                // 开机自启只保证控制台在，不主动弹页面。
                RunBackground(delegate { EnsureConsole(false); });
            }
            else
            {
                OpenPage("");
            }

            try
            {
                Application.Run();
            }
            catch (Exception ex)
            {
                Log("message loop failed: " + ex);
            }
            finally
            {
                CleanupInstance();
            }
        }

        private static bool HasArg(string[] args, string name)
        {
            if (args == null) return false;
            foreach (string arg in args)
            {
                if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static void InitPaths()
        {
            appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (string.IsNullOrEmpty(appDir))
            {
                appDir = AppDomain.CurrentDomain.BaseDirectory;
            }
            if (appDir.EndsWith(":", StringComparison.Ordinal))
            {
                // 程序恰好放在盘符根目录时，补回反斜杠，避免 Path.Combine 生成 "C:console"。
                appDir += Path.DirectorySeparatorChar;
            }

            projectDir = Path.GetDirectoryName(appDir);
            if (string.IsNullOrEmpty(projectDir))
            {
                projectDir = appDir;
            }
            if (!File.Exists(Path.Combine(projectDir, "console", "server.mjs")))
            {
                string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                if (!string.IsNullOrEmpty(documents))
                {
                    projectDir = Path.Combine(documents, "qq-bridge-full");
                }
            }

            nodeExe = FindNode();
            string localEdge = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Microsoft", "Edge", "Application", "msedge.exe");
            edgeExe = FirstExisting(
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                localEdge);
            edgeProfile = Path.Combine(appDir, "EdgeProfile");
        }

        private static string FindNode()
        {
            // 允许用环境变量指定；否则按常见位置与 PATH 查找，避免写死 D:\node.exe。
            string overridePath = Environment.GetEnvironmentVariable("QQB_NODE_EXE");
            try
            {
                if (!string.IsNullOrEmpty(overridePath) && File.Exists(overridePath)) return overridePath;
            }
            catch { }

            string localNode = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "nodejs", "node.exe");
            string found = FirstExisting(
                @"D:\node.exe",
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
                localNode);
            if (found != null) return found;

            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            foreach (string raw in pathEnv.Split(';'))
            {
                string dir = raw.Trim().Trim('"');
                if (dir.Length == 0) continue;
                try
                {
                    string candidate = Path.Combine(Environment.ExpandEnvironmentVariables(dir), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
            return null;
        }

        private static string FirstExisting(params string[] paths)
        {
            foreach (string p in paths)
            {
                try
                {
                    if (string.IsNullOrEmpty(p)) continue;
                    string expanded = Environment.ExpandEnvironmentVariables(p);
                    if (File.Exists(expanded)) return expanded;
                }
                catch { }
            }
            return null;
        }

        private static void Log(string message)
        {
            try
            {
                lock (logLock)
                {
                    File.AppendAllText(
                        Path.Combine(appDir, "launcher.log"),
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine,
                        new UTF8Encoding(false));
                }
            }
            catch { }
        }

        private static void SetupTray(bool autoStart)
        {
            string iconPath = Path.Combine(appDir, "icon.ico");
            try
            {
                if (File.Exists(iconPath))
                {
                    trayIcon = new Icon(iconPath);
                    trayIconOwned = true;
                }
            }
            catch (Exception ex)
            {
                Log("tray icon load failed: " + ex.Message);
                trayIcon = null;
                trayIconOwned = false;
            }
            if (trayIcon == null)
            {
                trayIcon = SystemIcons.Application;
                trayIconOwned = false;
            }

            tray = new NotifyIcon();
            tray.Icon = trayIcon;
            tray.Text = "QQ Bridge 控制台";
            tray.Visible = true;
            tray.DoubleClick += delegate { OpenPage(""); };

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("打开控制台", null, delegate { OpenPage(""); });
            menu.Items.Add("打开使用说明", null, delegate { OpenPage("#help"); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("全部启动", null, delegate { ServiceAction("/api/start"); });
            menu.Items.Add("全部重启", null, delegate { ServiceAction("/api/restart"); });
            menu.Items.Add("全部停止", null, delegate { ServiceAction("/api/stop"); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开项目目录", null, delegate { OpenFolder(projectDir); });
            ToolStripMenuItem autoStartItem = new ToolStripMenuItem("开机自启");
            autoStartItem.CheckOnClick = true;
            autoStartItem.Checked = IsAutoStartEnabled();
            autoStartItem.CheckedChanged += delegate { SetAutoStart(autoStartItem.Checked); };
            menu.Items.Add(autoStartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出（控制台继续运行）", null, delegate { QuitApplication(false); });
            menu.Items.Add("退出并停止全部服务", null, delegate { QuitApplication(true); });
            tray.ContextMenuStrip = menu;

            watchdog = new System.Windows.Forms.Timer();
            watchdog.Interval = 20000;
            watchdog.Tick += delegate { OnWatchdogTick(); };
            watchdog.Start();

            if (!autoStart)
            {
                try { tray.ShowBalloonTip(2500, "QQ Bridge 控制台", "已在托盘运行：双击图标打开控制台。", ToolTipIcon.Info); }
                catch { }
            }
        }

        private static void OnWatchdogTick()
        {
            if (quitting != 0 || actionBusy != 0) return;
            if (Interlocked.CompareExchange(ref watchdogBusy, 1, 0) != 0) return;

            RunBackground(delegate
            {
                try
                {
                    if (quitting != 0) return;
                    if (ConsoleAlive()) return;

                    // 单次 3 秒超时可能只是控制台忙/网络栈抖动，连续两次失败再拉起，
                    // 避免当前日志里那种“控制台明明没死却被反复重启”的误报。
                    Thread.Sleep(1000);
                    if (quitting != 0 || ConsoleAlive()) return;

                    Log("watchdog: console down confirmed (2 probes)");
                    if (EnsureConsole(false))
                    {
                        ShowBalloon("控制台已自动重启", "检测到控制台退出，已自动拉起。", ToolTipIcon.Info);
                    }
                    else
                    {
                        Log("watchdog: restart attempt failed");
                    }
                }
                catch (Exception ex)
                {
                    Log("watchdog failed: " + ex.Message);
                }
                finally
                {
                    Interlocked.Exchange(ref watchdogBusy, 0);
                }
            });
        }

        private static void ShowBalloon(string title, string text, ToolTipIcon icon)
        {
            Log(title + ": " + text);
            RunOnUi(delegate
            {
                if (tray == null) return;
                try { tray.ShowBalloonTip(3000, title, text, icon); }
                catch { }
            });
        }

        private static void ReportError(string title, string text)
        {
            Log("ERROR " + title + ": " + text);
            if (tray == null)
            {
                // 第二个实例没有托盘，双击失败时必须让用户看到提示。
                try { MessageBox.Show(text, title, MessageBoxButtons.OK, MessageBoxIcon.Error); }
                catch { }
                return;
            }
            ShowBalloon(title, text, ToolTipIcon.Error);
        }

        private static void RunOnUi(Action action)
        {
            if (action == null) return;
            Control control = uiMarshal;
            if (control == null)
            {
                try { action(); }
                catch (Exception ex) { Log("ui action failed: " + ex); }
                return;
            }
            try
            {
                if (control.InvokeRequired) control.BeginInvoke(action);
                else action();
            }
            catch (Exception ex)
            {
                Log("marshal failed: " + ex.Message);
                try { action(); }
                catch (Exception ex2) { Log("ui action failed: " + ex2); }
            }
        }

        private static void RunBackground(Action action)
        {
            if (action == null) return;
            ThreadPool.QueueUserWorkItem(delegate(object state)
            {
                try { action(); }
                catch (Exception ex) { Log("background action failed: " + ex); }
            });
        }

        private static string ReadToken()
        {
            try
            {
                string file = Path.Combine(projectDir, "state", "console-token");
                return File.Exists(file) ? File.ReadAllText(file).Trim() : string.Empty;
            }
            catch { return string.Empty; }
        }

        private static string HttpRequest(string path, string method, string body, int timeoutMs)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + ConsolePort + path);
                req.Method = method;
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                // 本地回环必须直连；不要被 IE/WinHTTP 的系统代理或 PAC 劫持。
                req.Proxy = null;
                req.KeepAlive = false;
                req.AllowAutoRedirect = false;

                string token = ReadToken();
                if (!string.IsNullOrEmpty(token))
                {
                    req.Headers["x-console-token"] = token;
                }

                if (body != null)
                {
                    byte[] data = Encoding.UTF8.GetBytes(body);
                    req.ContentType = "application/json";
                    req.ContentLength = data.Length;
                    using (Stream s = req.GetRequestStream()) { s.Write(data, 0, data.Length); }
                }

                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch { return null; }
        }

        private static bool ConsoleAlive()
        {
            string body = HttpRequest("/api/health", "GET", null, HealthTimeoutMs);
            return body != null && Regex.IsMatch(body, "\"ok\"\\s*:\\s*true");
        }

        private static bool PortListening()
        {
            try
            {
                using (Socket socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp))
                {
                    IAsyncResult ar = socket.BeginConnect(IPAddress.Loopback, ConsolePort, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(400, false)) return false;
                    socket.EndConnect(ar);
                    return true;
                }
            }
            catch { return false; }
        }

        private static bool WaitForConsole(int timeoutMs)
        {
            Stopwatch watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < timeoutMs)
            {
                if (ConsoleAlive()) return true;
                long left = timeoutMs - watch.ElapsedMilliseconds;
                if (left <= 0) break;
                Thread.Sleep((int)Math.Min(300, left));
            }
            return ConsoleAlive();
        }

        private static bool EnsureConsole(bool showError)
        {
            if (quitting != 0) return false;
            if (ConsoleAlive()) return true;

            Mutex startGate = null;
            bool hasGate = false;
            try
            {
                // 跨进程启动闸：双击两次、看门狗与手动打开同时发生时，只允许一个实例拉起 node。
                startGate = new Mutex(false, StartMutexName);
                try { hasGate = startGate.WaitOne(StartGateTimeoutMs, false); }
                catch (AbandonedMutexException) { hasGate = true; }

                if (!hasGate)
                {
                    Log("start gate timeout");
                    if (showError) ReportError("控制台启动超时", "另一个启动过程超过 45 秒未结束，请稍后再试。");
                    return false;
                }

                // 等待闸期间可能已经有别的进程把控制台拉起来了。
                if (ConsoleAlive()) return true;

                if (PortListening())
                {
                    // 端口在监听但不是健康接口：可能是控制台正在启动/卡住，也可能是别的程序占用了 7788。
                    // 此时绝不能再拉一个 node，否则只会 EADDRINUSE 退出并制造“重启成功”的假象。
                    Log("port " + ConsolePort + " is listening but /api/health is not ready; wait 10s");
                    if (WaitForConsole(10000)) return true;
                    if (showError)
                    {
                        ReportError("控制台端口被占用",
                            "端口 " + ConsolePort + " 已在监听，但健康检查无响应。可能控制台正在启动、卡住，或被其他程序占用；为避免重复实例，本次不自动启动。");
                    }
                    return false;
                }

                string entry = Path.Combine(projectDir, "console", "server.mjs");
                if (nodeExe == null || !File.Exists(nodeExe))
                {
                    if (showError) ReportError("找不到 node.exe", "请安装 Node.js，或设置 QQB_NODE_EXE 环境变量指向 node.exe。");
                    return false;
                }
                if (!File.Exists(entry))
                {
                    if (showError) ReportError("找不到控制台程序", "缺少 " + entry + "，请检查项目目录 " + projectDir + "。");
                    return false;
                }

                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo(nodeExe, "\"" + entry + "\"");
                    psi.WorkingDirectory = projectDir;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Log("starting console: " + nodeExe + " \"" + entry + "\"");
                    using (Process p = Process.Start(psi))
                    {
                        if (p != null) Log("console process spawned pid=" + p.Id);
                    }
                }
                catch (Exception ex)
                {
                    Log("spawn console failed: " + ex);
                    if (showError) ReportError("控制台启动失败", ex.Message);
                    return false;
                }

                if (WaitForConsole(StartupWaitMs))
                {
                    Log("console ready on port " + ConsolePort);
                    return true;
                }

                Log("console start timed out after " + StartupWaitMs + "ms");
                if (showError)
                {
                    ReportError("控制台未就绪",
                        (StartupWaitMs / 1000) + " 秒内 http://127.0.0.1:" + ConsolePort + "/api/health 无响应，请查看控制台日志。");
                }
                return false;
            }
            catch (Exception ex)
            {
                Log("ensure console failed: " + ex);
                if (showError) ReportError("启动控制台失败", ex.Message);
                return false;
            }
            finally
            {
                if (startGate != null)
                {
                    if (hasGate)
                    {
                        try { startGate.ReleaseMutex(); }
                        catch { }
                    }
                    try { startGate.Dispose(); }
                    catch { }
                }
            }
        }

        private static void OpenPage(string hash)
        {
            if (quitting != 0) return;
            RunBackground(delegate
            {
                if (quitting != 0) return;
                if (!EnsureConsole(true)) return;

                // 探测/拉起控制台可以放在后台，但打开 Edge 的 Process.Start 必须回到
                // WinForms 主线程执行；在 ThreadPool 线程里启动会得到没有 renderer 的空白窗口。
                RunOnUi(delegate
                {
                    if (quitting != 0) return;
                    OpenPageCore(hash);
                });
            });
        }

        private static bool OpenPageSecondInstance()
        {
            if (!EnsureConsole(true)) return false;
            return OpenPageCore("");
        }

        private static bool OpenPageCore(string hash)
        {
            try
            {
                string url = "http://127.0.0.1:" + ConsolePort + "/" + (hash ?? string.Empty);

                if (edgeExe != null)
                {
                    try
                    {
                        Directory.CreateDirectory(edgeProfile);

                        Rectangle area = Screen.PrimaryScreen != null
                            ? Screen.PrimaryScreen.WorkingArea
                            : new Rectangle(0, 0, 1620, 1020);
                        int width = area.Width > 0 ? Math.Min(1620, Math.Max(800, (int)(area.Width * 0.9))) : 1620;
                        int height = area.Height > 0 ? Math.Min(1020, Math.Max(600, (int)(area.Height * 0.9))) : 1020;

                        // 不能直接从本进程 CreateProcess 拉起 Edge：实测在中等完整性、未签名的
                        // 启动器下会得到“有窗口、无 renderer”的白页；直接交给 ShellExecute 又会被
                        // 安全提示拦下。改为用签名的 wscript.exe 执行 open-edge.vbs，由脚本再拉起
                        // Edge，父进程变成 wscript.exe，renderer 正常创建。
                        if (OpenEdgeViaWScript(url, width, height))
                        {
                            Log("open console app window (edge --app via wscript): " + url + " size=" + width + "x" + height);
                            return true;
                        }
                        Log("edge wscript launch failed; falling back to shell URL");
                    }
                    catch (Exception ex)
                    {
                        Log("edge app window failed: " + ex.Message);
                    }
                }

                Log("open console page via shell: " + url);
                // 最后兜底：用系统 shell 打开普通浏览器标签页，避免 32 位进程关联失败。
                Process.Start(new ProcessStartInfo("cmd.exe", "/c start \"\" \"" + url + "\"")
                {
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    UseShellExecute = false
                });
                return true;
            }
            catch (Exception ex)
            {
                Log("open console page failed: " + ex);
                ReportError("打开控制台失败", ex.Message);
                return false;
            }
        }

        private static bool OpenEdgeViaWScript(string url, int width, int height)
        {
            string vbs = Path.Combine(appDir, "open-edge.vbs");
            if (!File.Exists(vbs))
            {
                Log("open-edge.vbs is missing: " + vbs);
                return false;
            }

            string wscript = Path.Combine(Environment.SystemDirectory, "wscript.exe");
            if (!File.Exists(wscript))
            {
                Log("wscript.exe is missing: " + wscript);
                return false;
            }

            // 每个实参都按 Windows 命令行规则单独转义后再拼接：URL 也显式加双引号，
            // 含空格的路径按 CommandLineToArgvW 规则转义，保证 wscript 收到的参数与这里一致。
            // 注意：.NET Framework 4.x 的 ProcessStartInfo 没有 ArgumentList，只能自己转义。
            string args = QuoteArgument(vbs)
                + " " + QuoteArgument(edgeExe)
                + " " + QuoteArgument(url)
                + " " + QuoteArgument(edgeProfile)
                + " " + width.ToString()
                + " " + height.ToString();

            // 记录最终命令行，便于下次出现“参数被截断”时对比（不含任何密钥）。
            Log("wscript command line: \"" + wscript + "\" " + args);

            Process.Start(new ProcessStartInfo(wscript, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
            return true;
        }

        /// <summary>
        /// 按 CommandLineToArgvW 的规则给单个实参加引号/反斜杠转义。
        /// 统一给每个实参加双引号（URL 也变成 "http://127.0.0.1:7788/"），
        /// 引号前的反斜杠按“双写”处理，结尾反斜杠双写，保证参数原样到达 wscript。
        /// </summary>
        private static string QuoteArgument(string value)
        {
            if (value == null) return "\"\"";
            if (value.Length == 0) return "\"\"";

            StringBuilder sb = new StringBuilder(value.Length + 8);
            sb.Append('"');
            int backslashes = 0;
            foreach (char c in value)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    // 引号前已有的反斜杠要双写，再补一个转义反斜杠
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                    backslashes = 0;
                    continue;
                }
                if (backslashes > 0)
                {
                    sb.Append('\\', backslashes);
                    backslashes = 0;
                }
                sb.Append(c);
            }
            // 右引号前的反斜杠也要双写，否则会被当作转义引号
            if (backslashes > 0) sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        private static void OpenFolder(string dir)
        {
            try { Process.Start("explorer.exe", "\"" + dir + "\""); }
            catch { }
        }

        private static void ServiceAction(string path)
        {
            if (quitting != 0) return;
            if (Interlocked.CompareExchange(ref actionBusy, 1, 0) != 0)
            {
                ShowBalloon("请稍候", "已有服务操作正在进行。", ToolTipIcon.Info);
                return;
            }

            RunBackground(delegate
            {
                try
                {
                    if (!EnsureConsole(true)) return;
                    string result = HttpRequest(path, "POST", "{}", 300000);
                    if (result == null)
                    {
                        ShowBalloon("操作失败", "控制台没有响应，请打开控制台查看日志。", ToolTipIcon.Error);
                        return;
                    }
                    if (Regex.IsMatch(result, "\"ok\"\\s*:\\s*false"))
                    {
                        ShowBalloon("操作失败", "控制台返回失败，请打开控制台查看日志。", ToolTipIcon.Error);
                        return;
                    }
                    Log("service action " + path + " completed");
                }
                catch (Exception ex)
                {
                    ShowBalloon("操作失败", ex.Message, ToolTipIcon.Error);
                }
                finally
                {
                    Interlocked.Exchange(ref actionBusy, 0);
                }
            });
        }

        private static int ConsolePid()
        {
            string health = HttpRequest("/api/health", "GET", null, 3000);
            if (health == null) return 0;
            Match m = Regex.Match(health, "\"pid\"\\s*:\\s*(\\d+)");
            int pid;
            return (m.Success && int.TryParse(m.Groups[1].Value, out pid)) ? pid : 0;
        }

        private static void QuitApplication(bool stopServices)
        {
            if (Interlocked.CompareExchange(ref quitting, 1, 0) != 0) return;

            if (!stopServices)
            {
                Log("quit requested (console keeps running)");
                ExitApplication();
                return;
            }

            Log("quit requested (stop all services)");
            ShowBalloon("正在退出", "正在停止全部服务，请稍候…", ToolTipIcon.Info);
            RunBackground(delegate
            {
                try
                {
                    // /api/stop 只停桥接/NapCat/DSH/WorkBuddy，控制台自身随后由这里结束。
                    HttpRequest("/api/stop", "POST", "{}", 300000);
                    int pid = ConsolePid();
                    if (pid > 0)
                    {
                        try { Process.GetProcessById(pid).Kill(); }
                        catch (Exception ex) { Log("kill console failed: " + ex.Message); }
                    }
                    Log("services stop requested; exiting");
                }
                catch (Exception ex)
                {
                    Log("quit-stop failed: " + ex);
                }
                RunOnUi(delegate { ExitApplication(); });
            });
        }

        private static void ExitApplication()
        {
            if (Interlocked.Exchange(ref exiting, 1) != 0) return;
            Log("exiting");
            try { if (watchdog != null) watchdog.Stop(); }
            catch { }
            try { if (tray != null) tray.Visible = false; }
            catch { }
            try { Application.Exit(); }
            catch (Exception ex) { Log("Application.Exit failed: " + ex.Message); }
        }

        private static void CleanupInstance()
        {
            try
            {
                if (watchdog != null)
                {
                    watchdog.Stop();
                    watchdog.Dispose();
                    watchdog = null;
                }
            }
            catch { }
            try
            {
                if (tray != null)
                {
                    tray.Visible = false;
                    tray.Dispose();
                    tray = null;
                }
            }
            catch { }
            try
            {
                if (trayIcon != null && trayIconOwned) trayIcon.Dispose();
                trayIcon = null;
            }
            catch { }
            try
            {
                if (uiMarshal != null)
                {
                    uiMarshal.Dispose();
                    uiMarshal = null;
                }
            }
            catch { }
            try
            {
                if (instanceMutex != null)
                {
                    try { instanceMutex.ReleaseMutex(); }
                    catch { }
                    instanceMutex.Dispose();
                    instanceMutex = null;
                }
            }
            catch { }
        }

        private static string AutoStartCommand()
        {
            // 直接 ShellExecute 这个未签名 exe 会被“打开文件 - 安全警告”拦下；
            // cmd 的 start 使用 CreateProcess，可绕过该提示。
            return "\"" + Path.Combine(Environment.SystemDirectory, "cmd.exe") + "\" /c start \"\" \""
                + Path.Combine(appDir, "QQBridgeConsole.exe") + "\" --autostart";
        }

        private static bool IsAutoStartEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", false))
                {
                    if (key == null) return false;
                    string value = key.GetValue("QQBridgeConsole") as string;
                    return !string.IsNullOrEmpty(value)
                        && string.Equals(value, AutoStartCommand(), StringComparison.OrdinalIgnoreCase);
                }
            }
            catch { return false; }
        }

        private static void SetAutoStart(bool enabled)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (key == null) return;
                    if (enabled)
                        key.SetValue("QQBridgeConsole", AutoStartCommand());
                    else
                        key.DeleteValue("QQBridgeConsole", false);
                }
                ShowBalloon("开机自启", enabled ? "已开启" : "已关闭", ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                ShowBalloon("设置失败", ex.Message, ToolTipIcon.Warning);
            }
        }
    }
}
