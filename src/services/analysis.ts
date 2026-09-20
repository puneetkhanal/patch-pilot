import fs from 'node:fs/promises';
import path from 'node:path';
import { Config } from '../config/env.js';
import {
  AiAnalysisProvider,
  DependencyGraph,
  IssueAiUpgradeAnalysis,
  IssueCursorUpgradeAnalysis,
  IssueFinalUpgradeVerification,
  IssueUpgradeAnalysis,
  RepositoryUpgradeAnalysis,
  TrackerIssue,
  UpgradeRiskLevel,
  UpgradeVerdict
} from '../domain/types.js';
import { resolveProvider } from './aiProvider.js';
import { generateJson } from './geminiClient.js';
import { collectIssueRepoContext } from './repoContext.js';

export const defaultAiPromptTemplate = `You are reviewing a JavaScript dependency security upgrade.
Inspect the repository and assess compatibility and operational risk for the supplied Dependabot issue.
Return JSON with exactly these fields:
{
  "riskLevel": "safe | likely_safe | risky | unsafe",
  "safetyScore": 0,
  "confidence": "high | medium | low",
  "needsAdditionalBumps": false,
  "summary": "concise risk summary",
  "steps": ["implementation steps"],
  "breakingChanges": ["likely breaking changes or empty"],
  "verificationChecks": ["specific tests and checks"]
}
Be concrete and do not claim knowledge not present in the context.`;

export const finalVerificationPrompt = `You are the final, independent reviewer of a dependency upgrade.
Reconcile the deterministic dependency-graph analysis with the codebase review. Do not assume either is correct.
Return JSON only with: verdict (safe, likely_safe, risky, or unsafe), confidence (0-100), summary, reasons (array), and verificationChecks (array).
Use safe only when the supplied evidence supports a low-risk upgrade. Missing or contradictory evidence must reduce confidence.`;

function major(value?: string) { return Number(value?.match(/\d+/)?.[0] || 0); }
function cleanRange(value?: string) { return value?.replace(/^[~^<>=\s]*/, '') || ''; }
function riskForScore(score: number): UpgradeRiskLevel {
  if (score >= 85) return 'safe';
  if (score >= 65) return 'likely_safe';
  if (score >= 35) return 'risky';
  return 'unsafe';
}
function confidenceFor(complete: boolean, versionKnown: boolean): 'high' | 'medium' | 'low' {
  return complete && versionKnown ? 'high' : complete || versionKnown ? 'medium' : 'low';
}
function recommendationFor(risk: UpgradeRiskLevel) {
  return {
    safe: 'Proceed with normal automated tests.',
    likely_safe: 'Proceed after targeted compatibility tests.',
    risky: 'Review affected consumers and test in an isolated worktree.',
    unsafe: 'Do not automate; plan a manual migration first.'
  }[risk];
}
function legacyScoreFor(risk: UpgradeRiskLevel) {
  return { safe: 90, likely_safe: 75, risky: 50, unsafe: 15 }[risk];
}
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
    try { await fs.access(candidate); return candidate; } catch { /* try the parent workspace */ }
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  throw new Error('package-lock.json not found');
}

