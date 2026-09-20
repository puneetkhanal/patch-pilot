import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const configuredPatterns = (process.env.IDENTIFIER_DENY_PATTERNS || '')
  .split(',')
  .filter(Boolean)
  .map(pattern => new RegExp(pattern, 'i'));
const allowedUrlHosts = [
  'localhost',
  '127.0.0.1',
  'api.github.com',
  'github.com',
  'api.openai.com',
  'example.com',
  'generativelanguage.googleapis.com'
];
const urlPattern = new RegExp(`https?:\\/\\/(?!${allowedUrlHosts.map(host => host.replaceAll('.', '\\.')).join('|')})(?:[^\\s"')]+)`, 'i');
const builtInPatterns = [
  urlPattern,
  /\/[Uu]sers\/[A-Za-z0-9._-]+\//,
  /\b(?!SHA-(?:1|224|256|384|512)\b)[A-Z]{2,10}-\d{2,}\b/
];
const patterns = [...builtInPatterns, ...configuredPatterns];
const skippedNames = new Set([
  'node_modules',
  '.git',
  'dist',
  'package-lock.json',
  '.tracker-state.json',
  '.orchestrator-settings.json'
]);
const hits = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skippedNames.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of patterns) {
      if (pattern.test(text)) hits.push(`${path.relative(root, file)} matches ${pattern}`);
    }
  }
}

walk(root);
if (hits.length) {
  console.error(hits.join('\n'));
  process.exit(1);
}
console.log('identifier audit passed');
