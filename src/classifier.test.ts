/**
 * Unit tests for the LLM classifier's provider selection and failure modes.
 * These never make a real network call — they only check which provider would
 * be used and that askYesNo throws (rather than silently returning false) when
 * no provider is configured.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { classifierProvider, isClassifierAvailable, askYesNo } from './llm/classifier.js';

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('LLM classifier provider selection', () => {
  it('reports none when no key is set', () => {
    expect(classifierProvider()).toBe('none');
    expect(isClassifierAvailable()).toBe(false);
  });

  it('prefers Anthropic when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.OPENAI_API_KEY = 'sk-proj-test';
    expect(classifierProvider()).toBe('anthropic');
    expect(isClassifierAvailable()).toBe(true);
  });

  it('falls back to OpenAI when only OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-proj-test';
    expect(classifierProvider()).toBe('openai');
    expect(isClassifierAvailable()).toBe(true);
  });

  it('askYesNo throws (not returns false) when no provider is configured', async () => {
    await expect(askYesNo('anything?')).rejects.toThrow(/No LLM provider/);
  });
});
