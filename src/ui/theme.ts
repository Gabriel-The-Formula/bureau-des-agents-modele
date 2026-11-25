// Le thème clair ou sombre. Par défaut clair, quel que soit le système ; la bascule de la barre du haut
// passe en sombre et s'en souvient. Toutes les couleurs de l'interface sont des variables CSS (styles.css).
import { savePref, useOffice, type Theme } from '../state/store.ts';

/** Pose le thème sur <html> (« auto », ancien réglage enregistré, vaut clair). */
export function applyTheme(theme: Theme) {
  const effective = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', effective);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effective === 'light' ? '#F4EDDB' : '#040405');
}

/** Le thème réellement affiché (clair ou sombre). */
export function useEffectiveTheme(): 'light' | 'dark' {
  const theme = useOffice((s) => s.theme);
  return theme === 'dark' ? 'dark' : 'light';
}

/** Passe à l'autre thème et s'en souvient. */
export function toggleTheme(current: 'light' | 'dark') {
  const theme: Theme = current === 'light' ? 'dark' : 'light';
  useOffice.setState({ theme });
  savePref('theme', theme);
  applyTheme(theme);
}
