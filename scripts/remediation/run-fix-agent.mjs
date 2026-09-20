#!/usr/bin/env node
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

function args(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) result[values[index]?.replace(/^--/, '')] = values[index + 1];
  return result;
}

const input = args(process.argv.slice(2));
const required = ['provider', 'skill-file', 'package', 'target', 'manifest', 'alert'];
for (const name of required) if (!input[name]) throw new Error(`Missing --${name}`);
const instructions = await fs.readFile(input['skill-file'], 'utf8');
const analysis = process.env.REMEDIATION_DEPENDENCY_ANALYSIS_JSON || 'No dependency-engine result was supplied.';
const prompt = `Apply the configured ${input.provider} skill \"${input.skill || 'dependency-security-fix'}\" to the dependency fix already staged in this worktree.

Issue context:
- repository: ${input.repo || 'unknown'}
- alert: ${input.alert}
- package: ${input.package}
- target version: ${input.target}
- manifest: ${input.manifest}

Fresh dependency-engine analysis:
${analysis}

Configured skill instructions:
${instructions}

Inspect the current worktree, make any required compatibility changes, and run appropriate validation. Follow the skill exactly. Do not commit or push.`;

async function runCodex() {
  const { Codex } = await import('@openai/codex-sdk');
  const options = process.env.CODEX_API_KEY ? { apiKey: process.env.CODEX_API_KEY } : {};
  const codex = new Codex(options);
  const thread = codex.startThread({
    workingDirectory: process.cwd(),
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    ...(process.env.CODEX_FIX_MODEL ? { model: process.env.CODEX_FIX_MODEL } : {})
  });
  const turn = await thread.run(prompt);
  console.log(`agent_provider: codex`);
  console.log(`agent_skill: ${input.skill}`);
  console.log(turn.finalResponse || 'Codex completed without a final message.');
}

async function runCursor() {
  if (!process.env.CURSOR_API_KEY) throw new Error('CURSOR_API_KEY is required for Cursor fixes');
  const { Agent } = await import('@cursor/sdk');
  const result = await Agent.prompt(prompt, {
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: process.env.CURSOR_MODEL || 'composer-2.5' },
    tools: ['shell', 'read', 'edit', 'grep', 'glob', 'ls', 'readLints', 'semSearch'],
    local: { cwd: process.cwd(), sandboxOptions: { enabled: true } }
  });
  if (result.status !== 'finished') throw new Error(result.error?.message || `Cursor fix ${result.status}`);
  console.log(`agent_provider: cursor`);
  console.log(`agent_skill: ${input.skill}`);
  console.log(result.result || 'Cursor completed without a final message.');
}

async function runClaude() {
  const command = process.env.CLAUDE_FIX_COMMAND || 'claude';
  await new Promise((resolve, reject) => {
    const child = spawn(command, ['-p', '--permission-mode', 'acceptEdits', prompt], { cwd: process.cwd(), env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Claude fix exited ${code}`)));
  });
  console.log(`agent_provider: claude`);
  console.log(`agent_skill: ${input.skill}`);
}

if (input.provider === 'codex') await runCodex();
else if (input.provider === 'cursor') await runCursor();
else if (input.provider === 'claude') await runClaude();
else throw new Error(`Unsupported fix agent provider: ${input.provider}`);
