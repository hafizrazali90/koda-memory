import OpenAI from 'openai';

/**
 * Binary yes/no classifier used by the validation detectors (duplicate /
 * contradiction confirmation).
 *
 * Provider-flexible:
 *   - If ANTHROPIC_API_KEY is set → Claude Haiku via the Anthropic API.
 *   - Else if OPENAI_API_KEY is set → gpt-4o-mini via the OpenAI SDK.
 *
 * History: the detectors used to POST to api.anthropic.com using OPENAI_API_KEY,
 * which on this deployment is an OpenAI key (sk-proj-...). Anthropic rejected it,
 * the call silently failed, and every check returned "no" — so duplicate and
 * contradiction detection never actually worked. This helper picks a provider
 * that matches the configured key.
 *
 * IMPORTANT: askYesNo THROWS on an API/network failure (rather than returning
 * false). That lets the validation engine mark the job failed and RETRY it with
 * backoff, instead of silently treating an outage as "not a duplicate".
 */

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = 'gpt-4o-mini';

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY required');
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

export function isClassifierAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}

/**
 * Returns which provider askYesNo will use, for logging/diagnostics.
 */
export function classifierProvider(): 'anthropic' | 'openai' | 'none' {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

async function askAnthropic(prompt: string): Promise<boolean> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 5,
      messages: [{ role: 'user', content: `${prompt}\n\nAnswer YES or NO only.` }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Anthropic ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
  }
  const data = (await resp.json()) as { content?: Array<{ text?: string }> };
  const answer = data.content?.[0]?.text?.trim().toUpperCase() ?? '';
  return answer.startsWith('YES');
}

async function askOpenAI(prompt: string): Promise<boolean> {
  const openai = getOpenAI();
  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    max_tokens: 3,
    messages: [{ role: 'user', content: `${prompt}\n\nAnswer YES or NO only.` }],
  });
  const answer = (resp.choices[0]?.message?.content ?? '').trim().toUpperCase();
  return answer.startsWith('YES');
}

/**
 * Ask the configured LLM a yes/no question. Returns true on "YES".
 * Throws if no provider is configured or the API call fails (retryable).
 */
export async function askYesNo(prompt: string): Promise<boolean> {
  const provider = classifierProvider();
  if (provider === 'anthropic') return askAnthropic(prompt);
  if (provider === 'openai') return askOpenAI(prompt);
  throw new Error('No LLM provider configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)');
}
