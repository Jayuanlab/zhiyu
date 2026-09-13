import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(web, 'public/vendor/fonts');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'provenance.json'), 'utf8'));
const css = fs.readFileSync(path.join(web, 'app/local-fonts.css'), 'utf8');
const references = new Set([...css.matchAll(/url\(\/vendor\/fonts\/([^)]*)\)/g)].map(match => match[1]));
assert.equal(references.size, manifest.assets.length);
assert.equal(/https?:|\/_next\//.test(css), false);
for (const asset of manifest.assets) {
  assert.match(asset.file, /^[a-f0-9]+-s(?:\.p)?\.woff2$/);
  assert(references.has(asset.file));
  const bytes = fs.readFileSync(path.join(root, asset.file));
  assert.equal(bytes.length, asset.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
}
for (const family of ['notosanssc', 'notoserifsc', 'roboto']) {
  const license = fs.readFileSync(path.join(root, `${family}-OFL.txt`), 'utf8');
  assert(license.includes('SIL OPEN FONT LICENSE Version 1.1'));
  assert(license.includes('Copyright'));
}
for (const url of manifest.preloads) assert(references.has(path.basename(url)));
// Optional comparison with the original build also proves ranges, fallback
// metrics and declaration order survived the URL/class-name replacement.
const original = path.join(web, '.tmp', `next-review-${manifest.sourceBuild}`, 'static/css');
let comparedOriginal = false;
if (fs.existsSync(original)) {
  const sources = fs.readdirSync(original).filter(file => file.endsWith('.css')).map(file => fs.readFileSync(path.join(original, file), 'utf8'));
  const normalize = value => value.replace(/\/\*[^]*?\*\//g, '').replace(/\s+/g, '')
    .replace(/\/(?:_next\/static\/media|vendor\/fonts)\//g, '/fonts/')
    .replace(/\.__className_[\w]+|\.zhiyu-font-(?:sans|serif|roboto)(?![\w-])/g, '.font')
    .replace(/\.__variable_[\w]+|\.zhiyu-font-(?:sans|serif|roboto)-variable/g, '.variable');
  const selected = manifest.families.map(family => {
    const matches = sources.filter(source => new RegExp(`font-family:"?${family}"?;`).test(source));
    assert.equal(matches.length, 1);
    return matches[0];
  });
  assert.equal(normalize(css), normalize(selected.join('\n')));
  comparedOriginal = true;
}
console.log(JSON.stringify({ assets: references.size, bytes: manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0), preloads: manifest.preloads.length, licenses: 3, comparedOriginal, passed: true }, null, 2));
