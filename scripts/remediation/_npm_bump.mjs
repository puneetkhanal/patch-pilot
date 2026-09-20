import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const directOnly = args[0] === '--direct-bump';
if (directOnly) args.shift();
const [manifest, packageName, target] = args;
if (!manifest || !packageName || !target) {
  console.error('usage: _npm_bump.mjs [--direct-bump] MANIFEST PACKAGE TARGET');
  process.exit(2);
}
const file = path.resolve(manifest);
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
let changed = false;
for (const bucket of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  if (json[bucket]?.[packageName]) {
    const current = String(json[bucket][packageName]);
    const prefix = current.match(/^[~^]/)?.[0] || '';
    json[bucket][packageName] = `${prefix}${target}`;
    changed = true;
  }
}
if (!changed && !directOnly) {
  json.overrides ||= {};
  json.overrides[packageName] = target;
  changed = true;
}
if (!changed) {
  console.error(`${packageName} is not a direct dependency in ${manifest}`);
  process.exit(3);
}
fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
console.log(`updated_package: ${packageName}@${target}`);
