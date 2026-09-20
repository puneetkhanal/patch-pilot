import { $, api, buildAnalysisMemberProgress, h, installRepoControls, issueRisk, matchesRisk, setBusy, settings, splitRepo, workflowLogTail } from './common.js';

const state = { issues: [], workItems: [], selected: new Set(), view: 'work-items', filter: '', risk: '', search: '', defaults: {}, appSettings: {}, localRepositories: [], githubRepositories: [], fixAgentSkills: [], groupingPromptTemplate: '', groupingPromptVersion: '', pendingFixIssue: null, autoGroupExpandedSteps: new Set(), workflowAction: null, workflowSnapshots: {} };
const states = ['NEW','TRIAGED','PLANNED_BATCH','IN_PROGRESS','READY_FOR_REVIEW','MERGED','RESOLVED','BLOCKED','CLOSED'];
function notice(message, error = false) { const el = $('#notice'); el.textContent = message; el.className = `notice${error ? ' error' : ''}`; setTimeout(() => el.classList.add('hidden'), 7000); }
function repoPath(suffix = '') { const [owner, repo] = splitRepo(); return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`; }
function body(extra = {}) { return JSON.stringify({ repo: settings.repo, projectPath: settings.projectPath, provider: selectedAiProvider(), ...extra }); }
function aiProviders() { return state.defaults.aiProviders || []; }
function aiConfigured() { return aiProviders().length > 0; }
function selectedAiProvider() {
  const providers = aiProviders();
  if (settings.aiProvider && providers.includes(settings.aiProvider)) return settings.aiProvider;
  if (providers.includes('cursor')) return 'cursor';
  return providers[0] || 'cursor';
}
function syncAiProviderUi() {
  const select = $('#ai-provider');
  if (!select) return;
  const providers = aiProviders();
  for (const option of select.options) option.disabled = !providers.includes(option.value);
  select.value = selectedAiProvider();
  settings.aiProvider = select.value;
}
function memberRisk(issue) {
  return issue?.lastUpgradeAnalysis?.riskLevel || 'not_analyzed';
}
function isFixBlocked(issue) {
  const analysis = issue?.lastUpgradeAnalysis;
  return !analysis || ['risky', 'unsafe'].includes(analysis.riskLevel) || analysis.needsAdditionalBumps;
}
function workItemBlockedMembers(workItem) {
  const issueById = new Map(state.issues.map(issue => [issue.id, issue]));
  return workItem.issueIds.map(id => issueById.get(id)).filter(issue => issue && isFixBlocked(issue));
}
function workItemHumanReviewIds(workItem) {
  const flagged = new Set(workItem.grouping?.humanReviewIssueIds || []);
  if (workItem.grouping?.requiresHumanReview) {
    for (const issue of workItemBlockedMembers(workItem)) flagged.add(issue.id);
  }
  return flagged;
}
function workItemHumanReviewTag(workItem) {
  const flagged = workItemHumanReviewIds(workItem);
  const count = flagged.size || (workItem.grouping?.requiresHumanReview ? workItem.issueIds.length : 0);
  if (!workItem.grouping?.requiresHumanReview && !count) return null;
  return h('span', { class: 'tag human-review' }, count ? `Human review · ${count}` : 'Human review');
}
async function confirmRiskyFix(blocked) {
  if (!blocked.length) return true;
  const names = blocked.map(issue => `${issue.packageName} (${memberRisk(issue).replaceAll('_', ' ')})`).join(', ');
  return confirm(`These work-item members are flagged for review: ${names}.\n\nFix anyway?`);
}
function aiStatusLabel() {
  const providers = aiProviders();
  if (!providers.length) return 'AI not configured';
  const provider = selectedAiProvider();
  const model = provider === 'gemini' ? state.defaults.geminiModel : state.defaults.cursorModel;
  return `${provider === 'gemini' ? 'Gemini' : 'Cursor'} AI ready (${model})`;
}

async function init() {
  state.defaults = await api('/api/config/defaults'); installRepoControls(state.defaults);
  $('#connection').textContent = `${state.defaults.githubAuth?.configured ? state.defaults.githubAuth.message : 'GitHub login needed'} · ${aiStatusLabel()}`;
  syncAiProviderUi();
  const [appSettings, localRepositories, githubRepositories, fixAgentSkills, groupingPrompt] = await Promise.all([
    api('/api/settings').catch(() => ({})),
    api('/api/local-repositories').catch(() => []),
    api('/api/github/repos').catch(() => []),
    api('/api/remediation/fix-agent-skills').catch(() => []),
    api('/api/work-items/grouping-prompt').catch(() => ({ promptTemplate: '', configured: false }))
  ]);
  state.appSettings = appSettings;
  state.localRepositories = localRepositories;
  state.githubRepositories = githubRepositories;
  state.fixAgentSkills = fixAgentSkills;
  state.groupingPromptTemplate = groupingPrompt.promptTemplate || '';
  state.groupingPromptVersion = groupingPrompt.version || 'v1';
  if (settings.groupingPrompt && settings.groupingPromptVersion !== state.groupingPromptVersion) settings.groupingPrompt = '';
  settings.groupingPromptVersion = state.groupingPromptVersion;
  $('#grouping-prompt').value = settings.groupingPrompt || state.groupingPromptTemplate;
  $('#group-size').value = String(settings.groupSize);
  $('#repositories-root').value = appSettings.repositoriesRoot || '';
  populateRepositories();
  populateFixAgents();
  renderDiscoveredRepositories();
  applyLocalSelection(settings.repo);
  bind();
  if (settings.repo) await load(); else renderEmpty('Open Settings, choose your repositories root, then select a GitHub repository.');
  if (!appSettings.repositoriesRoot) $('#settings-dialog').showModal();
}

function bind() {
  $('#repo').addEventListener('change', async () => {
    settings.repo = $('#repo').value;
    state.selected.clear();
    applyLocalSelection(settings.repo);
    if (!settings.repo) return;
    notice(`Scanning ${settings.repo} for supported vulnerability alerts…`);
    try { await api(repoPath('/scan'), { method: 'POST' }); await load(); } catch (error) { notice(error.message, true); await load(); }
  });
  $('#project-path').addEventListener('change', () => settings.projectPath = $('#project-path').value);
  $('#settings-button').addEventListener('click', () => $('#settings-dialog').showModal());
  $('#save-settings').addEventListener('click', async event => action(event.currentTarget, 'Scanning folders…', async () => {
    const repositoriesRoot = $('#repositories-root').value.trim();
    if (!repositoriesRoot) throw new Error('Enter the parent folder containing your GitHub repositories.');
    const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ repositoriesRoot }) });
    state.appSettings = result.settings;
    state.localRepositories = result.repositories;
    populateRepositories();
    renderDiscoveredRepositories();
    $('#settings-result').textContent = `Found ${result.repositories.length} GitHub ${result.repositories.length === 1 ? 'repository' : 'repositories'}.`;
  }));
  $('#refresh').addEventListener('click', load);
  $('#scan').addEventListener('click', async event => action(event.currentTarget, 'Scanning…', async () => { const result = await api(repoPath('/scan'), { method: 'POST' }); notice(`Found ${result.alertCount} supported alerts grouped into ${result.issueCount} remediation issues.`); await load(); }));
  $('#search').addEventListener('input', event => { state.search = event.target.value.toLowerCase(); renderIssues(); });
  $('#risk-filter').addEventListener('change', event => { state.risk = event.target.value; renderIssues(); });
  $('#view-filters').addEventListener('click', event => { if (event.target.tagName !== 'BUTTON') return; state.view = event.target.dataset.view || 'issues'; state.filter = event.target.dataset.state || ''; for (const button of $('#view-filters').querySelectorAll('button')) button.classList.toggle('selected', button === event.target); renderIssues(); });
  $('#group-size').addEventListener('change', event => { settings.groupSize = Number(event.target.value); });
  $('#ai-provider')?.addEventListener('change', event => { settings.aiProvider = event.target.value; $('#connection').textContent = `${state.defaults.githubAuth?.configured ? state.defaults.githubAuth.message : 'GitHub login needed'} · ${aiStatusLabel()}`; });
  $('#grouping-prompt-button').addEventListener('click', () => $('#grouping-prompt-dialog').showModal());
  $('[data-close-grouping-prompt]').addEventListener('click', () => $('#grouping-prompt-dialog').close());
  $('#save-grouping-prompt').addEventListener('click', () => { settings.groupingPrompt = $('#grouping-prompt').value; settings.groupingPromptVersion = state.groupingPromptVersion; $('#grouping-prompt-dialog').close(); notice('AI grouping prompt saved in this browser.'); });
  $('#reset-grouping-prompt').addEventListener('click', () => { settings.groupingPrompt = ''; $('#grouping-prompt').value = state.groupingPromptTemplate; });
  $('#select-visible').addEventListener('click', () => { for (const issue of visibleIssues()) state.selected.add(issue.id); renderIssues(); });
  $('#clear-selected').addEventListener('click', () => { state.selected.clear(); renderIssues(); });
  $('#create-batch').addEventListener('click', async event => action(event.currentTarget, 'Creating…', async () => { if (!state.selected.size) throw new Error('Select one or more Dependabot issues.'); await api(repoPath('/work-items'), { method: 'POST', body: JSON.stringify({ issueIds: [...state.selected] }) }); state.selected.clear(); selectWorkItemView(); notice('Work item created.'); await load(); }));
  $('#auto-batch').addEventListener('click', async event => action(event.currentTarget, 'Organizing…', async () => { const result = await runAutoGroup(); selectWorkItemView(); notice(`Created ${result.workItems.length} work item${result.workItems.length === 1 ? '' : 's'} with up to ${settings.groupSize} compatible issues together.`); await load(); }));
  $('#reset-work-items').addEventListener('click', async event => {
    if (!state.workItems.length) return notice('There are no work items to reset.');
    if (!confirm(`Reset all ${state.workItems.length} work item${state.workItems.length === 1 ? '' : 's'} for ${settings.repo}? This clears every work-item record and returns its active issues to Triaged.`)) return;
    await action(event.currentTarget, 'Resetting…', async () => {
      const result = await api(repoPath('/work-items/actions/reset'), { method: 'POST', body: JSON.stringify({ confirm: true }) });
      state.selected.clear();
      selectWorkItemView();
      notice(`Reset ${result.removed} work item${result.removed === 1 ? '' : 's'} and released ${result.releasedIssues} issue${result.releasedIssues === 1 ? '' : 's'}.`);
      await load();
    });
  });
  $('#analyze-selected').addEventListener('click', async event => action(event.currentTarget, 'Analyzing…', async () => { const ids = [...state.selected]; if (!ids.length) throw new Error('Select one or more issues.'); const started = await api(repoPath('/analyze-upgrade/bulk'), { method: 'POST', body: body({ useAi: false, issueIds: ids }) }); const result = await waitForAnalysis(started.id); const grouped = await runAutoGroup(); selectWorkItemView(); notice(`Analyzed ${result.completed}; ${result.failed} failed. Created ${grouped.workItems.length} work item${grouped.workItems.length === 1 ? '' : 's'}.`); await load(); }));
  for (const button of document.querySelectorAll('[data-close-auto-group]')) button.addEventListener('click', () => $('#auto-group-dialog').close());
  $('[data-close-log]').addEventListener('click', () => $('#log-dialog').close());
  $('[data-close-fix-agent]').addEventListener('click', () => $('#fix-agent-dialog').close());
  $('#start-fix').addEventListener('click', event => action(event.currentTarget, 'Starting…', startSelectedFix));
}

function populateFixAgents() {
  const select = $('#fix-agent-select');
  select.replaceChildren(h('option', { value: '' }, 'Built-in dependency update (no AI agent)'));
  for (const item of state.fixAgentSkills) {
    const provider = `${item.provider[0].toUpperCase()}${item.provider.slice(1)}`;
    const label = `${provider} · ${item.name}${item.configured ? '' : ` — ${item.reason}`}`;
    select.append(h('option', { value: JSON.stringify({ provider: item.provider, skill: item.skill }), ...(item.configured ? {} : { disabled: '' }) }, label));
  }
  const preferred = state.fixAgentSkills.find(item => item.provider === 'cursor' && item.configured)
    || state.fixAgentSkills.find(item => item.configured);
  if (preferred) select.value = JSON.stringify({ provider: preferred.provider, skill: preferred.skill });
}

function defaultFixAgent() {
  const cursor = state.fixAgentSkills.find(item => item.provider === 'cursor' && item.configured);
  if (cursor) return { provider: cursor.provider, skill: cursor.skill };
  const fallback = state.fixAgentSkills.find(item => item.configured);
  return fallback ? { provider: fallback.provider, skill: fallback.skill } : null;
}
function requireFixAgent() {
  const agent = defaultFixAgent();
  if (!agent) throw new Error('Configure CURSOR_API_KEY and add a Cursor fix skill under .cursor/skills before running a fix.');
  return agent;
}

function populateRepositories() {
  const options = $('#repo-options');
  options.replaceChildren();
  const localNames = new Set();
  for (const repository of state.localRepositories) {
    localNames.add(repository.repo);
    options.append(h('option', { value: repository.repo, label: repository.path }));
  }
  for (const repository of state.githubRepositories) if (!localNames.has(repository.fullName)) options.append(h('option', { value: repository.fullName, label: 'GitHub · not found under local root' }));
}

function applyLocalSelection(repo) {
  const local = state.localRepositories.find(repository => repository.repo === repo);
  if (!local) return;
  settings.projectPath = local.path;
  $('#project-path').value = local.path;
}

function renderDiscoveredRepositories() {
  const target = $('#discovered-repositories');
  if (!state.localRepositories.length) {
    target.replaceChildren(h('div', { class: 'empty' }, 'No GitHub repositories found under this root.'));
    return;
  }
  target.replaceChildren(...state.localRepositories.map(repository => h('button', { class: 'discovered-item', type: 'button', onclick: () => {
    $('#repo').value = repository.repo;
    settings.repo = repository.repo;
    applyLocalSelection(repository.repo);
    $('#settings-dialog').close();
    $('#repo').dispatchEvent(new Event('change'));
  } }, h('strong', {}, repository.repo), h('span', {}, repository.path))));
}

async function action(button, label, fn) { setBusy(button, true, label); try { await fn(); } catch (error) { notice(error.message, true); } finally { setBusy(button, false); } }
function groupingStepIcon(status) {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '!';
  if (status === 'running') return '…';
  return '○';
}
function groupingStepLabel(status) {
  return { completed: 'Done', running: 'In progress', failed: 'Failed', pending: 'Pending' }[status] || status;
}
function groupingProgressPercent(job) {
  const completed = job.steps.filter(step => step.status === 'completed').length;
  const running = job.steps.some(step => step.status === 'running') ? 0.5 : 0;
  const issueProgress = job.totalIssues ? (job.analyzedIssues / job.totalIssues) * 0.35 : 0;
  const activeStep = job.steps.find(step => step.status === 'running');
  const issuePhase = activeStep && ['dependency_analysis', 'import_context'].includes(activeStep.id) ? issueProgress : 0;
  return Math.min(100, Math.round(((completed + running) / job.steps.length) * 65 + issuePhase * 100));
}
function autoGroupStepDetails(job, step) {
  const artifacts = job.artifacts;
  if (!artifacts) return null;
  if (step.id === 'dependency_analysis' && artifacts.dependencyAnalysis?.length) return artifacts.dependencyAnalysis;
  if (step.id === 'import_context' && artifacts.collectedEvidence) return artifacts.collectedEvidence;
  if (step.id === 'ai_grouping' && artifacts.llmRequest) return artifacts.llmRequest;
  return null;
}
function autoGroupStepDetailsLabel(step) {
  if (step.id === 'dependency_analysis') return 'View dependency analysis';
  if (step.id === 'import_context') return 'View collected manifests, imports, and graphs';
  if (step.id === 'ai_grouping') return 'View LLM prompt and input';
  return 'View details';
}
function renderAutoGroupJob(job) {
  const labels = groupingStepLabel;
  const icons = groupingStepIcon;
  const percent = groupingProgressPercent(job);
  $('#auto-group-percent').textContent = `${percent}%`;
  $('#auto-group-progress-bar').style.width = `${percent}%`;
  const activeStep = job.steps.find(step => step.status === 'running');
  const current = job.currentPackageName
    ? `Working on ${job.currentPackageName}${job.totalIssues ? ` · ${job.analyzedIssues}/${job.totalIssues}` : ''}`
    : activeStep?.detail || (job.status === 'succeeded' ? 'Grouping complete.' : job.status === 'failed' ? 'Grouping failed.' : 'Preparing…');
  $('#auto-group-current').innerHTML = `<strong>Current:</strong> ${current}`;
  $('#auto-group-steps').replaceChildren(...job.steps.map(step => {
    const details = autoGroupStepDetails(job, step);
    const copyChildren = [
      h('div', { class: 'workflow-step-title' }, h('strong', {}, step.label), h('span', { class: `workflow-status ${step.status}` }, labels(step.status))),
      step.detail ? h('p', {}, step.detail) : null
    ];
    if (details && ['completed', 'failed'].includes(step.status)) {
      copyChildren.push(h('details', {
        class: 'auto-group-step-details',
        open: state.autoGroupExpandedSteps.has(step.id) ? '' : undefined,
        ontoggle: event => {
          if (event.target.open) state.autoGroupExpandedSteps.add(step.id);
          else state.autoGroupExpandedSteps.delete(step.id);
        }
      },
        h('summary', {}, autoGroupStepDetailsLabel(step)),
        h('pre', { class: 'auto-group-detail-body' }, JSON.stringify(details, null, 2))
      ));
    }
    return h('li', { class: `workflow-step ${step.status}` },
      h('div', { class: 'workflow-marker', 'aria-hidden': 'true' }, icons(step.status)),
      h('div', { class: 'workflow-step-copy' }, ...copyChildren)
    );
  }));
  const error = $('#auto-group-error');
  if (job.error) {
    error.textContent = job.error;
    error.classList.remove('hidden');
  } else {
    error.textContent = '';
    error.classList.add('hidden');
  }
}
async function waitForGrouping(id) {
  const dialog = $('#auto-group-dialog');
  let job;
  do {
    await new Promise(resolve => setTimeout(resolve, 500));
    job = await api(`/api/grouping-jobs/${encodeURIComponent(id)}`);
    renderAutoGroupJob(job);
  } while (['queued', 'running'].includes(job.status) && dialog.open);
  renderAutoGroupJob(job);
  return job;
}
async function runAutoGroup() {
  const dialog = $('#auto-group-dialog');
  state.autoGroupExpandedSteps = new Set();
  const started = await api(repoPath('/work-items/auto-group'), { method: 'POST', body: JSON.stringify({ projectPath: settings.projectPath, maxGroupSize: settings.groupSize, promptTemplate: settings.groupingPrompt || undefined, provider: selectedAiProvider() }) });
  renderAutoGroupJob(started);
  dialog.showModal();
  const job = await waitForGrouping(started.id);
  if (job.status === 'failed') throw new Error(job.error || 'AI auto-group failed.');
  return { workItems: job.workItems || [] };
}
function selectWorkItemView() { state.view = 'work-items'; state.filter = ''; for (const button of $('#view-filters').querySelectorAll('button')) button.classList.toggle('selected', button.dataset.view === 'work-items'); }
async function load() { try { const [issues, workItems] = await Promise.all([api(repoPath('/issues')), api(repoPath('/work-items'))]); state.issues = issues; state.workItems = workItems; const currentIds = new Set(issues.map(issue => issue.id)); for (const id of state.selected) if (!currentIds.has(id)) state.selected.delete(id); render(); } catch (error) { notice(error.message, true); renderEmpty('Unable to load this repository. Check the token and repository name.'); } }
function render() { renderSummary(); renderIssues(); }
function renderSummary() { const counts = Object.fromEntries(states.map(name => [name, state.issues.filter(issue => issue.state === name).length])); const target = $('#summary'); target.replaceChildren(...[['Dependabot issues',state.issues.filter(issue => !['CLOSED','MERGED','RESOLVED'].includes(issue.state)).length],['New',counts.NEW],['In progress',counts.IN_PROGRESS],['Ready for review',counts.READY_FOR_REVIEW],['Active work items',state.workItems.filter(item=>!['merged','failed'].includes(item.state)).length]].map(([label,value]) => h('div',{class:'metric'},h('strong',{},value),h('span',{},label)))); }
function renderEmpty(message) { $('#board').replaceChildren(h('div',{class:'empty'},h('strong',{},message))); }
function visibleIssues() { return state.issues.filter(issue => (!state.filter || issue.state === state.filter) && matchesRisk(issue, state.risk) && (!state.search || `${issue.title} ${issue.packageName} ${issue.manifestPath}`.toLowerCase().includes(state.search))); }
function renderSelectionCount() { $('#selection-count').textContent = `${state.selected.size} selected`; }
function renderIssues() {
  renderSelectionCount();
  for (const element of document.querySelectorAll('.issue-view-control')) element.classList.toggle('hidden', state.view === 'work-items');
  if (state.view === 'work-items') return renderWorkItems();
  const issues = visibleIssues(); if (!issues.length) return renderEmpty(state.issues.length ? 'No issues match this view.' : 'No supported vulnerability issues loaded. Run a scan to populate the board.');
  $('#board').replaceChildren(...issues.map(issue => {
    const checkbox = h('input',{type:'checkbox',checked:state.selected.has(issue.id),'aria-label':`Select ${issue.title}`,onchange:event=>{event.stopPropagation();event.target.checked?state.selected.add(issue.id):state.selected.delete(issue.id);renderSelectionCount();}});
    const risk = issue.lastAiAnalysis?.riskLevel;
    return h('article',{class:'issue-card'},
      h('div',{class:'card-top'},h('div',{class:'card-title'},h('button',{onclick:()=>openIssue(issue)},issue.title)),h('label',{class:'check'},checkbox)),
      h('div',{class:'meta'},h('span',{class:'tag state'},issue.state.replaceAll('_',' ')),h('span',{class:'tag'},issue.ecosystem),h('span',{class:'tag'},issue.severity),risk?h('span',{class:`tag risk-${risk}`},issueRisk(issue).replaceAll('_',' ')):h('span',{class:'tag'},'not analyzed'),h('span',{class:'tag'},`${issue.alerts.length} alert${issue.alerts.length===1?'':'s'}`)),
      h('div',{class:'manifest',title:issue.manifestPath},issue.manifestPath),
      h('div',{class:'card-actions'},h('button',{class:'accent',onclick:()=>analyze(issue)},'AI analysis'),h('button',{onclick:()=>runJob(issue,'fix')},'Run fix'),h('button',{onclick:()=>openIssue(issue)},'Details')));
  }));
}

function dropHandlers(targetWorkItemId) {
  return {
    ondragover:event=>{event.preventDefault();event.dataTransfer.dropEffect='move';event.currentTarget.classList.add('drag-over')},
    ondragleave:event=>event.currentTarget.classList.remove('drag-over'),
    ondrop:event=>{event.preventDefault();event.currentTarget.classList.remove('drag-over');const issueId=event.dataTransfer.getData('text/plain');if(issueId)void moveDependabotIssue(issueId,targetWorkItemId)}
  };
}
function compareVersion(left, right) {
  const parts = value => value.trim().replace(/^[^\d]*/, '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const a = parts(left); const b = parts(right);
  for (let index = 0; index < 3; index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}
function workItemFixTargets(members) {
  const targets = new Map();
  for (const issue of members) {
    const key = `${issue.manifestPath}\0${issue.packageName}`;
    const current = targets.get(key);
    if (!current || compareVersion(issue.patchedVersion, current.issue.patchedVersion) > 0) {
      const covered = current ? [current.issue, ...(current.covered || [])] : [];
      targets.set(key, { issue, covered });
    } else {
      current.covered = [...(current.covered || []), issue];
    }
  }
  return [...targets.values()];
}
function workItemMember(issue, draggable = false, covered = []) {
  return h('li',{class:'work-item-member',draggable:draggable?'true':'false',...(draggable?{ondragstart:event=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',issue.id);event.currentTarget.classList.add('dragging')},ondragend:event=>{event.currentTarget.classList.remove('dragging');for(const element of document.querySelectorAll('.drag-over'))element.classList.remove('drag-over')}}:{})},
    h('div',{class:'work-item-member-primary'},
      h('button',{onclick:()=>openIssue(issue)},issue.packageName),
      h('span',{},`→ ${issue.patchedVersion}`),
      covered.length?h('small',{class:'member-covered'},`covers ${covered.length} overlapping alert${covered.length===1?'':'s'}`):null,
      draggable?h('small',{class:'member-drag'},'Drag to move'):null
    ),
    h('code',{class:'work-item-member-manifest',title:issue.manifestPath},issue.manifestPath)
  );
}
async function moveDependabotIssue(issueId,targetWorkItemId){try{await api(repoPath('/work-items/move-issue'),{method:'POST',body:JSON.stringify({issueId,...(targetWorkItemId?{targetWorkItemId}:{})})});notice(targetWorkItemId?'Issue moved to work item.':'Issue moved to Unassigned.');await load()}catch(error){notice(error.message,true)}}
function renderWorkItems() {
  const issueById = new Map(state.issues.map(issue => [issue.id, issue]));
  const activeWorkItems = state.workItems.filter(item=>!['merged','failed'].includes(item.state));
  const activeAssignments = new Set(activeWorkItems.flatMap(item=>item.issueIds));
  const matches = issue => (!state.risk || issueRisk(issue) === state.risk) && (!state.search || `${issue.title} ${issue.packageName} ${issue.manifestPath}`.toLowerCase().includes(state.search));
  const unassigned = state.issues.filter(issue=>!activeAssignments.has(issue.id)&&!['CLOSED','MERGED','RESOLVED'].includes(issue.state)&&matches(issue));
  const workItems = activeWorkItems.filter(workItem => {
    const members = workItem.issueIds.map(id => issueById.get(id)).filter(Boolean);
    return (!state.risk || members.some(issue => memberRisk(issue) === state.risk)) && (!state.search || members.some(issue => `${issue.title} ${issue.packageName} ${issue.manifestPath}`.toLowerCase().includes(state.search)));
  });
  const unassignedCard = h('article',{class:'issue-card work-item unassigned-work-item',...dropHandlers(undefined)},h('div',{class:'card-top'},h('div',{class:'card-title'},'Unassigned'),h('span',{class:'badge'},`${unassigned.length} issues`)),h('p',{class:'work-item-help'},'Drop here to remove an issue from a draft work item.'),unassigned.length?h('ul',{class:'group-members'},...unassigned.map(issue=>workItemMember(issue,true))):h('div',{class:'work-item-empty'},'All open issues are assigned.'));
  if (!workItems.length && !unassigned.length) return renderEmpty(activeWorkItems.length ? 'No work items match these filters.' : 'No open Dependabot issues are available. Scan the repository first.');
  $('#board').replaceChildren(unassignedCard,...workItems.map(workItem => {
    const members = workItem.issueIds.map(id => issueById.get(id)).filter(Boolean);
    const fixTargets = workItemFixTargets(members);
    const safe = members.filter(issue => memberRisk(issue) === 'safe').length;
    const likely = members.filter(issue => memberRisk(issue) === 'likely_safe').length;
    const unanalyzed = members.filter(issue => !issue.lastUpgradeAnalysis).length;
    const humanReviewTag = workItemHumanReviewTag(workItem);
    const editable = workItem.state === 'draft';
    return h('article',{class:`issue-card work-item${editable?'':' locked-work-item'}`,...(editable?dropHandlers(workItem.id):{})},
      h('div',{class:'card-top'},h('div',{class:'card-title'},`Work item ${workItem.id.slice(0,8)}`),h('span',{class:'badge'},workItem.state.replaceAll('_',' '))),
      h('div',{class:'meta'},h('span',{class:'tag state'},workItem.grouping?.source === 'ai' ? 'AI GROUPED' : workItem.grouping?.source === 'dependency_engine' ? 'ENGINE GROUPED' : 'MANUAL'),workItem.grouping?.safetyRank?h('span',{class:'tag'},`Safety rank #${workItem.grouping.safetyRank}`):null,typeof workItem.grouping?.safetyScore==='number'?h('span',{class:`tag risk-${workItem.grouping.safetyLevel||'risky'}`},`${workItem.grouping.safetyScore}/100 ${String(workItem.grouping.safetyLevel||'').replaceAll('_',' ')}`):null,humanReviewTag,h('span',{class:'tag'},`${fixTargets.length} fix target${fixTargets.length===1?'':'s'}`),members.length>fixTargets.length?h('span',{class:'tag'},`${members.length} tracked alert${members.length===1?'':'s'}`):null,safe?h('span',{class:'tag risk-safe'},`${safe} safe`):null,likely?h('span',{class:'tag risk-likely_safe'},`${likely} likely safe`):null,unanalyzed?h('span',{class:'tag'},`${unanalyzed} not analyzed`):null),
      h('ul',{class:'group-members'},...fixTargets.map(target=>workItemMember(target.issue,editable,target.covered))),
      workItem.grouping?.rationale?.length?h('details',{class:'group-rationale'},h('summary',{},'Why this work item was created'),h('ul',{},...workItem.grouping.rationale.map(reason=>h('li',{},reason)))):null,
      h('div',{class:'card-actions'},h('button',{onclick:()=>openWorkItem(workItem)},'Details'))
    );
  }));
}

