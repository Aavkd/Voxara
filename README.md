# Voxara — compagnon IA vocal et agentique

Voxara est une application CLI TypeScript **local-first**. Elle réunit conversation texte ou vocale, mémoire durable, outils agentiques, délégation à des agents de code et contrôle assisté du navigateur ou du bureau Windows.

Le cœur conversationnel peut utiliser Google Gemini, GitHub Models ou Ollama. Les données locales — mémoire, espace de travail, tâches et journal de contrôle — restent sur la machine, sauf lorsqu’une demande est envoyée à un fournisseur cloud ou à un agent externe configuré.

> La pile vocale et le contrôle du bureau ciblent actuellement Windows. Le chat texte, l’évaluation, la mémoire et une partie de l’agent fonctionnent sans microphone.

## Capacités

- Chat texte avec streaming et conversation vocale en temps quasi réel.
- Voix locale : VAD adaptatif, détection de fin de tour, STT, TTS en flux et interruption naturelle (*barge-in*).
- Fournisseurs LLM interchangeables : Gemini, GitHub Models et Ollama.
- Mode agent avec calcul, fichiers confinés, heure, mémoire, contexte documentaire et vision d’écran.
- Mémoire longue durée locale en Markdown : faits, épisodes de session, consolidation et hygiène automatisées.
- Tâches longues déléguées en arrière-plan à Codex CLI ou Claude Code, avec suivi, livrables et garde-fous Git.
- Contrôle naturel du navigateur Chrome, du bureau Windows et des applications, avec règles de confiance, confirmations et journal d’audit.
- Pilote asynchrone pour les objectifs multi-étapes : il travaille en arrière-plan, peut être interrompu et rend la main dès que vous utilisez la souris ou le clavier.
- Benchmarks, comparaisons de modèles, tests RAG et scénarios agentiques.

## Vue d’ensemble

```text
Vous ── voix ou texte ──> Voxara ──> fournisseur LLM
                              │
                              ├── mémoire Markdown locale
                              ├── outils, documents et espace de travail
                              ├── tâches déléguées (Codex CLI / Claude Code)
                              └── contrôle de l’ordinateur
                                   ├── écran et UI Automation Windows
                                   └── extension Chrome locale
```

Les actions unitaires (lire une page, cliquer, ouvrir une application) sont exécutées pendant le tour de conversation. Les objectifs qui nécessitent plusieurs étapes passent par le pilote en arrière-plan : Voxara confirme immédiatement la prise en charge, puis annonce le résultat à une frontière de tour sûre.

## Prérequis

### Base

- Node.js 18 ou plus récent ;
- npm ;
- un fournisseur LLM configuré : Google Gemini, GitHub Models ou Ollama.

### Voix (facultatif)

- Windows ;
- FFmpeg disponible dans le `PATH` ;
- microphone et sortie audio ;
- Python 3.11 ou 3.12 pour faster-whisper ou Qwen3-TTS ;
- NVIDIA/CUDA pour la configuration GPU par défaut de faster-whisper, ou une configuration CPU adaptée.

### Délégation et contrôle (facultatifs)

- Codex CLI et/ou Claude Code installés et authentifiés pour la délégation ;
- Google Chrome et l’extension locale du projet pour contrôler les onglets ;
- Windows pour le contrôle du bureau via UI Automation.

## Démarrage rapide

```powershell
npm install
Copy-Item .env.example .env
```

Choisissez ensuite un fournisseur dans `.env`.

```env
# Google Gemini
LLMTEST_PROVIDER=google
GOOGLE_API_KEY=your_api_key
GOOGLE_MODEL=gemini-2.0-flash
```

```env
# GitHub Models
LLMTEST_PROVIDER=github
GITHUB_TOKEN=your_personal_access_token
GITHUB_MODEL=gpt-4o-mini
```

```env
# Ollama local
LLMTEST_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
```

Vérifiez la configuration, puis démarrez un chat :

```powershell
npm run dev -- config
npm run dev -- validate
npm run dev -- chat
```

Pendant le développement, utilisez `npm run dev -- <commande>`. Après compilation, utilisez `node dist/cli.js <commande>`.

```powershell
npm run build
node dist/cli.js agent-chat
```

## Conversations et outils

```powershell
# Chat texte
npm run dev -- chat

# Chat agentique avec une sélection d’outils et du contexte documentaire
npm run dev -- agent-chat --tools calculator,file_read,file_write --docs .\context.txt

# Espace de travail dédié à cette session
npm run dev -- agent-chat --sandbox .\WORKSPACE
```