export async function analyzeUpgrade(issue: TrackerIssue, projectPath: string): Promise<IssueUpgradeAnalysis> {
  if (issue.ecosystem !== 'npm') throw new Error(`Unsupported ecosystem: ${issue.ecosystem}`);
  const findings: IssueUpgradeAnalysis['findings'] = [];
  const nodes = new Map<string, DependencyGraph['nodes'][number]>();
  const edges: DependencyGraph['edges'] = [];
  const manifestPath = manifestFile(projectPath, issue.manifestPath);
  const manifestDirectory = path.dirname(manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, any>;
  const buckets = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  let declaredRange: string | undefined;
  let dependencyType: string | undefined;
  for (const bucket of buckets) {
    for (const [name, version] of Object.entries<string>(manifest[bucket] || {})) {
      nodes.set(name, { id: name, requestedVersion: version, version, direct: true, dependencyType: bucket });
      edges.push({ from: 'project', to: name, kind: bucket });
      if (name === issue.packageName) {
        declaredRange = version;
        dependencyType = bucket;
        findings.push({ code: 'DIRECT_DEPENDENCY', message: `Declared in ${bucket} as ${version}`, severity: 'info' });
        if (bucket === 'peerDependencies') findings.push({ code: 'PEER_RANGE', message: 'The vulnerable package is a peer dependency; verify the supported compatibility range.', severity: 'warning' });
      }
    }
  }
  nodes.set('project', { id: 'project', version: String(manifest.version || ''), direct: true, dependencyType: 'root' });

  let lockRead = false;
  try {
    const lock = JSON.parse(await fs.readFile(await findPackageLock(projectPath, manifestDirectory), 'utf8')) as any;
    lockRead = true;
    for (const [packagePath, metadata] of Object.entries<any>(lock.packages || {}).slice(0, 5000)) {
      if (!packagePath || !packagePath.includes('node_modules/')) continue;
      const name = packagePath.split('node_modules/').pop()!;
      const existing = nodes.get(name);
      nodes.set(name, { id: name, version: metadata.version || existing?.version, requestedVersion: existing?.requestedVersion, direct: existing?.direct || false, dependencyType: existing?.dependencyType });
      for (const [kind, dependencies] of [['runtime', metadata.dependencies], ['optional', metadata.optionalDependencies], ['peer', metadata.peerDependencies]] as const) {
        for (const dependency of Object.keys(dependencies || {})) {
          if (!nodes.has(dependency)) nodes.set(dependency, { id: dependency, direct: false });
          if (edges.length < 10_000) edges.push({ from: name, to: dependency, kind });
        }
      }
    }
  } catch {
    findings.push({ code: 'LOCKFILE_UNREADABLE', message: 'package-lock.json could not be read; transitive analysis is incomplete.', severity: 'warning' });
  }

  const currentVersion = cleanRange(nodes.get(issue.packageName)?.version || declaredRange);
  const currentMajor = major(currentVersion);
  const targetMajor = major(issue.patchedVersion);
  const gap = currentMajor && targetMajor ? targetMajor - currentMajor : 0;
  if (gap > 0) findings.push({ code: 'MAJOR_VERSION_GAP', message: `Upgrade crosses from major ${currentMajor} to ${targetMajor}.`, severity: gap > 1 ? 'error' : 'warning' });
  if (!declaredRange) findings.push({ code: 'TRANSITIVE_DEPENDENCY', message: 'Package is not directly declared and may require an override or parent dependency upgrade.', severity: 'warning' });
  const peerEdges = edges.filter(edge => edge.kind === 'peer' && edge.to === issue.packageName);
  if (peerEdges.length) findings.push({ code: 'PEER_CONSUMERS', message: `${peerEdges.length} installed package(s) declare this package as a peer dependency.`, severity: 'warning' });
  if ((issue.manifestPaths?.length || 0) > 1) findings.push({ code: 'MULTIPLE_MANIFESTS', message: `Upgrade affects ${issue.manifestPaths!.length} manifests.`, severity: 'warning' });

  const needsAdditionalBumps = !declaredRange || peerEdges.length > 0;
  let safetyScore = 100;
  if (!lockRead) safetyScore -= 20;
  if (!currentMajor || !targetMajor) safetyScore -= 25;
  if (!declaredRange) safetyScore -= 25;
  if (gap === 1) safetyScore -= 45;
  if (gap > 1) safetyScore -= 70;
  if (gap < 0) safetyScore -= 30;
  safetyScore -= Math.min(30, peerEdges.length * 10);
  if (dependencyType === 'peerDependencies') safetyScore -= 10;
  if ((issue.manifestPaths?.length || 0) > 1) safetyScore -= 10;
  safetyScore = Math.max(0, Math.min(100, safetyScore));
  const riskLevel = riskForScore(safetyScore);
  return {
    riskLevel,
    safetyScore,
    confidence: confidenceFor(lockRead, Boolean(currentMajor && targetMajor)),
    recommendation: recommendationFor(riskLevel),
    needsAdditionalBumps,
    findings,
    dependencyGraph: { nodes: [...nodes.values()], edges },
    analyzedAt: new Date().toISOString()
  };
}

function parseAiJson(content: string): any {
  const candidate = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || content;
  try { return JSON.parse(candidate.trim()); } catch { return { summary: content.trim(), steps: [], breakingChanges: [], verificationChecks: [] }; }
}
function stringArray(value: unknown) { return Array.isArray(value) ? value.map(String) : []; }
function normalizeVerdict(parsed: any, model?: string): UpgradeVerdict {
  const verdicts: UpgradeRiskLevel[] = ['safe', 'likely_safe', 'risky', 'unsafe'];
  const verdict = verdicts.includes(parsed.verdict) ? parsed.verdict : 'risky';
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
    summary: String(parsed.summary || 'No summary returned.'),
    reasons: stringArray(parsed.reasons),
    verificationChecks: stringArray(parsed.verificationChecks),
    model,
    analyzedAt: new Date().toISOString()
  };
}
async function chatCompletion(config: Config, system: string, context: unknown) {
  if (!config.llmApiKey || !config.llmModel) throw new Error('LLM_API_KEY and LLM_MODEL are required for AI analysis');
  const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.llmApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.llmModel, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(context) }] })
  });
  if (!response.ok) throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as any;
  return parseAiJson(String(payload.choices?.[0]?.message?.content || ''));
}

