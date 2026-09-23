import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { Config } from '../config/env.js';
import { issueStates, FixJob, TrackerIssue } from '../domain/types.js';
import { GitHubClient } from '../integrations/github.js';
import { ReviewNotifier } from '../integrations/cursorSlackNotifier.js';
import { awsStatus } from '../remediation/aws.js';
import { JobManager } from '../remediation/jobManager.js';
import { Repository } from '../repository/repository.js';
import { analyzeUpgrade, analyzeUpgradeWithAi, buildRepositoryAnalysis, defaultAiPromptTemplate, vetUpgradeWithCursor, verifyUpgradeWithLlm } from '../services/analysis.js';
import { AnalysisJobManager } from '../services/analysisJobs.js';
import { GroupingJobManager } from '../services/groupingJobs.js';
import { recordAiAnalysis, recordCursorAnalysis, recordDependencyAnalysis, recordFinalVerification } from '../services/analysisTracking.js';
import { BatchService } from '../services/batches.js';
import { Scanner } from '../services/scanner.js';
import { WorktreeService } from '../services/worktrees.js';
import { LocalRepositoryService } from '../services/localRepositories.js';
import { SettingsService } from '../services/settings.js';
import { ecosystemAdapters } from '../ecosystems/catalog.js';
import { FixAgentSkillService } from '../services/fixAgentSkills.js';
import { buildIssueWorkflow } from '../services/issueWorkflow.js';
import { buildWorkItemWorkflow } from '../services/workItemWorkflow.js';
import { collectPrimaryBatchAlerts } from '../services/packageTargetDedup.js';
import { buildSlackReviewMessage } from '../services/slackReview.js';
import { defaultWorkItemGroupingPrompt } from '../services/workItemGrouping.js';
import { aiProviderSchema, assertProviderConfigured, configuredAiProviders, resolveProvider } from '../services/aiProvider.js';

export type ApiDependencies = {
  config: Config;
  repo: Repository;
  github: GitHubClient;
  scanner: Scanner;
  batches: BatchService;
  jobs: JobManager;
  worktrees: WorktreeService;
  slack: ReviewNotifier;
  analysisJobs: AnalysisJobManager;
  groupingJobs: GroupingJobManager;
  settings: SettingsService;
  localRepositories: LocalRepositoryService;
  fixAgentSkills: FixAgentSkillService;
};

const repoParts = (repo: string) => {
  const [owner, name, extra] = repo.split('/');
  if (!owner || !name || extra) throw new Error('repo must use owner/name format');
  return { owner, name };
};
const projectPath = (body: any, config: Config) => body?.projectPath || config.analysisProjectPath || config.defaultProjectPath || config.repoRoot;

