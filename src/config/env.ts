export interface Config {
  port: number;
  ghToken?: string;
  githubApiBase: string;
  defaultRepo?: string;
  defaultProjectPath?: string;
  repositoriesRoot?: string;
  analysisProjectPath?: string;
  repoRoot?: string;
  fixCacheRoot?: string;
  preInstallScript?: string;
  postBumpHook?: string;
  requireAwsSso: boolean;
  awsProfile: string;
  llmApiKey?: string;
  llmBaseUrl: string;
  llmModel?: string;
  aiPromptTemplate?: string;
  cursorApiKey?: string;
  cursorModel: string;
  geminiApiKey?: string;
  geminiModel: string;
  codexFixEnabled: boolean;
  codexFixModel?: string;
  claudeFixEnabled: boolean;
  claudeFixCommand: string;
  fixAgentSkillsRoot?: string;
  slackMcpUrl?: string;
  slackMcpTool: string;
  slackDefaultChannel?: string;
}

export const CURSOR_ANALYSIS_MODEL = 'composer-2.5' as const;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash' as const;

export function loadConfig(env = process.env): Config {
  return {
    port: Number(env.PORT || 4000),
    ghToken: env.GH_TOKEN,
    githubApiBase: env.GITHUB_API_BASE_URL || 'https://api.github.com',
    defaultRepo: env.ORCHESTRATOR_DEFAULT_REPO,
    defaultProjectPath: env.ORCHESTRATOR_DEFAULT_PROJECT_PATH,
    repositoriesRoot: env.GITHUB_REPOSITORIES_ROOT,
    analysisProjectPath: env.UPGRADE_ANALYSIS_PROJECT_PATH,
    repoRoot: env.DEPENDABOT_FIX_REPO_ROOT,
    fixCacheRoot: env.DEPENDABOT_FIX_CACHE_ROOT,
    preInstallScript: env.REMEDIATION_PRE_INSTALL_SCRIPT,
    postBumpHook: env.REMEDIATION_POST_BUMP_HOOK,
    requireAwsSso: /^(1|true|yes)$/i.test(env.REMEDIATION_REQUIRE_AWS_SSO || ''),
    awsProfile: env.AWS_SSO_PROFILE || 'default',
    llmApiKey: env.LLM_API_KEY,
    llmBaseUrl: (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    llmModel: env.LLM_MODEL,
    aiPromptTemplate: env.AI_UPGRADE_PROMPT_TEMPLATE,
    cursorApiKey: env.CURSOR_API_KEY,
    cursorModel: CURSOR_ANALYSIS_MODEL,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    codexFixEnabled: !/^(0|false|no)$/i.test(env.CODEX_FIX_ENABLED || ''),
    codexFixModel: env.CODEX_FIX_MODEL,
    claudeFixEnabled: /^(1|true|yes)$/i.test(env.CLAUDE_FIX_ENABLED || ''),
    claudeFixCommand: env.CLAUDE_FIX_COMMAND || 'claude',
    fixAgentSkillsRoot: env.FIX_AGENT_SKILLS_ROOT,
    slackMcpUrl: env.SLACK_MCP_URL,
    slackMcpTool: env.SLACK_MCP_TOOL || 'send_message',
    slackDefaultChannel: env.SLACK_DEFAULT_CHANNEL
  };
}
