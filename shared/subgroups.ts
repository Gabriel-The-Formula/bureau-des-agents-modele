// Les sous-catégories des réalisations, regroupées : Haiku donne une sous-catégorie libre par session (« Page d'accueil »,
// « Tests mobile », « Newsletter »…), si bien qu'une catégorie chargée finissait avec une puce par tâche. Chaque catégorie a
// donc au plus 5 groupes : des familles fixes reconnues par mots-clés (dans la sous-catégorie, sinon le titre), la dernière
// ramassant le reste. Une catégorie sans familles garde ses sous-catégories telles quelles, ramenées à 4 + « Autres ».
import type { FeedCategory } from './live.ts';

/** Au plus autant de sous-catégories par catégorie. */
export const MAX_SUBGROUPS = 5;

interface Family { label: string; re?: RegExp }

/** Les familles, dans l'ordre de reconnaissance ; la dernière, sans mots-clés, ramasse le reste. Mots-clés sans accents. */
const FAMILIES: Partial<Record<FeedCategory, Family[]>> = {
  code: [
    { label: 'Écrans et parcours', re: /ecran|page|mobile|bouton|mise en page|design|parcours|affichage|menu/ },
    { label: 'Correctifs', re: /bug|correct|erreur|plantage|regression/ },
    { label: 'Tests et qualité', re: /\btests?\b|qualite|relecture|lint|typage/ },
    { label: 'Mise en ligne et vitesse', re: /deploi|mise en ligne|perf|vitesse|migration/ },
    { label: 'Fonctions' },
  ],
  organisation: [
    { label: 'Agents et automatisations', re: /agent|automat|routine|planifi/ },
    { label: 'Bureau et suivi', re: /bureau|suivi|tableau/ },
    { label: 'Règles et organisation' },
  ],
};

export const OTHER_SUBGROUP = 'Autres';

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

interface Groupable { sub?: string; title: string }

/**
 * Le groupe de chaque réalisation d'une catégorie (au plus MAX_SUBGROUPS groupes distincts). `null` : pas de sous-catégorie
 * connue (catégorie sans familles et entrée sans sous-catégorie).
 */
export function subGrouper(cat: FeedCategory, entries: Groupable[]): (e: Groupable) => string | null {
  const fams = FAMILIES[cat];
  if (fams) {
    const rest = fams[fams.length - 1].label;
    return (e) => {
      for (const hay of [e.sub, e.title]) {
        if (!hay) continue;
        const f = fams.find((x) => x.re?.test(fold(hay)));
        if (f) return f.label;
      }
      return rest;
    };
  }
  const n = new Map<string, number>();
  for (const e of entries) if (e.sub) n.set(e.sub, (n.get(e.sub) ?? 0) + 1);
  if (n.size <= MAX_SUBGROUPS) return (e) => e.sub ?? null;
  const kept = new Set([...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_SUBGROUPS - 1).map(([s]) => s));
  return (e) => (e.sub ? (kept.has(e.sub) ? e.sub : OTHER_SUBGROUP) : null);
}

/** Les familles fixes de chaque catégorie (pour vérifier la limite). */
export const SUBGROUP_FAMILIES = FAMILIES;
