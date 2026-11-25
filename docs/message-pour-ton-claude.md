# Le message à coller à ton Claude Code

Copie tout le bloc ci-dessous et colle-le dans une nouvelle session Claude Code.

```
Installe et personnalise le Bureau des agents sur cette machine : https://github.com/Gabriel-The-Formula/bureau-des-agents-modele

C'est un bureau en pixel art qui suit en direct mes sessions Claude Code (il lit ~/.claude/projects), en local, sans
compte en ligne. Fais ceci, dans l'ordre, et dis-moi à chaque étape ce que tu fais :

1) Vérifie les prérequis : macOS ou Linux, Node.js 22.18 ou plus récent (`node -v` ; sinon propose-moi de l'installer
   depuis https://nodejs.org, version LTS), git. Si le dépôt est privé, vérifie que `gh auth status` est connecté.
2) Clone le dépôt dans mon dossier personnel (`gh repo clone` ou `git clone`), puis va dans le dossier.
3) Lis le README et CLAUDE.md du dépôt.
4) Crée un dossier pour mes rapports, ~/bureau-rapports, avec un premier rapport d'exemple
   ~/bureau-rapports/bienvenue/RAPPORT-BUREAU.md (en-tête `rapport:`, `sujet: Démarrage`, `niveau: a-lire`, `resume:`,
   comme dans la section « Les rapports » du README) qui m'explique en quelques lignes à quoi sert chaque onglet.
5) Lance `npm run local -- --rapports ~/bureau-rapports` en arrière-plan. Attends que le terminal affiche « Le Bureau des
   agents est ouvert », puis donne-moi le lien de connexion affiché. Vérifie que les onglets Bureau, Réalisations et
   Rapports s'affichent (le bureau montre mes sessions des dernières 24 h).
6) Pose-moi trois questions courtes pour personnaliser le bureau : mon activité (pour remplacer les catégories des
   réalisations), le nom à donner à ma machine sur l'étage, et si je veux garder les résumés par Claude Haiku.
   Puis fais les changements décrits dans la section « L'adapter » du README, lance `npm run check` et `npm run build`,
   et relance le bureau.
7) Termine par un résumé : où sont mes données, comment relancer le bureau (`npm run local -- --rapports ~/bureau-rapports`),
   et comment demander à mes agents d'écrire leurs études dans ~/bureau-rapports pour qu'elles apparaissent dans Rapports.

Règles : ne mets jamais de secret, de mot de passe ni de jeton dans un fichier versionné ; ne publie rien en ligne et ne
crée aucun compte sans me demander ; réponds-moi en français, simplement.
```
