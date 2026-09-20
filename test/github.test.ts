import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../src/integrations/github.js';

afterEach(() => vi.unstubAllGlobals());

describe('GitHubClient authentication', () => {
  it('uses the gh CLI token when GH_TOKEN is absent', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cli-token');
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new GitHubClient(undefined, 'https://api.github.com', () => 'cli-token');
    expect(client.authStatus()).toMatchObject({ configured: true, source: 'gh-cli' });
    expect(await client.repositories()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('prefers an explicit environment token', () => {
    const resolver = vi.fn(() => 'cli-token');
    const client = new GitHubClient('env-token', 'https://api.github.com', resolver);
    expect(client.authStatus()).toMatchObject({ configured: true, source: 'env' });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('reports actionable setup guidance when neither method is available', () => {
    const client = new GitHubClient(undefined, 'https://api.github.com', () => undefined);
    expect(client.authStatus()).toMatchObject({ configured: false, source: 'none' });
    expect(client.authStatus().message).toContain('gh auth login');
  });

  it('follows Dependabot cursor links without sending the unsupported page parameter', async () => {
    const makeAlert = (number: number) => ({ number, state: 'open', dependency: { package: { ecosystem: 'npm', name: `package-${number}` }, manifest_path: 'package.json' } });
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      expect(url).not.toMatch(/[?&]page=/);
      expect(url).toContain('ecosystem=npm');
      if (fetchMock.mock.calls.length === 1) {
        return new Response(JSON.stringify([makeAlert(1)]), { status: 200, headers: { 'Content-Type': 'application/json', Link: '<https://api.github.com/repos/owner/repo/dependabot/alerts?state=open&ecosystem=npm&per_page=100&after=cursor>; rel="next"' } });
      }
      expect(url).toContain('after=cursor');
      return new Response(JSON.stringify([makeAlert(2)]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new GitHubClient('token');
    expect((await client.dependabotAlerts('owner', 'repo')).map(alert => alert.number)).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('closes a pull request through the GitHub API', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init: RequestInit) => {
      expect(String(input)).toBe('https://api.github.com/repos/owner/repo/pulls/42');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(String(init.body))).toEqual({ state: 'closed' });
      return new Response(JSON.stringify({ number: 42, state: 'closed' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new GitHubClient('token');

    await client.closePullRequest('owner', 'repo', 42);

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
