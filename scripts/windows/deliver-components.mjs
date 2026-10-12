import { copyFile, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './release-lib.mjs';

const workspace = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const inputs = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]?.replace(/^--/, '');
  if (!['installer', 'manifest', 'runtime-report', 'installer-report', 'wechat-report', 'setup-report', 'privacy-report'].includes(name) || !process.argv[index + 1]) throw new Error('delivery_argument_invalid');
  inputs[name] = resolve(process.argv[index + 1]);
}
for (const name of ['installer', 'manifest', 'runtime-report', 'installer-report', 'wechat-report', 'setup-report', 'privacy-report']) if (!inputs[name]) throw new Error(`delivery_argument_missing:${name}`);
const load = async path => JSON.parse(await readFile(path, 'utf8'));
const manifest = await load(inputs.manifest);
const reports = Object.fromEntries(await Promise.all(['runtime-report', 'installer-report', 'wechat-report', 'setup-report', 'privacy-report'].map(async key => [key, await load(inputs[key])])));
if (manifest.product !== 'Zhiyu' || manifest.platform !== 'win32-x64' || manifest.optionalComponents?.quant !== true || manifest.optionalComponents?.wechat !== true || manifest.optionalComponents?.python !== true) throw new Error('delivery_component_manifest_required');
for (const [key, report] of Object.entries(reports)) {
  const passed = key === 'setup-report' ? report.ok === true : report.passed === true;
  if (!passed || report.passed === false || report.ok === false) throw new Error(`delivery_verification_not_passed:${key}`);
}
const installerHash = await sha256(inputs.installer), manifestHash = await sha256(inputs.manifest);
if (reports['installer-report'].installerSha256 !== installerHash || reports['installer-report'].referenceManifestSha256 !== manifestHash) throw new Error('delivery_installer_evidence_mismatch');
if (reports['runtime-report'].sourceManifestSha256 !== manifestHash) throw new Error('delivery_runtime_evidence_mismatch');
if (reports['privacy-report'].sourceManifestSha256 !== manifestHash) throw new Error('delivery_privacy_evidence_mismatch');
const fileHashes = new Map(manifest.files.map(file => [file.path, file.sha256]));
const wechat = reports['wechat-report'];
if (wechat.readerSha256 !== fileHashes.get('vendor/wechat-reader/wx.exe') ||
    wechat.componentSourceSha256?.server !== fileHashes.get('components/wechat/server.py') ||
    wechat.componentSourceSha256?.bootstrapReader !== fileHashes.get('components/wechat/bootstrap-reader.ps1') ||
    wechat.checks?.length < 12 || !wechat.checks.every(check => check.passed === true)) throw new Error('delivery_wechat_evidence_mismatch');
