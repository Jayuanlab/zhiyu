import { copyFile, cp, mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertWithin, filesUnder, run, sha256, within } from './release-lib.mjs';

// A public continuation published by the original wx-cli author. This is a
// patched application component, NOT the upstream's unmodified release binary.
export const WECHAT_READER_SOURCE = Object.freeze({
  repository: 'https://github.com/jackwener/wx-cli-again',
  commit: '077a54cbfe679bda963cd038d8440422907fc797',
  version: '0.6.3',
  archiveSha256: 'e29ff8ec85dd4417d1a8ce8fad68baca49d637352a4ef1b25fc3db03e1b4c615',
  license: 'Apache-2.0',
  patchId: 'zhiyu-private-reader-v1',
});
const RUST = { version: '1.90.0', target: 'x86_64-pc-windows-msvc', sha256: 'a2db311d0ac032a97717c9280d85fc31d6ccc34b330f8a095b63a1bc042744f6' };
const PERL = { version: '5.40.2.2', url: 'https://github.com/StrawberryPerl/Perl-Dist-Strawberry/releases/download/SP_54022_64bit/strawberry-perl-5.40.2.2-64bit-portable.zip', sha256: '7df5cdc41e8638c00b2aa00cccc69ec8cd5a5ad0ec265c81f389beffb53b6920' };
const NOTICE = '// Modified by Zhiyu: private data directory, authenticated per-directory IPC and owned graceful shutdown.\n';

