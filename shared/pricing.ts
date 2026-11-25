// Les tarifs de l'API Claude, en dollars par million de jetons : la SEULE table du projet.
// Sert à afficher un « équivalent tarif API » par session (sur abonnement, ce n'est pas ce que tu paies).
// Source : tarifs publics Anthropic (API directe), relevés le 25 octobre 2026. Un modèle absent = « prix inconnu ».
//
// Écriture de cache : 1,25x l'entrée pour 5 min, 2x pour 1 h. Lecture de cache : 0,1x l'entrée, sauf mention contraire.

export interface ModelPrice {
  /** entrée, sortie (dollars par million de jetons) */
  input: number;
  output: number;
  /** lecture de cache, si elle ne vaut pas 0,1x l'entrée */
  cacheRead?: number;
  /** au-delà de ce nombre de jetons de prompt par requête, le tarif `above` s'applique (Haiku 5.5) */
  tierAbove?: number;
  above?: { input: number; output: number; cacheRead?: number };
}

export const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 }, // lecture de cache baissée le 07/10/2026
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, tierAbove: 100_000, above: { input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** Le tarif d'un modèle tel qu'il est écrit dans la transcription (suffixes de date ou de contexte ignorés). */
export function priceOf(model: string): ModelPrice | null {
  const m = String(model ?? '').toLowerCase().replace(/\[.*\]$/, '');
  if (PRICES[m]) return PRICES[m];
  const base = m.replace(/-\d{8}$/, '').replace(/@.*$/, '');
  return PRICES[base] ?? null;
}

/** Le coût d'une réponse, en dollars ; null si le modèle n'est pas dans la table. */
export function costOf(model: string, u: Usage): number | null {
  const p0 = priceOf(model);
  if (!p0) return null;
  const input = Number(u.input_tokens ?? 0);
  const output = Number(u.output_tokens ?? 0);
  const read = Number(u.cache_read_input_tokens ?? 0);
  const created = Number(u.cache_creation_input_tokens ?? 0);
  const w1h = Math.min(created, Number(u.cache_creation?.ephemeral_1h_input_tokens ?? 0));
  const w5m = created - w1h;
  const prompt = input + read + created;
  const p = p0.tierAbove && p0.above && prompt > p0.tierAbove ? p0.above : p0;
  const readPrice = p.cacheRead ?? p.input * 0.1;
  return (input * p.input + output * p.output + read * readPrice + w5m * p.input * 1.25 + w1h * p.input * 2) / 1_000_000;
}
