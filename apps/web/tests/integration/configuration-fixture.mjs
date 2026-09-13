import {readFileSync} from 'node:fs';
import YAML from 'yaml';

export function configurationManifest(name) {
  const manifest=YAML.parse(readFileSync(new URL('../../../../manifests/workshops/paper-trader.workshop.yaml',import.meta.url),'utf8'));
  manifest.metadata.name=name;
  manifest.metadata.title='隔离导入车间';
  manifest.spec.role='reviewer';
  const first=structuredClone(manifest.spec.loops[0]);
  first.name='old-target';first.title='旧目标';first.goal='更新后的观察目标';
  first.trigger={type:'cron',expression:'0 8 * * *',timezone:'Asia/Shanghai'};
  const second=structuredClone(first);second.name='new-target';second.title='新目标';
  manifest.spec.loops=[first,second];
  manifest.spec.sources=[{name:'old-source',type:'manual',purpose:'保留已有源'},{name:'new-source',type:'manual',purpose:'新资料源'}];
  return {manifest,yaml:YAML.stringify(manifest)};
}
