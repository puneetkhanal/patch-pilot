import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { Agent, type ConversationTurn } from '@cursor/sdk';
import { describe, expect, it } from 'vitest';

const enabled = process.env.RUN_SLACK_E2E === '1';
if (enabled) {
  try { loadEnvFile(path.resolve('.env')); }
  catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
}

const liveDescribe = enabled ? describe : describe.skip;
const defaultMcpUrl = 'https://mcp.slack.com/mcp';
const defaultMcpClientId = '3660753192626.8903469228982';

type McpCall = {
  args?: { providerIdentifier?: string; toolName?: string };
  result?: { status: 'success'; value: { isError: boolean } } | { status: 'error'; error?: unknown };
};

function mcpCallsFrom(turns: ConversationTurn[]) {
  return turns.flatMap(turn => turn.type === 'agentConversationTurn' ? turn.turn.steps : [])
    .filter(step => step.type === 'toolCall' && step.message.type === 'mcp')
    .map(step => step.message as McpCall);
}

liveDescribe('Cursor SDK to Slack MCP', () => {
  it('sends exactly one visible Slack message without using the PatchPilot API or UI', async () => {
    if (process.env.E2E_SLACK_SEND !== '1') {
      throw new Error('E2E_SLACK_SEND=1 is required because this test sends a visible Slack message');
    }

    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) throw new Error('CURSOR_API_KEY is required');

    const channel = process.env.E2E_SLACK_CHANNEL || process.env.SLACK_DEFAULT_CHANNEL || '';
    if (!/^[CGD][A-Z0-9]+$/.test(channel)) {
      throw new Error('E2E_SLACK_CHANNEL must be a Slack channel or conversation ID such as C0123456789');
    }

    const server = process.env.SLACK_CURSOR_MCP_SERVER || 'slack';
    const tool = process.env.SLACK_CURSOR_MCP_TOOL || 'slack_send_message';
    const clientId = process.env.SLACK_CURSOR_MCP_CLIENT_ID || defaultMcpClientId;
    const runtime = process.env.E2E_CURSOR_RUNTIME === 'local' ? 'local' : 'cloud';
    const existingAgentId = process.env.E2E_CURSOR_AGENT_ID;
    const useDashboardMcp = process.env.E2E_CURSOR_MCP_SOURCE === 'dashboard';
    const marker = `PatchPilot Cursor SDK E2E ${new Date().toISOString()} ${randomUUID()}`;
    const calls: McpCall[] = [];

    const agent = existingAgentId
      ? await Agent.resume(existingAgentId, { apiKey })
      : await Agent.create({
      apiKey,
      model: { id: 'composer-2.5' },
      name: `PatchPilot direct Slack E2E (${runtime})`,
      ...(runtime === 'local'
        ? {
            local: {
              cwd: path.resolve('.'),
              settingSources: ['user', 'plugins'] as const
            },
            tools: ['mcp'] as const
          }
        : { cloud: { repos: [], skipReviewerRequest: true } }),
      ...(runtime === 'cloud' && !useDashboardMcp
        ? {
            mcpServers: {
              [server]: {
                type: 'http' as const,
                url: process.env.SLACK_CURSOR_MCP_URL || defaultMcpUrl,
                auth: { CLIENT_ID: clientId }
              }
            }
          }
        : {})
        });

    try {
      const run = await agent.send([
        `This is a direct ${runtime} Cursor SDK integration test.`,
        'Send one test message using the required MCP tool.',
        `Call ${server}/${tool} exactly once and do not call any other tool.`,
        `Send to channel ID: ${channel}`,
        `Message: [E2E TEST - NO ACTION REQUIRED] ${marker}`,
        'Do not claim success unless the tool call succeeds.'
      ].join('\n'), {
        idempotencyKey: randomUUID(),
        onStep: ({ step }) => {
          if (step.type === 'toolCall' && step.message.type === 'mcp') calls.push(step.message);
        }
      });

      let result = await run.wait();
      let completedRun = run;
      if (runtime === 'cloud' && result.status === 'error' && /run stream is no longer available/i.test(result.error?.message || '')) {
        completedRun = await Agent.getRun(run.id, {
          runtime: 'cloud',
          agentId: agent.agentId,
          apiKey
        });
        result = await completedRun.wait();
      }
      expect(result.status, result.error?.message || result.result).toBe('finished');

      if (!calls.length) calls.push(...mcpCallsFrom(await completedRun.conversation()));
      const matching = calls.filter(call => (
        call.args?.providerIdentifier?.toLowerCase() === server.toLowerCase()
        && call.args?.toolName === tool
      ));

      expect(matching, result.result).toHaveLength(1);
      expect(matching[0].result).toMatchObject({
        status: 'success',
        value: { isError: false }
      });
    } finally {
      agent.close();
    }
  }, 180_000);
});
