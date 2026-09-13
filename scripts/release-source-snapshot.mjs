import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
export function captureReleaseSources(root) {
  const git = args => execFileSync('git', args, {cwd:root,windowsHide:true,maxBuffer:32*1024*1024});
  const candidates = [...new Set(git(['ls-files','-z','--cached','--others','--exclude-standard']).toString('utf8').split('\0').filter(Boolean))];
  const files = [];
  for (const file of candidates.sort()) {
    if (!/^(apps\/web\/|packages\/|tools\/|scripts\/|manifests\/|package\.json$|pnpm-lock\.yaml$)/.test(file)) continue;
    if (/(^|\/)(\.env[^/]*|node_modules|\.next|\.tmp|\.venv|venv|__pycache__|dist|build|coverage|tests|records)(\/|$)/.test(file)) continue;
    if (file.endsWith('next-env.d.ts') || /\.test\.[^.]+$/.test(file)) continue;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|json|yaml|yml|css|sql|toml|txt)$/.test(file)) continue;
    const target = path.resolve(root,file);
    if (!target.startsWith(path.resolve(root)+path.sep)) throw Error('Invalid source path');
    let stat;
    try {stat=lstatSync(target);} catch(error) {if(error.code==='ENOENT')continue;throw error;}
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    files.push({path:file,sha256:hash(readFileSync(target))});
  }
  return {capturedAt:new Date().toISOString(),revision:git(['rev-parse','HEAD']).toString('utf8').trim(),
    sourceHash:hash(JSON.stringify(files)),files,
    scope:'Git-visible source/config files, including untracked files; excludes env, generated outputs, tests and binary assets. Not a deployment configuration or asset fingerprint.'};
}