Sans `--tools`, le mode `agent-chat` rend disponibles tous les outils intégrés. Pour restreindre une session, passez `--tools none` ou une liste séparée par des virgules.

| Famille | Outils |
| --- | --- |
| Utilitaires | `calculator`, `get_current_time` |
| Fichiers et mémoire | `file_read`, `file_write`, `memory_read`, `memory_note` |
| Délégation | `delegate_task`, `delegate_status`, `delegate_approve`, `delegate_cancel` |
| Vision et navigateur | `screen_view`, `browser_read`, `browser_act` |
| Bureau Windows | `desktop_read`, `desktop_act`, `control_code` |
| Pilote asynchrone | `pilot_task`, `pilot_status`, `pilot_approve`, `pilot_cancel` |

Les fichiers manipulés par l’agent sont limités à `LLMTEST_WORKSPACE_DIR` (par défaut `~/.llmtest/workspace`) ou au dossier donné par `--sandbox`.

## Conversation vocale

La boucle vocale écoute, transcrit localement, sollicite le modèle et lit sa réponse dès que des segments sont prêts. Reprendre la parole interrompt la synthèse en cours lorsque `VOICE_BARGE_IN=true`.

La configuration par défaut utilise faster-whisper pour le STT et Piper pour le TTS.

```powershell
# Installer les moteurs locaux
npm run stt:setup
npm run tts:piper:setup

# Dans un autre terminal, démarrer le serveur de transcription
npm run stt:start

# Diagnostiquer puis démarrer
npm run dev -- voice-check
npm run dev -- voice-chat
```

Pour activer les outils en conversation vocale :

```powershell
npm run dev -- voice-chat --agent --tools all --sandbox .\WORKSPACE
```

Autres moteurs de synthèse disponibles : Supertonic et Qwen3-TTS. Le script `npm run tts:setup` lance le service Python Qwen3-TTS ; `npm run tts:vllm` démarre sa variante vLLM/Docker. Comparez les voix disponibles avec :

```powershell
npm run tts:supertonic:setup
npm run dev -- tts-compare "Bonjour, ceci est un test."
```

Exemple de réglage vocal minimal :

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

Les transcriptions, événements et mesures de latence sont enregistrés dans `~/.llmtest/voice-sessions/`.

## Vision et contrôle de l’ordinateur

En mode agent, Voxara peut capturer l’écran à la demande, lire les onglets du vrai navigateur Chrome, agir sur une page, ou interagir avec les fenêtres Windows. Le modèle choisit des intentions typées ; les références d’éléments sont éphémères et doivent être relues avant une action.

Les captures peuvent être envoyées au fournisseur de vision indiqué par `CONTROL_VISION_PROVIDER`. Avec Gemini, l’image est prise en charge directement ; avec un modèle texte local, le fournisseur de vision peut rester Google.

```env
CONTROL_VISION_PROVIDER=google
CONTROL_SCREENSHOT_MAX_EDGE=1568
CONTROL_TRUST_LEVEL=session_grant
CONTROL_BRIDGE_PORT=7863
CONTROL_MAX_SNAPSHOT_CHARS=8000
```

Les niveaux de confiance sont :

- `confirm_each` : confirmation pour chaque action ;
- `session_grant` : valeur par défaut, une confirmation pour les actions couvertes de la session ;
- `auto` : exécution sans demande de confirmation pour les actions couvertes, toujours journalisée.

Les actions sensibles — fermeture de fenêtre ou d’onglet, soumission de formulaire et raccourcis clavier risqués — demandent une confirmation explicite. `control_code` est le repli PowerShell ou JavaScript pour ce qu’aucune intention typée ne peut exprimer ; il demande aussi une explication et une confirmation, sauf si `CONTROL_CODE_AUTO=true` est explicitement configuré. Le journal est conservé sous `~/.llmtest/state/control/`.

### Extension Chrome

L’extension MV3 dans [`extension/`](extension/) se connecte uniquement au serveur local de Voxara, avec un jeton d’appairage. Pour l’installer :

```powershell
npm run dev -- control doctor
```

Copiez le jeton affiché, ouvrez `chrome://extensions`, activez le mode développeur, puis chargez le dossier `extension/` non empaqueté. Collez enfin le jeton dans les options de l’extension. Lancez ensuite une session `agent-chat` ou `voice-chat --agent` : le bridge démarre avec la session.

