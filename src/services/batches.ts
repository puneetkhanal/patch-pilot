import crypto from 'node:crypto';
import path from 'node:path';
import { AiAnalysisProvider, BatchGrouping, SecurityBatch, TrackerIssue } from '../domain/types.js';
import { Repository } from '../repository/repository.js';
import { activeEcosystemAdapter } from '../ecosystems/catalog.js';
import { Config } from '../config/env.js';
import { assessGroupHumanReview } from './humanReview.js';
import { countFixTargets } from './packageTargetDedup.js';
import { proposeWorkItemsWithAi } from './workItemGrouping.js';

function groupingHumanReviewFields(issueIds: string[], issues: TrackerIssue[]) {
  const review = assessGroupHumanReview(issueIds, new Map(issues.map(issue => [issue.id, issue])));
  return review.requiresHumanReview
    ? { requiresHumanReview: true, humanReviewIssueIds: review.humanReviewIssueIds, humanReviewReasons: review.humanReviewReasons }
    : {};
}

function mergedGroupingHumanReviewFields(group: { requiresHumanReview?: boolean; humanReviewIssueIds?: string[]; humanReviewReasons?: string[] }, issueIds: string[], issues: TrackerIssue[]) {
  const server = groupingHumanReviewFields(issueIds, issues);
  const humanReviewIssueIds = [...new Set([...(server.humanReviewIssueIds || []), ...(group.humanReviewIssueIds || []).filter(id => issueIds.includes(id))])];
  const humanReviewReasons = [...new Set([...(server.humanReviewReasons || []), ...(group.humanReviewReasons || [])])];
  return server.requiresHumanReview || group.requiresHumanReview || humanReviewIssueIds.length
    ? { requiresHumanReview: true, humanReviewIssueIds, humanReviewReasons }
    : {};
}

function transitionForGrouping(issue: TrackerIssue, to: TrackerIssue['state'], note: string) {
  if (issue.state === to) return;
  const at = new Date().toISOString();
  issue.history.push({ at, from: issue.state, to, actor: 'ai-auto-group', note });
  issue.state = to;
  issue.updatedAt = at;
}

export interface GroupingEligibility {
  issues: TrackerIssue[];
  replaceable: SecurityBatch[];
}

export class BatchService {
  constructor(private repo: Repository) {}

  async reset(repoKey: string) {
    const workItems = await this.repo.listBatches(repoKey);
    const issueIds = [...new Set(workItems.flatMap(workItem => workItem.issueIds))];
    for (const workItem of workItems) await this.repo.deleteBatch(workItem.id);
    let releasedIssues = 0;
    for (const issueId of issueIds) {
      const issue = await this.repo.getIssue(issueId, repoKey);
      if (!issue || ['CLOSED', 'MERGED', 'RESOLVED'].includes(issue.state)) continue;
      if (issue.state !== 'TRIAGED') await this.repo.transitionIssue(issue.id, 'TRIAGED', 'work-item-reset', 'All work items were reset by the operator.', true, repoKey);
      releasedIssues++;
    }
    return { removed: workItems.length, releasedIssues };
  }

  private async validate(repoKey: string, issueIds: string[]) {
    const unique = [...new Set(issueIds)];
    if (unique.length < 1) throw new Error('Work item must contain at least one tracked issue');
    const issues: TrackerIssue[] = [];
    const alreadyBatched = new Set((await this.repo.listBatches(repoKey)).filter(batch => !['merged', 'failed'].includes(batch.state)).flatMap(batch => batch.issueIds));
    for (const id of unique) {
      const issue = await this.repo.getIssue(id, repoKey);
      if (!issue) throw new Error(`Unknown issue ${id}`);
      if (!activeEcosystemAdapter(issue.ecosystem)) throw new Error(`No active remediation adapter for ${issue.ecosystem}: ${id}`);
      if (['CLOSED', 'MERGED', 'RESOLVED'].includes(issue.state)) throw new Error(`Completed issue cannot be batched: ${id}`);
      if (alreadyBatched.has(id)) throw new Error(`Dependabot issue is already in an active work item: ${id}`);
      issues.push(issue);
    }
    const fixTargets = countFixTargets(issues);
    if (fixTargets < 1 || fixTargets > 10) throw new Error('Work item must contain 1-10 unique fix targets');
    if (new Set(issues.map(issue => issue.ecosystem)).size > 1) throw new Error('A work item must use one ecosystem adapter.');
    return issues;
  }

