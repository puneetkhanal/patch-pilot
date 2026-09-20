function parts(value: string) {
  const cleaned = value.trim().replace(/^[^\d]*/, '');
  const [core, prerelease] = cleaned.split('-');
  const segments = core.split('.').map(part => Number.parseInt(part, 10) || 0);
  while (segments.length < 3) segments.push(0);
  return { segments, prerelease: prerelease || '' };
}

export function compareVersions(left: string, right: string) {
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index++) {
    if (a.segments[index] !== b.segments[index]) return a.segments[index] > b.segments[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

export function maxVersion(versions: string[]) {
  return versions.reduce((best, current) => compareVersions(current, best) > 0 ? current : best, versions[0]);
}
