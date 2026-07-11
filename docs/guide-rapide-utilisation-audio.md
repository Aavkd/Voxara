# Guide rapide: utiliser la version audio

Ce guide resume le flux actuel apres les phases audio 1 a 7: diagnostic, conversation vocale temps reel, interruption, style de voix, changement de modele et mode agent avec outils.

## 1. Preparer l'environnement

Depuis la racine du projet:

```bash
npm install
npm run build
```

Verifiez ensuite le fichier `.env`. Les reglages importants sont:

```env
LLMTEST_PROVIDER=google
GOOGLE_API_KEY=...
GOOGLE_MODEL=gemini-2.0-flash

VOICE_LANGUAGE=fr
VOICE_STT_BINARY_PATH=whisper-cli
VOICE_STT_MODEL_PATH=./models/whisper/ggml-large-v3-turbo.bin
VOICE_TTS_PROVIDER=piper
PIPER_BINARY_PATH=./tools/piper/bin/piper.exe
PIPER_VOICE=./models/piper/fr_FR-siwis-medium.onnx
VOICE_BARGE_IN=true
```

Pour une session en anglais, passez `VOICE_LANGUAGE=en`. Pour une session locale via Ollama, utilisez `LLMTEST_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://localhost:11434` et `OLLAMA_MODEL=qwen3:8b`.

## 2. Installer le TTS CPU

Le TTS ne consomme pas de VRAM et ne demande pas de serveur. Installez Piper et/ou Supertonic une fois :

```bash
npm run tts:piper:setup
npm run tts:supertonic:setup
```

Piper propose `fr_FR-siwis-medium` (feminine), `fr_FR-upmc-medium` (deux locuteurs) et `fr_FR-tom-medium` (masculine). Supertonic propose notamment les presets `F1` et `M1`. Comparez-les avec :

```bash
npm run dev -- tts-compare
```

## 3. Lancer les services locaux

La reconnaissance vocale utilise le binaire configure par `VOICE_STT_BINARY_PATH` avec le modele configure par `VOICE_STT_MODEL_PATH`.

La synthese vocale normale est locale (Piper CLI ou Supertonic ONNX). Qwen3-TTS reste une option legacy qui attend un service local sur `VOICE_TTS_BASE_URL`. L'adaptateur essaie d'abord:

```text
POST /v1/audio/speech
```

puis, si cet endpoint n'existe pas:

```text
POST /synthesize
```

Le service doit renvoyer soit un WAV, soit un JSON contenant `audio_base64`, `audioBase64` ou `audio`.

## 4. Faire un diagnostic avant de parler

Lancez:

```bash
npm run dev -- voice-check
```

Ce diagnostic verifie la configuration LLM, les prompts, Whisper/STT, Qwen3-TTS, le micro, les haut-parleurs, la detection de voix, la transcription et la lecture audio.

Commandes utiles:

```bash
npm run dev -- voice-check --duration 3
npm run dev -- voice-check --device "Nom du micro"
npm run dev -- voice-check --skip-record
npm run dev -- voice-check --skip-playback
npm run dev -- voice-check --skip-tts
npm run dev -- voice-check --keep-recording
```

Si le diagnostic ne detecte pas votre parole, baissez legerement `VOICE_VAD_THRESHOLD` dans `.env`, par exemple `0.012`. Si l'assistant s'interrompt trop facilement, augmentez-le, par exemple `0.025`.

## 5. Lancer une conversation vocale simple

```bash
npm run dev -- voice-chat
```

Le mode simple est le plus fluide: vous parlez, Whisper transcrit, le modele repond en streaming, Qwen3-TTS commence a parler des que possible.

Pendant la session, l'interface affiche les etats:

```text
listening -> transcribing -> thinking -> speaking
```

Vous pouvez parler pendant que l'assistant repond. Si `VOICE_BARGE_IN=true`, l'audio est coupe et votre nouvelle phrase devient le tour suivant.

## 6. Commandes disponibles pendant la session

Tapez ces commandes directement dans le terminal:

| Commande | Effet |
| --- | --- |
| `/exit` | Quitte la session proprement. |
| `/mute` | Desactive temporairement l'ecoute micro. |
| `/unmute` | Reactive l'ecoute micro. |
| `/interrupt` | Coupe manuellement la reponse audio en cours. |
| `/provider google` | Passe sur Gemini. |
| `/provider github` | Passe sur GitHub Models. |
| `/provider ollama` | Passe sur Ollama local. |
| `/model <nom>` | Change le modele pour la suite de la session. |
| `/tts <piper\|supertonic\|qwen3>` | Change le moteur TTS sans redemarrer. |
| `/tts-voice <nom>` | Change la voix du moteur TTS actif. |
| `/reload-prompts` | Recharge les prompts sans redemarrer. |
| `/voice-style` | Affiche le prompt de style vocal actuel. |
| `/debug on` | Active l'affichage debug. |
| `/debug off` | Desactive l'affichage debug. |

## 7. Modifier la personnalite et la voix

Les prompts sont dans `prompts/` et sont lus au runtime.

Les plus importants pour l'audio:

| Fichier | Role |
| --- | --- |
| `prompts/persona.md` | Personnalite et comportement general de l'assistant. |
| `prompts/voice-style.md` | Style de voix envoye a Qwen3-TTS. |
| `prompts/agent.md` | Regles du mode agent et des outils. |

Apres modification:

```bash
npm run dev -- prompts check
```

Dans une session deja ouverte, utilisez:

```text
/reload-prompts
```

## 8. Utiliser le mode agent vocal

Le mode agent permet a l'assistant d'utiliser les outils locaux avant de donner une reponse finale vocale.

```bash
npm run dev -- voice-chat --agent
```

Par defaut, tous les outils integres sont actifs:

```text
calculator, file_read, file_write, get_current_time
```

Exemples:

```bash
npm run dev -- voice-chat --agent --tools calculator,file_read --sandbox ./sandbox
npm run dev -- voice-chat --agent --tools none
npm run dev -- voice-chat --agent --tools all --agent-max-steps 10
```

En mode agent, le terminal affiche l'activite des outils, mais seule la reponse finale est lue a voix haute. C'est utile pour demander par exemple: "Lis le fichier notes.txt dans le sandbox et resume-le", ou "Calcule le total de ces montants".

Pendant la session agent:

| Commande | Effet |
| --- | --- |
| `/tools` | Liste les outils actifs et disponibles. |
| `/tools all` | Active tous les outils. |
| `/tools none` | Desactive les outils. |
| `/tools calculator,file_read` | Active seulement les outils listes. |

## 9. Logs et reprise de debug

Chaque session vocale cree un log JSONL de transcription. Le chemin est affiche au demarrage:

```text
Transcript log: ...
```

Le log contient les transcripts partiels, transcripts finaux, commandes, chunks assistant, interruptions, appels outils et metriques de latence.

Les metriques affichees apres chaque tour incluent notamment:

| Metrique | Signification |
| --- | --- |
| `LLM first token` | Temps avant le premier token du modele. |
| `TTS first audio` | Temps avant le premier audio genere. |
| `TTS chunks` | Temps de synthese de chaque chunk audio. |
| `stop` | Temps d'arret audio apres interruption. |
| `turn` | Duree totale du tour. |

## 10. Recette de test recommandee

1. Lancez `npm run dev -- voice-check`.
2. Parlez une phrase courte en francais.
3. Verifiez que le diagnostic affiche un transcript STT et joue une phrase TTS.
4. Lancez `npm run dev -- voice-chat`.
5. Posez une question courte.
6. Interrompez l'assistant pendant qu'il parle.
7. Lancez `npm run dev -- voice-chat --agent --tools calculator`.
8. Demandez un calcul simple.
9. Modifiez `prompts/voice-style.md`, puis tapez `/reload-prompts`.

## 11. Depannage rapide

| Symptome | A verifier |
| --- | --- |
| Pas de micro detecte | Essayez `--device "Nom exact"` avec le nom affiche par `voice-check`. |
| Pas de transcription | Verifiez `VOICE_STT_BINARY_PATH`, `VOICE_STT_MODEL_PATH` et `VOICE_LANGUAGE`. |
| Pas de voix assistant | Lancez le script setup du moteur choisi et verifiez `PIPER_VOICE` ou `SUPERTONIC_ASSETS_DIR`. |
| Reponses trop lentes | Essayez un modele LLM plus rapide, un TTS plus leger, ou Ollama local si disponible. |
| Interruptions involontaires | Augmentez `VOICE_VAD_THRESHOLD` ou utilisez un casque. |
| L'agent ne peut pas utiliser les outils | Utilisez un provider compatible tool-use; sinon restez en mode vocal simple. |