  async create(repoKey: string, issueIds: string[], branch?: string, grouping?: BatchGrouping) {
    const issues = await this.validate(repoKey, issueIds);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const batch: SecurityBatch = { id, repo: repoKey, issueIds: issues.map(issue => issue.id), state: 'draft', branch: branch || `security-fix/dependabot/batch/${id}`, remediation: {}, grouping: grouping || { source: 'manual', rationale: ['Selected manually by the operator.'] }, createdAt: now, updatedAt: now };
    await this.repo.saveBatch(batch);
    for (const issue of issues) {
      if (issue.state === 'NEW') await this.repo.transitionIssue(issue.id, 'TRIAGED', 'batch-create', id, false, repoKey);
      const current = await this.repo.getIssue(issue.id, repoKey);
      if (current?.state === 'TRIAGED') await this.repo.transitionIssue(issue.id, 'PLANNED_BATCH', 'batch-create', id, false, repoKey);
    }
    return batch;
  }

  async compose(repoKey: string, maxGroupSize = 3) {
    if (!Number.isInteger(maxGroupSize) || maxGroupSize < 2 || maxGroupSize > 10) throw new Error('maxGroupSize must be an integer from 2 to 10');
    const batches = await this.repo.listBatches(repoKey);
    const replaceable = batches.filter(batch => batch.state === 'draft' && batch.grouping?.source === 'dependency_engine');
    for (const batch of replaceable) {
      for (const issueId of batch.issueIds) {
        const issue = await this.repo.getIssue(issueId, repoKey);
        if (issue?.state === 'PLANNED_BATCH') await this.repo.transitionIssue(issue.id, 'TRIAGED', 'auto-group', `Recomputing groups with a maximum size of ${maxGroupSize}`, false, repoKey);
      }
      await this.repo.deleteBatch(batch.id);
    }
    const replaced = new Set(replaceable.map(batch => batch.id));
    const alreadyBatched = new Set(batches.filter(batch => !replaced.has(batch.id) && !['merged', 'failed'].includes(batch.state)).flatMap(batch => batch.issueIds));
    const issues = (await this.repo.listIssues(repoKey)).filter(issue =>
      !['CLOSED', 'MERGED', 'RESOLVED', 'IN_PROGRESS', 'READY_FOR_REVIEW'].includes(issue.state) &&
      !alreadyBatched.has(issue.id) &&
      activeEcosystemAdapter(issue.ecosystem)
    );
    const groups = new Map<string, TrackerIssue[]>();
    const isolated: TrackerIssue[] = [];
    for (const issue of issues) {
      const analysis = issue.lastUpgradeAnalysis;
      if (!analysis || ['risky', 'unsafe'].includes(analysis.riskLevel) || analysis.needsAdditionalBumps) {
        isolated.push(issue);
        continue;
      }
      const key = issue.ecosystem;
      groups.set(key, [...(groups.get(key) || []), issue]);
    }
    const created: SecurityBatch[] = [];
    for (const group of groups.values()) {
      group.sort((a, b) => {
        const risk = { safe: 0, likely_safe: 1, risky: 2, unsafe: 3 };
        return path.posix.dirname(a.manifestPath).localeCompare(path.posix.dirname(b.manifestPath)) || risk[a.lastUpgradeAnalysis!.riskLevel] - risk[b.lastUpgradeAnalysis!.riskLevel] || a.packageName.localeCompare(b.packageName);
      });
      for (let offset = 0; offset < group.length; offset += maxGroupSize) {
        const chunk = group.slice(offset, offset + maxGroupSize);
        const manifestDirectories = [...new Set(chunk.map(issue => path.posix.dirname(issue.manifestPath) === '.' ? 'repository root' : path.posix.dirname(issue.manifestPath)))];
        const analyzedAt = chunk.map(issue => issue.lastUpgradeAnalysis!.analyzedAt).sort().at(-1);
        created.push(await this.create(repoKey, chunk.map(issue => issue.id), undefined, {
          source: 'dependency_engine',
          maxGroupSize,
          analyzedAt,
          rationale: [
            `All ${chunk.length} dependencies passed deterministic analysis as safe or likely safe.`,
            `All members use the ${chunk[0].ecosystem} adapter; affected manifest directories: ${manifestDirectories.join(', ')}.`,
            'No member requires an additional coordinated dependency bump.',
            `Group size is within the requested maximum of ${maxGroupSize}.`
          ],
          ...groupingHumanReviewFields(chunk.map(issue => issue.id), chunk)
        }));
      }
    }
    for (const issue of isolated.sort((a, b) => a.packageName.localeCompare(b.packageName))) {
      const analysis = issue.lastUpgradeAnalysis;
      const reason = !analysis
        ? 'Dependency analysis has not run, so this issue remains isolated.'
        : analysis.needsAdditionalBumps
          ? 'The dependency engine found that additional coordinated bumps may be required.'
          : `The dependency engine rated this issue ${analysis.riskLevel}, so it remains isolated.`;
      created.push(await this.create(repoKey, [issue.id], undefined, {
        source: 'dependency_engine',
        maxGroupSize,
        analyzedAt: analysis?.analyzedAt,
        rationale: [reason, 'A single-issue work item can be analyzed and moved before remediation.'],
        ...groupingHumanReviewFields([issue.id], [issue])
      }));
    }
    return created;
  }