Le guide complet, incluant les actions prises en charge et le dépannage, est disponible dans [extension/README.md](extension/README.md).

### Bureau Windows et pilote

`desktop_read` observe les fenêtres et leurs éléments UI Automation ; `desktop_act` ouvre, focalise, ferme, active un élément, renseigne un champ ou envoie une saisie. Les demandes multi-étapes sont confiées à `pilot_task` : la conversation reste disponible pendant l’exécution. Dites « stop » ou « annule » pour l’interrompre ; une interaction souris/clavier de votre part suspend le pilote et vous rend la main.

Le contrôle du bureau est Windows uniquement. Vérifiez les canaux navigateur et bureau avec `npm run dev -- control doctor`.

## Délégation à Codex ou Claude Code

Voxara peut confier une tâche longue et bornée à un agent installé : recherche approfondie, analyse de dépôt, débogage, code ou production de documents. Une délégation renvoie tout de suite un identifiant de tâche ; le résultat et les livrables sont annoncés quand ils sont prêts.

Activez la délégation explicitement :

```env
DELEGATION_ENABLED=true
DELEGATION_DEFAULT_BACKEND=auto
DELEGATION_ALLOWED_ROOTS=C:\Users\you\.llmtest\workspace

# Facultatif si les exécutables ne sont pas dans PATH
# CODEX_CLI_PATH=
# CLAUDE_CLI_PATH=
```

```powershell
npm run dev -- delegates doctor
npm run dev -- delegates list
npm run dev -- delegates show <task-id>
npm run dev -- delegates cancel <task-id>
```

| Besoin | Comportement |
| --- | --- |
| Recherche ou analyse | Tâche `read_only` exécutée en arrière-plan, avec limites de durée et de sortie. |
| Livrable dans l’espace Voxara | Écriture directe dans une racine appartenant à l’agent, avec points de contrôle Git et chemins de livrables réels. |
| Modification d’un autre dépôt Git | Travail dans un worktree isolé ; un diff/patch est remis pour revue avant toute application. |
| Action sur des données utilisateur ou lancement de programme | Manifeste et plan décrivant les effets, puis application seulement après accord explicite. |

Les racines autorisées, les programmes exécutables et les limites sont configurables dans `.env`. N’autorisez pas un shell généraliste dans `DELEGATION_ALLOWED_PROGRAMS` sans mesurer qu’il contourne pratiquement toute granularité de l’allowlist.

## Mémoire durable

La mémoire est locale, lisible et modifiable en Markdown dans `~/.llmtest/memory/` (ou `LLMTEST_MEMORY_DIR`) :

```text
MEMORY.md       index chargé dans les conversations
facts/          faits durables sur l’utilisateur
episodes/       synthèses datées des sessions
inbox/          notes à consolider
archive/        éléments retirés de l’index, conservés sans suppression brutale
```

```powershell
npm run dev -- memory list
npm run dev -- memory show <id>
npm run dev -- memory edit <id>
npm run dev -- memory consolidate --deep
npm run dev -- memory forget <id>
```

Après une conversation, un agent de mémoire peut produire un épisode, extraire des faits durables, fusionner les doublons, résoudre des contradictions et archiver les éléments retirés. Consultez [l’architecture mémoire](docs/memory-architecture-spec.md) pour le format et les règles de rétention.

## Commandes CLI

| Commande | Rôle |
| --- | --- |
| `config` | Affiche la configuration résolue et sa provenance. |
| `validate` | Vérifie les identifiants et le modèle actif. |
| `models` | Liste les modèles du fournisseur configuré. |
| `prompt <texte>` | Envoie un prompt unique, avec image ou prompt système facultatif. |
| `chat` | Démarre une conversation textuelle avec streaming. |
| `agent-chat` | Démarre une conversation avec outils et contexte documentaire. |
| `voice-check` | Diagnostique microphone, lecture, VAD, STT et TTS. |
| `voice-chat` | Démarre la conversation vocale temps réel. |
| `tts-compare [texte]` | Compare les moteurs et voix TTS. |
| `control doctor` | Vérifie la configuration, l’appairage Chrome et l’hôte de bureau Windows. |
| `memory …` | Gère la mémoire durable. |
| `delegates …` | Diagnostique et gère les tâches déléguées. |
| `run <fichier>` | Exécute une suite de benchmarks. |
| `compare <fichier> --models <a,b>` | Compare une suite entre plusieurs modèles. |
| `convo <fichier>` | Exécute un scénario conversationnel multi-tours. |
| `agent <fichier>` | Exécute des tests d’outils et d’assertions de fichiers. |
| `rag <fichier>` | Exécute une suite RAG fondée sur des documents. |
| `prompts check` | Valide les prompts modifiables. |
| `shell` | Lance le REPL interactif. |