async function runCursorAgent(prompt: string, projectPath: string, config: Config, tools: string[] = ['read', 'grep', 'glob', 'ls', 'readLints', 'semSearch']) {
  if (!config.cursorApiKey) throw new Error('CURSOR_API_KEY is required for Cursor AI analysis');
  const { Agent } = await import('@cursor/sdk');
  const result = await Agent.prompt(prompt, {
    apiKey: config.cursorApiKey,
    model: { id: config.cursorModel },
    tools,
    local: { cwd: path.resolve(projectPath), sandboxOptions: { enabled: true } }
  });
  if (result.status !== 'finished' || !result.result) throw new Error(result.error?.message || `Cursor AI analysis ${result.status}`);
  return { ...result, result: result.result };
}

function mapAiAnalysis(parsed: any, provider: AiAnalysisProvider, model: string, prompt: string, meta: { runId?: string; durationMs?: number } = {}): IssueAiUpgradeAnalysis {
  const riskLevels: UpgradeRiskLevel[] = ['safe', 'likely_safe', 'risky', 'unsafe'];
  const riskLevel = riskLevels.includes(parsed.riskLevel) ? parsed.riskLevel : 'risky';
  const confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';
  return {
    riskLevel,
    safetyScore: Math.max(0, Math.min(100, Number(parsed.safetyScore) || 0)),
    confidence,
    needsAdditionalBumps: Boolean(parsed.needsAdditionalBumps),
    summary: String(parsed.summary || ''),
    steps: stringArray(parsed.steps),
    breakingChanges: stringArray(parsed.breakingChanges),
    verificationChecks: stringArray(parsed.verificationChecks),
    provider,
    model,
    prompt,
    runId: meta.runId,
    durationMs: meta.durationMs,
    analyzedAt: new Date().toISOString()
  };
}

async function analyzeUpgradeWithGemini(issue: TrackerIssue, projectPath: string, config: Config, prompt: string): Promise<IssueAiUpgradeAnalysis> {
  const repoContext = await collectIssueRepoContext(issue, projectPath, issue.lastUpgradeAnalysis);
  const geminiPrompt = `${prompt}\n\nBase your answer only on the supplied repository context. Do not assume access to files or tools beyond what is provided.`;
  const result = await generateJson(geminiPrompt, repoContext, config);
  return mapAiAnalysis(parseAiJson(result.text), 'gemini', result.model, prompt, { durationMs: result.durationMs });
}