function workflowActionBusy(workItem) {
  const action = state.workflowAction;
  return Boolean(action && action.workItemId === workItem.id);
}

function workflowLiveStepId(kind) {
  if (kind === 'create-pr') return 'pull-request';
  return 'fix';
}

function workflowFixJobLine(job) {
  const lines = String(job?.log || '').split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  return lines.at(-1);
}

function workflowLiveDetail(kind, job) {
  if (!job) return 'Starting…';
  if (kind === 'analyze') {
    const done = (job.completed || 0) + (job.failed || 0);
    const total = job.total || 0;
    if (job.currentPackageName) return `Analyzing ${job.currentPackageName} · ${done}/${total}`;
    if (job.status === 'queued') return `Queued · ${total} issue${total === 1 ? '' : 's'}`;
    return `AI analysis · ${done}/${total}`;
  }
  const label = kind === 'create-pr' ? 'Creating pull request' : 'Applying coordinated fix';
  const latest = workflowFixJobLine(job);
  if (job.status === 'queued') return `${label} · queued, preparing worktree`;
  if (job.status === 'running') return latest ? `${label} · ${latest}` : `${label} · running, waiting for job output`;
  if (job.status === 'succeeded') return latest ? `${label} · completed · ${latest}` : `${label} · completed`;
  return `${label} · ${job.error || job.status}`;
}

