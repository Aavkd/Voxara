# Voxara — compagnon IA vocal et agentique

Voxara est une application CLI TypeScript qui fournit un compagnon IA **local-first** : conversation texte ou voix, mémoire durable, outils, et délégation de tâches complexes à **Codex CLI** ou **Claude Code**. Les agents travaillent en arrière-plan : vous continuez à parler avec Voxara pendant qu’ils recherchent, analysent ou produisent des fichiers.

> La capture vocale cible actuellement Windows (FFmpeg / DirectShow). Les fonctionnalités texte, mémoire, délégation et évaluation n’exigent pas de microphone.

## Fonctionnalités

- Conversation textuelle avec streaming et conversation vocale quasi temps réel.
- Chaîne vocale locale : VAD, détection de fin de tour, STT, TTS en flux et interruption naturelle (*barge-in*).
- Google Gemini, GitHub Models ou Ollama local.
- Conversations agentiques avec calcul, fichiers, heure, mémoire et documents de contexte.
- Mémoire longue durée locale, éditable en Markdown, consolidée et nettoyée automatiquement.
- Délégation asynchrone à Codex CLI ou Claude Code pour la recherche web approfondie, l’analyse de dépôt, le débogage et le code.
- Écritures de code contrôlées par Git, worktrees isolés et plans d’actions externes soumis à approbation explicite.
- Benchmarks, comparaisons de modèles, RAG, tests d’outils et scénarios multi-tours.

## Comment cela fonctionne

```text
Vous ── voix ou texte ──> Voxara ──> modèle de langage
                              │
                              ├── mémoire Markdown locale
                              ├── outils et espace de travail
                              └── tâches longues en arrière-plan
                                   ├── Codex CLI
                                   └── Claude Code
```

Une délégation renvoie immédiatement un identifiant de tâche. Voxara suit l’exécution en arrière-plan et remet le résultat quand il est prêt, avec les chemins réels des livrables produits.

## Prérequis

### Application

- Node.js 18 ou plus récent ;
- npm ;
- un fournisseur LLM : Google Gemini, GitHub Models ou Ollama.

### Voix (facultatif)

- Windows ;
- FFmpeg dans le `PATH` ;
- microphone et sortie audio ;
- Python 3.11 ou 3.12 pour faster-whisper ou Qwen3-TTS ;
- NVIDIA/CUDA pour la configuration GPU faster-whisper par défaut, ou une configuration CPU adaptée.

### Délégation (facultatif)

- Codex CLI et/ou Claude Code installé et authentifié ;
- délégation activée dans `.env`.

## Démarrage rapide

```powershell
npm install
Copy-Item .env.example .env
```

Configurez un fournisseur dans `.env`.

### Google Gemini

```env
LLMTEST_PROVIDER=google
GOOGLE_API_KEY=your_api_key
GOOGLE_MODEL=gemini-2.0-flash
```

### GitHub Models

```env
LLMTEST_PROVIDER=github
GITHUB_TOKEN=your_personal_access_token
GITHUB_MODEL=gpt-4o-mini
```

### Ollama

```env
LLMTEST_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
```

Vérifiez la configuration, puis démarrez une conversation :

```powershell
npm run dev -- config
npm run dev -- validate
npm run dev -- chat
```

Pour compiler :

```powershell
npm run build
node dist/cli.js chat
```

Pendant le développement, utilisez `npm run dev -- <commande>`. Après compilation, utilisez `node dist/cli.js <commande>`.

## Conversations et outils

```powershell
# Conversation texte
npm run dev -- chat

# Conversation agentique avec fichiers et documents
npm run dev -- agent-chat --tools calculator,file_read,file_write --docs .\context.txt

# Espace de travail dédié à une session
npm run dev -- agent-chat --sandbox .\WORKSPACE
```

Les outils intégrés sont `calculator`, `file_read`, `file_write`, `get_current_time`, `memory_read` et `memory_note`. Les outils de fichiers sont limités à `LLMTEST_WORKSPACE_DIR` (par défaut `~/.llmtest/workspace`) ou au répertoire passé avec `--sandbox`.

## Conversation vocale

La boucle vocale écoute, transcrit localement, sollicite le modèle, puis lit la réponse au fil de sa génération. Si vous recommencez à parler, l’assistant peut interrompre sa réponse.

La configuration standard utilise faster-whisper pour le STT et Piper pour le TTS.

```powershell
# Installer les moteurs locaux
npm run stt:setup
npm run tts:piper:setup

# Dans un autre terminal
npm run stt:start

# Diagnostiquer et démarrer la conversation
npm run dev -- voice-check
npm run dev -- voice-chat
```

