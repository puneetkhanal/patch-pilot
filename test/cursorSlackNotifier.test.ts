import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@cursor/sdk';
import { loadConfig } from '../src/config/env.js';
import { CursorSlackNotifier } from '../src/integrations/cursorSlackNotifier.js';

vi.mock('@cursor/sdk', () => ({ Agent: { create: vi.fn(), resume: vi.fn(), getRun: vi.fn() } }));

describe('CursorSlackNotifier', () => {
  let root: string;
  const close = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-slack-'));
    await fs.mkdir(path.join(root, '.cursor/skills/send-slack-review'), { recursive: true });
    await fs.writeFile(path.join(root, '.cursor/skills/send-slack-review/SKILL.md'), '---\nname: send-slack-review\ndescription: Send a review request.\n---\nCall the configured Slack MCP tool exactly once.\n');
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  function mockAgent(step: any, result: any = { id: 'run-slack-1', status: 'finished', result: 'sent' }, conversation?: any[]) {
    const send = vi.fn(async (_prompt: string, options: any) => {
      if (step) await options.onStep({ step });
      return { id: 'run-slack-1', status: 'running', wait: vi.fn().mockResolvedValue(result), cancel, ...(conversation ? { conversation: vi.fn().mockResolvedValue(conversation) } : {}) };
    });
    const sdkAgent = { agentId: 'bc-slack-1', send, close } as any;
    vi.mocked(Agent.create).mockResolvedValue(sdkAgent);
    vi.mocked(Agent.resume).mockResolvedValue(sdkAgent);
    return send;
  }

  function config(extra: Record<string, string> = {}) {
    return loadConfig({
      CURSOR_API_KEY: 'cursor-key',
      SLACK_CURSOR_MCP_SERVER: 'slack',
      SLACK_CURSOR_MCP_TOOL: 'slack_send_message',
      SLACK_DEFAULT_CHANNEL: 'C0123456789',
      ...extra
    });
  }

  it('uses dashboard-managed Slack MCP and verifies its completed tool result case-insensitively', async () => {
    const send = mockAgent({
      type: 'toolCall',
      message: {
        type: 'mcp',
        args: { providerIdentifier: 'Slack', toolName: 'slack_send_message', args: { channel_id: 'C0123456789' } },
        result: { status: 'success', value: { isError: false, content: [] } }
      }
    });
    const notifier = new CursorSlackNotifier(config(), root);
    const onProgress = vi.fn();

    const delivery = await notifier.sendReviewRequest({
      text: 'Please review this pull request.',
      pullRequests: [{ title: 'Upgrade lodash', url: 'https://example.com/pull/7', status: 'pending; review required' }],
      onProgress
    });

    expect(notifier.status()).toMatchObject({ configured: true, provider: 'cursor-cloud-mcp', server: 'slack', tool: 'slack_send_message' });
    expect(Agent.create).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'cursor-key',
      cloud: { repos: [], skipReviewerRequest: true }
    }));
    expect(vi.mocked(Agent.create).mock.calls[0][0]).not.toHaveProperty('mcpServers');
    expect(vi.mocked(Agent.create).mock.calls[0][0]).not.toHaveProperty('tools');
    expect(send).toHaveBeenCalledWith(expect.stringContaining('"title":"Upgrade lodash"'), expect.objectContaining({ onStep: expect.any(Function) }));
    expect(delivery).toEqual({ ok: true, provider: 'cursor-cloud-mcp', server: 'slack', tool: 'slack_send_message', channel: 'C0123456789', runId: 'run-slack-1' });
    expect(onProgress.mock.calls.map(([progress]) => [progress.id, progress.status])).toEqual([
      ['cursor-agent', 'running'],
      ['cursor-agent', 'completed'],
      ['cursor-run', 'running'],
      ['cursor-run', 'completed'],
      ['slack-delivery', 'running'],
      ['slack-delivery', 'completed']
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses an inline MCP server only when a custom URL is configured', async () => {
    mockAgent({
      type: 'toolCall',
      message: { type: 'mcp', args: { providerIdentifier: 'slack', toolName: 'slack_send_message' }, result: { status: 'success', value: { isError: false, content: [] } } }
    });
    const notifier = new CursorSlackNotifier(config({
      SLACK_CURSOR_MCP_URL: 'https://example.com/slack/mcp',
      SLACK_CURSOR_MCP_CLIENT_ID: 'custom-client'
    }), root);

    await notifier.sendReviewRequest({ text: 'Review', pullRequests: [] });

    expect(Agent.create).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: {
        slack: {
          type: 'http',
          url: 'https://example.com/slack/mcp',
          auth: { CLIENT_ID: 'custom-client' }
        }
      }
    }));
  });

  it('is configured without a default channel when callers can supply one', () => {
    const notifier = new CursorSlackNotifier(config({ SLACK_DEFAULT_CHANNEL: '' }), root);

    expect(notifier.status()).toMatchObject({ configured: true });
  });

  it('clones an optional cloud repo when configured', async () => {
    mockAgent({
      type: 'toolCall',
      message: { type: 'mcp', args: { providerIdentifier: 'slack', toolName: 'slack_send_message' }, result: { status: 'success', value: { isError: false, content: [] } } }
    });
    const notifier = new CursorSlackNotifier(config({ SLACK_CURSOR_CLOUD_REPO: 'https://github.com/owner/repo' }), root);

    await notifier.sendReviewRequest({ text: 'Review', pullRequests: [] });

    expect(Agent.create).toHaveBeenCalledWith(expect.objectContaining({
      cloud: { repos: [{ url: 'https://github.com/owner/repo' }], skipReviewerRequest: true }
    }));
  });

  it('resumes a configured cloud agent without overriding its persisted MCP tools', async () => {
    mockAgent({
      type: 'toolCall',
      message: { type: 'mcp', args: { providerIdentifier: 'slack', toolName: 'slack_send_message' }, result: { status: 'success', value: { isError: false, content: [] } } }
    });
    const notifier = new CursorSlackNotifier(config({ SLACK_CURSOR_AGENT_ID: 'bc-existing-slack-agent' }), root);

    await notifier.sendReviewRequest({ text: 'Review', pullRequests: [] });

    expect(Agent.resume).toHaveBeenCalledWith('bc-existing-slack-agent', { apiKey: 'cursor-key' });
    expect(Agent.create).not.toHaveBeenCalled();
  });

  it('fails closed when Cursor uses a different MCP tool', async () => {
    mockAgent({
      type: 'toolCall',
      message: { type: 'mcp', args: { providerIdentifier: 'slack', toolName: 'slack_read_channel' }, result: { status: 'success', value: { isError: false, content: [] } } }
    });
    const notifier = new CursorSlackNotifier(config(), root);

    await expect(notifier.sendReviewRequest({ text: 'Review', pullRequests: [] }))
      .rejects.toThrow('Expected exactly one slack/slack_send_message MCP call; observed slack/slack_read_channel');
  });

  it('verifies cloud MCP calls from completed conversation history when streaming omits them', async () => {
    mockAgent(undefined, { id: 'run-slack-1', status: 'finished', result: 'sent' }, [{
      type: 'agentConversationTurn',
      turn: {
        steps: [{
          type: 'toolCall',
          message: {
            type: 'mcp',
            args: { providerIdentifier: 'slack', toolName: 'slack_send_message' },
            result: { status: 'success', value: { isError: false, content: [] } }
          }
        }]
      }
    }]);
    const notifier = new CursorSlackNotifier(config(), root);

    await expect(notifier.sendReviewRequest({ text: 'Review', pullRequests: [] }))
      .resolves.toMatchObject({ ok: true, runId: 'run-slack-1' });
  });

  it('turns a cloud agent authentication explanation into reconnection guidance', async () => {
    mockAgent(undefined, {
      id: 'run-slack-1',
      status: 'finished',
      result: 'The configured Slack MCP server requires authentication before slack_send_message can be used.'
    });
    const notifier = new CursorSlackNotifier(config(), root);

    await expect(notifier.sendReviewRequest({ text: 'Review', pullRequests: [] }))
      .rejects.toMatchObject({ status: 412, message: 'Reconnect Slack MCP in Cursor (Settings → MCP → Slack or cursor.com/agents), then retry the review request.' });
  });

  it('distinguishes an unavailable MCP namespace from a disconnected Slack integration', async () => {
    mockAgent(undefined, {
      id: 'run-slack-1',
      status: 'finished',
      result: 'The configured slack MCP server is unavailable — tool discovery failed.'
    });
    const notifier = new CursorSlackNotifier(config(), root);

    await expect(notifier.sendReviewRequest({ text: 'Review', pullRequests: [] }))
      .rejects.toMatchObject({
        status: 412,
        code: 'slack_mcp_unavailable',
        message: 'Slack MCP is not available to this Cursor SDK cloud run. In cursor.com/agents, open the MCP dropdown, add or enable https://mcp.slack.com/mcp, complete its OAuth flow, and retry. The regular Cursor Slack integration is separate and does not expose slack_send_message to SDK agents.'
      });
  });

  it('turns Cursor OAuth failures into reconnection guidance', async () => {
    vi.mocked(Agent.create).mockRejectedValue(new Error('OAuth login required'));
    const notifier = new CursorSlackNotifier(config(), root);

    await expect(notifier.sendReviewRequest({ text: 'Review', pullRequests: [] }))
      .rejects.toMatchObject({ status: 412, message: 'Reconnect Slack MCP in Cursor (Settings → MCP → Slack or cursor.com/agents), then retry the review request.' });
  });
});
