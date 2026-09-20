import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { GitHubClient } from './integrations/github.js';
import { SlackMcpClient } from './integrations/slackMcp.js';
import { JobManager } from './remediation/jobManager.js';
import { JsonRepository } from './repository/jsonRepository.js';
import { AnalysisJobManager } from './services/analysisJobs.js';
import { BatchService } from './services/batches.js';
import { GroupingJobManager } from './services/groupingJobs.js';
import { Scanner } from './services/scanner.js';
import { WorktreeService } from './services/worktrees.js';
import { LocalRepositoryService } from './services/localRepositories.js';
import { SettingsService } from './services/settings.js';
import { FixAgentSkillService } from './services/fixAgentSkills.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
try { loadEnvFile(path.join(projectRoot, '.env')); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
const config = loadConfig();
const repository = new JsonRepository();
const github = new GitHubClient(config.ghToken, config.githubApiBase);
const settings = new SettingsService(path.join(projectRoot, '.orchestrator-settings.json'), { repositoriesRoot: config.repositoriesRoot });
const batches = new BatchService(repository);
const app = createApp({
  config,
  repo: repository,
  github,
  scanner: new Scanner(repository, github),
  batches,
  jobs: new JobManager(repository),
  worktrees: new WorktreeService(),
  slack: new SlackMcpClient(config),
  analysisJobs: new AnalysisJobManager(repository, config),
  groupingJobs: new GroupingJobManager(repository, batches, config),
  settings,
  localRepositories: new LocalRepositoryService(),
  fixAgentSkills: new FixAgentSkillService(config)
}, path.resolve(here, '../public'));

app.listen(config.port, () => console.log(`PatchPilot listening on http://localhost:${config.port}`));
