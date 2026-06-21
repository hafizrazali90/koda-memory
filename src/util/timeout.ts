/**
 * Race a promise against a timeout, resolving to `fallback` if it doesn't
 * settle in time. The original promise is NOT cancelled — it just stops being
 * awaited — so callers must ensure abandoning it is safe (it is for vector
 * search: a late/failed embedding result is simply ignored).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([
    promise.then(
      (v) => { clearTimeout(timer); return v; },
      () => { clearTimeout(timer); return fallback; }, // a rejection also falls back
    ),
    timeout,
  ]);
}

/**
 * Read-path budget for the vector (embedding) call before we degrade to
 * keyword + graph results. The OpenAI embedding round-trip is ~400ms in the
 * happy case; this caps the tail (an OpenAI slow moment otherwise hung searches
 * for 15s). Tunable via KODA_VECTOR_TIMEOUT_MS.
 */
export function vectorTimeoutMs(): number {
  const v = Number(process.env.KODA_VECTOR_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 800;
}