  async getEligibleGroupingIssues(repoKey: string): Promise<GroupingEligibility> {
    const batches = await this.repo.listBatches(repoKey);
    const replaceable = batches.filter(batch => batch.state === 'draft' && ['dependency_engine', 'ai'].includes(batch.grouping?.source || ''));
    const replaced = new Set(replaceable.map(batch => batch.id));
    const preservedAssignments = new Set(batches.filter(batch => !replaced.has(batch.id) && !['merged', 'failed'].includes(batch.state)).flatMap(batch => batch.issueIds));
    const issues = (await this.repo.listIssues(repoKey)).filter(issue =>
      !['CLOSED', 'MERGED', 'RESOLVED', 'IN_PROGRESS', 'READY_FOR_REVIEW'].includes(issue.state) &&
      !preservedAssignments.has(issue.id) &&
      activeEcosystemAdapter(issue.ecosystem)
    );
    return { issues, replaceable };
  }

  async applyGroupingProposal(
    repoKey: string,
    issues: TrackerIssue[],
    proposal: Awaited<ReturnType<typeof proposeWorkItemsWithAi>>,
    maxGroupSize: number,
    replaceable: SecurityBatch[]
  ) {
    if (issues.length && !proposal.groups.length) throw new Error('AI grouping produced no work items for eligible issues');
    const allBatches = await this.repo.listBatches(repoKey);
    const replaceableIds = new Set(replaceable.map(batch => batch.id));
    const preservedAssignments = new Set(allBatches.filter(batch => !replaceableIds.has(batch.id) && !['merged', 'failed'].includes(batch.state)).flatMap(batch => batch.issueIds));
    const byId = new Map(issues.map(issue => [issue.id, issue]));
    const assigned = new Set<string>();
    const created: SecurityBatch[] = [];
    for (const group of proposal.groups) {
      if (!group.issueIds.length) continue;
      const members = group.issueIds.map(id => byId.get(id));
      if (members.some(member => !member)) throw new Error('Normalized AI grouping references an unavailable issue');
      const groupIssues = members as TrackerIssue[];
      if (group.issueIds.some(id => assigned.has(id))) throw new Error('Normalized AI grouping assigns an issue more than once');
      if (group.issueIds.some(id => preservedAssignments.has(id))) throw new Error('Normalized AI grouping conflicts with a preserved work item');
      if (new Set(groupIssues.map(issue => issue.ecosystem)).size > 1) throw new Error('Normalized AI grouping mixed ecosystem adapters');
      if (countFixTargets(groupIssues) > maxGroupSize) throw new Error('Normalized AI grouping exceeds the requested maximum');
      group.issueIds.forEach(id => assigned.add(id));
      const analyzedAt = group.issueIds.map(id => {
        const issue = byId.get(id);
        return issue?.lastAiAnalysis?.analyzedAt || issue?.lastUpgradeAnalysis?.analyzedAt;
      }).filter(Boolean).sort().at(-1);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      created.push({
        id,
        repo: repoKey,
        issueIds: [...group.issueIds],
        state: 'draft',
        branch: `security-fix/dependabot/batch/${id}`,
        remediation: {},
        grouping: {
          source: 'ai',
          maxGroupSize,
          analyzedAt,
          safetyRank: group.safetyRank,
          safetyScore: group.safetyScore,
          safetyLevel: group.safetyLevel,
          safetySummary: group.summary,
          model: proposal.model,
          rationale: group.rationale.length ? group.rationale : [group.summary],
          ...mergedGroupingHumanReviewFields(group, group.issueIds, issues)
        },
        createdAt: now,
        updatedAt: now
      });
    }
    const updatedIssues = [...assigned].map(id => structuredClone(byId.get(id)!));
    for (const issue of updatedIssues) {
      if (issue.state === 'PLANNED_BATCH') transitionForGrouping(issue, 'TRIAGED', `Recomputing AI work items with a maximum size of ${maxGroupSize}`);
      if (issue.state === 'NEW') transitionForGrouping(issue, 'TRIAGED', 'Preparing issue for an AI-generated work item');
      if (issue.state === 'TRIAGED') transitionForGrouping(issue, 'PLANNED_BATCH', created.find(batch => batch.issueIds.includes(issue.id))!.id);
    }
    await this.repo.replaceBatches(repoKey, [...replaceableIds], created, updatedIssues);
    return created;
  }