Pour utiliser les outils — dont la délégation — dans la conversation vocale :

```powershell
npm run dev -- voice-chat --agent --tools all --sandbox .\WORKSPACE
```

Autres moteurs TTS disponibles :

```powershell
npm run tts:supertonic:setup
npm run dev -- tts-compare "Bonjour, ceci est un test."
```

Exemple de configuration :

```env
VOICE_LANGUAGE=fr
VOICE_STT_PROVIDER=faster-whisper
VOICE_STT_BASE_URL=http://localhost:7862
VOICE_TTS_PROVIDER=piper
PIPER_BINARY_PATH=./tools/piper/bin/piper.exe
PIPER_VOICE=./models/piper/fr_FR-siwis-medium.onnx
VOICE_BARGE_IN=true
```

| Commande pendant `voice-chat` | Effet |
| --- | --- |
| `/exit` | Termine la session. |
| `/mute`, `/unmute` | Coupe ou réactive le microphone. |
| `/interrupt` | Arrête la réponse parlée. |
| `/provider <google\|github\|ollama>` | Change le fournisseur. |
| `/model <nom>` | Change le modèle actif. |
| `/tts <piper\|supertonic\|qwen3>` | Change le moteur de synthèse. |
| `/tts-voice <nom>` | Change la voix. |
| `/reload-prompts` | Recharge les prompts. |
| `/tools all\|none\|<a,b>` | Modifie les outils en mode agent. |
| `/memory` | Affiche l’index de mémoire. |

Les événements et mesures de latence sont enregistrés dans `~/.llmtest/voice-sessions/`.

## Délégation à Codex ou Claude Code

Voxara peut confier à un agent installé une tâche longue et bornée : recherche web approfondie, inspection de dépôt, analyse de tests, débogage, écriture de code ou création de livrables dans l’espace de travail.

Activez cette capacité explicitement :

```env
DELEGATION_ENABLED=true
DELEGATION_DEFAULT_BACKEND=auto
DELEGATION_ALLOWED_ROOTS=C:\Users\you\.llmtest\workspace

# Facultatif si les exécutables ne sont pas dans PATH
# CODEX_CLI_PATH=
# CLAUDE_CLI_PATH=
```

Puis vérifiez votre installation et gérez les tâches :

```powershell
npm run dev -- delegates doctor
npm run dev -- delegates list
npm run dev -- delegates show <task-id>
npm run dev -- delegates cancel <task-id>
```

| Type de besoin | Comportement |
| --- | --- |
| Recherche ou analyse | Tâche en `read_only`, exécutée en arrière-plan avec limites de durée et de sortie. |
| Écrire dans l’espace Voxara | Écriture directe avec checkpoints Git et liste des chemins effectivement produits. |
| Modifier un autre dépôt Git | Travail dans un worktree isolé ; un diff/patch est fourni pour revue, sans modifier l’arbre principal. |
| Agir sur des fichiers utilisateur ou lancer un programme | Préparation d’un manifeste, explication du plan, puis exécution seulement après accord explicite. |

Les tâches sont confinées aux racines déclarées, annulables et supervisées. Les programmes exécutables par une action externe doivent être explicitement autorisés avec `DELEGATION_ALLOWED_PROGRAMS`. Évitez d’y autoriser un shell généraliste, sauf choix délibéré.

## Mémoire durable

La mémoire est locale, lisible et modifiable en Markdown dans `~/.llmtest/memory/` (ou `LLMTEST_MEMORY_DIR`) :

```text
MEMORY.md       index chargé dans les conversations
facts/          faits durables sur l’utilisateur
episodes/       synthèses datées des sessions
inbox/          notes à consolider
archive/        contenu retiré de l’index, sans suppression brutale
```

```powershell
npm run dev -- memory list
npm run dev -- memory show <id>
npm run dev -- memory edit <id>
npm run dev -- memory consolidate --deep
npm run dev -- memory forget <id>
```

Après une conversation, un agent de mémoire peut créer un épisode, extraire des faits durables et effectuer l’hygiène : fusion de doublons, résolution des contradictions, compactage des anciens épisodes et archivage des éléments retirés. Voir [l’architecture mémoire](docs/memory-architecture-spec.md).

## Commandes CLI

