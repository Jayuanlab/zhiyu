; Compile with ISCC /DPayloadDir=<absolute payload> /DReleaseVersion=<version> /DOutputDir=<absolute output>
#ifndef PayloadDir
  #error PayloadDir must name the validated Windows release payload directory.
#endif
#ifndef ReleaseVersion
  #define ReleaseVersion "0.5.0"
#endif
#ifndef OutputDir
  #define OutputDir SourcePath + "..\..\output\windows-installer"
#endif

[Setup]
AppId={{8BB1A478-108A-418C-891A-38E5F94AA2E8}
AppName=知遇
AppVersion={#ReleaseVersion}
AppPublisher=Zhiyu
AppComments=本机 AI 持续工作台
DefaultDirName={localappdata}\Programs\Zhiyu
DefaultGroupName=知遇
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayIcon={app}\Zhiyu.exe
OutputDir={#OutputDir}
OutputBaseFilename=Zhiyu-Setup-{#ReleaseVersion}-x64
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
CloseApplications=yes
CloseApplicationsFilter=Zhiyu.exe,node.exe,postgres.exe
RestartApplications=no
AppMutex=Local\Zhiyu.Desktop.Running
SetupMutex=Local\Zhiyu.Desktop.Installing
DisableDirPage=yes
DisableWelcomePage=no
UsePreviousTasks=yes
UninstallLogMode=append

[Languages]
Name: "zhcn"; MessagesFile: "compiler:Default.isl"

[LangOptions]
LanguageName=简体中文
LanguageID=$0804
LanguageCodePage=936
DialogFontName=Microsoft YaHei UI
DialogFontSize=9
WelcomeFontName=Microsoft YaHei UI

[Messages]
WelcomeLabel1=欢迎安装知遇
WelcomeLabel2=知遇会安装在您的个人目录中，无需管理员权限。%n%n模型与功能通过首次配置向导设置。个人资料存放在独立目录，升级和卸载默认保留。%n%n关闭浏览器后，后台可继续工作；退出知遇、电脑关机或休眠时，持续任务暂停。
FinishedHeadingLabel=知遇安装完成
FinishedLabelNoIcons=安装已完成。打开知遇后，请按照中文向导设置模型连接并检查运行状态。
FinishedLabel=安装已完成。您可以使用桌面或开始菜单快捷方式打开知遇，并按照中文向导设置模型连接。
ClickFinish=点击“完成”退出安装向导。
ButtonNext=下一步(&N) >
ButtonBack=< 上一步(&B)
ButtonInstall=安装(&I)
ButtonCancel=取消
ButtonFinish=完成
ButtonOK=确定
ButtonYes=是(&Y)
ButtonNo=否(&N)
SetupWindowTitle=安装知遇
SetupAppTitle=知遇安装程序
UninstallAppTitle=卸载知遇
UninstallAppFullTitle=卸载知遇
ConfirmUninstall=确定卸载知遇吗？%n%n个人资料和备份目录会保留，重新安装后仍可使用。
InformationTitle=提示
ConfirmTitle=确认
ErrorTitle=错误
ClickNext=点击“下一步”继续，或点击“取消”退出安装。
WizardSelectTasks=选择快捷方式
SelectTasksDesc=选择您需要的快捷方式。
SelectTasksLabel2=请选择安装时创建的快捷方式，然后点击“下一步”。
WizardReady=准备安装
ReadyLabel1=现在可以开始在本机安装知遇。
ReadyLabel2a=点击“安装”开始，或点击“上一步”修改设置。
ReadyLabel2b=点击“安装”开始。
ReadyMemoDir=安装目录：
ReadyMemoTasks=快捷方式：
WizardPreparing=准备安装
PreparingDesc=正在检查知遇后台和安装条件。
WizardInstalling=正在安装
InstallingLabel=正在安装知遇，请稍候。
StatusCreateDirs=正在创建目录…
StatusExtractFiles=正在释放软件文件…
StatusCreateIcons=正在创建快捷方式…
StatusCreateRegistryEntries=正在保存安装信息…
StatusSavingUninstall=正在保存卸载信息…
StatusRunProgram=正在完成安装…
StatusRollback=正在回滚本次安装…
ExitSetupTitle=退出安装
ExitSetupMessage=安装尚未完成。现在退出将不会完成软件安装。%n%n您可以稍后重新运行安装包。%n%n确定退出安装吗？
SetupAlreadyRunning=安装程序已经在运行。
SetupAppRunningError=知遇仍在运行。%n%n请在系统托盘右键知遇，选择“退出知遇”，等待后台停止后点击“确定”。
UninstallAppRunningError=知遇仍在运行。%n%n请在系统托盘右键知遇，选择“退出知遇”，等待后台停止后点击“确定”。
CannotContinue=当前无法继续安装。请点击“取消”，处理提示的问题后重新安装。
ApplicationsFound=仍有程序正在使用需要更新的文件。请先关闭知遇后台，避免中断正在执行的任务。
CloseApplications=关闭正在使用安装文件的程序
DontCloseApplications=保留正在运行的程序
ErrorCloseApplications=无法关闭占用安装文件的程序。请先从系统托盘退出知遇后重试。
StatusClosingApplications=正在等待占用文件的程序退出…
WindowsVersionNotSupported=知遇需要 Windows 10 或 Windows 11 的 x64 系统。
DiskSpaceWarningTitle=磁盘空间不足
DiskSpaceWarning=安装至少需要 %1 KB 可用空间，当前仅有 %2 KB。%n%n是否继续？
ErrorCreatingDir=无法创建目录“%1”。请检查磁盘空间和目录权限。
SetupFileMissing=安装文件“%1”缺失，请重新下载安装包。
SetupFileCorrupt=安装文件损坏，请重新下载安装包。
SetupAborted=安装未完成。%n%n请处理提示的问题后重新运行安装包。
ErrorExecutingProgram=无法运行文件：%n%1
AbortRetryIgnoreSelectAction=请选择处理方式
AbortRetryIgnoreRetry=重试
AbortRetryIgnoreIgnore=忽略错误并继续
AbortRetryIgnoreCancel=取消安装
RetryCancelSelectAction=请选择处理方式
RetryCancelRetry=重试
RetryCancelCancel=取消
WizardUninstalling=正在卸载
UninstallStatusLabel=正在卸载知遇，请稍候。个人资料和备份会保留。
StatusUninstalling=正在卸载 %1…
UninstalledAll=知遇已卸载。个人资料和备份目录已保留。
UninstalledMost=知遇卸载完成。%n%n部分软件文件未能删除，可手动处理。个人资料和备份目录已保留。

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: checkedonce

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\Zhiyu.exe"; DestName: "ZhiyuPreflight.exe"; Flags: dontcopy

[Icons]
Name: "{userprograms}\知遇"; Filename: "{app}\Zhiyu.exe"; WorkingDir: "{app}"; Comment: "打开知遇工作台"; Check: ShouldCreateShortcuts
Name: "{userdesktop}\知遇"; Filename: "{app}\Zhiyu.exe"; WorkingDir: "{app}"; Tasks: desktopicon; Check: ShouldCreateShortcuts

[Run]
Filename: "{app}\Zhiyu.exe"; Parameters: "--after-install"; Description: "打开知遇并进行首次配置"; Flags: nowait postinstall skipifsilent

[Code]
function ShouldCreateShortcuts(): Boolean;
var
  Index: Integer;
begin
  Result := not WizardNoIcons;
  for Index := 1 to ParamCount do
    if CompareText(ParamStr(Index), '/NOICONS') = 0 then
      Result := False;
end;

function CheckNotRunning(const Executable: String): Boolean;
var
  ExitCode: Integer;
begin
  Result := False;
  if not Exec(Executable, '--check-running', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    Exit;
  Result := ExitCode = 0;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  ExtractTemporaryFile('ZhiyuPreflight.exe');
  if not CheckNotRunning(ExpandConstant('{tmp}\ZhiyuPreflight.exe')) then
    Result := '知遇后台仍在运行，或无法确认它已退出。请在系统托盘右键“知遇”，选择“退出知遇”，等待后台停止后再安装。升级不会强制中断正在执行的任务。';
end;

function InitializeUninstall(): Boolean;
begin
  // Protect the complete uninstall operation, including the preflight-to-delete gap.
  CreateMutex('Local\Zhiyu.Desktop.Installing');
  Result := CheckNotRunning(ExpandConstant('{app}\Zhiyu.exe'));
  if not Result then
    SuppressibleMsgBox('请先在系统托盘退出知遇，等待后台停止后再卸载。卸载会保留个人资料和备份。', mbError, MB_OK, IDOK);
end;

// There are intentionally no AppData entries or UninstallDelete directives.
// Application updates and uninstallation must never remove personal data.