const setup = reports['setup-report'];
if (setup.sourceHashesMatchedAfterRun !== true) throw new Error('delivery_setup_source_changed');
for (const name of ['setup.html', 'setup.js', 'components.mjs', 'manager.mjs']) {
  if (setup.sourceHashes?.[name] !== fileHashes.get(`runtime/${name}`)) throw new Error('delivery_setup_evidence_mismatch');
}
const output = join(workspace, 'output', 'windows-release', manifest.version);
await mkdir(output, { recursive: true });
if (await realpath(output) !== output) throw new Error('delivery_directory_must_be_ordinary');
const name = `Zhiyu-Setup-${manifest.version}-x64.exe`, target = join(output, name);
let previousDeliveryArchive = null;
if (existsSync(target)) {
  const old = await load(join(output, 'delivery.json'));
  if (old.installer.sha256 !== await sha256(target)) throw new Error('previous_delivery_not_owned');
  const archive = join(workspace, 'output', 'windows-installer', `previous-delivery-${Date.now()}`);
  await mkdir(archive);
  for (const file of [name, `${name}.sha256`, '使用说明.txt', 'delivery.json']) {
    const source = join(output, file);
    if (!existsSync(source)) continue;
    await copyFile(source, join(archive, file));
    if (await sha256(source) !== await sha256(join(archive, file))) throw new Error('previous_delivery_archive_not_confirmed');
  }
  // Only the verified, archived release executable is replaced. No user data.
  await unlink(target);
  previousDeliveryArchive = archive;
}
const pending = `${target}.partial`;
if (existsSync(pending)) throw new Error('delivery_pending_file_requires_review');
await copyFile(inputs.installer, pending);
if (await sha256(pending) !== installerHash) throw new Error('delivery_copy_not_confirmed');
await rename(pending, target);
await writeFile(`${target}.sha256`, `${installerHash}  ${name}\n`, 'utf8');
const bytes = (await stat(target)).size;
const guide = `知遇 ${manifest.version} · Windows 微信与量化试用安装版

安装包约 ${(bytes / 1_000_000).toFixed(1)} MB，程序展开后约 3.1 GB；建议预留至少 6 GB 空间。

一、开始使用
1. 双击 ${name}，按向导安装。程序文件较多，请等待安装进度完成后再打开知遇。
已有知遇在运行时，先从托盘退出知遇，再运行安装程序；重新安装前建议先做冷备份。
2. 从桌面或开始菜单打开“知遇”。填写自己的模型接口地址、模型名称与密钥，保存后检测连接。
3. 在“启用微信和量化”选择需要的组件，保存设置，再点击“启动知遇”。进入工作台后先完成一次普通对话。

二、微信
安装包已包含私有读取端、桌面发送服务和 Python。使用者仍需安装并登录本人电脑版微信（读取端面向微信 4.x）。
停止后台后，勾选“启用微信”和本人消息接入授权，再点击“保存并接入本人微信”。仅在页面提示权限不足时，点击管理员权限接入并处理 Windows 权限窗口。
接入后在微信工作台核对消息内容与时间。实际读取是否兼容当前微信版本仍需在这台电脑验证。
读取授权与发送开关分别保存；允许发送后仍须审核、预览和确认。窗口存在不等于已登录，界面显示已执行发送不等于对方已收到。结果未确认时不要重复发送。
保持 Windows 桌面解锁，留意配置页的读取端、窗口和失败状态。

三、量化
勾选量化并启动后，会创建独立、全新的模拟账户，初始模拟资金 100 万元，不导入开发者账户或旧盘。
量化只做模拟交易，不连接真实券商账户。行情来源需要网络，数据降级、时间和覆盖范围以量化页面提示为准。
自选股猎手维护自选股池，操盘交易员消费当前自选股；安装本身不会建立自动交易任务。

四、后台与资料
关闭浏览器后后台仍运行；托盘“退出知遇”会收尾服务。关机、休眠或退出期间不执行持续任务。
程序默认位于 %LOCALAPPDATA%\\Programs\\Zhiyu；个人资料位于 %LOCALAPPDATA%\\Zhiyu\\data。
暂停停止新任务，正在执行的动作仍可能完成。配置页可停止后台、查看心跳和失败原因、做冷备份。
备份含个人资料、微信接入凭据和模型密钥，请妥善保存。卸载默认保留资料；恢复目前由维护者停机操作。

五、验证范围
本机独立副本的 Web、数据库、量化固定行情测试、微信合成数据隔离测试、安装/退出/卸载已通过。
打包测试没有读取或发送本机真实微信消息，没有使用真实市场行情或付费模型。使用者的微信版本与真实模型生成仍需首次使用时核对。
当前安装包未做数字签名，干净 Windows 虚拟机、升级失败及自动恢复向导尚未验收。
网页自动化浏览器、Office/PDF 渲染器和视频工具不在本包内；依赖这些组件的技能仍需额外配置。

安装文件：${name}
大小：${bytes} bytes
SHA-256：${installerHash}
`;
await writeFile(join(output, '使用说明.txt'), guide, 'utf8');
const delivery = { schemaVersion: 1, kind: 'windows-components-trial-delivery', version: manifest.version, platform: manifest.platform, createdAt: new Date().toISOString(),
  installer: { name, bytes, sha256: installerHash }, manifest: { sha256: manifestHash, fileCount: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0) },
  verification: { fullRuntime: 'passed', finalInstaller: 'passed', wechatSynthetic: 'passed', desktopSetup: 'passed', realWechatRead: false, realWechatSend: false, realMarketCalls: false, productionModelCalls: false,
    evidence: Object.fromEntries(await Promise.all(Object.keys(reports).map(async key => [key, { sha256: await sha256(inputs[key]), kind: reports[key].kind || key }])) ) },
  components: manifest.optionalComponents, signature: { status: 'NotSigned' }, limitations: ['Clean Windows VM untested', 'Real WeChat compatibility untested', 'Real model generation untested', 'No automatic restore wizard'],
  instructions: { name: '使用说明.txt', sha256: await sha256(join(output, '使用说明.txt')) } };
await writeFile(join(output, 'delivery.json'), `${JSON.stringify(delivery, null, 2)}\n`, 'utf8');
const internalDirectory = join(workspace, 'output/windows-installer-check', `delivery-${randomUUID()}`);
await mkdir(internalDirectory);
const internalReceipt = join(internalDirectory, 'receipt.json');
await writeFile(internalReceipt, JSON.stringify({ passed: true, kind: 'windows-component-delivery-internal',
  createdAt: new Date().toISOString(), inputs, output, previousDeliveryArchive, installerSha256: installerHash,
  manifestSha256: manifestHash, publishedMetadataSha256: await sha256(join(output, 'delivery.json')) }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ event: 'components_delivery_completed', output, installer: target, bytes, sha256: installerHash, previousDeliveryArchive, internalReceipt }));
