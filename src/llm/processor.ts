import OpenAI from 'openai';

const PROCESSOR_MODEL = 'gpt-4o-mini';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for LLM processing');
    client = new OpenAI({ apiKey });
  }
  return client;
}

export function isProcessorAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export interface SimilarMemory {
  id: string;
  content: string;
  similarity: number;
}

export interface ProcessedMemory {
  content: string;
  category: 'decision' | 'lesson' | 'rule' | 'preference' | 'fact';
  why: string;
  tags: string[];
  duplicate_of?: string; // ID of existing memory to update instead of creating new
}

const SYSTEM_PROMPT = `You are a memory processor for an AI coding assistant.
Your job is light-touch cleanup and metadata tagging. PRESERVE the author's original meaning and wording.

Rules:
- content: keep the author's original statement. ONLY fix spelling, grammar, and formatting. Do NOT summarize, reinterpret, re-word, or change the meaning. Do NOT invent details the author didn't state. Keep it under 400 chars but never drop information to hit a length — trim only redundant filler.
- category: classify WITHOUT altering content — decision (architectural choice), lesson (learned from bug/mistake), rule (must-always-do), preference (style/approach), fact (static project info)
- why: one sentence on the consequence if ignored — leave as empty string if the author didn't imply one (do not fabricate)
- tags: array including the project name + 2-4 topic tags (lowercase, hyphenated)
- duplicate_of: ID of an existing memory this UPDATES (not just relates to) — null if this is genuinely new

Return valid JSON only. No markdown, no explanation.`;

export async function processMemory(
  rawContent: string,
  project: string,
  similarMemories: SimilarMemory[]
): Promise<ProcessedMemory> {
  const openai = getClient();

  const similarContext = similarMemories.length > 0
    ? `\n\nExisting similar memories (check if this is a duplicate or update):\n${similarMemories
        .map((m) => `- ${m.id} (similarity ${m.similarity}): ${m.content}`)
        .join('\n')}`
    : '';

  const userMessage = `Project: ${project}\nRaw content: ${rawContent}${similarContext}`;

  const response = await openai.chat.completions.create({
    model: PROCESSOR_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  const raw = response.choices[0].message.content ?? '{}';

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fallback: return raw content unprocessed (preserve the author's words)
    return {
      content: rawContent.slice(0, 400),
      category: 'lesson',
      why: '',
      tags: [project],
    };
  }

  const validCategories = ['decision', 'lesson', 'rule', 'preference', 'fact'];
  const category = validCategories.includes(parsed.category as string)
    ? (parsed.category as ProcessedMemory['category'])
    : 'lesson';

  return {
    content: (parsed.content as string) || rawContent.slice(0, 400),
    category,
    why: (parsed.why as string) || '',
    tags: Array.isArray(parsed.tags) ? (parsed.tags as string[]) : [project],
    duplicate_of: typeof parsed.duplicate_of === 'string' && parsed.duplicate_of !== 'null'
      ? parsed.duplicate_of
      : undefined,
  };
}