export async function analyzeUpgradeWithAi(
  issue: TrackerIssue,
  projectPath: string,
  config: Config,
  promptTemplate?: string,
  provider?: AiAnalysisProvider
): Promise<IssueAiUpgradeAnalysis> {
  const selected = resolveProvider(provider, config);
  const prompt = (promptTemplate?.trim() || config.aiPromptTemplate?.trim() || defaultAiPromptTemplate).slice(0, 20_000);
  if (selected === 'gemini') return analyzeUpgradeWithGemini(issue, projectPath, config, prompt);
  const context = {
    issue: { packageName: issue.packageName, patchedVersion: issue.patchedVersion, vulnerableVersionRange: issue.vulnerableVersionRange, manifestPath: issue.manifestPath, manifestPaths: issue.manifestPaths, severity: issue.severity, alerts: issue.alerts }
  };
  const result = await runCursorAgent(`${prompt}\n\nUse the available read-only tools to inspect manifests, lockfiles, imports, API usage, configuration, and tests before answering. Do not rely on a separate dependency engine.\n\nInput:\n${JSON.stringify(context)}`, projectPath, config);
  return mapAiAnalysis(parseAiJson(result.result), 'cursor', result.model?.id || config.cursorModel, prompt, { runId: result.id, durationMs: result.durationMs });
}

const vettingPrompt = `Review whether this dependency upgrade is compatible with the code in this repository. Inspect relevant imports, APIs, configuration, tests, and peer constraints. Do not edit files or run commands.

Return JSON only with: verdict (safe, likely_safe, risky, or unsafe), confidence (0-100), summary, reasons (array), verificationChecks (array).`;

async function vetUpgradeWithGemini(issue: TrackerIssue, heuristic: IssueUpgradeAnalysis, projectPath: string, config: Config): Promise<IssueCursorUpgradeAnalysis> {
  const repoContext = await collectIssueRepoContext(issue, projectPath, heuristic);
  const context = {
    issue: {
      packageName: issue.packageName,
      currentVersion: heuristic.dependencyGraph.nodes.find(node => node.id === issue.packageName)?.version,
      targetVersion: issue.patchedVersion,
      manifestPath: issue.manifestPath
    },
    heuristic,
    repoContext
  };
  const result = await generateJson(`${vettingPrompt}\n\nBase your answer only on the supplied repository context.`, context, config);
  return {
    ...normalizeVerdict(parseAiJson(result.text), result.model),
    provider: 'gemini',
    durationMs: result.durationMs,
    basedOnAnalysisAt: heuristic.analyzedAt
  };
}

export async function vetUpgradeWithCursor(
  issue: TrackerIssue,
  heuristic: IssueUpgradeAnalysis,
  projectPath: string,
  config: Config,
  provider?: AiAnalysisProvider
): Promise<IssueCursorUpgradeAnalysis> {
  const selected = resolveProvider(provider, config);
  if (selected === 'gemini') return vetUpgradeWithGemini(issue, heuristic, projectPath, config);
  const prompt = `${vettingPrompt}\n\nInput:\n${JSON.stringify({ issue: { packageName: issue.packageName, currentVersion: heuristic.dependencyGraph.nodes.find(node => node.id === issue.packageName)?.version, targetVersion: issue.patchedVersion, manifestPath: issue.manifestPath }, heuristic })}`;
  const result = await runCursorAgent(prompt, projectPath, config);
  return {
    ...normalizeVerdict(parseAiJson(result.result), result.model?.id || config.cursorModel),
    provider: 'cursor',
    runId: result.id,
    durationMs: result.durationMs,
    basedOnAnalysisAt: heuristic.analyzedAt
  };
}