export function patchWechatReaderSource(files) {
  const result = { ...files };
  function replace(file, before, after) {
    const text = result[file];
    if (!text?.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`wechat_reader_patch_requires_review:${file}`);
    result[file] = text.replace(before, after);
  }
  replace('src/config.rs', 'fn find_config_file() -> Result<PathBuf> {', `fn find_config_file() -> Result<PathBuf> {
    if std::env::var_os("WX_CLI_HOME").is_some() { return Ok(cli_dir().join("config.json")); }`);
  replace('src/config.rs', 'pub fn cli_dir() -> PathBuf {\n    cli_home_dir().join(".wx-cli")\n}', `pub fn cli_dir() -> PathBuf {
    if let Some(value) = std::env::var_os("WX_CLI_HOME") { return PathBuf::from(value); }
    cli_home_dir().join(".wx-cli")
}

pub fn pipe_name() -> String {
    format!("zhiyu-wx-reader-{:x}", md5::compute(cli_dir().to_string_lossy().to_lowercase().as_bytes()))
}

pub fn encode_private_request(req: &crate::ipc::Request) -> Result<String> {
    let mut envelope = serde_json::to_value(req)?;
    envelope.as_object_mut().unwrap().insert("_zhiyu_token".into(), serde_json::Value::String(std::env::var("WX_CLI_SESSION_TOKEN").unwrap_or_default()));
    Ok(serde_json::to_string(&envelope)? + "\\n")
}

pub fn decode_private_request(line: &str) -> Result<crate::ipc::Request> {
    let envelope: serde_json::Value = serde_json::from_str(line)?;
    let expected = std::env::var("WX_CLI_SESSION_TOKEN").unwrap_or_default();
    let provided = envelope.get("_zhiyu_token").and_then(|value| value.as_str()).unwrap_or("");
    let equal = expected.len() >= 32 && expected.len() == provided.len()
        && expected.bytes().zip(provided.bytes()).fold(0u8, |diff, (a,b)| diff | (a ^ b)) == 0;
    if !equal { anyhow::bail!("wechat_reader_credential_required"); }
    Ok(serde_json::from_value(envelope)?)
}`);
  replace('src/cli/init.rs', 'fn find_or_create_config_path() -> std::path::PathBuf {', `fn find_or_create_config_path() -> std::path::PathBuf {
    if std::env::var_os("WX_CLI_HOME").is_some() { return config::cli_dir().join("config.json"); }`);
  replace('src/cli/mod.rs', 'pub mod transport;', 'pub(crate) mod transport;');
  replace('src/ipc.rs', '    Ping,', '    Ping,\n    ZhiyuShutdown,');
  replace('src/daemon/server.rs', 'use crate::ipc::{Request, Response};', 'use crate::ipc::{Request, Response};\nstatic ZHIYU_SHUTDOWN: tokio::sync::Notify = tokio::sync::Notify::const_new();');
  replace('src/daemon/server.rs', '        Ping => Response::ok(serde_json::json!({ "pong": true })),', '        Ping => Response::ok(serde_json::json!({ "pong": true, "pid": std::process::id() })),\n        ZhiyuShutdown => Response::ok(serde_json::json!({ "stopping": true })),');
  replace('src/daemon/server.rs', '    let name = "wx-cli-daemon".to_ns_name::<GenericNamespaced>()?;', '    let pipe_name = crate::config::pipe_name();\n    let name = pipe_name.to_ns_name::<GenericNamespaced>()?;');
  replace('src/daemon/server.rs', '        let conn = listener.accept().await?;', '        let conn = tokio::select! {\n            accepted = listener.accept() => accepted?,\n            _ = ZHIYU_SHUTDOWN.notified() => return Ok(()),\n        };');
  const windowsServer = result['src/daemon/server.rs'].indexOf('async fn handle_connection_windows(');
  if (windowsServer < 0) throw new Error('wechat_reader_windows_server_missing');
  const prefix = result['src/daemon/server.rs'].slice(0, windowsServer);
  let body = result['src/daemon/server.rs'].slice(windowsServer);
  body = body.replace('let req: Request = match serde_json::from_str(&line)', 'let req: Request = match crate::config::decode_private_request(&line)');
  body = body.replace('    let resp = dispatch(req, &db, &names).await;', '    let is_shutdown = matches!(req, Request::ZhiyuShutdown);\n    let resp = dispatch(req, &db, &names).await;');
  body = body.replace('    writer.write_all(resp.to_json_line()?.as_bytes()).await?;\n    Ok(())', '    writer.write_all(resp.to_json_line()?.as_bytes()).await?;\n    writer.flush().await?;\n    if is_shutdown { ZHIYU_SHUTDOWN.notify_one(); }\n    Ok(())');
  result['src/daemon/server.rs'] = prefix + body;
  replace('src/cli/transport.rs', '    let name = "wx-cli-daemon".to_ns_name::<GenericNamespaced>()?;', '    let pipe_name = config::pipe_name();\n    let name = pipe_name.to_ns_name::<GenericNamespaced>()?;');
  replace('src/cli/transport.rs', '    let name = "wx-cli-daemon"\n        .to_ns_name::<GenericNamespaced>()', '    let pipe_name = config::pipe_name();\n    let name = pipe_name\n        .to_ns_name::<GenericNamespaced>()');
  const windowsPing = result['src/cli/transport.rs'].indexOf('fn ping_windows()');
  const pingEnd = result['src/cli/transport.rs'].indexOf('fn pid_belongs_to_daemon(', windowsPing);
  const pingText = result['src/cli/transport.rs'].slice(windowsPing, pingEnd);
  replace('src/cli/transport.rs', pingText, pingText.replace('serde_json::to_string(&Request::Ping)? + "\\n"', 'config::encode_private_request(&Request::Ping)?'));
  const sendStart = result['src/cli/transport.rs'].indexOf('fn send_windows(');
  const sendText = result['src/cli/transport.rs'].slice(sendStart);
  replace('src/cli/transport.rs', sendText, sendText.replace('serde_json::to_string(&req)? + "\\n"', 'config::encode_private_request(&req)?'));
  replace('src/cli/transport.rs', 'let mut buf = vec![0u16; 260];', 'let mut buf = vec![0u16; 32768];');
  result['src/cli/transport.rs'] += `
// Safe metadata/status APIs for the installed runtime: never start a daemon or query messages.
#[cfg(windows)]
pub fn zhiyu_runtime_status() -> serde_json::Value {
    let response = send_windows(Request::Ping).ok();
    let pid = response.as_ref().and_then(|r| r.data.get("pid")).and_then(|v| v.as_u64());
    let recorded = read_pid_file(&config::pid_path()).ok().flatten();
    let process_running = recorded.as_ref().map(|p| pid_belongs_to_daemon(p).unwrap_or(false)).unwrap_or(false);
    serde_json::json!({"running": response.is_some() || process_running, "responsive": response.is_some(), "pid": pid.or_else(|| recorded.map(|p| p.pid as u64)), "privateDataDirHash": config::pipe_name()})
}

#[cfg(windows)]
pub fn zhiyu_runtime_stop() -> Result<serde_json::Value> {
    let before = zhiyu_runtime_status();
    if before.get("running").and_then(|v| v.as_bool()) != Some(true) { return Ok(serde_json::json!({"running":false,"stopped":true,"pid":null})); }
    if before.get("responsive").and_then(|v| v.as_bool()) != Some(true) { anyhow::bail!("wechat_reader_stop_unconfirmed"); }
    let pid = before.get("pid").and_then(|v| v.as_u64()).ok_or_else(|| anyhow::anyhow!("wechat_reader_pid_missing"))? as u32;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
    // Hold the authenticated process handle before asking it to stop. A path
    // probe failure or PID reuse must never be treated as proof of process exit.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) }?;
    let outcome = (|| -> Result<serde_json::Value> {
        let mut buffer = vec![0u16;32768]; let mut length = buffer.len() as u32;
        unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_FORMAT(0), PWSTR(buffer.as_mut_ptr()), &mut length) }?;
        let actual = PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize]));
        if normalize_exe_path(&actual) != normalize_exe_path(&std::env::current_exe()?) { anyhow::bail!("wechat_reader_process_ownership_unconfirmed"); }
        send_windows(Request::ZhiyuShutdown)?;
        if unsafe { WaitForSingleObject(handle,15000) } != WAIT_OBJECT_0 { anyhow::bail!("wechat_reader_stop_unconfirmed"); }
        Ok(serde_json::json!({"running":false,"stopped":true,"pid":pid}))
    })();
    let _ = unsafe { CloseHandle(handle) };
    outcome
}
`;
  replace('src/main.rs', 'fn main() {', `fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 2 && args[1] == "--zhiyu-build-info" {
        println!("{}", serde_json::json!({"upstreamVersion":"0.6.3","sourceCommit":"077a54cbfe679bda963cd038d8440422907fc797","patchId":"zhiyu-private-reader-v1","privateDataRequired":true,"authenticatedIpc":true})); return;
    }
    let metadata_only = args.len() == 2 && ["--help","-h","--version","-V"].contains(&args[1].as_str());
    if !metadata_only {
        let home = std::env::var_os("WX_CLI_HOME").map(std::path::PathBuf::from);
        if !home.as_ref().map(|p| p.is_absolute()).unwrap_or(false) || std::env::var("WX_CLI_SESSION_TOKEN").unwrap_or_default().len() < 32 {
            eprintln!("wechat_reader_private_directory_and_credential_required"); std::process::exit(64);
        }
        #[cfg(windows)]
        if args.len() == 2 && args[1] == "--zhiyu-runtime-status" { println!("{}", cli::transport::zhiyu_runtime_status()); return; }
        #[cfg(windows)]
        if args.len() == 2 && args[1] == "--zhiyu-runtime-stop" {
            match cli::transport::zhiyu_runtime_stop() {
                Ok(value) => println!("{}", value),
                Err(_) => { eprintln!("wechat_reader_stop_unconfirmed"); std::process::exit(65); }
            }
            return;
        }
    }`);
  for (const file of Object.keys(result)) if (result[file] !== files[file]) result[file] = NOTICE + result[file];
  return result;
}