function workflowLivePercent(workflow, kind, job) {
  if (!job) return workflow.progress;
  if (kind === 'analyze') {
    const done = (job.completed || 0) + (job.failed || 0);
    const total = Math.max(job.total || 1, 1);
    const completedSteps = workflow.steps.filter(step => step.status === 'completed' && step.id !== 'ai-analysis').length;
    const analysisFraction = ['succeeded', 'completed_with_errors', 'failed'].includes(job.status) ? 1 : done / total;
    return Math.min(100, Math.round(((completedSteps + analysisFraction) / workflow.steps.length) * 100));
  }
  if (['queued', 'running'].includes(job.status)) {
    const completedSteps = workflow.steps.filter(step => step.status === 'completed').length;
    return Math.min(100, Math.round(((completedSteps + 0.5) / workflow.steps.length) * 100));
  }
  return workflow.progress;
}

function mergeWorkflowWithLiveAction(workflow, kind, job) {
  if (!job || !['queued', 'running'].includes(job.status)) return workflow;
  const stepId = workflowLiveStepId(kind);
  const steps = workflow.steps.map(step => step.id === stepId
    ? { ...step, status: 'running', detail: workflowLiveDetail(kind, job) }
    : step);
  const progress = workflowLivePercent({ ...workflow, steps }, kind, job);
  return { ...workflow, steps, progress, nextAction: workflowLiveDetail(kind, job), nextActionKind: 'wait' };
}