async function verifyWithGemini(
  issue: TrackerIssue,
  heuristic: IssueUpgradeAnalysis,
  codebaseReview: IssueCursorUpgradeAnalysis,
  config: Config
): Promise<IssueFinalUpgradeVerification> {
  const gemini = await generateJson(finalVerificationPrompt, {
    issue: { packageName: issue.packageName, targetVersion: issue.patchedVersion, manifestPath: issue.manifestPath, severity: issue.severity },
    deterministicAnalysis: heuristic,
    codebaseReview
  }, config);
  const verdict = normalizeVerdict(parseAiJson(gemini.text), config.geminiModel);
  return {
    ...verdict,
    agreesWithHeuristic: verdict.verdict === heuristic.riskLevel,
    agreesWithCursor: verdict.verdict === codebaseReview.verdict
  };
}

export async function verifyUpgradeWithLlm(
  issue: TrackerIssue,
  heuristic: IssueUpgradeAnalysis,
  codebaseReview: IssueCursorUpgradeAnalysis | undefined,
  config: Config,
  provider?: AiAnalysisProvider
): Promise<IssueFinalUpgradeVerification> {
  if (!codebaseReview) throw new Error('Codebase vetting must complete before final verification');
  if (codebaseReview.basedOnAnalysisAt && codebaseReview.basedOnAnalysisAt !== heuristic.analyzedAt) {
    throw new Error('Codebase vetting is stale; run vetting again before final verification');
  }
  const selected = resolveProvider(provider, config);
  if (selected === 'gemini') return verifyWithGemini(issue, heuristic, codebaseReview, config);
  if (!config.llmApiKey || !config.llmModel) throw new Error('LLM_API_KEY and LLM_MODEL are required for final verification with Cursor provider');
  const verdict = normalizeVerdict(await chatCompletion(config, finalVerificationPrompt, {
    issue: { packageName: issue.packageName, targetVersion: issue.patchedVersion, manifestPath: issue.manifestPath, severity: issue.severity },
    deterministicAnalysis: heuristic,
    codebaseReview
  }), config.llmModel);
  return {
    ...verdict,
    agreesWithHeuristic: verdict.verdict === heuristic.riskLevel,
    agreesWithCursor: verdict.verdict === codebaseReview.verdict
  };
}

export function buildRepositoryAnalysis(repo: string, projectPath: string, issues: TrackerIssue[]): RepositoryUpgradeAnalysis {
  const summary: RepositoryUpgradeAnalysis['summary'] = { safe: 0, likely_safe: 0, risky: 0, unsafe: 0, not_analyzed: 0 };
  const nodeMap = new Map<string, DependencyGraph['nodes'][number]>();
  const edgeMap = new Map<string, DependencyGraph['edges'][number]>();
  const dependencies = issues.flatMap(issue => {
    const analysis = issue.lastAiAnalysis || issue.lastUpgradeAnalysis;
    if (!analysis) { summary.not_analyzed++; return []; }
    summary[analysis.riskLevel]++;
    const graph = issue.lastUpgradeAnalysis?.dependencyGraph;
    for (const node of graph?.nodes || []) nodeMap.set(node.id, { ...nodeMap.get(node.id), ...node });
    for (const edge of graph?.edges || []) edgeMap.set(`${edge.from}\0${edge.to}\0${edge.kind}`, edge);
    const packageNode = graph?.nodes.find(node => node.id === issue.packageName);
    const recommendation = 'summary' in analysis ? analysis.summary : analysis.recommendation || recommendationFor(analysis.riskLevel);
    return [{ issueId: issue.id, packageName: issue.packageName, currentVersion: packageNode?.version || packageNode?.requestedVersion, targetVersion: issue.patchedVersion, manifestPath: issue.manifestPath, riskLevel: analysis.riskLevel, safetyScore: analysis.safetyScore ?? legacyScoreFor(analysis.riskLevel), confidence: analysis.confidence || 'low' as const, recommendation, needsAdditionalBumps: analysis.needsAdditionalBumps }];
  }).sort((a, b) => b.safetyScore - a.safetyScore || a.packageName.localeCompare(b.packageName));
  return { repo, projectPath: path.resolve(projectPath), summary, dependencies, graph: { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] }, analyzedAt: new Date().toISOString() };
}
