import { describe, it, expect } from 'vitest';
import { normalizeProject } from './project-alias.js';

describe('normalizeProject', () => {
  it('passes through an already-canonical name unchanged', () => {
    expect(normalizeProject('ripple-suite')).toBe('ripple-suite');
  });

  it('folds case drift to the canonical casing', () => {
    expect(normalizeProject('Sifututor')).toBe('sifututor');
    expect(normalizeProject('SIFUTUTOR')).toBe('sifututor');
  });

  it('folds known same-concept spelling variants', () => {
    expect(normalizeProject('kelas')).toBe('kelasapp');
    expect(normalizeProject('Kelas')).toBe('kelasapp');
    expect(normalizeProject('finch')).toBe('finch-inbox');
    expect(normalizeProject('Sifututor Agent OS')).toBe('sifututor-agent-os');
  });

  it('trims whitespace', () => {
    expect(normalizeProject('  ripple-suite  ')).toBe('ripple-suite');
  });

  it('leaves unknown project names untouched (not lowercased globally)', () => {
    expect(normalizeProject('MyNewProject')).toBe('MyNewProject');
  });
});
