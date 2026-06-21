import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required for vector search');
    }
    // Bound each request (SDK default is 10 MINUTES) and don't let the SDK add
    // its own retries on top of our manual retry loop below. A hung connection
    // therefore fails fast instead of lingering.
    client = new OpenAI({ apiKey, timeout: 8000, maxRetries: 0 });
  }
  return client;
}

/**
 * Generate an embedding for a single text.
 * Returns a Float32Array of 1536 dimensions.
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  const results = await generateEmbeddings([text]);
  return results[0];
}

/**
 * Generate embeddings for multiple texts in a single API call.
 */
export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const openai = getClient();
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      });

      return response.data.map((item) => new Float32Array(item.embedding));
    } catch (error) {
      lastError = error as Error;
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  throw new Error(`Failed to generate embeddings after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message}`);
}

/**
 * Check if the OpenAI API key is configured.
 */
export function isEmbeddingAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export { EMBEDDING_DIMENSIONS };
