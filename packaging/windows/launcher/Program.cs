using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Zhiyu.Desktop
{
    internal static class Program
    {
        internal static readonly string InstallRoot = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        internal static string DataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Zhiyu", "data");
        internal static bool NoOpen;
        internal static bool AfterInstall;
        internal static string MutexName
        {
            get
            {
                using (SHA256 hash = SHA256.Create())
                {
                    string fingerprint = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(DataDirectory).TrimEnd('\\').ToUpperInvariant()))).Replace("-", "").Substring(0, 24);
                    return @"Local\Zhiyu.Launcher." + WindowsIdentity.GetCurrent().User.Value + "." + fingerprint;
                }
            }
        }
        internal const string InstallerMutexName = @"Local\Zhiyu.Desktop.Running";
        internal const string InstallationMutexName = @"Local\Zhiyu.Desktop.Installing";

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                for (int index = 0; index < args.Length; index++)
                {
                    if (args[index] == "--data-dir")
                    {
                        if (++index >= args.Length) throw new ArgumentException("--data-dir 需要指定绝对目录。");
                        string root = Path.GetPathRoot(args[index]);
                        if (String.IsNullOrEmpty(root) || (!root.StartsWith(@"\\") && (root.Length < 3 || root[1] != ':' || (root[2] != '\\' && root[2] != '/'))))
                            throw new ArgumentException("--data-dir 需要指定绝对目录。");
                        DataDirectory = Path.GetFullPath(args[index]);
                    }
                    else if (args[index] == "--no-open") NoOpen = true;
                    else if (args[index] == "--after-install") AfterInstall = true;
                    else if (args[index] != "--check-running") throw new ArgumentException("无法识别启动参数：" + args[index]);
                }
            }
            catch (Exception ex)
            {
                if (Array.IndexOf(args, "--check-running") < 0)
                    MessageBox.Show(ex.Message, "知遇启动参数错误", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 2;
            }
            // The installer executes a temporary copy to inspect the SAME per-user data directory.
            if (Array.IndexOf(args, "--check-running") >= 0)
                return ManagerClient.CheckRunning() ? 10 : 0;

            // Inno's postinstall child starts just before Setup exits. Wait for Setup
            // to release its guard; this never bypasses the installation boundary.
            if (AfterInstall)
            {
                DateTime deadline = DateTime.UtcNow.AddSeconds(60);
                while (InstallationInProgress() && DateTime.UtcNow < deadline) Thread.Sleep(200);
            }
            if (InstallationInProgress()) return RefuseDuringInstallation();

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool ownsMutex;
            using (Mutex mutex = new Mutex(true, MutexName, out ownsMutex))
            {
                if (!ownsMutex)
                {
                    if (NoOpen) return 0;
                    try
                    {
                        bool opened = false;
                        for (int attempt = 0; attempt < 15 && !opened; attempt++)
                        {
                            try { ManagerClient.Request("POST", "/api/open", 5000); opened = true; }
                            catch { Thread.Sleep(500); }
                        }
                        if (!opened)
                            MessageBox.Show("知遇正在启动或退出。请在系统托盘查看当前状态后重试。", "知遇", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    catch (Exception ex) { MessageBox.Show(ex.Message, "无法打开知遇", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
                    return 0;
                }
                // Inno Setup checks this session-local guard in addition to the runtime preflight.
                using (Mutex installationGuard = new Mutex(false, InstallerMutexName))
                try
                {
                    // Close the gap between the first check and acquiring our running guard.
                    if (InstallationInProgress()) return RefuseDuringInstallation();
                    Application.Run(new LauncherContext());
                }
                catch (Exception ex)
                {
                    MessageBox.Show("知遇启动失败：" + ex.Message + "\n个人资料仍保存在：\n" + DataDirectory, "知遇", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }

        private static bool InstallationInProgress()
        {
            try
            {
                Mutex guard;
                if (!Mutex.TryOpenExisting(InstallationMutexName, out guard)) return false;
                guard.Dispose();
                return true;
            }
            catch (UnauthorizedAccessException) { return true; }
        }

        private static int RefuseDuringInstallation()
        {
            if (!NoOpen)
                MessageBox.Show("知遇正在安装、升级或卸载。请等待操作完成后再打开知遇。", "知遇", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 3;
        }
    }

    internal static class ManagerClient
    {
        internal static Dictionary<string, object> ReadState()
        {
            string path = Path.Combine(Program.DataDirectory, "runtime", "state.json");
            string json = File.ReadAllText(path, Encoding.UTF8);
            return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
        }

        internal static bool DataDirectoryOwned()
        {
            try
            {
                if (!Directory.Exists(Program.DataDirectory)) return false;
                string marker = Path.Combine(Program.DataDirectory, ".zhiyu-install-data");
                if (!File.Exists(marker) || (File.GetAttributes(marker) & FileAttributes.ReparsePoint) != 0) return false;
                for (DirectoryInfo ancestor = new DirectoryInfo(Program.DataDirectory); ancestor != null; ancestor = ancestor.Parent)
                    if ((ancestor.Attributes & FileAttributes.ReparsePoint) != 0) return false;
                string logs = Path.Combine(Program.DataDirectory, "logs");
                if (Directory.Exists(logs) && (File.GetAttributes(logs) & FileAttributes.ReparsePoint) != 0) return false;
                return File.ReadAllText(marker, Encoding.UTF8).Trim() == "zhiyu-private-install-data-v1";
            }
            catch { return false; }
        }

        internal static Dictionary<string, object> Request(string method, string route, int timeout)
        {
            Dictionary<string, object> state = ReadState();
            int port = Convert.ToInt32(state["managerPort"], CultureInfo.InvariantCulture);
            if (port < 1 || port > 65535) throw new InvalidDataException("后台端口信息无效。");
            string token = File.ReadAllText(Path.Combine(Program.DataDirectory, "runtime", "control-token"), Encoding.UTF8).Trim();
            if (String.IsNullOrEmpty(token) || token.Length > 4096) throw new InvalidDataException("后台访问凭据无效。");
            string origin = "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture);
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(origin + route);
            request.Method = method;
            request.Proxy = null;
            request.Timeout = timeout;
            request.ReadWriteTimeout = timeout;
            request.AllowAutoRedirect = false;
            request.Headers["X-Zhiyu-Token"] = token;
            request.Headers["Origin"] = origin;
            request.Headers["X-Zhiyu-CSRF"] = token;
            if (method == "POST")
            {
                byte[] body = Encoding.UTF8.GetBytes("{}");
                request.ContentType = "application/json";
                request.ContentLength = body.Length;
                using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
            }
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                Dictionary<string, object> result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                if (result == null) throw new InvalidDataException("后台返回了无效的状态。");
                if (result.ContainsKey("ok") && Object.Equals(result["ok"], false))
                    throw new InvalidOperationException(Text(result, "error", "后台未完成操作。"));
                return result;
            }
        }

        internal static bool CheckRunning()
        {
            Mutex existing;
            if (Mutex.TryOpenExisting(Program.MutexName, out existing))
            {
                existing.Dispose();
                return true;
            }
            try { Request("GET", "/api/status", 2000); return true; }
            catch { }
            // If the API is temporarily unavailable, refuse to overwrite a live bundled process.
            try
            {
                Dictionary<string, object> state = ReadState();
                int pid = Convert.ToInt32(state["pid"], CultureInfo.InvariantCulture);
                using (Process process = Process.GetProcessById(pid))
                {
                    if (process.HasExited) return false;
                    try
                    {
                        string module = process.MainModule.FileName;
                        return String.Equals(Path.GetFileName(module), "node.exe", StringComparison.OrdinalIgnoreCase);
                    }
                    catch { return true; }
                }
            }
            catch (ArgumentException) { return false; }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
            catch { return File.Exists(Path.Combine(Program.DataDirectory, "runtime", "state.json")); }
        }

        internal static bool ManagerProcessAlive()
        {
            try
            {
                Dictionary<string, object> state = ReadState();
                int pid = Convert.ToInt32(state["pid"], CultureInfo.InvariantCulture);
                using (Process process = Process.GetProcessById(pid)) return !process.HasExited;
            }
            catch (ArgumentException) { return false; }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
            catch { return true; }
        }

        internal static bool HasConfirmedManagerStop(Process managedProcess)
        {
            try
            {
                if (managedProcess == null || !managedProcess.HasExited || managedProcess.ExitCode != 0) return false;
                Dictionary<string, object> state = ReadState();
                return Convert.ToInt32(state["pid"], CultureInfo.InvariantCulture) == managedProcess.Id &&
                    Text(state, "status", null) == "stopped";
            }
            catch { return false; }
        }

        internal static string Text(Dictionary<string, object> source, string key, string fallback)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : fallback;
        }
    }

    internal sealed class LauncherContext : ApplicationContext
    {
        private readonly NotifyIcon tray;
        private readonly ToolStripMenuItem stateItem;
        private readonly ToolStripMenuItem openItem;
        private readonly ToolStripMenuItem backupItem;
        private readonly ToolStripMenuItem quitItem;
        private readonly System.Windows.Forms.Timer timer;
        private readonly Control dispatcher;
        private Process managerProcess;
        private int checking;
        private int starting;
        private bool quitting;
        private string statusDetail = "正在启动知遇本地后台…";
        private Form statusForm;
        private TextBox statusText;
        private readonly object logLock = new object();
        private string startupDiagnosticPath;
        private string lastStartupDiagnostic;

        internal LauncherContext()
        {
            dispatcher = new Control();
            dispatcher.CreateControl();
            // Force handle creation on the UI thread before ThreadPool callbacks.
            IntPtr ignored = dispatcher.Handle;
            stateItem = new ToolStripMenuItem("状态：启动中");
            stateItem.Enabled = false;
            openItem = new ToolStripMenuItem("打开知遇", null, delegate { OpenOrStart(); });
            ToolStripMenuItem inspectItem = new ToolStripMenuItem("查看状态", null, delegate { ShowStatus(); });
            backupItem = new ToolStripMenuItem("备份个人资料", null, delegate { Backup(); });
            quitItem = new ToolStripMenuItem("退出知遇", null, delegate { Quit(); });
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.AddRange(new ToolStripItem[] { stateItem, new ToolStripSeparator(), openItem, inspectItem, backupItem, new ToolStripSeparator(), quitItem });
            tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "知遇 · 启动中", ContextMenuStrip = menu, Visible = true };
            tray.DoubleClick += delegate { OpenOrStart(); };
            timer = new System.Windows.Forms.Timer { Interval = 3000 };
            timer.Tick += delegate { RefreshState(); };
            timer.Start();
            OpenOrStart(!Program.NoOpen);
        }

        private void OnUi(Action action)
        {
            try { if (!dispatcher.IsDisposed) dispatcher.BeginInvoke(action); }
            catch (InvalidOperationException) { /* The user may have completed shutdown during an in-flight poll. */ }
        }

        private void OpenOrStart(bool openBrowser = true)
        {
            if (quitting || Interlocked.Exchange(ref starting, 1) != 0) return;
            openItem.Enabled = false;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    try { ManagerClient.Request(openBrowser ? "POST" : "GET", openBrowser ? "/api/open" : "/api/status", 5000); }
                    catch
                    {
                        if ((managerProcess != null && !managerProcess.HasExited) || ManagerClient.ManagerProcessAlive())
                            throw new InvalidOperationException("后台仍在启动或发生异常，请查看状态和日志；不会重复启动另一个后台。");
                        string node = Path.Combine(Program.InstallRoot, "vendor", "node", "node.exe");
                        string script = Path.Combine(Program.InstallRoot, "runtime", "manager.mjs");
                        if (!File.Exists(node) || !File.Exists(script))
                            throw new FileNotFoundException("安装文件不完整，请重新安装知遇。");
                        // The manager establishes ownership before creating its data tree.
                        // Precreating even one subdirectory makes a fresh tree unowned.
                        ProcessStartInfo info = new ProcessStartInfo(node,
                            Quote(script) + " --install-root " + Quote(Program.InstallRoot) + " --data-dir " + Quote(Program.DataDirectory) + (openBrowser ? " --open" : ""));
                        info.UseShellExecute = false;
                        info.CreateNoWindow = true;
                        info.WindowStyle = ProcessWindowStyle.Hidden;
                        info.WorkingDirectory = Program.InstallRoot;
                        info.RedirectStandardOutput = true;
                        info.RedirectStandardError = true;
                        managerProcess = new Process { StartInfo = info, EnableRaisingEvents = true };
                        managerProcess.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) WriteLog(e.Data); };
                        managerProcess.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) WriteLog(e.Data); };
                        if (!managerProcess.Start()) throw new InvalidOperationException("未能启动本地后台。");
                        managerProcess.BeginOutputReadLine();
                        managerProcess.BeginErrorReadLine();
                        OnUi(delegate { SetState("启动中", "本地后台进程已启动，正在等待真实运行状态…", null); });
                    }
                }
                catch (Exception ex)
                {
                    WriteLog("Open failed: " + ex.Message);
                    OnUi(delegate { SetState("无法启动", ex.Message, ex.Message); Notify("知遇无法启动", ex.Message, ToolTipIcon.Error); ShowStatus(); });
                }
                finally { Interlocked.Exchange(ref starting, 0); OnUi(delegate { if (!quitting) openItem.Enabled = true; RefreshState(); }); }
            });
        }

        private void RefreshState()
        {
            if (quitting || Interlocked.Exchange(ref checking, 1) != 0) return;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    Dictionary<string, object> state = ManagerClient.Request("GET", "/api/status", 2500);
                    string status = ManagerClient.Text(state, "status", "unknown");
                    string label = StatusLabel(status);
                    string error = ManagerClient.Text(state, "error", null);
                    StringBuilder detail = new StringBuilder();
                    detail.AppendLine("状态：" + label);
                    detail.AppendLine("后台进程：" + ManagerClient.Text(state, "pid", "未知"));
                    detail.AppendLine("最近心跳：" + FormatTime(ManagerClient.Text(state, "updatedAt", "未提供")));
                    if (!String.IsNullOrEmpty(error)) detail.AppendLine("异常：" + error);
                    object components;
                    if (state.TryGetValue("components", out components) && components != null)
                    {
                        detail.AppendLine();
                        detail.AppendLine("组件状态：");
                        Dictionary<string, object> componentMap = components as Dictionary<string, object>;
                        if (componentMap != null)
                        {
                            foreach (KeyValuePair<string, object> component in componentMap)
                            {
                                Dictionary<string, object> values = component.Value as Dictionary<string, object>;
                                detail.AppendLine(ComponentLabel(component.Key) + "：" + StatusLabel(ManagerClient.Text(values, "phase", "unknown")));
                                string heartbeat = ManagerClient.Text(values, "lastHeartbeat", null);
                                string componentError = ManagerClient.Text(values, "error", null);
                                if (!String.IsNullOrEmpty(heartbeat)) detail.AppendLine("  最近心跳：" + FormatTime(heartbeat));
                                if (!String.IsNullOrEmpty(componentError)) detail.AppendLine("  异常：" + componentError);
                            }
                        }
                        else detail.AppendLine("后台暂未提供可读的组件状态，请在网页查看详情。");
                    }
                    detail.AppendLine();
                    detail.AppendLine("关闭浏览器后，后台仍继续运行。退出知遇、关机或休眠后，持续任务暂停。");
                    detail.AppendLine("个人资料：" + Program.DataDirectory);
                    OnUi(delegate { SetState(label, detail.ToString(), error); });
                }
                catch (Exception ex)
                {
                    // The settings page can request a graceful manager shutdown too.
                    // Exit only for OUR child and its confirmed final state; retain the
                    // tray on crashes and when another instance owns the state file.
                    if (ManagerClient.HasConfirmedManagerStop(managerProcess))
                    {
                        OnUi(delegate { quitting = true; ExitThread(); });
                        return;
                    }
                    string label = (managerProcess != null && !managerProcess.HasExited) || ManagerClient.ManagerProcessAlive() ? "后台暂未响应" : "后台已停止";
                    OnUi(delegate { SetState(label, "状态：" + label + "\r\n最近检查：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "\r\n原因：" + ex.Message +
                        (String.IsNullOrEmpty(lastStartupDiagnostic) ? "" : "\r\n启动诊断：" + lastStartupDiagnostic) +
                        (String.IsNullOrEmpty(startupDiagnosticPath) ? "" : "\r\n启动日志：" + startupDiagnosticPath) +
                        "\r\n\r\n个人资料：" + Program.DataDirectory + "\r\n可尝试打开知遇，或查看日志后重试。", ex.Message); });
                }
                finally { Interlocked.Exchange(ref checking, 0); }
            });
        }

        private void SetState(string label, string detail, string error)
        {
            if (quitting) return;
            statusDetail = detail;
            stateItem.Text = "状态：" + label;
            tray.Text = "知遇 · " + label;
            if (statusText != null && !statusText.IsDisposed) statusText.Text = detail;
        }

        private void ShowStatus()
        {
            if (statusForm != null && !statusForm.IsDisposed) { statusForm.Activate(); return; }
            statusForm = new Form { Text = "知遇 · 运行状态", StartPosition = FormStartPosition.CenterScreen, Size = new Size(720, 470), MinimumSize = new Size(540, 360), Font = new Font("Microsoft YaHei UI", 9F) };
            statusText = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = true, Dock = DockStyle.Fill, Text = statusDetail, BackColor = SystemColors.Window };
            FlowLayoutPanel buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 48, Padding = new Padding(8) };
            Button refresh = new Button { Text = "刷新状态", AutoSize = true };
            refresh.Click += delegate { RefreshState(); };
            Button logs = new Button { Text = "打开日志目录", AutoSize = true };
            logs.Click += delegate
            {
                try
                {
                    if (!ManagerClient.DataDirectoryOwned())
                    {
                        if (!String.IsNullOrEmpty(startupDiagnosticPath) && File.Exists(startupDiagnosticPath))
                            Process.Start(new ProcessStartInfo(startupDiagnosticPath) { UseShellExecute = true });
                        else MessageBox.Show(statusForm, "个人资料目录尚未完成初始化。请先查看当前运行状态；知遇不会写入未受管理的目录。", "启动诊断", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        return;
                    }
                    string directory = Path.Combine(Program.DataDirectory, "logs");
                    Directory.CreateDirectory(directory);
                    Process.Start(new ProcessStartInfo(directory) { UseShellExecute = true });
                }
                catch (Exception ex) { MessageBox.Show(statusForm, ex.Message, "无法打开日志", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            };
            buttons.Controls.Add(refresh);
            buttons.Controls.Add(logs);
            statusForm.Controls.Add(statusText);
            statusForm.Controls.Add(buttons);
            statusForm.Show();
            RefreshState();
        }

        private void Backup()
        {
            if (quitting || !backupItem.Enabled) return;
            backupItem.Enabled = false;
            quitItem.Enabled = false;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    Dictionary<string, object> response = ManagerClient.Request("POST", "/api/backup", 300000);
                    string path = ManagerClient.Text(response, "path", null);
                    if (String.IsNullOrEmpty(path) || (!File.Exists(path) && !Directory.Exists(path)))
                        throw new InvalidDataException("后台未返回可确认的备份文件，请查看日志。");
                    OnUi(delegate { MessageBox.Show("备份已完成：\n" + path, "知遇", MessageBoxButtons.OK, MessageBoxIcon.Information); });
                }
                catch (Exception ex) { OnUi(delegate { MessageBox.Show("备份未完成：" + ex.Message, "知遇", MessageBoxButtons.OK, MessageBoxIcon.Warning); }); }
                finally { OnUi(delegate { if (!quitting) { backupItem.Enabled = true; quitItem.Enabled = true; } }); }
            });
        }

        private void Quit()
        {
            if (quitting || !quitItem.Enabled) return;
            quitting = true;
            timer.Stop();
            openItem.Enabled = false;
            backupItem.Enabled = false;
            quitItem.Enabled = false;
            stateItem.Text = "状态：正在安全退出";
            tray.Text = "知遇 · 正在安全退出";
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    if (ManagerClient.ManagerProcessAlive())
                    {
                        ManagerClient.Request("POST", "/api/shutdown", 30000);
                        DateTime deadline = DateTime.UtcNow.AddSeconds(45);
                        while (ManagerClient.ManagerProcessAlive() && DateTime.UtcNow < deadline) Thread.Sleep(400);
                        if (ManagerClient.ManagerProcessAlive()) throw new InvalidOperationException("后台还未退出，可能正在保存资料。请稍后再次退出，或查看日志。");
                    }
                    OnUi(delegate { ExitThread(); });
                }
                catch (Exception ex)
                {
                    OnUi(delegate
                    {
                        quitting = false;
                        openItem.Enabled = true;
                        backupItem.Enabled = true;
                        quitItem.Enabled = true;
                        timer.Start();
                        SetState("退出未完成", ex.Message, ex.Message);
                        MessageBox.Show("退出未完成：" + ex.Message, "知遇", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    });
                }
            });
        }

        private void WriteLog(string line)
        {
            lastStartupDiagnostic = line;
            try
            {
                lock (logLock)
                {
                    string path;
                    if (ManagerClient.DataDirectoryOwned())
                    {
                        string directory = Path.Combine(Program.DataDirectory, "logs");
                        Directory.CreateDirectory(directory);
                        path = Path.Combine(directory, "launcher.log");
                    }
                    else
                    {
                        // Keep startup failures observable without claiming or changing
                        // a data tree that the manager has not yet accepted.
                        if (String.IsNullOrEmpty(startupDiagnosticPath)) startupDiagnosticPath = CreateStartupDiagnostic();
                        path = startupDiagnosticPath;
                    }
                    if (File.Exists(path) && new FileInfo(path).Length >= 5 * 1024 * 1024)
                    {
                        string previous = path + ".1";
                        if (File.Exists(previous)) File.Delete(previous);
                        File.Move(path, previous);
                        if (path == startupDiagnosticPath) CreatePrivateDiagnosticFile(path);
                    }
                    if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                        throw new IOException("日志文件被重定向，已停止写入。");
                    File.AppendAllText(path, DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch { /* A full disk must not prevent the tray from reporting the original failure. */ }
        }

        private static string CreateStartupDiagnostic()
        {
            string temporary = Path.GetFullPath(Path.GetTempPath());
            string data = Path.GetFullPath(Program.DataDirectory).TrimEnd(Path.DirectorySeparatorChar);
            if (temporary.TrimEnd(Path.DirectorySeparatorChar).Equals(data, StringComparison.OrdinalIgnoreCase) ||
                temporary.StartsWith(data + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new IOException("启动诊断不能写入未受管理的个人资料目录。");
            for (DirectoryInfo ancestor = new DirectoryInfo(temporary); ancestor != null; ancestor = ancestor.Parent)
                if (!ancestor.Exists || (ancestor.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("无法确认临时诊断目录的实际位置。");
            // A data alias must not turn the independent Temp file into an
            // unowned data write. Inspect existing ancestors without creating any.
            DirectoryInfo dataAncestor = new DirectoryInfo(data);
            while (dataAncestor != null && !dataAncestor.Exists) dataAncestor = dataAncestor.Parent;
            for (; dataAncestor != null; dataAncestor = dataAncestor.Parent)
                if ((dataAncestor.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("无法确认个人资料目录的实际位置，已停止文件诊断。");
            string path = Path.Combine(temporary, "Zhiyu-launcher-diagnostic-" + Guid.NewGuid().ToString("N") + ".log");
            CreatePrivateDiagnosticFile(path);
            return path;
        }

        private static void CreatePrivateDiagnosticFile(string path)
        {
            FileSecurity security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            SecurityIdentifier currentUser = WindowsIdentity.GetCurrent().User;
            security.SetOwner(currentUser);
            security.AddAccessRule(new FileSystemAccessRule(currentUser, FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
            using (FileStream file = new FileStream(path, FileMode.CreateNew, FileSystemRights.Write, FileShare.Read, 4096, FileOptions.None, security)) { }
        }

        private void Notify(string title, string message, ToolTipIcon icon)
        {
            tray.ShowBalloonTip(10000, title, message, icon);
        }

        private static string Quote(string argument)
        {
            // Windows command-line quoting, including trailing backslashes in install/data roots.
            StringBuilder result = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char character in argument)
            {
                if (character == '\\') { backslashes++; continue; }
                if (character == '"') { result.Append('\\', backslashes * 2 + 1); result.Append('"'); }
                else { result.Append('\\', backslashes); result.Append(character); }
                backslashes = 0;
            }
            result.Append('\\', backslashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private static string StatusLabel(string status)
        {
            switch (status)
            {
                case "ready": case "running": return "运行中";
                case "setup_required": return "等待首次配置";
                case "starting": return "启动中";
                case "migrating": return "正在升级资料结构";
                case "configuring": return "正在应用配置";
                case "pending": return "等待启动";
                case "initializing": return "正在初始化";
                case "healthy": return "正常";
                case "stopped": return "已暂停";
                case "paused": return "已暂停";
                case "pausing": return "正在暂停";
                case "resuming": return "正在恢复";
                case "stopping": return "正在退出";
                case "degraded": return "部分功能异常";
                case "error": case "failed": return "运行异常";
                case "backing_up": return "正在备份";
                case "unresponsive": return "暂未响应";
                case "stop_unconfirmed": return "退出待确认";
                case "not_configured": return "等待配置";
                case "configured": return "配置已保存";
                case "not_installed": return "尚未安装";
                case "idle": return "等待工作";
                case "lost": return "连接中断";
                case "success": return "执行成功";
                case "settled_after_abort": return "中断后已恢复";
                case "disabled": return "未启用";
                case "unavailable": return "暂不可用";
                default: return "状态待确认";
            }
        }

        private static string ComponentLabel(string name)
        {
            switch (name)
            {
                case "postgres": case "database": case "db": return "个人数据库";
                case "web": case "next": return "网页工作台";
                case "runner": case "worker": case "runtime": return "持续任务后台";
                case "model": return "模型连接";
                case "manager": return "本地管理服务";
                default: return name;
            }
        }

        private static string FormatTime(string value)
        {
            DateTimeOffset parsed;
            return DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out parsed)
                ? parsed.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") : value;
        }

        protected override void ExitThreadCore()
        {
            timer.Stop();
            timer.Dispose();
            tray.Visible = false;
            tray.Dispose();
            if (statusForm != null && !statusForm.IsDisposed) statusForm.Close();
            if (managerProcess != null) managerProcess.Dispose();
            dispatcher.Dispose();
            base.ExitThreadCore();
        }
    }
}
