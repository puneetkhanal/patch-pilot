import { Config } from '../config/env.js';

export class SlackMcpClient {
  constructor(private config: Config) {}
  status() { return { configured: Boolean(this.config.slackMcpUrl), url: this.config.slackMcpUrl ? 'configured' : undefined, tool: this.config.slackMcpTool, defaultChannel: this.config.slackDefaultChannel }; }

  private async post(payload: unknown, sessionId?: string) {
    const response = await fetch(this.config.slackMcpUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Slack MCP request failed: ${response.status} ${await response.text()}`);
    const body = await response.text();
    const data = response.headers.get('content-type')?.includes('text/event-stream')
      ? body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).find(Boolean)
      : body;
    return { payload: data ? JSON.parse(data) : undefined, sessionId: response.headers.get('mcp-session-id') || sessionId };
  }

  async sendReviewRequest(input: { channel?: string; text: string; pullRequests: Array<{ title: string; url: string; status: string }> }) {
    if (!this.config.slackMcpUrl) throw new Error('SLACK_MCP_URL is not configured');
    const initialized = await this.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'patchpilot', version: '1.0.0' } } });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, initialized.sessionId);
    const list = input.pullRequests.map(pr => `• ${pr.title} — ${pr.status}\n  ${pr.url}`).join('\n');
    const text = list ? `${input.text}\n\n${list}` : input.text;
    const result = await this.post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: this.config.slackMcpTool, arguments: { channel: input.channel || this.config.slackDefaultChannel, text } } }, initialized.sessionId);
    if (result.payload?.error) throw new Error(result.payload.error.message || 'Slack MCP tool call failed');
    if (result.payload?.result?.isError) throw new Error('Slack MCP tool returned an error');
    return result.payload?.result || { ok: true };
  }
}