function workflowMemberStatusIcon(status) {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '!';
  if (status === 'running') return '…';
  return '○';
}

function renderWorkflowLiveAction(workItem, workflow, live) {
  if (!live?.job) return null;
  const { kind, job } = live;
  const current = workflowLiveDetail(kind, job);
  const percent = workflowLivePercent(workflow, kind, job);
  const children = [
    h('div', { class: 'workflow-live-heading' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Live action'), h('strong', {}, kind === 'analyze' ? 'AI analysis in progress' : kind === 'create-pr' ? 'Pull request in progress' : 'Fix in progress')),
      h('strong', { class: 'workflow-percent' }, `${percent}%`)
    ),
    h('div', { class: 'workflow-progress', 'aria-label': `${percent}% complete` }, h('span', { style: `width:${percent}%` })),
    h('p', { class: 'workflow-live-current' }, h('strong', {}, 'Current:'), ` ${current}`)
  ];
  if (kind === 'analyze') {
    const members = workItem.issueIds.map(id => state.issues.find(issue => issue.id === id)).filter(Boolean);
    const rows = buildAnalysisMemberProgress(job, members);
    children.push(h('ol', { class: 'workflow-member-progress' }, ...rows.map(row => h('li', { class: `workflow-member-row ${row.status}` },
      h('span', { class: 'workflow-member-icon', 'aria-hidden': 'true' }, workflowMemberStatusIcon(row.status)),
      h('div', { class: 'workflow-member-copy' },
        h('strong', {}, row.issue.packageName),
        h('span', {}, ` → ${row.issue.patchedVersion}`),
        row.error ? h('small', { class: 'workflow-error' }, row.error) : null
      )
    ))));
  } else {
    const tail = workflowLogTail(job.log);
    children.push(
      h('div', { class: 'workflow-live-status' },
        h('span', { class: `workflow-status ${job.status === 'failed' ? 'failed' : ['queued', 'running'].includes(job.status) ? 'running' : 'completed'}` }, job.status.replaceAll('_', ' ')),
        job.result?.commitSha ? h('code', { class: 'mono' }, `commit ${job.result.commitSha.slice(0, 12)}`) : null,
        job.result?.prUrl ? h('a', { class: 'workflow-link', href: job.result.prUrl, target: '_blank', rel: 'noreferrer' }, 'Open pull request') : null
      ),
      h('details', { class: 'workflow-live-log', open: '' },
        h('summary', {}, tail ? 'View live job output' : 'Waiting for job output'),
        h('pre', {}, tail || `Job ${job.status}. Output will appear here as the remediation script runs.`),
        h('button', { type: 'button', onclick: () => openJobLog(job.id) }, 'Open full log')
      )
    );
  }
  return h('section', { class: 'workflow-live-action' }, ...children);
}

function workItemWorkflowActions(workItem, workflow, busy = false) {
  const actions = [];
  if (busy) return actions;
  if (workflow.nextActionKind === 'fix') actions.push(h('button', { class: 'primary', onclick: () => runWorkItem(workItem, 'fix') }, workflow.blockedIssueIds?.length ? 'Fix all anyway' : 'Fix all'));
  if (workflow.nextActionKind === 'create-pr') actions.push(h('button', { class: 'primary', onclick: () => runWorkItem(workItem, 'create-pr') }, 'Create one pull request'));
  if (workflow.canRefix) actions.push(h('button', { class: 'primary', onclick: () => runWorkItem(workItem, 'fix') }, 'Fix all again'));
  if (workflow.nextActionKind === 'review' && workflow.prUrl) actions.push(h('a', { class: 'workflow-link', href: workflow.prUrl, target: '_blank', rel: 'noreferrer' }, 'Open pull request'));
  return actions;
}

function renderWorkItemWorkflow(workItem, workflow, live = null) {
  const target = $('#work-item-workflow');
  if (!target || target.dataset.workItemId !== workItem.id) return;
  const displayWorkflow = live?.job ? mergeWorkflowWithLiveAction(workflow, live.kind, live.job) : workflow;
  const busy = workflowActionBusy(workItem) || Boolean(live?.job && ['queued', 'running'].includes(live.job.status));
  const labels = { completed: 'Done', current: 'Next', running: 'In progress', remaining: 'Remaining', optional: 'Optional', failed: 'Failed' };
  const icons = { completed: '✓', current: '●', running: '●', remaining: '○', optional: '◇', failed: '!' };
  const runs = displayWorkflow.remediationRuns || [];
  target.classList.toggle('is-busy', busy);
  target.replaceChildren(
    ...(live?.job ? [renderWorkflowLiveAction(workItem, displayWorkflow, live)] : []),
    h('div', { class: 'workflow-heading' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Complete work-item workflow'), h('h3', {}, 'Delivery progress')), h('strong', { class: 'workflow-percent' }, `${displayWorkflow.progress}%`)),
    h('div', { class: 'workflow-progress', 'aria-label': `${displayWorkflow.progress}% of required work-item workflow complete` }, h('span', { style: `width:${displayWorkflow.progress}%` })),
    h('ol', { class: 'workflow-flow' }, ...displayWorkflow.steps.map(step => h('li', { class: `workflow-step ${step.status}` },
      h('div', { class: 'workflow-marker', 'aria-hidden': 'true' }, icons[step.status]),
      h('div', { class: 'workflow-step-copy' }, h('div', { class: 'workflow-step-title' }, h('strong', {}, step.label), h('span', { class: `workflow-status ${step.status}` }, labels[step.status])), h('p', {}, step.detail), step.completedAt ? h('time', { datetime: step.completedAt }, workflowTime(step.completedAt)) : null)
    ))),
    h('div', { class: 'next-action' }, h('span', {}, 'Next step'), h('strong', {}, displayWorkflow.nextAction), h('div', { class: 'next-action-buttons' }, ...workItemWorkflowActions(workItem, displayWorkflow, busy))),
    h('div', { class: 'fix-evidence' }, h('h4', {}, 'Latest work-item run'), displayWorkflow.latestRun
      ? h('dl', {}, h('div', {}, h('dt', {}, 'Job ID'), h('dd', { class: 'mono' }, displayWorkflow.latestRun.id)), h('div', {}, h('dt', {}, 'Operation'), h('dd', {}, displayWorkflow.latestRun.kind.replaceAll('-', ' '))), h('div', {}, h('dt', {}, 'Status'), h('dd', { class: displayWorkflow.latestRun.status === 'failed' ? 'workflow-error' : '' }, displayWorkflow.latestRun.status)), h('div', {}, h('dt', {}, 'Commit'), h('dd', { class: 'mono' }, displayWorkflow.latestRun.result?.commitSha || 'Not committed')), h('div', {}, h('dt', {}, 'Branch'), h('dd', { class: 'mono' }, displayWorkflow.latestRun.result?.branch || workItem.branch)), displayWorkflow.latestRun.error ? h('div', {}, h('dt', {}, 'Error'), h('dd', { class: 'workflow-error' }, displayWorkflow.latestRun.error)) : null)
      : h('p', { class: 'workflow-empty' }, 'No fix or pull-request job has run for this work item.')),
    ...(runs.length ? [h('details', { class: 'workflow-runs' }, h('summary', {}, `All work-item runs (${runs.length})`), h('div', { class: 'workflow-run-list' }, ...runs.map(run => h('div', { class: 'workflow-run' },
      h('span', { class: `status-dot ${run.status === 'succeeded' ? 'successful' : run.status === 'failed' ? 'failed' : 'pending'}` }),
      h('code', {}, run.id),
      h('strong', {}, run.kind.replaceAll('-', ' ')),
      h('span', {}, run.status),
      h('time', {}, workflowTime(run.updatedAt))
    ))))] : [])
  );
}

async function fetchWorkItemWorkflow(workItem) {
  const workflow = await api(`/api/work-items/${encodeURIComponent(workItem.id)}/workflow`);
  state.workflowSnapshots[workItem.id] = workflow;
  return workflow;
}

async function fetchWorkflowLiveJob(workItem) {
  const action = state.workflowAction;
  if (!action || action.workItemId !== workItem.id || !action.jobId) return null;
  const endpoint = action.kind === 'analyze'
    ? `/api/analysis-jobs/${encodeURIComponent(action.jobId)}`
    : `/api/fix-jobs/${encodeURIComponent(action.jobId)}`;
  const job = await api(endpoint);
  return { kind: action.kind, job };
}

async function showWorkflowLiveAction(workItem, kind, job) {
  const workflow = state.workflowSnapshots[workItem.id] || await fetchWorkItemWorkflow(workItem);
  renderWorkItemWorkflow(workItem, workflow, { kind, job });
}

async function loadWorkItemWorkflow(workItem, live = null) {
  const target = $('#work-item-workflow');
  if (!target) return;
  try {
    if (!live) live = await fetchWorkflowLiveJob(workItem);
    const workflow = state.workflowSnapshots[workItem.id] || await fetchWorkItemWorkflow(workItem);
    renderWorkItemWorkflow(workItem, workflow, live);
  } catch (error) {
    if (target.dataset.workItemId === workItem.id) target.replaceChildren(h('div', { class: 'workflow-error' }, `Unable to load work-item workflow: ${error.message}`));
  }
}

async function ensureWorkItemDrawer(workItem) {
  if (!$('#issue-dialog').open || $('#work-item-workflow')?.dataset.workItemId !== workItem.id) {
    openWorkItem(workItem);
    await new Promise(resolve => setTimeout(resolve, 0));
    let attempts = 0;
    while (attempts < 40 && !state.workflowSnapshots[workItem.id]) {
      await new Promise(resolve => setTimeout(resolve, 50));
      attempts++;
    }
  }
}

function workflowActionTerminal(kind, status) {
  if (kind === 'analyze') return ['succeeded', 'completed_with_errors', 'failed'].includes(status);
  return ['succeeded', 'failed'].includes(status);
}

async function pollWorkflowAction(workItem, kind, jobId, initialJob = null) {
  const interval = kind === 'analyze' ? 500 : 500;
  let workflow = state.workflowSnapshots[workItem.id];
  if (!workflow) workflow = await fetchWorkItemWorkflow(workItem);
  let job = initialJob;
  while (true) {
    if (!job) {
      const endpoint = kind === 'analyze'
        ? `/api/analysis-jobs/${encodeURIComponent(jobId)}`
        : `/api/fix-jobs/${encodeURIComponent(jobId)}`;
      job = await api(endpoint);
    }
    if ($('#work-item-workflow')?.dataset.workItemId === workItem.id) renderWorkItemWorkflow(workItem, workflow, { kind, job });
    if (workflowActionTerminal(kind, job.status)) break;
    job = null;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  if ($('#work-item-workflow')?.dataset.workItemId === workItem.id) renderWorkItemWorkflow(workItem, workflow, { kind, job });
  state.workflowAction = null;
  delete state.workflowSnapshots[workItem.id];
  await load();
  const updated = state.workItems.find(item => item.id === workItem.id);
  if (updated && $('#issue-dialog').open && $('#work-item-workflow')?.dataset.workItemId === workItem.id) {
    await loadWorkItemWorkflow(updated);
    void resumeWorkflowPollingIfNeeded(updated);
  }
  return job;
}

async function resumeWorkflowPollingIfNeeded(workItem) {
  if (state.workflowAction?.workItemId === workItem.id) return;
  const jobId = workItem.remediation?.jobId;
  if (!jobId) return;
  try {
    const job = await api(`/api/fix-jobs/${encodeURIComponent(jobId)}`);
    if (!['queued', 'running'].includes(job.status)) return;
    const kind = job.kind === 'batch-create-pr' ? 'create-pr' : 'fix';
    state.workflowAction = { workItemId: workItem.id, kind, jobId };
    const workflow = state.workflowSnapshots[workItem.id] || await fetchWorkItemWorkflow(workItem);
    renderWorkItemWorkflow(workItem, workflow, { kind, job });
    const result = await pollWorkflowAction(workItem, kind, jobId, job);
    if (result.status === 'failed') notice(`${kind === 'create-pr' ? 'Pull request' : 'Fix'} job failed.`, true);
  } catch (error) {
    state.workflowAction = null;
  }
}

function openJobLog(id) {
  const dialog = $('#log-dialog');
  dialog.showModal();
  void (async () => {
    try {
      const job = await api(`/api/fix-jobs/${encodeURIComponent(id)}`);
      const workflow = job.agent ? `Workflow: ${job.agent.provider} · ${job.agent.skill}\n\n` : '';
      $('#job-log').textContent = workflow + (job.log || `${job.status}…`);
    } catch (error) {
      $('#job-log').textContent = error.message;
    }
  })();
}

function openWorkItem(workItem) {
  const dialog = $('#issue-dialog');
  const members = workItem.issueIds.map(id=>state.issues.find(issue=>issue.id===id)).filter(Boolean);
  const fixTargets = workItemFixTargets(members);
  const source = workItem.grouping?.source === 'dependency_engine' ? 'Dependency engine' : workItem.grouping?.source === 'ai' ? `AI${workItem.grouping.model?` · ${workItem.grouping.model}`:''}` : 'Manual';
  const humanReviewIds = workItemHumanReviewIds(workItem);
  const humanReviewMembers = members.filter(issue => humanReviewIds.has(issue.id));
  $('#issue-detail').replaceChildren(h('div',{class:'drawer-content'},
    h('div',{class:'dialog-head'},h('div',{},h('p',{class:'eyebrow'},'Work item'),h('h2',{},workItem.id.slice(0,8))),h('button',{onclick:()=>dialog.close()},'Close')),
    h('div',{class:'detail-grid'},h('div',{class:'detail-box'},h('span',{},'Status'),workItem.state.replaceAll('_',' ')),h('div',{class:'detail-box'},h('span',{},'Fix targets'),fixTargets.length),h('div',{class:'detail-box'},h('span',{},'Tracked alerts'),members.length),h('div',{class:'detail-box'},h('span',{},'Created by'),source),workItem.grouping?.safetyRank?h('div',{class:'detail-box'},h('span',{},'Safety rank'),`#${workItem.grouping.safetyRank}`):null,typeof workItem.grouping?.safetyScore==='number'?h('div',{class:'detail-box'},h('span',{},'AI safety'),`${workItem.grouping.safetyScore}/100 · ${String(workItem.grouping.safetyLevel||'').replaceAll('_',' ')}`):null,humanReviewMembers.length||workItem.grouping?.requiresHumanReview?h('div',{class:'detail-box'},h('span',{},'Human review'),`${humanReviewMembers.length || workItem.issueIds.length} member${(humanReviewMembers.length || workItem.issueIds.length)===1?'':'s'}`):null,h('div',{class:'detail-box'},h('span',{},'Branch'),h('code',{class:'mono'},workItem.branch)),h('div',{class:'detail-box'},h('span',{},'Updated'),workflowTime(workItem.updatedAt))),
    h('section',{id:'work-item-workflow',class:'workflow-panel','data-work-item-id':workItem.id},h('div',{class:'workflow-loading'},'Loading complete work-item workflow…')),
    h('div',{class:'detail-actions'},h('button',{class:'primary',onclick:()=>runWorkItem(workItem,'fix')},workItemBlockedMembers(workItem).length?'Fix all anyway':'Fix all'),h('button',{onclick:()=>runWorkItem(workItem,'create-pr')},'Create one PR'),workItem.remediation.jobId?h('button',{onclick:()=>openJobLog(workItem.remediation.jobId)},'Latest job log'):null),
    humanReviewMembers.length||workItem.grouping?.humanReviewReasons?.length?h('section',{class:'analysis human-review-panel'},h('h3',{},'Human review required'),workItem.grouping?.humanReviewReasons?.length?h('ul',{},...workItem.grouping.humanReviewReasons.map(reason=>h('li',{},reason))):null,humanReviewMembers.length?h('div',{class:'work-item-detail-members'},...humanReviewMembers.map(issue=>h('article',{class:'work-item-detail-member'},h('div',{},h('strong',{},issue.packageName),h('span',{},` → ${issue.patchedVersion}`),isFixBlocked(issue)?h('p',{class:'muted-text'},issue.lastUpgradeAnalysis?`Engine risk: ${issue.lastUpgradeAnalysis.riskLevel.replaceAll('_',' ')}`:'Dependency analysis not completed'):null),h('button',{onclick:()=>openIssue(issue)},'Issue details')))):h('p',{class:'muted-text'},'Review flagged members before fixing or merging.')):null,
    h('section',{class:'analysis'},h('h3',{},'Fix targets'),h('p',{class:'muted-text'},'One coordinated fix run bumps each target version below. Overlapping alerts for the same package are covered by the highest target.'),h('div',{class:'work-item-detail-members'},...fixTargets.map(target=>h('article',{class:'work-item-detail-member'},h('div',{},h('strong',{},target.issue.packageName),h('span',{},` → ${target.issue.patchedVersion}`),target.covered.length?h('p',{class:'muted-text'},`Covers ${target.covered.length} overlapping alert${target.covered.length===1?'':'s'} at lower target versions.`):null),h('div',{class:'meta'},humanReviewIds.has(target.issue.id)?h('span',{class:'tag human-review'},'Human review'):null,h('span',{class:`tag ${target.issue.lastUpgradeAnalysis?`risk-${target.issue.lastUpgradeAnalysis.riskLevel}`:''}`},target.issue.lastUpgradeAnalysis?target.issue.lastUpgradeAnalysis.riskLevel.replaceAll('_',' '):'not analyzed'),target.issue.lastUpgradeAnalysis?h('span',{class:'tag'},`${target.issue.lastUpgradeAnalysis.safetyScore}/100`):null,h('span',{class:'tag state'},target.issue.state.replaceAll('_',' '))),h('button',{onclick:()=>openIssue(target.issue)},'Issue details'))))),
    members.length>fixTargets.length?h('details',{class:'group-rationale'},h('summary',{},`All tracked alerts (${members.length})`),h('div',{class:'work-item-detail-members'},...members.map(issue=>h('article',{class:'work-item-detail-member'},h('div',{},h('strong',{},issue.packageName),h('span',{},` → ${issue.patchedVersion}`)),h('button',{onclick:()=>openIssue(issue)},'Issue details'))))):null,
    workItem.grouping?.rationale?.length?h('section',{class:'analysis'},h('h3',{},'Grouping rationale'),workItem.grouping.safetySummary?h('p',{},workItem.grouping.safetySummary):null,h('ul',{},...workItem.grouping.rationale.map(reason=>h('li',{},reason)))):null,
    workItem.remediation.result?.prUrl?h('p',{},h('a',{href:workItem.remediation.result.prUrl,target:'_blank',rel:'noreferrer'},'Open work-item pull request')):null
  ));
  if(!dialog.open)dialog.showModal();
  void loadWorkItemWorkflow(workItem).then(() => resumeWorkflowPollingIfNeeded(workItem));
}

function workflowTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function workflowActions(issue, workflow) {
  const actions = [];
  if (workflow.nextActionKind === 'analyze') actions.push(h('button',{class:'primary',onclick:()=>analyze(issue)},'Run AI analysis'));
  if (workflow.nextActionKind === 'fix') {
    actions.push(h('button',{class:'primary',onclick:()=>runJob(issue,'fix')},workflow.steps.some(step=>step.id==='fix'&&step.status==='failed')?'Retry fix':'Run fix'));
  }
  if (workflow.nextActionKind === 'create-pr') actions.push(h('button',{class:'primary',onclick:()=>runJob(issue,'create-pr')},'Create pull request'));
  if (workflow.canRefix) actions.push(h('button',{class:'primary',onclick:()=>runJob(issue,'fix')},'Run fix again'));
  if (workflow.nextActionKind === 'review' && issue.pr.url) actions.push(h('a',{class:'workflow-link',href:issue.pr.url,target:'_blank',rel:'noreferrer'},`Open pull request #${issue.pr.number||''}`));
  return actions;
}

function renderIssueWorkflow(issue, workflow) {
  const target = $('#issue-workflow');
  if (!target || target.dataset.issueId !== issue.id) return;
  const labels = {completed:'Done',current:'Next',running:'In progress',remaining:'Remaining',optional:'Optional',failed:'Failed'};
  const icons = {completed:'✓',current:'●',running:'●',remaining:'○',optional:'◇',failed:'!'};
  const runs = workflow.remediationRuns || [];
  target.replaceChildren(
    h('div',{class:'workflow-heading'},h('div',{},h('p',{class:'eyebrow'},'Live workflow state'),h('h3',{},'Remediation progress')),h('strong',{class:'workflow-percent'},`${workflow.progress}%`)),
    h('div',{class:'workflow-progress','aria-label':`${workflow.progress}% of required workflow complete`},h('span',{style:`width:${workflow.progress}%`})),
    h('ol',{class:'workflow-flow'},...workflow.steps.map(step=>h('li',{class:`workflow-step ${step.status}`},
      h('div',{class:'workflow-marker','aria-hidden':'true'},icons[step.status]),
      h('div',{class:'workflow-step-copy'},h('div',{class:'workflow-step-title'},h('strong',{},step.label),h('span',{class:`workflow-status ${step.status}`},labels[step.status])),h('p',{},step.detail),step.completedAt?h('time',{datetime:step.completedAt},workflowTime(step.completedAt)):null)
    ))),
    h('div',{class:'next-action'},h('span',{},'Next step'),h('strong',{},workflow.nextAction),h('div',{class:'next-action-buttons'},...workflowActions(issue,workflow))),
    h('div',{class:'fix-evidence'},h('h4',{},'Applied fix evidence'),workflow.latestFix
      ? h('dl',{},h('div',{},h('dt',{},'Fix job ID'),h('dd',{class:'mono'},workflow.latestFix.id)),h('div',{},h('dt',{},'Status'),h('dd',{class:workflow.latestFix.valid===false?'workflow-error':''},workflow.latestFix.valid===false?'Invalid · no branch commit':workflow.latestFix.status)),h('div',{},h('dt',{},'Fix workflow'),h('dd',{},workflow.latestFix.agent?`${workflow.latestFix.agent.provider} · ${workflow.latestFix.agent.skill}`:'Built-in dependency update')),h('div',{},h('dt',{},'Commit'),h('dd',{class:'mono'},workflow.latestFix.commitSha||'Not committed')),h('div',{},h('dt',{},'Branch'),h('dd',{class:'mono'},workflow.latestFix.branch||issue.pr.branch)),workflow.latestFix.validationMessage?h('div',{},h('dt',{},'Validation'),h('dd',{class:'workflow-error'},workflow.latestFix.validationMessage)):null,workflow.latestFix.error?h('div',{},h('dt',{},'Error'),h('dd',{class:'workflow-error'},workflow.latestFix.error)):null)
      : h('p',{class:'workflow-empty'},'No fix job has been applied yet.')),
    ...(runs.length ? [h('details',{class:'workflow-runs'},
      h('summary',{},`All remediation runs (${runs.length})`),
      h('div',{class:'workflow-run-list'},...runs.map(run=>h('div',{class:'workflow-run'},
        h('span',{class:`status-dot ${run.status==='succeeded'?'successful':run.status==='failed'?'failed':'pending'}`}),
        h('code',{},run.id),
        h('strong',{},run.kind.replaceAll('-',' ')),
        h('span',{},run.agent?`${run.agent.provider} · ${run.agent.skill}`:'built-in'),
        h('time',{},workflowTime(run.updatedAt))
      )))
    )] : [])
  );
}

async function loadIssueWorkflow(issue) {
  const target = $('#issue-workflow');
  if (!target) return;
  try {
    const workflow = await api(`/api/issues/${encodeURIComponent(issue.id)}/workflow?repo=${encodeURIComponent(issue.repo)}`);
    renderIssueWorkflow(issue, workflow);
  } catch (error) {
    if (target.dataset.issueId === issue.id) target.replaceChildren(h('div',{class:'workflow-error'},`Unable to load workflow state: ${error.message}`));
  }
}

function openIssue(issue) {
  const dialog = $('#issue-dialog'); const ai = issue.lastAiAnalysis;
  const stateSelect = h('select',{},...states.map(name=>h('option',{value:name,...(name===issue.state?{selected:'selected'}:{})},name.replaceAll('_',' '))));
  stateSelect.addEventListener('change',async()=>{try{await api(`/api/issues/${encodeURIComponent(issue.id)}/state`,{method:'POST',body:JSON.stringify({repo:issue.repo,state:stateSelect.value,force:true})});await load();dialog.close();}catch(error){notice(error.message,true);}});
  $('#issue-detail').replaceChildren(h('div',{class:'drawer-content'},
    h('div',{class:'dialog-head'},h('div',{},h('p',{class:'eyebrow'},issue.severity),h('h2',{},issue.title)),h('button',{onclick:()=>dialog.close()},'Close')),
    h('div',{class:'detail-grid'},h('div',{class:'detail-box'},h('span',{},'Target'),issue.patchedVersion),h('div',{class:'detail-box'},h('span',{},'State'),stateSelect),h('div',{class:'detail-box'},h('span',{},'Manifest'),issue.manifestPath),h('div',{class:'detail-box'},h('span',{},'Alerts'),issue.alerts.join(', ')),h('div',{class:'detail-box'},h('span',{},'Last fix workflow'),issue.remediation?.agent?`${issue.remediation.agent.provider} · ${issue.remediation.agent.skill}`:'Built-in dependency update')),
    h('section',{id:'issue-workflow',class:'workflow-panel','data-issue-id':issue.id},h('div',{class:'workflow-loading'},'Loading current workflow state…')),
    h('div',{class:'detail-actions'},h('button',{class:'primary',onclick:()=>runJob(issue,'fix')},'Run fix'),h('button',{onclick:()=>runJob(issue,'create-pr')},'Create PR'),aiConfigured()?h('button',{class:'accent',onclick:()=>analyze(issue)},'AI analysis'):null,issue.remediation.jobId?h('button',{onclick:()=>pollJob(issue.remediation.jobId)},'Latest job log'):null),
    h('section',{class:'analysis'},h('h3',{},'AI analysis'),ai?h('div',{},h('p',{},`Risk: ${ai.riskLevel.replaceAll('_',' ')} · score ${ai.safetyScore}/100 · ${ai.confidence} confidence`),h('p',{},ai.summary),h('p',{class:'muted-text'},`${ai.provider||'cursor'} · ${ai.model||(ai.provider==='gemini'?state.defaults.geminiModel:state.defaults.cursorModel)}${ai.runId?` · run ${ai.runId}`:''}`),ai.breakingChanges.length?h('div',{},h('strong',{},'Breaking changes'),h('ul',{},...ai.breakingChanges.map(value=>h('li',{},value)))):null,h('strong',{},'Verification'),h('ul',{},...ai.verificationChecks.map(value=>h('li',{},value)))):h('p',{},aiConfigured()?'No AI analysis has been run.':'Configure CURSOR_API_KEY or GEMINI_API_KEY to enable AI analysis.')),
    issue.pr.url?h('p',{},h('a',{href:issue.pr.url,target:'_blank',rel:'noreferrer'},`Open pull request #${issue.pr.number||''}`)):null)); if(!dialog.open)dialog.showModal();void loadIssueWorkflow(issue);
}

async function analyze(issue) { try { await api(`/api/issues/${encodeURIComponent(issue.id)}/analyze-upgrade/ai`,{method:'POST',body:body({promptTemplate:settings.prompt||undefined})});const grouped=await runAutoGroup();selectWorkItemView();notice(`AI analysis complete for ${issue.packageName}. ${grouped.workItems.length} work item${grouped.workItems.length===1?'':'s'} ready.`);await load();const updated=state.issues.find(item=>item.id===issue.id);if(updated)openIssue(updated);} catch(error){notice(error.message,true);} }
function openFixChooser(issue) {
  state.pendingFixIssue = issue;
  $('#fix-agent-issue').textContent = `${issue.packageName} → ${issue.patchedVersion}`;
  if ($('#issue-dialog').open) $('#issue-dialog').close();
  $('#fix-agent-dialog').showModal();
}
async function startSelectedFix() {
  const issue = state.pendingFixIssue;
  if (!issue) throw new Error('Choose an issue to fix.');
  const value = $('#fix-agent-select').value;
  const agent = value ? JSON.parse(value) : undefined;
  $('#fix-agent-dialog').close();
  state.pendingFixIssue = null;
  await startIssueJob(issue, 'fix', agent);
}
async function startIssueJob(issue,kind,agent){try{const endpoint=kind==='fix'?'fix':'create-pr';const reuseWorktree=kind==='create-pr'&&Boolean(issue.remediation?.result?.worktreePath);const job=await api(`/api/issues/${encodeURIComponent(issue.id)}/actions/${endpoint}`,{method:'POST',body:body({reuseWorktree,...(agent?{agent}:{})})});if($('#issue-dialog').open)$('#issue-dialog').close();await pollJob(job.id);}catch(error){notice(error.message,true);}}
async function runJob(issue,kind){if(kind==='fix')return startIssueJob(issue,'fix',requireFixAgent());return startIssueJob(issue,kind);}
async function runWorkItem(workItem, kind) {
  if (workflowActionBusy(workItem)) return;
  try {
    const extra = {};
    if (kind === 'fix') {
      const blocked = workItemBlockedMembers(workItem);
      if (blocked.length && !await confirmRiskyFix(blocked)) return;
      extra.force = blocked.length > 0;
      extra.agent = requireFixAgent();
    }
    await ensureWorkItemDrawer(workItem);
    state.workflowAction = { workItemId: workItem.id, kind, jobId: null };
    await showWorkflowLiveAction(workItem, kind, { status: 'queued', log: '', kind: kind === 'create-pr' ? 'batch-create-pr' : 'batch-fix' });
    const job = await api(`/api/work-items/${workItem.id}/actions/${kind}`, { method: 'POST', body: body(extra) });
    state.workflowAction.jobId = job.id;
    const result = await pollWorkflowAction(workItem, kind, job.id, job);
    if (result.status === 'failed') notice(`${kind === 'create-pr' ? 'Pull request' : 'Fix'} job failed${result.error ? `: ${result.error}` : '.'}`, true);
    else notice(kind === 'create-pr' ? 'Pull request job completed.' : 'Fix job completed.');
  } catch (error) {
    state.workflowAction = null;
    notice(error.message, true);
  }
}
async function pollJob(id) {
  const dialog = $('#log-dialog');
  dialog.showModal();
  let complete = false;
  while (dialog.open && !complete) {
    try {
      const job = await api(`/api/fix-jobs/${encodeURIComponent(id)}`);
      const workflow = job.agent ? `Workflow: ${job.agent.provider} · ${job.agent.skill}\n\n` : '';
      $('#job-log').textContent = workflow + (job.log || `${job.status}…`);
      complete = ['succeeded', 'failed'].includes(job.status);
      if (complete) {
        $('#job-log').textContent += `\n\nJob ${job.status}${job.error ? `: ${job.error}` : ''}`;
        await load();
      }
    } catch (error) {
      $('#job-log').textContent = error.message;
      complete = true;
    }
    if (!complete) await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
async function waitForAnalysis(id) {
  let job;
  do {
    await new Promise(resolve => setTimeout(resolve, 500));
    job = await api(`/api/analysis-jobs/${encodeURIComponent(id)}`);
  } while (['queued', 'running'].includes(job.status));
  return job;
}

init().catch(error=>notice(error.message,true));