| Commande | Rôle |
| --- | --- |
| `config` | Affiche la configuration résolue. |
| `validate` | Vérifie les identifiants et le modèle actif. |
| `models` | Liste les modèles disponibles. |
| `prompt <texte>` | Envoie un prompt unique, avec image ou prompt système facultatif. |
| `chat` | Conversation textuelle persistante. |
| `agent-chat` | Conversation avec outils et contexte documentaire. |
| `voice-check` | Diagnostic microphone, lecture, VAD, STT et TTS. |
| `voice-chat` | Conversation vocale temps réel. |
| `tts-compare [texte]` | Compare les moteurs et voix TTS. |
| `memory …` | Gestion de la mémoire durable. |
| `delegates …` | Diagnostic et gestion des tâches déléguées. |
| `run <fichier>` | Exécute une suite de benchmarks. |
| `compare <fichier> --models <a,b>` | Compare une suite entre plusieurs modèles. |
| `convo <fichier>` | Exécute un scénario conversationnel multi-tours. |
| `agent <fichier>` | Exécute des tests d’outils et d’assertions de fichiers. |
| `rag <fichier>` | Exécute des tests RAG fondés sur des documents. |
| `prompts check` | Valide les prompts modifiables. |
| `shell` | Lance le REPL interactif. |

Utilisez `npm run dev -- <commande> --help` pour les options détaillées.

## Prompts et évaluation

Les prompts de comportement sont chargés depuis `prompts/` à l’exécution : personnalisez notamment `persona.md`, `agent.md`, `voice-style.md` et `rag.md`, puis validez-les :

```powershell
npm run dev -- prompts check --debug
```

Les exemples de benchmarks, scénarios d’agents et suites RAG se trouvent dans `tests/suites/`.

```powershell
npm run dev -- prompt "Résume les avantages de l’inférence locale" --temperature 0.2
npm run dev -- prompt "Décris cette image" --image .\photo.png
npm run dev -- run .\tests\suites\smoke.json
npm run dev -- compare .\tests\suites\smoke.json --models gemini-2.0-flash,gemini-2.5-flash
```

## Configuration

La priorité de configuration est la suivante :

1. options de ligne de commande ;
2. variables d’environnement déjà présentes ;
3. `.env` à la racine du projet ;
4. `~/.llmtest/.env` ;
5. valeurs par défaut.

Ne versionnez pas `.env`. Consultez [`.env.example`](.env.example) pour l’ensemble des réglages de fournisseurs, voix, mémoire, délégation, limites et espaces de travail.

## Développement

```powershell
npm run build
npm test
npm run dev -- --help
```

Les tests isolent les frontières externes (LLM, audio et moteurs de parole) : ils ne requièrent ni clé API, ni microphone, ni GPU.

## Structure

```text
src/
  audio/        Microphone, lecture, VAD, tours et interruptions
  commands/     Commandes CLI
  delegation/   Politique, exécution supervisée, backends Codex/Claude, worktrees
  engine/       Boucle agent, tâches et livraisons
  memory/       Mémoire Markdown, consolidation et hygiène
  providers/    Gemini, GitHub Models, Ollama et outils
  speech/       Fournisseurs STT et TTS interchangeables
  rag/          Chargement documentaire, contexte et fidélité
  prompts/      Chargement et validation des prompts
docs/           Architecture, phases et guides
prompts/        Prompts modifiables à l’exécution
tests/          Tests, fixtures et suites d’évaluation
tools/          Scripts d’installation des services vocaux
```

## Dépannage

| Problème | À vérifier |
| --- | --- |
| Clé API absente | Vérifiez `LLMTEST_PROVIDER` et la clé associée, puis lancez `config` et `validate`. |
| Ollama inaccessible | Vérifiez que le serveur est démarré et que le modèle est installé. |
| Microphone absent | Vérifiez FFmpeg et lancez `voice-check --device "Nom exact"`. |
| Pas de transcription | Démarrez faster-whisper ou vérifiez whisper.cpp. |
| Pas de synthèse vocale | Vérifiez le fournisseur TTS et ses chemins de ressources. |
| Interruptions intempestives | Utilisez un casque, ajustez `VOICE_VAD_THRESHOLD` ou calibrez avec `voice-check`. |
| Délégation indisponible | Lancez `delegates doctor`, puis vérifiez l’activation, les racines et Codex/Claude. |
| Action externe non exécutée | Le plan doit avoir été présenté puis explicitement approuvé. |

Pour aller plus loin : [guide audio rapide](docs/guide-rapide-utilisation-audio.md), [architecture vocale](docs/audio-conversation-spec.md), [délégation d’agents](docs/phase-c2-coding-agent-delegation.md) et [feuille de route](docs/companion-roadmap.md).