async function download(url, path, expected, logFile) {
  if (!existsSync(path)) {
    await run('curl.exe', ['--fail','--location','--retry','3','--silent','--show-error','--output',`${path}.partial`,url], {logFile});
    if (await sha256(`${path}.partial`) !== expected) throw new Error(`wechat_download_checksum_mismatch:${path}`);
    await rename(`${path}.partial`, path);
  }
  if (await sha256(path) !== expected) throw new Error(`wechat_cached_checksum_mismatch:${path}`);
}

export async function buildWechatReader({ workspaceRoot, stageRoot, toolchainDirectory, toolchain, logFile } = {}) {
  workspaceRoot ??= resolve(fileURLToPath(new URL('../..', import.meta.url)));
  stageRoot ??= join(workspaceRoot, 'output', 'windows-wechat-component');
  toolchainDirectory ??= join(toolchain ?? join(workspaceRoot, 'output', 'windows-toolchain'), 'wechat-reader');
  assertWithin(join(workspaceRoot, 'output'), toolchainDirectory);
  if (!isAbsolute(stageRoot)) throw new Error('wechat_reader_absolute_stage_required');
  if (!within(join(workspaceRoot,'output'),stageRoot)) {
    // The release coordinator created a short physical stage to avoid Windows
    // long paths. Accept only its explicit, UUID-marked owned payload folder.
    const parent=dirname(stageRoot), expected=basename(parent).match(/^components-([0-9a-f-]{36})$/)?.[1];
    if(basename(stageRoot)!=='payload'||!expected||String(await readFile(join(parent,'.zhiyu-build-owned'),'utf8')).trim()!==expected) throw new Error('wechat_reader_external_stage_ownership_required');
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('wechat_reader_windows_x64_build_required');
  await mkdir(toolchainDirectory,{recursive:true});
  logFile ??= join(toolchainDirectory, 'build.log');
  const sourceArchive = join(toolchainDirectory, 'wx-cli-source.tar.gz');
  await download(`https://codeload.github.com/jackwener/wx-cli-again/tar.gz/${WECHAT_READER_SOURCE.commit}`,sourceArchive,WECHAT_READER_SOURCE.archiveSha256,logFile);
  // Native Perl/MSVC dependencies still impose MAX_PATH limits. Keep both
  // source and Cargo output short; the source receipt retains the full pin.
  const source=join(toolchainDirectory,'src');await mkdir(source,{recursive:true});
  await run('tar.exe',['-xf',sourceArchive,'-C',source,'--strip-components','1'],{logFile});
  const filenames = ['src/config.rs','src/cli/init.rs','src/cli/mod.rs','src/cli/transport.rs','src/ipc.rs','src/daemon/server.rs','src/main.rs'];
  const original = Object.fromEntries(await Promise.all(filenames.map(async name=>[name,await readFile(join(source,name),'utf8')])));
  const patched = patchWechatReaderSource(original);
  const patches = [];
  for(const name of filenames){
    const beforeSha256 = await sha256(join(source,name));
    await writeFile(join(source,name),patched[name],'utf8');
    patches.push({file:name,beforeSha256,afterSha256:await sha256(join(source,name))});
  }
  const rustName = `rust-${RUST.version}-${RUST.target}`;
  const rustArchive = join(toolchainDirectory,`${rustName}.tar.xz`);
  await download(`https://static.rust-lang.org/dist/${rustName}.tar.xz`,rustArchive,RUST.sha256,logFile);
  const rustExtraction = join(toolchainDirectory,'rust-source'); await mkdir(rustExtraction,{recursive:true});
  const rustSdk = join(toolchainDirectory,'rust');
  if(!existsSync(join(rustSdk,'bin','cargo.exe'))){
    await run('tar.exe',['-xf',rustArchive,'-C',rustExtraction,`${rustName}/rustc/bin`,`${rustName}/rustc/lib`,`${rustName}/cargo/bin`,`${rustName}/rust-std-${RUST.target}/lib`],{logFile});
    await mkdir(rustSdk,{recursive:true});
    for(const [component,folder] of [['rustc','bin'],['rustc','lib'],['cargo','bin'],[`rust-std-${RUST.target}`,'lib']]) await cp(join(rustExtraction,rustName,component,folder),join(rustSdk,folder),{recursive:true});
  }
  const perlArchive=join(toolchainDirectory,`strawberry-perl-${PERL.version}-portable.zip`);
  await download(PERL.url,perlArchive,PERL.sha256,logFile);
  const perlRoot=join(toolchainDirectory,'perl');
  const perlExecutable=join(perlRoot,'perl','bin','perl.exe');
  if(!existsSync(perlExecutable)){
    await mkdir(perlRoot,{recursive:true});
    await run('tar.exe',['-xf',perlArchive,'-C',perlRoot],{logFile});
  }
  const buildEnvironment=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|PROCESSOR_.*|NUMBER_OF_PROCESSORS|OS|LANG|LC_.*)$/i.test(key)));
  const compilerScript=join(workspaceRoot,'scripts/windows/compile-wechat-reader.ps1');
  const compilationKey=createHash('sha256').update(JSON.stringify({source:WECHAT_READER_SOURCE,patches,rust:RUST,perl:PERL,compilerSha256:await sha256(compilerScript),cargoLockSha256:await sha256(join(source,'Cargo.lock'))})).digest('hex');
  const binaryPath=join(toolchainDirectory,`target/${RUST.target}/release/wx.exe`), metadataPath=join(toolchainDirectory,'cargo-metadata.json'), cacheReceipt=join(toolchainDirectory,'compiled-receipt.json');
  const previous=existsSync(cacheReceipt)?JSON.parse(await readFile(cacheReceipt,'utf8')):null;
  const cached=previous?.compilationKey===compilationKey&&existsSync(binaryPath)&&existsSync(metadataPath)&&await sha256(binaryPath)===previous.binarySha256&&await sha256(metadataPath)===previous.metadataSha256;
  if(!cached){
    await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',compilerScript,'-SourceDirectory',source,'-RustDirectory',rustSdk,'-BuildDirectory',toolchainDirectory,'-PerlExecutable',perlExecutable],{logFile,env:buildEnvironment});
    await writeFile(cacheReceipt,JSON.stringify({compilationKey,binarySha256:await sha256(binaryPath),metadataSha256:await sha256(metadataPath)},null,2)+'\n','utf8');
  }
  const destination = join(stageRoot,'vendor','wechat-reader'); await mkdir(destination,{recursive:true});
  await copyFile(binaryPath,join(destination,'wx.exe'));
  await copyFile(join(source,'LICENSE'),join(destination,'LICENSE'));
  await copyFile(join(source,'Cargo.lock'),join(destination,'Cargo.lock'));
  const metadata = JSON.parse(await readFile(metadataPath,'utf8'));
  const nodes=new Map(metadata.resolve.nodes.map(node=>[node.id,node])), selected=new Set(), pending=[metadata.resolve.root];
  while(pending.length){const id=pending.pop();if(selected.has(id))continue;if(!nodes.has(id))throw new Error('wechat_windows_dependency_resolution_missing');selected.add(id);for(const dep of nodes.get(id).deps){if(dep.dep_kinds.some(kind=>kind.kind!=='dev'))pending.push(dep.pkg);}}
  metadata.packages=metadata.packages.filter(pkg=>selected.has(pkg.id));
  const crates = [];
  for(const pkg of metadata.packages){
    const licenses=[];
    const pkgRoot=dirname(pkg.manifest_path);
    // Native crates vendor OpenSSL/SQLCipher/zstd licenses below their wrapper
    // package root; retain those notices as well as the Rust wrapper licenses.
    const selected=(await filesUnder(pkgRoot)).filter(file=>/^(?:LICENSE|COPYING|NOTICE)(?:[._-].*)?$/i.test(basename(file))||file===pkg.license_file);
    for(const file of selected){
      const licensePath=`licenses/${pkg.name}-${pkg.version}/${relative(pkgRoot,file).replaceAll('\\','/')}`;
      await mkdir(dirname(join(destination,licensePath)),{recursive:true});await copyFile(file,join(destination,licensePath));licenses.push(licensePath);
    }
    crates.push({name:pkg.name,version:pkg.version,license:pkg.license,repository:pkg.repository,licenseFiles:licenses});
  }
  const nativeNotices=[];
  async function retainNative(component,version,license,crateName,sourceFiles,headerNotice){
    const pkg=metadata.packages.find(pkg=>pkg.name===crateName);
    if(!pkg)throw new Error(`wechat_native_license_package_missing:${crateName}`);
    const root=dirname(pkg.manifest_path), licenseFiles=[];
    for(const sourceFile of sourceFiles){
      const target=`licenses/native-${component}/${basename(sourceFile)}`;
      await mkdir(dirname(join(destination,target)),{recursive:true});await copyFile(join(root,sourceFile),join(destination,target));
      licenseFiles.push({path:target,sha256:await sha256(join(destination,target)),sourceFile});
    }
    if(headerNotice){
      const content=await readFile(join(root,headerNotice.file),'utf8');
      const notice=headerNotice.lines?content.split(/\r?\n/).slice(0,headerNotice.lines).join('\n')+'\n':content.slice(0,content.indexOf('*/')+2)+'\n';
      if(!notice.includes('opyright'))throw new Error(`wechat_native_copyright_notice_missing:${component}`);
      const target=`licenses/native-${component}/COPYRIGHT-NOTICE`;
      await mkdir(dirname(join(destination,target)),{recursive:true});await writeFile(join(destination,target),notice,'utf8');
      licenseFiles.push({path:target,sha256:await sha256(join(destination,target)),sourceFile:headerNotice.file,sourceSha256:await sha256(join(root,headerNotice.file)),extractedHeader:true});
    }
    nativeNotices.push({component,version,license,source:{crate:pkg.name,crateVersion:pkg.version,registry:pkg.source,repository:pkg.repository},licenseFiles});
  }
  await retainNative('openssl','3.5.0','Apache-2.0','openssl-src',['openssl/LICENSE.txt','openssl/AUTHORS.md','openssl/ACKNOWLEDGEMENTS.md'],{file:'openssl/include/openssl/opensslv.h.in'});
  await retainNative('sqlcipher','4.5.3','BSD-3-Clause','libsqlite3-sys',['sqlcipher/LICENSE']);
  await retainNative('sqlite','3.39.4','Public-Domain','libsqlite3-sys',[],{file:'sqlcipher/sqlite3.h',lines:11});
  await retainNative('zstd','1.5.7','BSD-3-Clause','zstd-sys',['zstd/LICENSE','zstd/COPYING']);
  await run('tar.exe',['-xf',rustArchive,'-C',rustExtraction,`${rustName}/LICENSE-APACHE`,`${rustName}/LICENSE-MIT`,`${rustName}/COPYRIGHT`],{logFile});
  const rustLicenseFiles=[];
  for(const name of ['LICENSE-APACHE','LICENSE-MIT','COPYRIGHT']){
    const licensePath=`licenses/rust-std-${RUST.version}/${name}`;await mkdir(dirname(join(destination,licensePath)),{recursive:true});await copyFile(join(rustExtraction,rustName,name),join(destination,licensePath));rustLicenseFiles.push(licensePath);
  }
  const receipt={schemaVersion:1,component:'wechat-reader',...WECHAT_READER_SOURCE,upstreamBinary:false,patches,rust:{...RUST,licenseFiles:rustLicenseFiles},buildPerl:PERL,compilationKey,cargoLockSha256:await sha256(join(destination,'Cargo.lock')),binarySha256:await sha256(join(destination,'wx.exe')),crates,nativeNotices};
  await writeFile(join(destination,'zhiyu-build.json'),JSON.stringify(receipt,null,2)+'\n','utf8');
  await writeFile(join(destination,'NOTICE'),'This wx-cli component was built by Zhiyu from the recorded upstream source commit. Modified files carry notices. Changes add mandatory private storage, authenticated per-directory Windows IPC, safe metadata APIs and graceful owned shutdown. Upstream author and dependency attribution is retained in LICENSE, licenses/ and zhiyu-build.json.\n','utf8');
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt=await buildWechatReader();console.log(JSON.stringify({component:receipt.component,version:receipt.version,sourceCommit:receipt.commit,binarySha256:receipt.binarySha256,patchId:receipt.patchId}));
}