export function apiRouter(d: ApiDependencies) {
  const router = Router();
  const asyncRoute = (handler: any) => (req: any, res: any, next: any) => Promise.resolve(handler(req, res, next)).catch(next);
  const issueFor = async (req: any) => {
    const repo = req.body?.repo || req.query?.repo;
    const issue = await d.repo.getIssue(req.params.id, repo);
    if (!issue) throw Object.assign(new Error('Issue not found'), { status: 404 });
    return issue;
  };
  const resolveFixAgent = async (requested?: { provider: 'codex' | 'claude' | 'cursor'; skill: string }) => {
    const settings = await d.settings.get();
    const selection = requested || (settings.defaultCursorSkill ? { provider: 'cursor' as const, skill: settings.defaultCursorSkill } : undefined);
    if (!selection) return {};
    const resolved = await d.fixAgentSkills.resolve(selection, settings.cursorSkillsDirectory);
    return { selection, resolved };
  };
  const slackReviewSchema = z.object({
    channel: z.string().trim().min(1).max(100).optional(),
    message: z.string().trim().min(1).max(1000).optional(),
    prNumbers: z.array(z.number().int().positive()).max(25)
  });
  const prepareSlackReview = async (req: any) => {
    const body = slackReviewSchema.parse(req.body || {});
    if (!body.prNumbers.length) throw Object.assign(new Error('Select at least one pull request'), { status: 400 });
    const repo = `${req.params.owner}/${req.params.repo}`;
    const requested = new Set(body.prNumbers);
    const prs = (await d.github.pullRequestStatuses(req.params.owner, req.params.repo)).filter(pr => requested.has(pr.number));
    const found = new Set(prs.map(pr => pr.number));
    const missing = [...requested].filter(number => !found.has(number));
    if (missing.length) throw Object.assign(new Error(`Open pull request(s) not found: ${missing.join(', ')}`), { status: 404 });
    const [issues, workItems] = await Promise.all([d.repo.listIssues(repo), d.repo.listBatches(repo)]);
    return {
      channel: body.channel,
      text: buildSlackReviewMessage(repo, prs, issues, workItems, body.message),
      pullRequests: prs.map(pr => ({ title: pr.title, url: pr.url, status: `${pr.checks.conclusion}; ${pr.reviewState}` }))
    };
  };

  router.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  router.get('/config/defaults', (_req, res) => res.json({
    defaultRepo: d.config.defaultRepo,
    defaultProjectPath: d.config.defaultProjectPath,
    preInstallScript: d.config.preInstallScript,
    postBumpHook: d.config.postBumpHook,
    remediationRequireAwsSso: d.config.requireAwsSso,
    aiConfigured: Boolean(d.config.llmApiKey && d.config.llmModel),
    aiModel: d.config.llmModel,
    cursorConfigured: Boolean(d.config.cursorApiKey),
    cursorModel: d.config.cursorModel,
    geminiConfigured: Boolean(d.config.geminiApiKey),
    geminiModel: d.config.geminiModel,
    aiProviders: configuredAiProviders(d.config),
    slackConfigured: d.slack.status().configured,
    ecosystems: ecosystemAdapters,
    githubAuth: d.github.authStatus()
  }));
  router.get('/github/repos', asyncRoute(async (_req: any, res: any) => res.json(await d.github.repositories())));
  router.get('/settings', asyncRoute(async (_req: any, res: any) => res.json(await d.settings.get())));
  router.put('/settings', asyncRoute(async (req: any, res: any) => {
    const body = z.object({
      repositoriesRoot: z.string().min(1),
      cursorSkillsDirectory: z.string().min(1).optional().nullable(),
      defaultCursorSkill: z.string().min(1).optional().nullable()
    }).parse(req.body);
    const cursorSkillsDirectory = body.cursorSkillsDirectory || undefined;
    const defaultCursorSkill = body.defaultCursorSkill || undefined;
    if (defaultCursorSkill) await d.fixAgentSkills.resolve({ provider: 'cursor', skill: defaultCursorSkill }, cursorSkillsDirectory);
    const repositories = await d.localRepositories.discover(body.repositoriesRoot);
    const settings = await d.settings.update({ repositoriesRoot: body.repositoriesRoot, cursorSkillsDirectory, defaultCursorSkill });
    res.json({ settings, repositories });
  }));
  router.get('/local-repositories', asyncRoute(async (_req: any, res: any) => {
    const settings = await d.settings.get();
    if (!settings.repositoriesRoot) return res.json([]);
    res.json(await d.localRepositories.discover(settings.repositoriesRoot));
  }));

  router.get('/repos/:owner/:repo/issues', asyncRoute(async (req: any, res: any) => {
    let issues = await d.repo.listIssues(`${req.params.owner}/${req.params.repo}`);
    if (req.query.state) issues = issues.filter(issue => issue.state === req.query.state);
    if (req.query.search) { const query = String(req.query.search).toLowerCase(); issues = issues.filter(issue => `${issue.title} ${issue.packageName} ${issue.manifestPath}`.toLowerCase().includes(query)); }
    res.json(issues);
  }));
  router.get('/repos/:owner/:repo/status', asyncRoute(async (req: any, res: any) => res.json(await d.repo.listSummary(`${req.params.owner}/${req.params.repo}`))));
  router.post('/repos/:owner/:repo/scan', asyncRoute(async (req: any, res: any) => res.json(await d.scanner.scan(req.params.owner, req.params.repo))));
  router.post('/issues/:id/state', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ repo: z.string().optional(), state: z.enum(issueStates), actor: z.string().default('api'), note: z.string().optional(), force: z.boolean().optional() }).parse(req.body);
    res.json(await d.repo.transitionIssue(req.params.id, body.state, body.actor, body.note, body.force, body.repo));
  }));
  router.post('/issues/:id/notes', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ repo: z.string().optional(), body: z.string().min(1), actor: z.string().default('api') }).parse(req.body);
    res.json(await d.repo.addNote(req.params.id, body.actor, body.body, body.repo));
  }));
  router.get('/issues/:id/workflow', asyncRoute(async (req: any, res: any) => {
    const issue = await d.repo.getIssue(req.params.id, req.query.repo);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    res.json(buildIssueWorkflow(issue, await d.jobs.list(issue.repo)));
  }));

  const finishIssueJob = async (issue: TrackerIssue, job: FixJob) => {
    const current = await d.repo.getIssue(issue.id, issue.repo);
    if (!current) return;
    current.remediation = { jobId: job.id, log: job.log, result: job.result, error: job.error };
    current.remediation.agent = job.agent;
    if (job.result?.prUrl) {
      current.pr.url = job.result.prUrl;
      const number = Number(job.result.prUrl.match(/\/pull\/(\d+)/)?.[1]);
      if (number) current.pr.number = number;
    }
    await d.repo.saveIssue(current);
    await d.repo.transitionIssue(current.id, job.status === 'succeeded' ? 'READY_FOR_REVIEW' : 'BLOCKED', 'job', job.error, true, current.repo);
  };

  const startIssue = (kind: FixJob['kind'], fixedFlags: string[]) => asyncRoute(async (req: any, res: any) => {
    const body = z.object({ repo: z.string().optional(), projectPath: z.string().optional(), agent: z.object({ provider: z.enum(['codex', 'claude', 'cursor']), skill: z.string().min(1) }).optional(), reuseWorktree: z.boolean().optional(), force: z.boolean().optional() }).parse(req.body || {});
    if (kind !== 'fix' && body.agent) return res.status(400).json({ error: 'An agent skill can only be selected when running a fix' });
    const issue = await d.repo.getIssue(req.params.id, body.repo);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const { selection: agent, resolved: agentSkill } = kind === 'fix' ? await resolveFixAgent(body.agent) : {};
    const aws = awsStatus(d.config.requireAwsSso, d.config.awsProfile);
    if (!aws.valid) return res.status(412).json(aws);
    const root = body.projectPath || d.config.repoRoot || d.config.defaultProjectPath || '';
    const upgradeAnalysis = issue.lastUpgradeAnalysis;
    if (kind === 'fix' && !body.force && !issue.pr.url && (!upgradeAnalysis || ['risky', 'unsafe'].includes(upgradeAnalysis.riskLevel) || upgradeAnalysis.needsAdditionalBumps)) {
      return res.status(409).json({ error: `Run dependency analysis and resolve upgrade risk before fixing ${issue.packageName}` });
    }
    const dynamicFlags = kind === 'create-pr' && body.reuseWorktree ? ['--reuse-worktree', '--skip-fix'] : [];
    const publishFlags = kind === 'fix' && issue.pr.url ? ['--push'] : [];
    const args = ['fix', issue.repo, String(issue.alerts[0]), ...(root ? ['--repo-root', root] : []), ...dynamicFlags, ...publishFlags, ...fixedFlags];
    const job = d.jobs.start({
      kind, repo: issue.repo, issueId: issue.id, alertNumber: issue.alerts[0], agent,
      command: path.resolve('scripts/remediation/dependabot-issue-fix.sh'), args,
      env: {
        REMEDIATION_PRE_INSTALL_SCRIPT: d.config.preInstallScript,
        REMEDIATION_POST_BUMP_HOOK: d.config.postBumpHook,
        DEPENDABOT_FIX_CACHE_ROOT: d.config.fixCacheRoot,
        DEPENDABOT_FIX_REPO_ROOT: root,
        GITHUB_REPOSITORY: issue.repo,
        REMEDIATION_AGENT_PROVIDER: agent?.provider,
        REMEDIATION_AGENT_SKILL: agent?.skill,
        REMEDIATION_AGENT_SKILL_FILE: agentSkill?.file,
        CODEX_FIX_MODEL: d.config.codexFixModel,
        CLAUDE_FIX_COMMAND: d.config.claudeFixCommand,
        CURSOR_API_KEY: d.config.cursorApiKey,
        CURSOR_MODEL: d.config.cursorModel,
        REMEDIATION_DEPENDENCY_ANALYSIS_JSON: upgradeAnalysis ? JSON.stringify({
          riskLevel: upgradeAnalysis.riskLevel,
          safetyScore: upgradeAnalysis.safetyScore,
          confidence: upgradeAnalysis.confidence,
          recommendation: upgradeAnalysis.recommendation,
          needsAdditionalBumps: upgradeAnalysis.needsAdditionalBumps,
          findings: upgradeAnalysis.findings
        }) : undefined
      },
      onComplete: completed => finishIssueJob(issue, completed)
    });
    issue.remediation = { jobId: job.id, agent };
    await d.repo.saveIssue(issue);
    await d.repo.transitionIssue(issue.id, 'IN_PROGRESS', 'job', kind, true, issue.repo);
    res.status(202).json(job);
  });

  router.post('/issues/:id/actions/fix', startIssue('fix', []));
  router.post('/issues/:id/actions/create-pr', startIssue('create-pr', ['--push', '--open-pr']));
  router.post('/issues/:id/actions/update-pr', startIssue('update-pr', ['--reuse-worktree', '--push']));
  router.post('/issues/:id/actions/reset-pr-and-fix', startIssue('reset-pr-and-fix', ['--reset-to-base', '--push']));
  router.get('/fix-jobs/:jobId', asyncRoute(async (req: any, res: any) => { const job = await d.jobs.get(req.params.jobId); return job ? res.json(job) : res.status(404).json({ error: 'Job not found' }); }));
  router.get('/repos/:owner/:repo/fix-jobs', asyncRoute(async (req: any, res: any) => res.json(await d.jobs.list(`${req.params.owner}/${req.params.repo}`))));
  router.get('/remediation/aws-status', (_req, res) => res.json(awsStatus(d.config.requireAwsSso, d.config.awsProfile)));
  router.get('/remediation/fix-agent-skills', asyncRoute(async (req: any, res: any) => {
    const settings = await d.settings.get();
    const directory = typeof req.query.cursorSkillsDirectory === 'string' ? req.query.cursorSkillsDirectory : settings.cursorSkillsDirectory;
    res.json(await d.fixAgentSkills.list(directory));
  }));
  router.post('/remediation/aws-sso-login', (_req, res) => res.status(501).json({ error: 'Run `aws sso login --profile <profile>` in a terminal; background HTTP workers cannot safely complete an interactive login.' }));

  router.post('/repos/:owner/:repo/batches', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ issueIds: z.array(z.string()), branch: z.string().optional() }).parse(req.body);
    res.status(201).json(await d.batches.create(`${req.params.owner}/${req.params.repo}`, body.issueIds, body.branch));
  }));
  router.get('/repos/:owner/:repo/batches', asyncRoute(async (req: any, res: any) => res.json(await d.repo.listBatches(`${req.params.owner}/${req.params.repo}`))));
  router.post('/repos/:owner/:repo/work-items', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ issueIds: z.array(z.string()).min(1).max(10) }).parse(req.body);
    res.status(201).json(await d.batches.create(`${req.params.owner}/${req.params.repo}`, body.issueIds));
  }));
  router.get('/repos/:owner/:repo/work-items', asyncRoute(async (req: any, res: any) => res.json(await d.repo.listBatches(`${req.params.owner}/${req.params.repo}`))));
  router.get('/work-items/:id/workflow', asyncRoute(async (req: any, res: any) => {
    const workItem = await d.repo.getBatch(req.params.id);
    if (!workItem) return res.status(404).json({ error: 'Work item not found' });
    const issues = (await Promise.all(workItem.issueIds.map(id => d.repo.getIssue(id, workItem.repo)))).filter((issue): issue is TrackerIssue => Boolean(issue));
    res.json(buildWorkItemWorkflow(workItem, issues, await d.jobs.list(workItem.repo)));
  }));
  router.get('/batches/:id', asyncRoute(async (req: any, res: any) => { const batch = await d.repo.getBatch(req.params.id); return batch ? res.json(batch) : res.status(404).json({ error: 'Batch not found' }); }));
  router.post('/repos/:owner/:repo/batches/compose-from-tracker', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ maxGroupSize: z.number().int().min(2).max(10).default(3) }).parse(req.body || {});
    res.status(201).json(await d.batches.compose(`${req.params.owner}/${req.params.repo}`, body.maxGroupSize));
  }));
  router.post('/repos/:owner/:repo/work-items/auto-group', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ projectPath: z.string().optional(), maxGroupSize: z.number().int().min(2).max(10).default(3), promptTemplate: z.string().max(20_000).optional(), provider: aiProviderSchema.optional() }).parse(req.body || {});
    const provider = resolveProvider(body.provider, d.config);
    assertProviderConfigured(provider, d.config, 'work-item grouping');
    const localPath = projectPath(body, d.config); if (!localPath) return res.status(400).json({ error: 'projectPath required' });
    const job = d.groupingJobs.start({
      repo: `${req.params.owner}/${req.params.repo}`,
      projectPath: localPath,
      maxGroupSize: body.maxGroupSize,
      promptTemplate: body.promptTemplate,
      provider
    });
    res.status(202).json(job);
  }));
  router.get('/grouping-jobs/:jobId', (req, res) => {
    const job = d.groupingJobs.get(req.params.jobId);
    return job ? res.json(job) : res.status(404).json({ error: 'Grouping job not found' });
  });
  router.post('/repos/:owner/:repo/work-items/move-issue', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ issueId: z.string().min(1), targetWorkItemId: z.string().min(1).optional() }).parse(req.body);
    res.json(await d.batches.moveIssue(`${req.params.owner}/${req.params.repo}`, body.issueId, body.targetWorkItemId));
  }));
  router.post('/repos/:owner/:repo/work-items/actions/reset', asyncRoute(async (req: any, res: any) => {
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm: true is required to reset all work items' });
    res.json(await d.batches.reset(`${req.params.owner}/${req.params.repo}`));
  }));
  router.post('/repos/:owner/:repo/batches/compose', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ groups: z.array(z.array(z.string()).min(1).max(10)) }).parse(req.body);
    const repo = `${req.params.owner}/${req.params.repo}`;
    res.status(201).json(await Promise.all(body.groups.map(group => d.batches.create(repo, group))));
  }));
  router.post('/repos/:owner/:repo/batches/actions/clear', asyncRoute(async (req: any, res: any) => {
    const repo = `${req.params.owner}/${req.params.repo}`;
    const body = z.object({ confirm: z.literal(true) }).parse(req.body);
    void body;
    const drafts = (await d.repo.listBatches(repo)).filter(batch => batch.state === 'draft');
    for (const batch of drafts) {
      for (const issueId of batch.issueIds) {
        const issue = await d.repo.getIssue(issueId, repo);
        if (issue?.state === 'PLANNED_BATCH') await d.repo.transitionIssue(issue.id, 'TRIAGED', 'batch-clear', batch.id, false, repo);
      }
      await d.repo.deleteBatch(batch.id);
    }
    res.json({ removed: drafts.length });
  }));

  const startBatch = (kind: 'batch-fix' | 'batch-create-pr', flags: string[]) => asyncRoute(async (req: any, res: any) => {
    const body = z.object({
      projectPath: z.string().optional(),
      force: z.boolean().optional(),
      agent: z.object({ provider: z.enum(['codex', 'claude', 'cursor']), skill: z.string().min(1) }).optional()
    }).parse(req.body || {});
    if (kind !== 'batch-fix' && body.agent) return res.status(400).json({ error: 'An agent skill can only be selected when running a fix' });
    const batch = await d.repo.getBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    if (kind === 'batch-create-pr' && batch.state !== 'ready_for_pr') return res.status(409).json({ error: 'Run the batch fix successfully before creating its PR' });
    const issues = await Promise.all(batch.issueIds.map(id => d.repo.getIssue(id, batch.repo)));
    if (issues.some(issue => !issue)) throw new Error('Batch contains a missing issue');
    const prExists = batch.state === 'pr_open' || Boolean(batch.remediation?.result?.prUrl);
    if (kind === 'batch-fix' && !body.force && !prExists) {
      const blocked = (issues as TrackerIssue[]).find(issue => !issue.lastUpgradeAnalysis || ['risky', 'unsafe'].includes(issue.lastUpgradeAnalysis.riskLevel) || issue.lastUpgradeAnalysis.needsAdditionalBumps);
      if (blocked) return res.status(409).json({ error: `Analyze and resolve dependency risk before fixing work item member: ${blocked.packageName}` });
    }
    const { selection: agent, resolved: agentSkill } = kind === 'batch-fix' ? await resolveFixAgent(body.agent) : {};
    const root = body.projectPath || d.config.repoRoot || d.config.defaultProjectPath || '';
    const alerts = collectPrimaryBatchAlerts(issues as TrackerIssue[]);
    const publishFlags = kind === 'batch-fix' && prExists ? ['--push'] : [];
    const upgradeAnalysesByAlert = Object.fromEntries(
      (issues as TrackerIssue[]).flatMap(issue => issue.lastUpgradeAnalysis ? [[String(issue.alerts[0]), issue.lastUpgradeAnalysis]] : [])
    );
    const job = d.jobs.start({
      kind, repo: batch.repo, batchId: batch.id, agent,
      command: path.resolve('scripts/remediation/dependabot-batch-fix.sh'),
      args: ['fix', batch.repo, '--alerts', alerts, '--batch-id', batch.id, ...(root ? ['--repo-root', root] : []), ...publishFlags, ...flags],
      env: {
        REMEDIATION_PRE_INSTALL_SCRIPT: d.config.preInstallScript,
        REMEDIATION_POST_BUMP_HOOK: d.config.postBumpHook,
        DEPENDABOT_FIX_CACHE_ROOT: d.config.fixCacheRoot,
        DEPENDABOT_FIX_REPO_ROOT: root,
        GITHUB_REPOSITORY: batch.repo,
        REMEDIATION_AGENT_PROVIDER: agent?.provider,
        REMEDIATION_AGENT_SKILL: agent?.skill,
        REMEDIATION_AGENT_SKILL_FILE: agentSkill?.file,
        CODEX_FIX_MODEL: d.config.codexFixModel,
        CLAUDE_FIX_COMMAND: d.config.claudeFixCommand,
        CURSOR_API_KEY: d.config.cursorApiKey,
        CURSOR_MODEL: d.config.cursorModel,
        REMEDIATION_BATCH_UPGRADE_ANALYSES_JSON: JSON.stringify(upgradeAnalysesByAlert)
      },
      onComplete: async completed => {
        const current = await d.repo.getBatch(batch.id);
        if (!current) return;
        current.remediation = { jobId: completed.id, log: completed.log, result: completed.result, error: completed.error, agent: completed.agent };
        current.state = completed.status === 'failed' ? 'failed' : completed.result?.prUrl ? 'pr_open' : 'ready_for_pr';
        current.updatedAt = new Date().toISOString();
        await d.repo.saveBatch(current);
        for (const issue of issues as TrackerIssue[]) {
          issue.remediation = current.remediation;
          await d.repo.saveIssue(issue);
          await d.repo.transitionIssue(issue.id, completed.status === 'succeeded' ? 'READY_FOR_REVIEW' : 'BLOCKED', 'batch-job', batch.id, true, issue.repo);
        }
      }
    });
    batch.state = 'fixing'; batch.remediation = { jobId: job.id, agent }; batch.updatedAt = new Date().toISOString(); await d.repo.saveBatch(batch);
    for (const issue of issues as TrackerIssue[]) await d.repo.transitionIssue(issue.id, 'IN_PROGRESS', 'batch-job', batch.id, true, issue.repo);
    res.status(202).json(job);
  });
  router.post('/batches/:id/actions/fix', startBatch('batch-fix', []));
  router.post('/batches/:id/actions/create-pr', startBatch('batch-create-pr', ['--reuse-worktree', '--skip-fix', '--push', '--open-pr']));
  router.post('/work-items/:id/actions/fix', startBatch('batch-fix', []));
  router.post('/work-items/:id/actions/create-pr', startBatch('batch-create-pr', ['--reuse-worktree', '--skip-fix', '--push', '--open-pr']));
  router.post('/work-items/:id/analyze', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ projectPath: z.string().optional(), promptTemplate: z.string().optional(), provider: aiProviderSchema.optional() }).parse(req.body || {});
    const workItem = await d.repo.getBatch(req.params.id);
    if (!workItem) return res.status(404).json({ error: 'Work item not found' });
    const localPath = projectPath(body, d.config); if (!localPath) return res.status(400).json({ error: 'projectPath required' });
    const provider = resolveProvider(body.provider, d.config);
    assertProviderConfigured(provider, d.config, 'analysis');
    res.status(202).json(d.analysisJobs.start({ repo: workItem.repo, projectPath: localPath, promptTemplate: body.promptTemplate, useAi: true, issueIds: workItem.issueIds, provider }));
  }));

  const runHeuristic = async (issue: TrackerIssue, localPath: string) => {
    recordDependencyAnalysis(issue, await analyzeUpgrade(issue, localPath));
    await d.repo.saveIssue(issue);
    return issue.lastUpgradeAnalysis!;
  };
  router.post('/issues/:id/analyze-upgrade', asyncRoute(async (req: any, res: any) => {
    const issue = await issueFor(req); const localPath = projectPath(req.body, d.config);
    if (!localPath) return res.status(400).json({ error: 'projectPath required' });
    res.json(await runHeuristic(issue, localPath));
  }));
  router.post('/issues/:id/analyze-upgrade/ai', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ repo: z.string().optional(), projectPath: z.string().optional(), promptTemplate: z.string().optional(), provider: aiProviderSchema.optional() }).parse(req.body || {});
    const provider = resolveProvider(body.provider, d.config);
    assertProviderConfigured(provider, d.config, 'analysis');
    const issue = await d.repo.getIssue(req.params.id, body.repo); if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const localPath = projectPath(body, d.config); if (!localPath) return res.status(400).json({ error: 'projectPath required' });
    recordAiAnalysis(issue, await analyzeUpgradeWithAi(issue, localPath, d.config, body.promptTemplate, provider));
    await d.repo.saveIssue(issue); res.json(issue.lastAiAnalysis);
  }));
  router.get('/issues/:id/analyses', asyncRoute(async (req: any, res: any) => {
    const issue = await d.repo.getIssue(req.params.id, req.query.repo); if (!issue) return res.status(404).json({ error: 'Issue not found' });
    res.json({
      dependencyEngine: { latest: issue.lastUpgradeAnalysis, history: issue.analysisHistory?.dependencyEngine || [] },
      ai: { latest: issue.lastAiAnalysis, history: issue.analysisHistory?.ai || [] },
      cursor: { latest: issue.lastCursorAnalysis, history: issue.analysisHistory?.cursor || [] },
      finalVerification: { latest: issue.lastFinalVerification, history: issue.analysisHistory?.finalVerification || [] }
    });
  }));
  router.post('/issues/:id/analyze-upgrade/cursor', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ repo: z.string().optional(), projectPath: z.string().optional(), provider: aiProviderSchema.optional() }).parse(req.body || {});
    const provider = resolveProvider(body.provider, d.config);
    assertProviderConfigured(provider, d.config, 'codebase vetting');
    const issue = await d.repo.getIssue(req.params.id, body.repo); if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const localPath = projectPath(body, d.config); if (!localPath) return res.status(400).json({ error: 'projectPath required' });
    const heuristic = await runHeuristic(issue, localPath);
    recordCursorAnalysis(issue, await vetUpgradeWithCursor(issue, heuristic, localPath, d.config, provider));
    await d.repo.saveIssue(issue); res.json(issue.lastCursorAnalysis);
  }));
  router.post('/issues/:id/analyze-upgrade/verify', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ repo: z.string().optional(), projectPath: z.string().optional(), provider: aiProviderSchema.optional() }).parse(req.body || {});
    const provider = resolveProvider(body.provider, d.config);
    assertProviderConfigured(provider, d.config, 'final verification');
    if (provider === 'cursor' && !(d.config.llmApiKey && d.config.llmModel)) return res.status(412).json({ error: 'LLM_API_KEY and LLM_MODEL are required for final verification with Cursor provider' });
    const issue = await d.repo.getIssue(req.params.id, body.repo); if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const localPath = projectPath(body, d.config); if (!localPath) return res.status(400).json({ error: 'projectPath required' });
    const heuristic = await runHeuristic(issue, localPath);
    const cursor = await vetUpgradeWithCursor(issue, heuristic, localPath, d.config, provider);
    recordCursorAnalysis(issue, cursor);
    recordFinalVerification(issue, await verifyUpgradeWithLlm(issue, heuristic, cursor, d.config, provider));
    await d.repo.saveIssue(issue); res.json(issue.lastFinalVerification);
  }));
  router.post('/repos/:owner/:repo/analyze-upgrade/bulk', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ projectPath: z.string().optional(), promptTemplate: z.string().optional(), useAi: z.boolean().optional(), useCursor: z.boolean().default(false), useFinalVerification: z.boolean().default(false), issueIds: z.array(z.string()).optional(), provider: aiProviderSchema.optional() }).parse(req.body || {});
    const localPath = projectPath(body, d.config); if (!localPath) return res.status(400).json({ error: 'projectPath required' });
    const useAi = body.useAi ?? !(body.useCursor || body.useFinalVerification);
    const needsProvider = useAi || body.useCursor || body.useFinalVerification;
    const provider = needsProvider ? resolveProvider(body.provider, d.config) : undefined;
    if (useAi) assertProviderConfigured(provider!, d.config, 'analysis');
    else if (body.useCursor) assertProviderConfigured(provider!, d.config, 'codebase vetting');
    else if (body.useFinalVerification) assertProviderConfigured(provider!, d.config, 'final verification');
    if (body.useFinalVerification && provider === 'cursor' && !(d.config.llmApiKey && d.config.llmModel)) return res.status(412).json({ error: 'LLM_API_KEY and LLM_MODEL are required for final verification with Cursor provider' });
    const job = d.analysisJobs.start({ repo: `${req.params.owner}/${req.params.repo}`, projectPath: localPath, promptTemplate: body.promptTemplate, useAi, useCursor: body.useCursor, useFinalVerification: body.useFinalVerification, issueIds: body.issueIds, provider });
    res.status(202).json(job);
  }));
  router.get('/repos/:owner/:repo/dependency-analysis', asyncRoute(async (req: any, res: any) => {
    const localPath = projectPath(req.query, d.config); if (!localPath) return res.status(400).json({ error: 'projectPath required' });
    const repo = `${req.params.owner}/${req.params.repo}`;
    res.json(buildRepositoryAnalysis(repo, localPath, await d.repo.listIssues(repo)));
  }));
  router.get('/analysis-jobs/:jobId', (req, res) => { const job = d.analysisJobs.get(req.params.jobId); return job ? res.json(job) : res.status(404).json({ error: 'Analysis job not found' }); });
  router.get('/analysis/prompt-template', (_req, res) => res.json({
    promptTemplate: d.config.aiPromptTemplate || defaultAiPromptTemplate,
    model: d.config.llmModel,
    configured: Boolean(d.config.llmApiKey && d.config.llmModel),
    cursorConfigured: Boolean(d.config.cursorApiKey),
    cursorModel: d.config.cursorModel,
    geminiConfigured: Boolean(d.config.geminiApiKey),
    geminiModel: d.config.geminiModel,
    aiProviders: configuredAiProviders(d.config)
  }));
  router.get('/work-items/grouping-prompt', (_req, res) => res.json({
    version: 'v2',
    promptTemplate: defaultWorkItemGroupingPrompt,
    cursorModel: d.config.cursorModel,
    geminiModel: d.config.geminiModel,
    cursorConfigured: Boolean(d.config.cursorApiKey),
    geminiConfigured: Boolean(d.config.geminiApiKey),
    aiProviders: configuredAiProviders(d.config)
  }));
  router.post('/repos/:owner/:repo/batch-grouping-prompt', asyncRoute(async (req: any, res: any) => {
    const issues = await d.repo.listIssues(`${req.params.owner}/${req.params.repo}`);
    res.json({ prompt: 'Review the dependency engine groups for compatibility. Prefer groups of up to 3, keep related manifest directories together when possible, and isolate risky or unsafe upgrades.', issues: issues.map(issue => ({ id: issue.id, package: issue.packageName, target: issue.patchedVersion, manifest: issue.manifestPath, risk: issue.lastUpgradeAnalysis?.riskLevel, safetyScore: issue.lastUpgradeAnalysis?.safetyScore, needsAdditionalBumps: issue.lastUpgradeAnalysis?.needsAdditionalBumps })) });
  }));

  router.get('/repos/:owner/:repo/pull-requests', asyncRoute(async (req: any, res: any) => {
    const repo = `${req.params.owner}/${req.params.repo}`; const issues = await d.repo.listIssues(repo);
    const prs = await d.github.pullRequestStatuses(req.params.owner, req.params.repo);
    for (const pr of prs) pr.issueId = issues.find(issue => issue.pr.branch === pr.branch || issue.pr.number === pr.number)?.id;
    res.json(prs);
  }));
  router.post('/repos/:owner/:repo/pull-requests/refresh', asyncRoute(async (req: any, res: any) => res.json(await d.github.pullRequestStatuses(req.params.owner, req.params.repo))));
  router.post('/repos/:owner/:repo/pull-requests/:number/close', asyncRoute(async (req: any, res: any) => {
    const number = z.coerce.number().int().positive().parse(req.params.number);
    await d.github.closePullRequest(req.params.owner, req.params.repo, number);
    res.json({ number, state: 'closed' });
  }));
  router.get('/issues/:id/pr-status', asyncRoute(async (req: any, res: any) => {
    const issue = await issueFor(req); const { owner, name } = repoParts(issue.repo);
    const prs = await d.github.pullRequestStatuses(owner, name); const pr = prs.find(candidate => candidate.number === issue.pr.number || candidate.branch === issue.pr.branch);
    return pr ? res.json(pr) : res.status(404).json({ error: 'Open PR not found' });
  }));
  router.post('/issues/:id/actions/associate-pr', asyncRoute(async (req: any, res: any) => {
    const issue = await issueFor(req); const { owner, name } = repoParts(issue.repo); const pr = await d.github.findPullRequestByBranch(owner, name, issue.pr.branch);
    if (!pr) return res.status(404).json({ error: 'Open PR not found for expected branch' });
    issue.pr = { branch: pr.head.ref, number: pr.number, url: pr.html_url }; await d.repo.saveIssue(issue); res.json(issue.pr);
  }));
  router.post('/issues/:id/actions/close-pr', asyncRoute(async (req: any, res: any) => {
    const issue = await issueFor(req); if (!issue.pr.number) return res.status(400).json({ error: 'Issue has no associated PR' });
    const { owner, name } = repoParts(issue.repo); await d.github.closePullRequest(owner, name, issue.pr.number); await d.repo.transitionIssue(issue.id, 'CLOSED', 'github', 'PR closed', true, issue.repo); res.status(204).end();
  }));
  router.post('/issues/:id/actions/apply-pr-labels', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ repo: z.string().optional(), labels: z.array(z.string()).min(1) }).parse(req.body); const issue = await d.repo.getIssue(req.params.id, body.repo);
    if (!issue || !issue.pr.number) return res.status(400).json({ error: 'Issue or associated PR not found' }); const { owner, name } = repoParts(issue.repo); res.json(await d.github.applyLabels(owner, name, issue.pr.number, body.labels));
  }));

  router.get('/package-manifest', asyncRoute(async (req: any, res: any) => {
    const localPath = String(req.query.projectPath || d.config.defaultProjectPath || ''); if (!localPath) return res.status(400).json({ error: 'projectPath required' });
    const fs = await import('node:fs/promises'); const manifestPath = String(req.query.manifestPath || 'package.json'); const manifest = JSON.parse(await fs.readFile(path.join(localPath, manifestPath), 'utf8'));
    res.json({ path: manifestPath, dependencies: manifest.dependencies || {}, devDependencies: manifest.devDependencies || {}, optionalDependencies: manifest.optionalDependencies || {}, peerDependencies: manifest.peerDependencies || {} });
  }));
  router.post('/repos/:owner/:repo/package-updates', asyncRoute(async (req: any, res: any) => {
    const body = z.object({ projectPath: z.string().optional(), manifestPath: z.string().default('package.json'), packageName: z.string().min(1), targetVersion: z.string().min(1), createPr: z.boolean().default(false) }).parse(req.body);
    const repo = `${req.params.owner}/${req.params.repo}`; const root = body.projectPath || d.config.repoRoot || d.config.defaultProjectPath || '';
    const job = d.jobs.start({ kind: 'package-update', repo, command: path.resolve('scripts/remediation/package-json-update.sh'), args: ['fix', repo, '--manifest', body.manifestPath, '--package', body.packageName, '--target', body.targetVersion, ...(root ? ['--repo-root', root] : []), ...(body.createPr ? ['--push', '--open-pr'] : [])], env: { REMEDIATION_PRE_INSTALL_SCRIPT: d.config.preInstallScript, REMEDIATION_POST_BUMP_HOOK: d.config.postBumpHook, DEPENDABOT_FIX_REPO_ROOT: root } });
    res.status(202).json(job);
  }));
  router.get('/package-update-jobs/:jobId', asyncRoute(async (req: any, res: any) => { const job = await d.jobs.get(req.params.jobId); return job?.kind === 'package-update' ? res.json(job) : res.status(404).json({ error: 'Package update job not found' }); }));

  router.get('/repos/:owner/:repo/worktrees', asyncRoute(async (req: any, res: any) => { const localPath = String(req.query.projectPath || d.config.defaultProjectPath || d.config.repoRoot || ''); if (!localPath) return res.status(400).json({ error: 'projectPath required' }); res.json(await d.worktrees.list(localPath)); }));
  router.delete('/repos/:owner/:repo/worktrees/:worktreeId', asyncRoute(async (req: any, res: any) => { const body = z.object({ projectPath: z.string().optional(), force: z.boolean().optional() }).parse(req.body || {}); const localPath = body.projectPath || d.config.defaultProjectPath || d.config.repoRoot; if (!localPath) return res.status(400).json({ error: 'projectPath required' }); res.json(await d.worktrees.remove(localPath, req.params.worktreeId, body.force)); }));
  router.post('/repos/:owner/:repo/worktrees/bulk-delete', asyncRoute(async (req: any, res: any) => { const body = z.object({ projectPath: z.string().optional(), ids: z.array(z.string()), force: z.boolean().optional() }).parse(req.body); const localPath = body.projectPath || d.config.defaultProjectPath || d.config.repoRoot; if (!localPath) return res.status(400).json({ error: 'projectPath required' }); const removed = []; for (const id of body.ids) removed.push(await d.worktrees.remove(localPath, id, body.force)); res.json(removed); }));

  router.get('/slack/status', (_req, res) => res.json(d.slack.status()));
  router.post('/slack/probe', asyncRoute(async (req: any, res: any) => { const body = z.object({ channel: z.string().trim().min(1).max(100).optional() }).parse(req.body || {}); res.json(await d.slack.sendReviewRequest({ channel: body.channel, text: 'PatchPilot Slack MCP connection test', pullRequests: [] })); }));
  router.post('/repos/:owner/:repo/slack-review-request', asyncRoute(async (req: any, res: any) => {
    res.json(await d.slack.sendReviewRequest(await prepareSlackReview(req)));
  }));
  router.post('/repos/:owner/:repo/slack-review-request/stream', async (req: any, res: any) => {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.flushHeaders?.();
    const write = (event: unknown) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      write({ type: 'progress', progress: { id: 'prepare', label: 'Prepare review request', status: 'running' } });
      const input = await prepareSlackReview(req);
      write({ type: 'progress', progress: { id: 'prepare', label: 'Prepare review request', status: 'completed', detail: `${input.pullRequests.length} pull request${input.pullRequests.length === 1 ? '' : 's'}` } });
      const result = await d.slack.sendReviewRequest({
        ...input,
        onProgress: progress => write({ type: 'progress', progress })
      });
      write({ type: 'result', result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write({ type: 'error', error: message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  router.get('/state/export', asyncRoute(async (_req: any, res: any) => res.json(await d.repo.exportState())));
  router.post('/state/import', asyncRoute(async (req: any, res: any) => { await d.repo.importState(req.body); res.status(204).end(); }));
  router.post('/state/save', asyncRoute(async (_req: any, res: any) => res.json(await d.repo.exportState())));
  return router;
}
