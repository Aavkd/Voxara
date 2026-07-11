# Phase 8 — TTS temps réel : Piper + Supertonic (in-process, CPU)

> Plan d'implémentation destiné à un agent. Ne pas exécuter aveuglément : chaque étape
> se termine par une vérification. Langue de travail du code : anglais (conventions du repo).

## 1. Contexte et objectif

L'audit du 2026-07-10 (session voice-chat en conditions réelles) a établi que le chemin
TTS actuel (Qwen3-TTS 1.7B VoiceDesign via vLLM-Omni Docker, port 8091) est inutilisable
pour la conversation temps réel :

- **Troncature** : le talker vLLM émet exactement 16 tokens codec (~1,2 s d'audio) puis
  EOS, quel que soit le texte (reproduit avec des textes de 72/150/181 caractères,
  réponse de 57 644 octets identique à l'octet près). Bug du serving vllm-omni v0.24.0,
  pas du client Node.
- **Latence** : TTFT de 10 à 19 s par requête (paging VRAM WDDM/WSL2, GPU saturé à
  15,9/16,4 Go par les apps desktop + les deux serveurs GPU).

**Objectif de la phase** : premier audio TTS < 800 ms après le premier token LLM,
tour complet < 3 s, zéro VRAM consommée par le TTS. Deux moteurs CPU installés et
comparables à chaud ; le défaut sera choisi après un A/B d'écoute par l'utilisateur.

## 2. Décisions actées (avec l'utilisateur, 2026-07-10)

| Décision | Choix |
|---|---|
| Moteur par défaut | À décider **après** l'A/B d'écoute (étape 5) |
| Intégration | **In-process dans Node** — pas de sidecar HTTP, pas de Python |
| Qwen3-TTS / vLLM | **Conservé en option** dans le code ; conteneur Docker arrêté par défaut |
| Voix françaises | Installer féminines **et** masculines pour les deux moteurs, comparer |

## 3. Moteurs cibles

### Piper
- Repo maintenu : `OHF-voice/piper1-gpl` (successeur de `rhasspy/piper`). Binaire Windows
  autonome (embarque espeak-ng) dans les releases.
- Voix FR (ONNX, sur HuggingFace `rhasspy/piper-voices`, chemin `fr/fr_FR/...`) :
  `fr_FR-siwis-medium` (féminine), `fr_FR-upmc-medium` (2 locuteurs : jessica/pierre),
  `fr_FR-tom-medium` (masculine). Chaque voix = un `.onnx` + un `.onnx.json`.
- Sortie : PCM 16-bit mono 22 050 Hz. RTF CPU attendu ≪ 0,1.
- **Licence : GPL-3.0 (phonémiseur espeak-ng)** → intégration par **spawn du CLI en
  process séparé uniquement** (pas de linkage, pas de binding in-process). C'est le seul
  moteur "in-process" par exception : le provider Node pilote un exécutable externe.

### Supertonic 3
- Repo : `supertone-inc/supertonic`. Modèle 99M params, ONNX Runtime, **31 langues dont
  le français** (`fr`), sortie WAV 44,1 kHz 16-bit. CPU suffisant (RTF 0,3 sur Raspberry
  Pi → bien plus rapide sur cette machine). Code MIT, poids OpenRAIL-M.
- Poids : `git clone https://huggingface.co/Supertone/supertonic-3` (nécessite git-lfs).
- SDK Node.js officiel dans le repo (`nodejs/`), basé sur `onnxruntime-node`. Voix =
  presets de style (vecteurs de style féminins/masculins fournis dans les assets).

## 4. État actuel du code (points d'ancrage)

- Interface provider : `src/speech/tts/ITTSProvider.ts` (`checkSetup`, `synthesize`,
  `synthesizeChunks`) — **ne pas changer l'interface**, tout le reste du pipeline
  (chunker, playback queue, barge-in) en dépend et fonctionne.
- Provider existant : `src/speech/tts/qwen3Tts.ts` (sert de modèle : AsyncEventQueue,
  gestion signal/timeout, tests miroirs dans `tests/`).
- Factory : `src/speech/tts/factory.ts` (`createTTSProvider(voice)`), types dans
  `src/speech/tts/types.ts`, config dans `src/config/loader.ts` (`VOICE_TTS_*`).
- Pipeline voix : `src/commands/voiceChat.ts` — `StreamingTextChunker`
  (minChars 70 / maxChars 260), `startVoiceAssistantTurn`, metrics.
- Lecture audio : `src/audio/player.ts` — `SystemAudioOutput` spawn **un PowerShell
  `System.Media.SoundPlayer` par chunk** (~300-500 ms de surcoût par chunk).
- Formats audio : `src/audio/wav.ts` (`decodePcm16Wav`, `encodePcm16Wav`,
  `PCM16_MONO_16KHZ`). Le player lit le sample rate dans l'en-tête WAV : les sorties
  22 050 Hz (Piper) et 44 100 Hz (Supertonic) ne demandent **aucun ré-échantillonnage**.

## 5. Étapes d'implémentation

### Étape 0 — Baseline et libération de la VRAM
1. `docker stop qwen3-tts-vllm` (ne pas `rm` — l'image de 30,9 Go reste réutilisable).
2. Ajouter des scripts npm : `tts:vllm:stop`, et retirer `tts:vllm` de tout démarrage
   implicite s'il y en a. Vérifier `package.json`.
3. Noter la baseline actuelle (métriques de l'audit) dans ce document, section 8.

### Étape 1 — Provider Piper
1. **Setup script** `tools/piper/setup.ps1` :
   - Télécharger la release Windows amd64 de piper (binaire + espeak-ng data) dans
     `tools/piper/bin/`. Vérifier que `piper.exe --help` fonctionne.
   - Télécharger dans `models/piper/` : `fr_FR-siwis-medium`, `fr_FR-upmc-medium`,
     `fr_FR-tom-medium` (`.onnx` + `.onnx.json` chacun) depuis
     `https://huggingface.co/rhasspy/piper-voices` (URLs stables `resolve/main/fr/fr_FR/...`).
2. **Provider** `src/speech/tts/piperTts.ts` :
   - `synthesize(text, options)` : spawn `piper.exe --model <voix> --output_file -`
     (WAV sur stdout), texte via stdin, collecte stdout en Buffer → `AudioBuffer`
     container `wav`. Timeout + `options.signal` → kill du process.
   - `synthesizeChunks` : même patron séquentiel que `qwen3Tts.ts` (réutiliser/extraire
     `AsyncEventQueue` dans un module partagé plutôt que dupliquer une 3e fois —
     il existe déjà en double dans `qwen3Tts.ts` et `voiceChat.ts`).
   - `checkSetup` : binaire présent, modèle présent, puis **une synthèse d'un mot** pour
     valider la chaîne et chauffer le cache disque ; rapporter la durée.
   - Sélection de voix : option `voice` (nom de fichier modèle) + `speaker` (id numérique
     pour upmc multi-locuteurs, flag `--speaker`).
3. **Config** (`loader.ts` + `.env`) : `VOICE_TTS_PROVIDER=piper`,
   `PIPER_BINARY_PATH` (défaut `./tools/piper/bin/piper.exe`),
   `PIPER_VOICE` (défaut `./models/piper/fr_FR-siwis-medium.onnx`), `PIPER_SPEAKER` (optionnel).
4. **Tests** : miroir des tests de `qwen3Tts` (spawn mocké) : texte vide, timeout,
   annulation par signal, WAV bien formé, chunks dans l'ordre.
5. **Vérification** : `npm run dev -- voice-check` doit afficher la section TTS piper OK
   avec un temps de synthèse mesuré. Attendu : < 500 ms par phrase.

### Étape 2 — Provider Supertonic
1. **Setup script** `tools/supertonic/setup.ps1` :
   - Vérifier git-lfs ; `git clone https://huggingface.co/Supertone/supertonic-3`
     vers `models/supertonic/`.
2. **Dépendances npm** : `onnxruntime-node`. S'inspirer du code du dossier `nodejs/` du
   repo supertonic (MIT) : soit dépendance npm si publiée, soit vendoriser le strict
   nécessaire dans `src/speech/tts/supertonic/` avec l'en-tête de licence MIT.
3. **Provider** `src/speech/tts/supertonicTts.ts` :
   - Chargement paresseux des sessions ONNX au premier appel (ou dans `checkSetup`),
     une seule fois, exécution provider CPU (**ne pas activer CUDA** — la VRAM reste
     réservée au STT).
   - `synthesize` : langue depuis `options.language` (`fr` → code langue supertonic),
     preset de voix configurable (au moins un féminin + un masculin exposés),
     sortie WAV 44,1 kHz → `AudioBuffer` container `wav`.
   - `synthesizeChunks`, `checkSetup` (assets présents + synthèse d'un mot chronométrée) :
     même patron que Piper.
4. **Config** : `SUPERTONIC_ASSETS_DIR` (défaut `./models/supertonic`),
   `SUPERTONIC_VOICE` (nom du preset).
5. **Tests** : mêmes cas que Piper (sessions ONNX mockées).
6. **Vérification** : `voice-check` OK, synthèse d'une phrase < 500 ms après warmup.

### Étape 3 — Factory, bascule à chaud, diagnostics
1. `factory.ts` : `createTTSProvider` accepte `piper | supertonic | qwen3-tts`.
2. `voiceChat.ts` : nouvelle commande `/tts <piper|supertonic|qwen3>` (recrée le provider
   à chaud, comme `/provider` pour le LLM) et `/tts-voice <nom>` (change la voix du
   moteur actif). Afficher le moteur+voix actifs dans l'en-tête de session.
3. `voiceCheck.ts` : ajouter la section TTS (les trois providers si configurés,
   checkSetup + temps de synthèse d'une phrase témoin).

### Étape 4 — Réglage latence du pipeline
Ces changements ne doivent PAS modifier les interfaces publiques.
1. **Chunker** (`voiceChat.ts`) : `minChars` 70 → 40 par défaut, et fast-path premier
   chunk : dès la première frontière de phrase (`[.!?;:]\s`) même sous minChars, flusher.
   Rendre `minChars`/`maxChars` configurables (`VOICE_TTS_CHUNK_MIN/MAX`).
2. **Player** (`player.ts`) : remplacer le spawn PowerShell par chunk par un lecteur
   persistant : un process PowerShell unique lancé au début de session, boucle qui lit
   des chemins de fichiers WAV sur stdin et joue via `System.Media.SoundPlayer`
   (PlaySync), avec un protocole de fin ("DONE <path>" sur stdout) et kill pour stop().
   Garder l'implémentation actuelle en fallback derrière un flag si le persistant échoue.
   Attention : préserver la sémantique de `CancellablePlaybackQueue.stop()` (barge-in).
3. **Métriques** : ajouter au log JSONL et à `printMetrics` le temps de synthèse par
   chunk (`ttsChunkMs`) pour objectiver l'A/B.

### Étape 5 — A/B d'écoute et choix du défaut (avec l'utilisateur)
1. Nouvelle commande CLI : `npm run dev -- tts-compare "<phrase>"` (défaut : deux phrases
   françaises témoins, une courte + une longue) : pour chaque moteur × chaque voix
   installée → synthèse chronométrée puis lecture, avec annonce console de qui joue.
2. **Remettre la main à l'utilisateur** (cf. mémoire projet : les tests d'écoute sont
   faits par lui). Il choisit moteur + voix par défaut.
3. Figer le choix dans `.env` (`VOICE_TTS_PROVIDER`, voix), mettre à jour ce document.

### Étape 6 — Nettoyage et documentation
1. `.env` : bloc TTS commenté proprement (piper/supertonic/qwen3, valeurs par défaut).
2. `README.md` + `docs/guide-rapide-utilisation-audio.md` : nouveau setup TTS
   (2 scripts setup, plus de serveur TTS à démarrer pour l'usage courant).
3. Vérifier que `voice-chat` démarre et fonctionne **sans** Docker ni serveur :7861/:8091.
4. Ce document : remplir la section 8 (résultats mesurés vs baseline).

## 6. Risques et garde-fous

- **Qualité française de Supertonic inconnue** : c'est précisément l'objet de l'A/B ;
  si décevante, Piper est le filet de sécurité éprouvé.
- **Licence GPL de Piper** : interaction uniquement par process séparé (spawn CLI).
  Ne pas vendoriser de code piper dans `src/`.
- **OpenRAIL-M (poids Supertonic)** : restrictions d'usage, OK pour une app personnelle ;
  ne pas redistribuer les poids dans le repo.
- **onnxruntime-node sur Windows** : vérifier la version Node requise ; en cas de souci
  de binaire natif, fallback possible = sidecar minimal, mais c'est un plan B explicite.
- **Chevauchement audio** : sorties 22 050 / 44 100 Hz — le player lit l'en-tête WAV,
  mais vérifier `decodePcm16Wav` sur du 44,1 kHz (tests unitaires à ajouter).
- **Pas de benchmark GPU en boucle** sur la machine (mémoire projet) : les mesures TTS
  sont CPU et courtes, mais rester à 1-2 synthèses par vérification et confier les
  tests d'écoute à l'utilisateur.

## 7. Critères d'acceptation de la phase

- [ ] `voice-chat` en français : premier audio TTS < 800 ms après premier token LLM.
- [ ] Tour complet (fin de parole utilisateur → fin de réponse audio courte) < 3 s.
- [ ] Phrases longues lues **en intégralité** (bug de troncature non reproduit).
- [ ] Aucune VRAM consommée par le TTS (`nvidia-smi` stable pendant la synthèse).
- [ ] Barge-in (`VOICE_BARGE_IN`) et `/interrupt` fonctionnent avec les deux moteurs.
- [ ] `/tts` et `/tts-voice` basculent à chaud sans redémarrage.
- [ ] Tests unitaires verts (`npm test`), y compris les nouveaux providers.
- [ ] Qwen3-TTS reste sélectionnable via `.env` (chemin non supprimé).

## 8. Résultats (à remplir en fin de phase)

Baseline audit 2026-07-10 (vLLM-Omni :8091) : TTS premier audio 22,7–27,2 s ;
tour complet 29,7–42,9 s ; audio tronqué à ~1,2 s quel que soit le texte.

| Métrique | Baseline | Piper | Supertonic |
|---|---|---|---|
| Synthèse phrase courte (ms) | ~22 000 | | |
| Premier audio après 1er token LLM (ms) | ~22 000–27 000 | | |
| Tour complet (ms) | 29 700–42 900 | | |
| Texte lu en entier | Non (~1,2 s max) | | |

Implementation status (2026-07-10): Piper and Supertonic CPU providers, setup scripts, hot switching, persistent Windows playback, chunk timing, and the listening comparison command are implemented. Hardware and listening measurements remain intentionally blank until the local voice assets are installed and evaluated by the user.

## 9. Résultats d'écoute et problèmes différés (test utilisateur, 2026-07-10)

### Choix TTS provisoire

- **Piper : écarté provisoirement.** Dès qu'une voix est produite, l'audio contient de forts grésillements et ne laisse entendre qu'une voix très dégradée. Ne pas le choisir comme moteur par défaut tant que le problème n'a pas été diagnostiqué (binaire/voix/sortie audio).
  → **Diagnostiqué et corrigé le 2026-07-11** : corruption CRLF du WAV sur stdout (mode texte Windows du binaire piper). Le provider utilise désormais `--output-raw` (flux binaire propre, vérifié octet par octet) encapsulé côté Node. Piper redevient candidat pour l'A/B — verdict d'écoute utilisateur en attente. Détails : `docs/fix-piper-audio-corruption.md`.
- **Supertonic : validé à l'écoute.** La qualité de génération est jugée excellente. Il devient le candidat par défaut pour les prochains essais, sous réserve de le figer dans `.env` après validation finale.

### Problème différé 1 — fin de parole / STT tronqué

**Symptôme :** l'application considère régulièrement que l'utilisateur a fini de parler avant la fin de sa phrase. Seule une partie de la phrase est alors transcrite et envoyée au LLM.

**Impact :** les réponses du LLM peuvent manquer le début ou la fin de l'intention de l'utilisateur ; la conversation n'est pas fiable.

**Éléments observés :** les logs montrent aussi des périodes de silence ou de niveau très faible sur `CABLE Output (VB-Audio Virtual Cable)` (`peak RMS` parfois entre `0.0002` et `0.0004`), entrecoupées d'activité. Cela suggère de réexaminer séparément le périphérique de capture, le routage VB-Cable et les paramètres VAD (`VOICE_VAD_THRESHOLD`, `VOICE_VAD_SILENCE_MS`, `VOICE_VAD_SPEECH_MS`) avant de modifier le STT.

**Statut :** à corriger dans une phase dédiée. Ne pas interpréter ce problème comme une erreur de Supertonic : il est en amont du TTS.

### Problème différé 2 — barge-in non fonctionnel en conditions réelles

**Symptôme :** l'utilisateur doit attendre que la réponse audio soit terminée avant de pouvoir parler à nouveau. La prise de parole pendant la réponse ne coupe pas systématiquement le LLM/TTS et ne crée pas immédiatement le tour suivant.

**Impact :** interaction strictement tour-par-tour, non naturelle, alors que `VOICE_BARGE_IN` est censé interrompre la réponse en cours.

**Éléments observés :** les réponses ont des durées de tour élevées (environ `14,7 s` à `38,9 s`) ; les temps Supertonic par chunk sont fréquemment de `2,8 s` à `8,9 s`. Le moniteur de barge-in doit être vérifié pendant ces synthèses longues, notamment avec la même source audio VB-Cable qui signale souvent l'absence de parole.

**Statut :** à corriger dans une phase dédiée. Le diagnostic devra couvrir la capture microphone concurrente pendant la lecture, le VAD de barge-in, l'annulation TTS/LLM et la reprise immédiate d'un nouveau tour.