  async composeWithAi(repoKey: string, config: Config, projectPath: string, maxGroupSize = 3, promptTemplate?: string, provider?: AiAnalysisProvider) {
    if (!Number.isInteger(maxGroupSize) || maxGroupSize < 2 || maxGroupSize > 10) throw new Error('maxGroupSize must be an integer from 2 to 10');
    const { issues, replaceable } = await this.getEligibleGroupingIssues(repoKey);
    const proposal = await proposeWorkItemsWithAi(issues, maxGroupSize, config, projectPath, promptTemplate, provider);
    return this.applyGroupingProposal(repoKey, issues, proposal, maxGroupSize, replaceable);
  }

  async moveIssue(repoKey: string, issueId: string, targetWorkItemId?: string) {
    const issue = await this.repo.getIssue(issueId, repoKey);
    if (!issue) throw new Error(`Unknown Dependabot issue ${issueId}`);
    const workItems = await this.repo.listBatches(repoKey);
    const source = workItems.find(item => !['merged', 'failed'].includes(item.state) && item.issueIds.includes(issueId));
    if (source?.id === targetWorkItemId) return { source, target: source };
    if (source && source.state !== 'draft') throw new Error('Issues can only be moved out of draft work items');
    const target = targetWorkItemId ? workItems.find(item => item.id === targetWorkItemId) : undefined;
    if (targetWorkItemId && !target) throw new Error('Target work item not found');
    if (target && target.state !== 'draft') throw new Error('Issues can only be moved into draft work items');
    if (target) {
      const targetIssues = (await Promise.all(target.issueIds.map(id => this.repo.getIssue(id, repoKey)))).filter(Boolean) as TrackerIssue[];
      if (targetIssues.some(member => member.ecosystem !== issue.ecosystem)) throw new Error('A work item must use one ecosystem adapter.');
      if (countFixTargets([...targetIssues, issue]) > 10) throw new Error('A work item can contain at most 10 fix targets');
    }

    if (source) {
      source.issueIds = source.issueIds.filter(id => id !== issueId);
      source.grouping = { source: 'manual', rationale: ['Membership adjusted manually using the work-item board.'] };
      source.updatedAt = new Date().toISOString();
      if (source.issueIds.length) await this.repo.saveBatch(source);
      else await this.repo.deleteBatch(source.id);
    }
    if (target) {
      target.issueIds = [...target.issueIds, issueId];
      target.grouping = { source: 'manual', rationale: ['Membership adjusted manually using the work-item board.'] };
      target.updatedAt = new Date().toISOString();
      await this.repo.saveBatch(target);
      if (issue.state === 'NEW') await this.repo.transitionIssue(issue.id, 'TRIAGED', 'work-item-move', target.id, false, repoKey);
      const current = await this.repo.getIssue(issue.id, repoKey);
      if (current?.state === 'TRIAGED') await this.repo.transitionIssue(issue.id, 'PLANNED_BATCH', 'work-item-move', target.id, false, repoKey);
    } else if (issue.state === 'PLANNED_BATCH') {
      await this.repo.transitionIssue(issue.id, 'TRIAGED', 'work-item-move', 'Moved to unassigned issues', false, repoKey);
    }
    return { source: source?.issueIds.length ? source : undefined, target };
  }
}
