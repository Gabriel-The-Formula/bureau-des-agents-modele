# Bien utiliser Claude Code avec son abonnement

Ce que nous avons appris en faisant tourner Claude Code tous les jours, pendant des semaines, sur plusieurs comptes et
des dizaines de sessions en parallèle. Rien n'est théorique : chaque règle vient d'une mesure ou d'une erreur qu'on a
payée. Les chiffres sont des ordres de grandeur relevés sur nos comptes ; mesure les tiens avec le bureau (prix par
session, jetons) avant de t'y fier.

## 1. Comprendre ce que tu dépenses

- Un abonnement Claude a **deux limites** : une fenêtre glissante de 5 heures, et une limite sur 7 jours. La fenêtre de
  5 h se recharge vite ; la semaine, non. Une fenêtre de 5 h utilisée à fond représentait chez nous **10 à 15 % de la
  semaine**. Autrement dit : environ 7 à 10 fenêtres pleines par semaine, pas une par tranche de 5 h.
- Une fois la limite de 7 jours atteinte, tout s'arrête jusqu'à la remise à zéro. Répartis l'effort sur la semaine
  plutôt que de tout brûler le lundi.
- Le bureau affiche un **prix en équivalent API** par session : ce n'est pas ce que tu paies, mais c'est le meilleur
  repère pour comparer les tâches entre elles et voir où part ta semaine.
- Ordre de grandeur constaté : la moitié des tâches coûtent peu (quelques dollars en équivalent API), mais une petite
  part des sessions à effort très élevé peut faire **près d'un tiers de la dépense**. C'est là qu'il faut regarder en premier.

## 2. Régler l'effort : medium par défaut

- **`medium` suffit pour 75 à 90 % des tâches** : code, correctifs, recherche, optimisation. Sur les modèles récents,
  `medium` vaut le `high` de la génération précédente.
- Monte en `high` seulement si la tâche l'exige vraiment (chantier lourd, étude longue). Garde `xhigh` pour la
  **première** session d'un très gros chantier (plus de 30 min d'autonomie), puis repasse en `high` pour les reprises.
- **Urgent ne veut pas dire effort élevé.** Une urgence se traite en la lançant tout de suite, pas en montant l'effort.
- `max` a tendance à sur-réfléchir : coût en plus, rarement un meilleur résultat.

## 3. Choisir le modèle

- Prends le modèle que l'éditeur recommande par défaut (aujourd'hui Claude Opus 5.5). Un modèle plus haut de gamme
  coûte nettement plus cher (chez nous environ 2 fois plus à travail égal) et n'est pas forcément meilleur en code.
- Ne passe à un modèle plus cher que si tu as **constaté** un échec du modèle par défaut sur cette tâche précise.
- Pour les petits outils internes (résumer, ranger, classer), un modèle léger (Sonnet, Haiku) suffit largement.
- À chaque nouveau modèle, relis **son** guide officiel (platform.claude.com, pages « Prompting » et « Effort »). Les
  recettes d'il y a six mois sont souvent fausses pour le modèle d'aujourd'hui.

## 4. Bien découper (ou ne pas découper) le travail

- **Donne la tâche entière** et laisse Claude aller au bout. Les modèles récents travaillent mieux avec la demande
  complète qu'avec une suite de petites sessions.
- Les **sous-agents** servent pour des pistes indépendantes et lourdes (explorer plusieurs dossiers, comparer plusieurs
  options en parallèle), pas pour de petites tâches : chaque sous-agent repart de zéro et coûte du contexte.
- Plusieurs sessions en parallèle : une session par tâche indépendante, et **jamais deux sessions qui modifient les
  mêmes fichiers**. Utilise un worktree git par session (Claude Code sait le faire).
- Ne pas ajouter de consigne « revérifie tout » ou « fais vérifier par un sous-agent » : le modèle vérifie déjà son
  travail, ça ne fait que doubler le coût.
- Pour une relecture de code, ne lui dis pas « sois conservateur » : il sous-déclarerait. Demande tout, trie ensuite.

## 5. Écrire de bonnes consignes

- Mets tes règles durables dans un fichier `CLAUDE.md` à la racine du projet (court, sous forme d'index), et le détail
  dans des fichiers séparés qu'il lit quand la tâche le concerne. Un CLAUDE.md énorme est relu à chaque session et
  coûte à chaque fois.
- Pour le design, « évite le look IA » ne marche pas : **nomme précisément** ce que tu refuses (couleurs, polices,
  effets) et donne ta palette.
- Exige qu'il **vérifie avant d'affirmer** : pas de « probablement » sur un fait qu'il peut contrôler (dans le code, ou
  par une recherche avec la source officielle citée).
- Laisse-le décider seul ce qui est évident ; ne garde pour toi que les vrais arbitrages (argent, envoi au nom de
  quelqu'un, mise en production, suppression). Sinon les tâches attendent tes réponses pendant des jours.

## 6. Les outils : seulement s'ils prouvent un gain

- Un outil, un skill ou un serveur MCP n'entre dans ton travail que s'il a battu « Claude seul » sur un même brief,
  jugé à l'aveugle. L'avoir installé n'est jamais une raison de l'utiliser. Exemple vécu : pour le motion design,
  Claude anime mieux seul en HTML/CSS que via un cadre vidéo dédié.
- **Serveurs MCP** : chaque serveur local (stdio) installé au niveau global démarre un processus **par session**. Avec
  20 sessions ouvertes, ça se multiplie. Installe-les dans le seul dossier qui s'en sert, ou préfère les connecteurs
  distants (HTTP) qui ne coûtent rien en local. Fige leur version (jamais `@latest`).

## 7. Ménager ta machine

- Beaucoup de sessions en parallèle qui lancent chacune un typecheck ou une suite de tests peuvent saturer la mémoire
  et faire planter l'ordinateur (vécu sur un Mac de 24 Go avec une vingtaine de sessions). Fais passer les commandes
  lourdes (build, typecheck, tests complets) **une à la fois**, par une petite file d'attente, et laisse la CI faire le
  contrôle complet.
- Pendant le travail local, ne lance que les tests liés aux fichiers modifiés.

## 8. Plusieurs comptes (si tu en as)

- Mets un compte de côté pour toi (tes sessions interactives) et fais tourner les tâches de fond sur les autres.
- Vise à **utiliser toute ta semaine** avant la remise à zéro, mais seulement avec des tâches utiles : une file de
  tâches classées par priorité (urgent et important d'abord) vaut mieux qu'un remplissage automatique qui brûle des
  jetons pour rien.

## Pour démarrer simplement

1. Effort `medium`, modèle par défaut.
2. Un `CLAUDE.md` court avec tes règles (langue, style, ce qu'il ne doit jamais faire sans toi).
3. Une tâche entière par session, en parallèle seulement si les tâches ne touchent pas les mêmes fichiers.
4. Le Bureau des agents ouvert à côté pour voir ce qui tourne et ce que ça coûte.
5. Une fois par semaine, regarde dans le bureau quelles sessions ont coûté le plus, et demande-toi si elles le valaient.
