import { TrackerIssue } from '../domain/types.js';
import { compareVersions } from '../utils/version.js';

export function packageTargetKey(issue: TrackerIssue) {
  return `${issue.ecosystem}\0${issue.manifestPath}\0${issue.packageName}`;
}

export interface PackageTargetOverlap {
  packageName: string;
  manifestPath: string;
  primaryIssueId: string;
  primaryTargetVersion: string;
  supersededIssueIds: string[];
  supersededTargetVersions: string[];
}

export interface PackageTargetClassification {
  primaryIssues: TrackerIssue[];
  supersededBy: Map<string, string>;
  overlaps: PackageTargetOverlap[];
}

export function classifyPackageTargetOverlaps(issues: TrackerIssue[]): PackageTargetClassification {
  const clusters = new Map<string, TrackerIssue[]>();
  for (const issue of issues) {
    const key = packageTargetKey(issue);
    clusters.set(key, [...(clusters.get(key) || []), issue]);
  }
  const primaryIssues: TrackerIssue[] = [];
  const supersededBy = new Map<string, string>();
  const overlaps: PackageTargetOverlap[] = [];
  for (const members of clusters.values()) {
    if (members.length === 1) {
      primaryIssues.push(members[0]);
      continue;
    }
    const sorted = [...members].sort((left, right) => compareVersions(right.patchedVersion, left.patchedVersion));
    const primary = sorted[0];
    const superseded = sorted.slice(1);
    primaryIssues.push(primary);
    for (const issue of superseded) supersededBy.set(issue.id, primary.id);
    overlaps.push({
      packageName: primary.packageName,
      manifestPath: primary.manifestPath,
      primaryIssueId: primary.id,
      primaryTargetVersion: primary.patchedVersion,
      supersededIssueIds: superseded.map(issue => issue.id),
      supersededTargetVersions: superseded.map(issue => issue.patchedVersion)
    });
  }
  return { primaryIssues, supersededBy, overlaps };
}

export function countFixTargets(issues: TrackerIssue[]) {
  const winners = new Map<string, TrackerIssue>();
  for (const issue of issues) {
    const key = packageTargetKey(issue);
    const current = winners.get(key);
    if (!current || compareVersions(issue.patchedVersion, current.patchedVersion) > 0) winners.set(key, issue);
  }
  return winners.size;
}

export function uniquePackageTargetIssueIds(issueIds: string[], issuesById: Map<string, TrackerIssue>) {
  const chosen: string[] = [];
  const winners = new Map<string, TrackerIssue>();
  for (const id of issueIds) {
    const issue = issuesById.get(id);
    if (!issue) continue;
    const key = packageTargetKey(issue);
    const current = winners.get(key);
    if (!current || compareVersions(issue.patchedVersion, current.patchedVersion) > 0) winners.set(key, issue);
  }
  for (const id of issueIds) {
    const issue = issuesById.get(id);
    if (!issue) continue;
    if (winners.get(packageTargetKey(issue))?.id === issue.id) chosen.push(id);
  }
  return chosen;
}

export function collectPrimaryBatchAlerts(issues: TrackerIssue[]) {
  const { primaryIssues } = classifyPackageTargetOverlaps(issues);
  const primaryIds = new Set(primaryIssues.map(issue => issue.id));
  return [...new Set(issues.filter(issue => primaryIds.has(issue.id)).flatMap(issue => issue.alerts))].join(',');
}

export function attachSupersededIssueIds<T extends { issueIds: string[] }>(groups: T[], supersededBy: Map<string, string>) {
  return groups.map(group => {
    const expanded = new Set(group.issueIds);
    for (const id of group.issueIds) {
      for (const [supersededId, primaryId] of supersededBy) {
        if (primaryId === id) expanded.add(supersededId);
      }
    }
    return { ...group, issueIds: [...expanded] };
  });
}
