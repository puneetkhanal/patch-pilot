import { describe, expect, it } from 'vitest';
import { activeEcosystemAdapter, ecosystemAdapters, primaryEcosystemAdapter } from '../src/ecosystems/catalog.js';

describe('ecosystem adapter catalog', () => {
  it('exposes npm as active and Python and Go as planned', () => {
    expect(primaryEcosystemAdapter.id).toBe('npm');
    expect(activeEcosystemAdapter('npm')?.language).toBe('JavaScript');
    expect(activeEcosystemAdapter('pip')).toBeUndefined();
    expect(ecosystemAdapters).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pip', language: 'Python', status: 'planned' }),
      expect.objectContaining({ id: 'go', language: 'Go', status: 'planned' })
    ]));
  });
});
