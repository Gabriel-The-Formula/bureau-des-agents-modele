# Collecteur local

Lit les transcriptions de Claude Code (`~/.claude/projects`), en tire un résumé par session et des événements de bureau
caviardés, et les pousse au Worker (`POST /api/ingest`). Node 22.18+, aucune dépendance.

```bash
node collector/index.ts --dry --once   # essai : affiche les envois (un JSON par ligne), n'envoie rien
node collector/index.ts                 # boucle (scan toutes les 2 s, envoi complet toutes les 60 s)
bash scripts/install-collector.sh <url> # LaunchAgent macOS
```

Réglages (variables d'environnement, ou `~/.config/bureau-collector/config.json`) : `BUREAU_URL`, `BUREAU_TOKEN`,
`BUREAU_SOURCE_ID` (défaut : nom d'hôte), `BUREAU_SOURCE_LABEL` (défaut : nom de la machine), `CLAUDE_PROJECTS_DIR`,
`BUREAU_WINDOW_H` (24), `BUREAU_SNIPPETS` (1 : première phrase du chef et des rapports ; 0 : aucun texte libre).

- `session.ts` : lecture incrémentale (offset d'octets, lignes `api-request*`, `attachment`, `file-history*` écartées sans
  décodage), état résumé d'une session et de ses sous-agents, statut recalculé à chaque passage.
- `describe.ts` : libellés sûrs (jamais de commande complète, de chemin absolu, d'URL, de nom d'utilisateur).
- `index.ts` : configuration, découverte des sessions, envoi par paquets avec reprise.

Rien d'un message de l'utilisateur, d'un prompt de sous-agent ni d'un résultat d'outil n'est envoyé.
