export type EcosystemAdapterStatus = 'active' | 'planned';

export interface EcosystemAdapterDescriptor {
  id: string;
  name: string;
  language: string;
  manifests: string[];
  status: EcosystemAdapterStatus;
}

export const ecosystemAdapters: readonly EcosystemAdapterDescriptor[] = [
  { id: 'npm', name: 'npm', language: 'JavaScript', manifests: ['package.json'], status: 'active' },
  { id: 'pip', name: 'pip / Poetry', language: 'Python', manifests: ['requirements.txt', 'pyproject.toml'], status: 'planned' },
  { id: 'go', name: 'Go modules', language: 'Go', manifests: ['go.mod'], status: 'planned' }
];

export const primaryEcosystemAdapter = ecosystemAdapters.find(adapter => adapter.status === 'active')!;

export function activeEcosystemAdapter(id: string) {
  return ecosystemAdapters.find(adapter => adapter.id === id && adapter.status === 'active');
}
