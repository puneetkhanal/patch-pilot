export const $ = selector => document.querySelector(selector);
export const settings = {
  get repo() { return localStorage.dt_repo || ''; }, set repo(value) { localStorage.dt_repo = value.trim(); },
  get projectPath() { return localStorage.dt_project_path || ''; }, set projectPath(value) { localStorage.dt_project_path = value.trim(); },
  get prompt() { return localStorage.dt_ai_prompt || ''; }, set prompt(value) { localStorage.dt_ai_prompt = value; },
  get groupingPrompt() { return localStorage.dt_ai_grouping_prompt || ''; }, set groupingPrompt(value) { localStorage.dt_ai_grouping_prompt = value; },
  get groupingPromptVersion() { return localStorage.dt_ai_grouping_prompt_version || ''; }, set groupingPromptVersion(value) { localStorage.dt_ai_grouping_prompt_version = value; },
  get groupSize() { const value = Number(localStorage.dt_group_size || 3); return Number.isInteger(value) && value >= 2 && value <= 10 ? value : 3; },
  set groupSize(value) { localStorage.dt_group_size = String(value); },
  get aiProvider() { return localStorage.dt_ai_provider || ''; },
  set aiProvider(value) { localStorage.dt_ai_provider = value; }
};
export function splitRepo(value = settings.repo) { const parts = value.trim().split('/'); if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Choose a repository in owner/name format.'); return parts; }
export async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const text = await response.text(); let payload; try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) throw new Error(payload?.error || `${response.status} ${response.statusText}`);
  return payload;
}
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'checked') element.checked = value;
    else if (key === 'value') element.value = value ?? '';
    else if (value !== undefined && value !== null) element.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) element.append(child instanceof Node ? child : document.createTextNode(String(child ?? '')));
  return element;
}
function appDialog(message, options = {}) {
  const {
    title = 'PatchPilot',
    eyebrow = 'Confirmation',
    confirmLabel = 'OK',
    cancelLabel,
    destructive = false
  } = options;
  return new Promise(resolve => {
    const dialog = h('dialog', { class: 'app-dialog', 'aria-labelledby': 'app-dialog-title' });
    const finish = confirmed => {
      dialog.remove();
      resolve(confirmed);
    };
    const form = h('form', { method: 'dialog', class: 'app-dialog-panel' },
      h('div', { class: 'app-dialog-heading' },
        h('div', { class: 'app-dialog-icon', 'aria-hidden': 'true' }, destructive ? '!' : 'P'),
        h('div', {},
          h('p', { class: 'eyebrow' }, eyebrow),
          h('h2', { id: 'app-dialog-title' }, title)
        )
      ),
      h('p', { class: 'app-dialog-message' }, message),
      h('div', { class: 'app-dialog-actions' },
        cancelLabel ? h('button', { type: 'submit', value: 'cancel' }, cancelLabel) : null,
        h('button', { type: 'submit', value: 'confirm', class: destructive ? 'danger-confirm' : 'primary' }, confirmLabel)
      )
    );
    dialog.append(form);
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close('cancel');
    });
    dialog.addEventListener('close', () => finish(dialog.returnValue === 'confirm'), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}
export function confirmDialog(message, options = {}) {
  return appDialog(message, { title: 'Confirm action', confirmLabel: 'Confirm', cancelLabel: 'Cancel', ...options });
}
export function alertDialog(message, options = {}) {
  return appDialog(message, { eyebrow: 'PatchPilot', title: 'Notice', confirmLabel: 'Got it', ...options });
}
export function setBusy(button, busy, text = 'Working…') { if (!button) return; if (busy) { button.dataset.label = button.textContent; button.textContent = text; button.disabled = true; } else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; } }
export function issueRisk(issue) { return issue?.lastAiAnalysis?.riskLevel || 'not_analyzed'; }
export function matchesRisk(issue, risk = '') { return !risk || issueRisk(issue) === risk; }
export function dependencyNeighborhood(graph, packageName) {
  const nodes = new Map((graph?.nodes || []).map(node => [node.id, node]));
  const target = nodes.get(packageName) || { id: packageName };
  const uniqueEdges = edges => [...new Map(edges.map(edge => [`${edge.from}\0${edge.to}\0${edge.kind || ''}`, edge])).values()];
  const dependents = uniqueEdges((graph?.edges || []).filter(edge => edge.to === packageName))
    .map(edge => ({ ...nodes.get(edge.from), id: edge.from, relationship: edge.kind || 'dependency' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const dependencies = uniqueEdges((graph?.edges || []).filter(edge => edge.from === packageName))
    .map(edge => ({ ...nodes.get(edge.to), id: edge.to, relationship: edge.kind || 'dependency' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { target, dependents, dependencies };
}
function dependencyNode(node, className = '') {
  const version = node.version || node.requestedVersion;
  return h('div', { class: `graph-node ${className}`.trim() },
    h('strong', {}, node.id === 'project' ? 'Project' : node.id),
    version ? h('small', {}, version) : null,
    node.relationship ? h('span', { class: 'graph-edge-kind' }, node.relationship) : null
  );
}
export function renderDependencyGraph(graph, packageName, open = false) {
  const { target, dependents, dependencies } = dependencyNeighborhood(graph, packageName);
  const direct = Boolean(target.direct || dependents.some(node => node.id === 'project'));
  const column = (label, nodes, empty) => h('div', { class: 'graph-column' },
    h('span', { class: 'graph-label' }, label),
    nodes.length ? h('div', { class: 'graph-node-list' }, ...nodes.map(node => dependencyNode(node))) : h('p', { class: 'graph-empty' }, empty)
  );
  return h('details', { class: 'package-graph', ...(open ? { open: '' } : {}) },
    h('summary', {}, h('span', {}, 'Dependency graph'), h('small', {}, `${direct ? 'Direct' : 'Transitive'} · ${dependents.length} dependent${dependents.length === 1 ? '' : 's'} · ${dependencies.length} dependenc${dependencies.length === 1 ? 'y' : 'ies'}`)),
    h('div', { class: 'package-graph-flow' },
      column('Used by', dependents, 'No parent package found'),
      h('div', { class: 'graph-target' }, h('span', {}, 'depends on →'), dependencyNode(target, 'selected'), h('span', {}, '→ depends on')),
      column('Uses', dependencies, 'No child dependencies')
    ),
    h('p', { class: 'graph-help' }, 'Arrows follow the lockfile relationship from a consumer to the package it requires. This view shows immediate relationships for the selected package.')
  );
}
export async function withBusy(button, text, operation) {
  setBusy(button, true, text);
  try { return await operation(); }
  finally { setBusy(button, false); }
}
export function buildAnalysisMemberProgress(job, members) {
  const resultById = new Map((job?.results || []).map(result => [result.issueId, result]));
  return members.map(member => {
    const result = resultById.get(member.id);
    if (result?.ok) return { issue: member, status: 'completed' };
    if (result && !result.ok) return { issue: member, status: 'failed', error: result.error };
    if (job?.currentIssueId === member.id) return { issue: member, status: 'running' };
    return { issue: member, status: 'pending' };
  });
}

export function workflowLogTail(log, lines = 40) {
  return String(log || '').split('\n').slice(-lines).join('\n').trim();
}

export function installRepoControls(defaults = {}) {
  const repo = $('#repo'), project = $('#project-path');
  if (!settings.repo && defaults.defaultRepo) settings.repo = defaults.defaultRepo;
  if (!settings.projectPath && defaults.defaultProjectPath) settings.projectPath = defaults.defaultProjectPath;
  if (repo) { repo.value = settings.repo || defaults.defaultRepo || ''; repo.addEventListener('change', () => settings.repo = repo.value); }
  if (project) { project.value = settings.projectPath || defaults.defaultProjectPath || ''; project.addEventListener('change', () => settings.projectPath = project.value); }
}
