export function slugify(v:string): string {
  return v.toLowerCase().replace(/\.lock\b/g,'lock').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/-+/g,'-') || 'unknown';
}
export function issueId(ecosystem:string, packageName:string, patchedVersion:string) { return `issue-${slugify(`${ecosystem}|${packageName}|${patchedVersion}`)}`; }
export function issueBranch(manifestPath:string, ecosystem:string, packageName:string, patchedVersion:string) {
  return `security-fix/dependabot/${slugify(manifestPath)}/${slugify(ecosystem)}/${slugify(packageName)}-${slugify(patchedVersion)}`;
}
