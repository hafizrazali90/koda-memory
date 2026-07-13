/**
 * Canonicalizes `project` labels to prevent the case/naming drift cleaned up
 * on 2026-07-13 (see scripts/dedupe-projects.ts) from recreating itself.
 *
 * Two kinds of drift observed in production:
 *  - Pure case drift: "Sifututor" vs "sifututor" — caught by lowercasing.
 *  - Same-concept, different spelling: "kelas" vs "kelasapp", "finch" vs
 *    "finch-inbox" — not catchable by case-folding alone, needs an explicit
 *    alias entry per pair.
 *
 * Keys are lowercase; matching is case-insensitive on the input.
 */
const PROJECT_ALIASES: Record<string, string> = {
  'sifututor': 'sifututor',
  'kelas': 'kelasapp',
  'kelasapp': 'kelasapp',
  'finch': 'finch-inbox',
  'finch-inbox': 'finch-inbox',
  'sifututor agent os': 'sifututor-agent-os',
  'sifututor-agent-os': 'sifututor-agent-os',
};

export function normalizeProject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const canonical = PROJECT_ALIASES[trimmed.toLowerCase()];
  return canonical ?? trimmed;
}
