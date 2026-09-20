import { TrackerIssue } from '../domain/types.js';
import { DependabotAlert, GitHubClient } from '../integrations/github.js';
import { Repository } from '../repository/repository.js';
import { issueBranch, issueId } from '../utils/slug.js';
import { primaryEcosystemAdapter } from '../ecosystems/catalog.js';

function complexity(alerts: DependabotAlert[]): 'low' | 'medium' | 'high' {
  const score = Math.max(...alerts.map(alert => alert.security_advisory?.cvss?.score ?? 0));
  return score >= 9 ? 'high' : score >= 7 ? 'medium' : 'low';
}

export class Scanner {
  constructor(private repo: Repository, private gh: GitHubClient) {}

  async scan(owner: string, name: string) {
    const repoKey = `${owner}/${name}`;
    const ecosystem = primaryEcosystemAdapter.id;
    const alerts = (await this.gh.dependabotAlerts(owner, name, 'open', ecosystem)).filter(alert => alert.dependency.package.ecosystem.toLowerCase() === ecosystem);
    const groups = new Map<string, DependabotAlert[]>();
    for (const alert of alerts) {
      const patched = alert.security_vulnerability?.first_patched_version?.identifier;
      if (!patched) continue;
      const key = issueId(ecosystem, alert.dependency.package.name, patched);
      groups.set(key, [...(groups.get(key) || []), alert]);
    }
    const now = new Date().toISOString();
    const issues: TrackerIssue[] = [];
    for (const [id, grouped] of groups) {
      const sorted = [...grouped].sort((a, b) => a.dependency.manifest_path.localeCompare(b.dependency.manifest_path) || a.number - b.number);
      const first = sorted[0];
      const patchedVersion = first.security_vulnerability!.first_patched_version!.identifier!;
      const manifestPaths = [...new Set(sorted.map(alert => alert.dependency.manifest_path))];
      const severityScore = Math.max(...sorted.map(alert => alert.security_advisory?.cvss?.score || 0));
      issues.push({
        id,
        repo: repoKey,
        title: `${first.dependency.package.name} → ${patchedVersion}`,
        state: 'NEW',
        alerts: sorted.map(alert => alert.number).sort((a, b) => a - b),
        packageName: first.dependency.package.name,
        ecosystem,
        manifestPath: manifestPaths[0],
        manifestPaths,
        patchedVersion,
        vulnerableVersionRange: first.security_vulnerability?.vulnerable_version_range || '',
        severity: first.security_advisory?.severity || 'unknown',
        severityScore,
        complexity: complexity(sorted),
        pr: { branch: issueBranch(manifestPaths[0], ecosystem, first.dependency.package.name, patchedVersion) },
        remediation: {},
        history: [{ at: now, to: 'NEW', actor: 'scan' }],
        notes: [],
        labels: [],
        updatedAt: now,
        createdAt: now
      });
    }
    await this.repo.upsertIssues(repoKey, issues);
    const pullRequests = await this.gh.openPullRequests(owner, name);
    return { alertCount: alerts.length, issueCount: issues.length, openPrCount: pullRequests.length, scannedAt: now };
  }
}
