import fs from 'node:fs/promises';
import path from 'node:path';
import { IssueUpgradeAnalysis, TrackerIssue } from '../domain/types.js';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.dependabot-worktrees']);
const MAX_IMPORT_FILES = 50;
const MAX_IMPORT_LINES = 200;

function manifestFile(projectPath: string, manifestPath: string) {
  const root = path.resolve(projectPath);
  const target = path.resolve(root, manifestPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('manifestPath must stay inside projectPath');
  return target;
}

async function findPackageLock(projectPath: string, manifestDirectory: string) {
  const root = path.resolve(projectPath);
  let directory = manifestDirectory;
  while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
    const candidate = path.join(directory, 'package-lock.json');
    try { await fs.access(candidate); return candidate; } catch { /* try parent */ }
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  return undefined;
}

function lockfileExcerpt(lock: any, packageName: string) {
  const entries: Record<string, unknown> = {};
  for (const [packagePath, metadata] of Object.entries<any>(lock.packages || {})) {
    if (!packagePath) continue;
    const name = packagePath.includes('node_modules/') ? packagePath.split('node_modules/').pop()! : packagePath;
    if (name === packageName || packagePath.endsWith(`/node_modules/${packageName}`)) {
      entries[packagePath] = {
        version: metadata.version,
        dependencies: metadata.dependencies,
        peerDependencies: metadata.peerDependencies,
        optionalDependencies: metadata.optionalDependencies
      };
    }
  }
  return entries;
}

function importPatterns(packageName: string) {
  const scoped = packageName.startsWith('@');
  const base = scoped ? packageName : packageName.split('/')[0];
  return [
    new RegExp(`from\\s+['"]${packageName}(?:/[^'"]*)?['"]`, 'g'),
    new RegExp(`require\\(\\s*['"]${packageName}(?:/[^'"]*)?['"]\\s*\\)`, 'g'),
    new RegExp(`import\\(\\s*['"]${packageName}(?:/[^'"]*)?['"]\\s*\\)`, 'g'),
    new RegExp(`from\\s+['"]${base}(?:/[^'"]*)?['"]`, 'g'),
    new RegExp(`require\\(\\s*['"]${base}(?:/[^'"]*)?['"]\\s*\\)`, 'g')
  ];
}

async function walkSourceFiles(root: string, directory: string, files: string[]) {
  if (files.length >= MAX_IMPORT_FILES) return;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= MAX_IMPORT_FILES) break;
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walkSourceFiles(root, fullPath, files);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    files.push(fullPath);
  }
}

async function collectImportUsage(projectPath: string, packageName: string) {
  const root = path.resolve(projectPath);
  const files: string[] = [];
  await walkSourceFiles(root, root, files);
  const patterns = importPatterns(packageName);
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    if (hits.length >= MAX_IMPORT_LINES) break;
    const content = await fs.readFile(file, 'utf8');
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (hits.length >= MAX_IMPORT_LINES) break;
      const line = lines[index];
      if (!patterns.some(pattern => pattern.test(line))) continue;
      hits.push({ file: path.relative(root, file), line: index + 1, text: line.trim() });
    }
  }
  return hits;
}

export interface IssueRepoContext {
  issue: {
    packageName: string;
    patchedVersion: string;
    vulnerableVersionRange: string;
    manifestPath: string;
    manifestPaths?: string[];
    severity: string;
    alerts: number[];
  };
  manifest?: Record<string, unknown>;
  lockfileExcerpt?: Record<string, unknown>;
  importUsage: Array<{ file: string; line: number; text: string }>;
  heuristicAnalysis?: IssueUpgradeAnalysis;
}

export async function collectIssueRepoContext(
  issue: TrackerIssue,
  projectPath: string,
  heuristic?: IssueUpgradeAnalysis
): Promise<IssueRepoContext> {
  const manifestPath = manifestFile(projectPath, issue.manifestPath);
  const manifestDirectory = path.dirname(manifestPath);
  const context: IssueRepoContext = {
    issue: {
      packageName: issue.packageName,
      patchedVersion: issue.patchedVersion,
      vulnerableVersionRange: issue.vulnerableVersionRange,
      manifestPath: issue.manifestPath,
      manifestPaths: issue.manifestPaths,
      severity: issue.severity,
      alerts: issue.alerts
    },
    importUsage: []
  };
  try {
    context.manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch { /* manifest unavailable */ }
  try {
    const lockPath = await findPackageLock(projectPath, manifestDirectory);
    if (lockPath) {
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as any;
      context.lockfileExcerpt = lockfileExcerpt(lock, issue.packageName);
    }
  } catch { /* lockfile unavailable */ }
  try {
    context.importUsage = await collectImportUsage(projectPath, issue.packageName);
  } catch { /* import scan failed */ }
  if (heuristic) context.heuristicAnalysis = heuristic;
  return context;
}