Utilisez `npm run dev -- <commande> --help` pour les options détaillées.

## Prompts et évaluation

Les prompts de comportement sont chargés depuis `prompts/` à l’exécution. Personnalisez notamment `persona.md`, `agent.md`, `voice-style.md` et `rag.md`, puis validez-les :

```powershell
npm run dev -- prompts check --debug
```

Les exemples de benchmarks, scénarios d’agents et suites RAG sont dans `tests/suites/`.

```powershell
npm run dev -- prompt "Résume les avantages de l’inférence locale" --temperature 0.2
npm run dev -- prompt "Décris cette image" --image .\photo.png
npm run dev -- run .\tests\suites\smoke.json
npm run dev -- compare .\tests\suites\smoke.json --models gemini-2.0-flash,gemini-2.5-flash
```

## Configuration

Les valeurs sont résolues dans cet ordre de priorité :

1. options de ligne de commande ;
2. variables d’environnement déjà présentes ;
3. `.env` à la racine du projet ;
4. `~/.llmtest/.env` ;
5. valeurs par défaut.

Ne versionnez jamais `.env`. [`.env.example`](.env.example) recense les réglages disponibles : fournisseurs, voix, mémoire, contrôle, délégation, limites et répertoires d’état.

## Développement

```powershell
npm run build
npm test
npm run dev -- --help
```

Les tests isolent les frontières externes (LLM, audio, agents, navigateur et hôte de bureau) : ils ne nécessitent ni clé API, ni microphone, ni GPU.

## Structure du projet

```text
src/
  audio/        Microphone, lecture, VAD, tours et interruptions
  commands/     Commandes CLI
  control/      Vision, politique, journal, browser bridge, bureau et pilote
  delegation/   Politique, exécution supervisée, backends Codex/Claude, worktrees
  engine/       Boucle agent, tâches et livraisons asynchrones
  memory/       Mémoire Markdown, consolidation et hygiène
  providers/    Gemini, GitHub Models, Ollama et outils
  speech/       Fournisseurs STT et TTS interchangeables
  rag/          Chargement documentaire, contexte et fidélité
  prompts/      Chargement et validation des prompts
docs/           Architecture, spécifications de phases et guides
extension/      Extension Chrome MV3 du Browser Bridge
prompts/        Prompts modifiables à l’exécution
tests/          Tests, fixtures et suites d’évaluation
tools/          Scripts et binaires des services vocaux
```

## Dépannage

| Problème | À vérifier |
| --- | --- |
| Clé API absente | Vérifiez `LLMTEST_PROVIDER` et la clé associée, puis lancez `config` et `validate`. |
| Ollama inaccessible | Vérifiez que le serveur est démarré et que le modèle est installé. |
| Microphone absent | Vérifiez FFmpeg et lancez `voice-check --device "Nom exact"`. |
| Pas de transcription | Démarrez faster-whisper ou vérifiez la configuration whisper.cpp. |
| Pas de synthèse vocale | Vérifiez le fournisseur TTS et ses chemins de ressources. |
| Interruptions intempestives | Utilisez un casque, ajustez `VOICE_VAD_THRESHOLD` ou calibrez avec `voice-check`. |
| Extension Chrome non connectée | Lancez `control doctor`, puis vérifiez le port et le jeton des options de l’extension. |
| Bureau Windows indisponible | Lancez `control doctor` depuis Windows afin de diagnostiquer l’hôte UI Automation. |
| Délégation indisponible | Lancez `delegates doctor`, puis vérifiez l’activation, les racines et Codex/Claude. |
| Action refusée | Voxara attend peut-être votre confirmation ; les actions sensibles ne sont jamais appliquées sans accord explicite. |

Pour approfondir : [guide audio rapide](docs/guide-rapide-utilisation-audio.md), [architecture vocale](docs/audio-conversation-spec.md), [contrôle de l’ordinateur](docs/phase-c3-computer-control.md), [délégation](docs/phase-c2-coding-agent-delegation.md) et [feuille de route](docs/companion-roadmap.md).
