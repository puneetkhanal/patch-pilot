import { GitHubRepository, PullRequestStatus } from '../domain/types.js';
import { spawnSync } from 'node:child_process';
import { primaryEcosystemAdapter } from '../ecosystems/catalog.js';

export interface DependabotAlert {
  number: number;
  state: string;
  dependency: { package: { ecosystem: string; name: string }; manifest_path: string };
  security_advisory?: { severity?: string; cvss?: { score?: number } };
  security_vulnerability?: { vulnerable_version_range?: string; first_patched_version?: { identifier?: string } | null };
  html_url?: string;
}

type Pull = {
  number: number;
  html_url: string;
  title: string;
  draft?: boolean;
  updated_at: string;
  user?: { login?: string };
  head: { ref: string; sha: string };
};
type RepositoryResponse = { full_name: string; private: boolean; default_branch: string; updated_at: string };

export class GitHubClient {
  private resolvedToken?: string;
  private tokenSource: 'env' | 'gh-cli' | 'none';

  constructor(token: string | undefined, private base = 'https://api.github.com', private cliToken: () => string | undefined = GitHubClient.readCliToken) {
    this.resolvedToken = token?.trim() || undefined;
    this.tokenSource = this.resolvedToken ? 'env' : 'none';
  }

  private static readCliToken() {
    const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 ? result.stdout.trim() || undefined : undefined;
  }

  private resolveToken() {
    if (!this.resolvedToken) {
      this.resolvedToken = this.cliToken();
      if (this.resolvedToken) this.tokenSource = 'gh-cli';
    }
    return this.resolvedToken;
  }

  authStatus() {
    const token = this.resolveToken();
    return {
      configured: Boolean(token),
      source: token ? this.tokenSource : 'none',
      message: token ? (this.tokenSource === 'gh-cli' ? 'Authenticated with gh CLI' : 'Authenticated with GH_TOKEN') : 'Install GitHub CLI and run `gh auth login`, or set GH_TOKEN'
    };
  }

  private headers() {
    const token = this.resolveToken();
    if (!token) throw new Error('GitHub authentication is required. Install `gh`, run `gh auth login`, or set GH_TOKEN.');
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'Content-Type': 'application/json'
    };
  }

  private async response(pathOrUrl: string, init: RequestInit = {}) {
    const url = new URL(pathOrUrl, this.base);
    if (url.origin !== new URL(this.base).origin) throw new Error('GitHub pagination returned an unexpected host');
    const response = await fetch(url, { ...init, headers: { ...this.headers(), ...(init.headers || {}) } });
    if (!response.ok) throw new Error(`GitHub API ${init.method || 'GET'} ${url.pathname}${url.search} failed: ${response.status} ${await response.text()}`);
    return response;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.response(path, init);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private async paged<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const chunk = await this.request<T[]>(`${path}${separator}per_page=100&page=${page}`);
      all.push(...chunk);
      if (chunk.length < 100) return all;
    }
  }

  async repositories(): Promise<GitHubRepository[]> {
    const repos = await this.paged<RepositoryResponse>('/user/repos?sort=updated&affiliation=owner,collaborator,organization_member');
    return repos.map(repo => ({ fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch, updatedAt: repo.updated_at }));
  }

  async dependabotAlerts(owner: string, repo: string, state = 'open', ecosystem = primaryEcosystemAdapter.id) {
    const all: DependabotAlert[] = [];
    let next: string | undefined = `/repos/${owner}/${repo}/dependabot/alerts?state=${encodeURIComponent(state)}&ecosystem=${encodeURIComponent(ecosystem)}&per_page=100`;
    const visited = new Set<string>();
    while (next) {
      if (visited.has(next)) throw new Error('GitHub Dependabot pagination returned a repeated cursor');
      visited.add(next);
      const response = await this.response(next);
      all.push(...await response.json() as DependabotAlert[]);
      const link = response.headers.get('link') || '';
      next = link.split(',').map(value => value.trim()).map(value => value.match(/^<([^>]+)>;\s*rel="([^"]+)"$/)).find(match => match?.[2] === 'next')?.[1];
    }
    return all;
  }

  async openPullRequests(owner: string, repo: string) {
    return this.paged<Pull>(`/repos/${owner}/${repo}/pulls?state=open`);
  }

  async pullRequestStatuses(owner: string, repo: string): Promise<PullRequestStatus[]> {
    const pulls = await this.openPullRequests(owner, repo);
    return Promise.all(pulls.map(async pull => {
      const [checks, statuses, reviews] = await Promise.all([
        this.request<{ total_count: number; check_runs: Array<{ status: string; conclusion: string | null }> }>(`/repos/${owner}/${repo}/commits/${pull.head.sha}/check-runs`),
        this.request<{ state: string; statuses: Array<{ state: string }> }>(`/repos/${owner}/${repo}/commits/${pull.head.sha}/status`),
        this.paged<{ state: string; submitted_at?: string }>(`/repos/${owner}/${repo}/pulls/${pull.number}/reviews`)
      ]);
      const checkStates = [
        ...checks.check_runs.map(check => check.status === 'completed' ? (check.conclusion || 'neutral') : 'pending'),
        ...statuses.statuses.map(status => status.state)
      ];
      const failed = checkStates.filter(state => ['failure', 'failed', 'error', 'timed_out', 'cancelled', 'action_required'].includes(state)).length;
      const successful = checkStates.filter(state => ['success', 'successful', 'neutral', 'skipped'].includes(state)).length;
      const pending = Math.max(0, checkStates.length - failed - successful);
      const latestReview = [...reviews].sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''))[0]?.state;
      const reviewState = reviews.some(review => review.state === 'CHANGES_REQUESTED') ? 'changes_requested'
        : reviews.some(review => review.state === 'APPROVED') ? 'approved'
        : latestReview ? 'review_required' : 'unknown';
      return {
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        branch: pull.head.ref,
        author: pull.user?.login,
        draft: Boolean(pull.draft),
        reviewState,
        checks: {
          total: checkStates.length,
          successful,
          failed,
          pending,
          conclusion: failed ? 'failed' : pending ? 'pending' : checkStates.length ? 'successful' : 'unknown'
        },
        updatedAt: pull.updated_at
      } satisfies PullRequestStatus;
    }));
  }

  async findPullRequestByBranch(owner: string, repo: string, branch: string) {
    const pulls = await this.paged<Pull>(`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    return pulls[0];
  }

  async closePullRequest(owner: string, repo: string, number: number) {
    return this.request<Pull>(`/repos/${owner}/${repo}/pulls/${number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
  }

  async applyLabels(owner: string, repo: string, number: number, labels: string[]) {
    return this.request<{ labels: Array<{ name: string }> }>(`/repos/${owner}/${repo}/issues/${number}/labels`, { method: 'POST', body: JSON.stringify({ labels }) });
  }
}
