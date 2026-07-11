# Phase 9 — Détection vocale fiable : endpointing STT + barge-in

> Plan d'implémentation destiné à un agent. Ne pas exécuter aveuglément : chaque étape
> se termine par une vérification. Langue de travail du code : anglais (conventions du repo).
> Couvre les deux problèmes différés de la phase 8 (§9 de
> `phase-8-realtime-tts-piper-supertonic.md`).

## 1. Contexte

Après la phase 8 (TTS Supertonic CPU), les latences sont acceptables mais deux défauts
rendent la conversation non fiable :

1. **Fin de parole prématurée** : l'app coupe l'utterance avant la fin de la phrase ;
   seul un fragment part au STT/LLM.
2. **Barge-in inopérant** : parler pendant la réponse ne l'interrompt pas ; interaction
   strictement tour-par-tour.

## 2. Résultats de l'audit du code (2026-07-10)

### 2.1 Fin de parole prématurée — causes identifiées

| # | Cause | Localisation | Confiance |
|---|---|---|---|
| A1 | `silenceEndMs = 500 ms` trop court : une pause naturelle intra-phrase (respiration, hésitation) dépasse facilement 500 ms → `speechEnd` au milieu de la phrase | `.env` (`VOICE_VAD_SILENCE_MS=500`), défaut dans `src/audio/vad.ts:6` | Haute |
| A2 | **Dérive du noise floor pendant la parole** : `NOISE_FLOOR_RISE = 0.002`/frame s'applique aussi quand `inSpeech` ; à 50 frames/s le floor absorbe ~10 %/s de l'écart avec l'énergie de parole. Sur une phrase longue continue, `effectiveThreshold` (= floor × 2,5) peut rattraper l'énergie de la voix en ~4–8 s → frames classées silence → coupure | `src/audio/vad.ts:139-144` | Haute (mécanisme certain, fréquence à confirmer par logs) |
| A3 | **Niveau capture très faible** : `CABLE Output (VB-Audio Virtual Cable)` livre des peak RMS de 0,0002–0,0004 en silence ; si la parole culmine vers 0,003–0,01, la marge au-dessus de `minThreshold = 0.002` est mince et les phonèmes doux (fricatives sourdes, fins de mots français) passent sous le seuil → le compteur de silence court pendant la parole | routage/gain Windows + VB-Cable, en amont du code | Haute (constaté dans les logs) |
| A4 | **Trou de capture entre les tours** : chaque `recordUtterance` respawn un ffmpeg DirectShow (~200–500 ms de démarrage où l'audio est perdu). Si l'utilisateur continue de parler après une coupure prématurée, la suite tombe soit dans ce trou, soit dans le moniteur de barge-in du tour suivant → fragments et interruptions parasites | `src/audio/microphone.ts:97`, boucle `listenForTranscript` `src/commands/voiceChat.ts:871` | Moyenne (aggravant, pas déclencheur) |

Le STT lui-même (faster-whisper HTTP) est hors de cause : il transcrit ce qu'on lui
envoie ; c'est la capture qui s'arrête trop tôt.

### 2.2 Barge-in inopérant — causes identifiées

| # | Cause | Localisation | Confiance |
|---|---|---|---|
| B1 | **Seuil fixe 0,018 jamais atteint** : `monitorBargeIn` passe `fixedThreshold: true` avec `threshold = VOICE_VAD_THRESHOLD = 0.018`. Or l'écoute normale ne fonctionne que parce que le mode adaptatif abaisse le seuil effectif vers ~0,002. Sur ce périphérique à bas niveau (A3), la parole n'atteint vraisemblablement jamais 0,018 → `speechStart` jamais émis → aucun barge-in. **Cause principale.** | `src/commands/voiceChat.ts:1006,1014` | Haute |
| B2 | **Stream LLM non annulable** : `interrupt()` n'arrête pas `provider.streamChat` (l'interface `ILLMProvider.streamChat` n'accepte pas de signal). `done` attend la fin complète du stream avant de se régler → même quand l'interruption marche, la reprise du tour suivant attend la génération LLM entière | `src/providers/ILLMProvider.ts:32-35`, `src/commands/voiceChat.ts:293-310` | Haute |
| B3 | **Event loop potentiellement bloqué pendant la synthèse Supertonic** : chunks à 2,8–8,9 s ; si le helper JS (g2p, pre/post-processing) ou `floatToPcm16`/`encodePcm16Wav` (boucles synchrones sur plusieurs secondes d'audio 44,1 kHz) bloquent l'event loop, les handlers stdout du mic et le poll 150 ms ne tournent pas → détection retardée de plusieurs secondes | `src/speech/tts/supertonicTts.ts:74-78,146-153` | À instrumenter (phase 0) |
| B4 | **Écho/bleed non calibré** : le seuil fixe haut servait de protection contre l'auto-interruption par la voix du TTS sortant des enceintes. L'abaisser sans mesurer le bleed réel risque l'effet inverse (le TTS s'interrompt lui-même). Il faut une calibration, pas juste une constante plus basse | conception `monitorBargeIn` | Haute |
| B5 | Latence Supertonic par chunk élevée (2,8–8,9 s) : `loadVoiceStyle` est rechargé **à chaque chunk** (lecture fichier + construction des tenseurs) au lieu d'être mis en cache par voix ; `totalSteps`/threads ONNX non mesurés. Réduit la fenêtre de réactivité globale et allonge les tours (14,7–38,9 s) | `src/speech/tts/supertonicTts.ts:73` | Haute (cache), Moyenne (reste) |
| B6 | Aucune télémétrie de niveaux pendant la lecture : `monitorBargeIn` ne passe pas `onNoSpeech`/`noSpeechReportIntervalMs` → impossible de savoir quel niveau atteint la parole de l'utilisateur pendant que le TTS joue | `src/commands/voiceChat.ts:1003-1023` | — |

Mineur : `InterruptController.inspect()` n'est appelé nulle part (chemin mort) ; le
contrôleur ne sert que de wrapper `stop()`.

## 3. Décisions de conception

- **Ordre impératif : instrumenter avant de régler.** Les seuils actuels ont été choisis
  à l'aveugle ; la phase 0 produit les chiffres qui calibrent les phases 1 et 2.
- **Un seul flux micro à terme** : le respawn ffmpeg par phase d'écoute (A4) est une
  dette ; on ne la traite ici que si les phases 1–2 ne suffisent pas (étape optionnelle 5).
- **Pas de benchmark GPU en boucle** (mémoire projet) : mesures courtes, tests d'écoute
  et de conversation confiés à l'utilisateur.
- **Ne pas changer `ITTSProvider` ni `ISTTProvider`.** L'ajout d'un paramètre optionnel
  `signal` à `ILLMProvider.streamChat` est additif (rétro-compatible).

## 4. Étapes d'implémentation

### Étape 0 — Instrumentation et diagnostic (préalable à tout tuning)

1. **Télémétrie VAD dans le log JSONL** : à chaque `speechStart`/`speechEnd`, consigner
   `energy`, `noiseFloor`, `effectiveThreshold`, `speechMs`, `silenceMs` (étendre
   `VadEvent` ou logger côté `recordUtterance` via un callback `onVadEvent` optionnel).
2. **Niveaux pendant le barge-in** : passer `noSpeechReportIntervalMs` + `onNoSpeech`
   dans `monitorBargeIn` et logger les stats (`maxEnergy`, floor, threshold) en JSONL.
3. **`voice-check` : section calibration** — mesurer et afficher :
   - 3 s de silence → noise floor du périphérique ;
   - une phrase parlée → peak/médiane RMS de la parole ;
   - une phrase parlée **pendant** qu'un WAV TTS joue → RMS du bleed + de la parole
     superposée. (Une seule synthèse, réutiliser un WAV en cache.)
4. **Sonde d'event-loop lag** : pendant `voice-check` TTS, un `setInterval(25 ms)` qui
   mesure la dérive ; afficher le lag max pendant une synthèse Supertonic. Tranche
   directement B3.
5. **Vérification** : `npm run dev -- voice-check` affiche les nouveaux chiffres ;
   consigner les valeurs mesurées dans la section 7 de ce document.

### Étape 1 — Endpointing : ne plus couper l'utilisateur

1. **Geler la montée du noise floor pendant la parole** (`vad.ts`) : n'appliquer
   `NOISE_FLOOR_RISE` que quand `inSpeech === false`. Conserver la descente rapide.
   (Corrige A2.)
2. **`silenceEndMs` : défaut 500 → 900 ms** (`DEFAULT_VAD_CONFIG`, `loader.ts`, `.env`,
   `.env.example`). Reste configurable via `VOICE_VAD_SILENCE_MS`. (Corrige A1.
   Coût : +400 ms de latence de fin de tour, acceptable vs des phrases coupées.)
3. **Hangover proportionnel (optionnel, si les logs de l'étape 0 le justifient)** :
   après ≥ 4 s de parole cumulée, prolonger le silence requis (p.ex. ×1,3) — les phrases
   longues ont plus de pauses internes.
4. **Ajuster `minThreshold` d'après la calibration** de l'étape 0 (si le floor mesuré en
   silence est ~0,0003, un `minThreshold` de 0,002 est peut-être encore trop haut pour
   ce périphérique → envisager 0,0015 ou une valeur dérivée : `max(floorMesuré × 3, 0.001)`).
5. **Tests unitaires (`tests/`)** :
   - phrase longue continue (frames voix constantes 8 s) → pas de `speechEnd` ;
   - pauses de 600–800 ms intra-phrase → pas de coupure avec le nouveau défaut ;
   - dips courts sous le seuil (phonèmes doux) → `silenceMs` ne déclenche pas ;
   - le floor ne monte pas pendant `inSpeech` (assertion sur `levelStats()`).
6. **Vérification** : `npm test` vert ; puis test de conversation par l'utilisateur —
   critère : 10 phrases longues d'affilée transcrites en entier.

### Étape 2 — Barge-in fonctionnel

1. **Seuil de barge-in calibré, pas fixe-aveugle** (`monitorBargeIn`) :
   - Nouvelle config `VOICE_BARGEIN_THRESHOLD` (optionnelle). Si absente : garder le VAD
     **adaptatif** pour le moniteur (le floor adaptatif absorbe le bleed constant du TTS)
     mais avec des garde-fous dédiés : `speechStartMs` barge-in ≥ 250 ms (vs 120) et
     `NOISE_TO_SPEECH_RATIO` effectif plus exigeant (p.ex. seuil = floor × 3,5) pour ne
     déclencher que sur une vraie prise de parole soutenue.
   - Retirer `fixedThreshold: true` au profit de cette config dédiée. (Corrige B1 en
     respectant B4.)
   - Les chiffres de bleed de l'étape 0.3 arbitrent : si le bleed est fort (enceintes),
     documenter la valeur `VOICE_BARGEIN_THRESHOLD` recommandée dans `.env.example`.
2. **Annulation du stream LLM** : ajouter `signal?: AbortSignal` à
   `ILLMProvider.streamChat` (paramètre optionnel, additif). L'implémenter dans les
   providers dont le SDK le permet (fetch/axios : passer le signal ; sinon, arrêter de
   consommer et résoudre avec le partiel). Dans `startVoiceAssistantTurn` /
   `startVoiceAgentAssistantTurn`, `interrupt()` aborte ce signal. `done` doit se régler
   < 500 ms après `interrupt()`. (Corrige B2.)
3. **Selon le verdict de la sonde B3 (étape 0.4)** :
   - si lag event-loop > ~200 ms pendant la synthèse : déplacer `floatToPcm16` +
     `encodePcm16Wav` hors du chemin chaud (chunking de la boucle avec `setImmediate`,
     ou worker_thread pour la conversion) et vérifier que le helper Supertonic n'exécute
     pas de g2p synchrone long ; re-mesurer.
4. **Cache du style Supertonic** (`supertonicTts.ts`) : mémoïser `loadVoiceStyle` par
   chemin de style (Map), invalidé si la voix change. Mesurer le gain par chunk. (B5.)
5. **Nettoyage mineur** : supprimer `InterruptController.inspect()` (chemin mort) ou le
   brancher ; ne garder qu'un seul chemin d'interruption.
6. **Tests unitaires** :
   - provider LLM mocké à stream lent + `interrupt()` → `done` se règle sans attendre la
     fin du stream ;
   - moniteur barge-in avec frames sous/au-dessus du seuil calibré → interrupt appelé
     seulement au-dessus, après la durée `speechStartMs` barge-in ;
   - style Supertonic chargé une seule fois pour N chunks (spy sur `loadVoiceStyle`).
7. **Vérification** : test utilisateur — parler pendant une réponse longue doit :
   couper l'audio < 500 ms, stopper la génération, et enchaîner le tour suivant avec
   l'utterance interruptrice complète.

### Étape 3 — Chaîne de capture (avec l'utilisateur)

1. Clarifier le routage `CABLE Output (VB-Audio Virtual Cable)` : pourquoi le micro
   passe par VB-Cable ? Vérifier le gain d'entrée Windows du périphérique (cible :
   parole ≥ 0,01 peak RMS ; silence ≤ 0,001). Si le niveau reste bas, augmenter le gain
   côté Windows/VB-Cable plutôt que de baisser les seuils. (A3.)
2. Documenter la configuration retenue dans `docs/guide-rapide-utilisation-audio.md`
   (périphérique recommandé, niveaux attendus, comment relire `voice-check`).

### Étape 4 — Validation de bout en bout (utilisateur)

1. Session de conversation réelle : critères §6.
2. Remplir la section 7 (mesures avant/après).
3. Mettre à jour `phase-8-...md` §9 (statut des deux problèmes différés → résolus/ref).

### Étape 5 (optionnelle, seulement si les étapes 1–3 ne suffisent pas) — Flux micro persistant

Un seul processus ffmpeg ouvert pour toute la session, avec un démultiplexeur qui sert
alternativement `listenForTranscript` et `monitorBargeIn` (élimine A4 : plus de trou de
démarrage entre les tours, plus de contention DirectShow). Refactor de
`FfmpegMicrophoneCapture` en flux continu + consommateurs. À chiffrer séparément —
ne pas l'embarquer dans cette phase sans accord.

## 5. Risques et garde-fous

- **Baisser le seuil de barge-in peut créer des auto-interruptions** (bleed TTS) :
  c'est pour ça que la calibration (étape 0.3) précède le changement, et que le moniteur
  garde `speechStartMs` long + ratio exigeant. En cas de fausses interruptions en test,
  remonter `VOICE_BARGEIN_THRESHOLD` est un rollback à une variable.
- **`silenceEndMs` à 900 ms allonge la fin de tour** : si l'utilisateur trouve la
  réactivité dégradée, 700 ms est le plancher raisonnable.
- **`streamChat(signal)`** : ne pas casser les providers existants — paramètre optionnel,
  comportement inchangé si absent ; tests de non-régression sur `chat`/`streamChat`.
- **Pas de refonte du flux micro dans cette phase** (étape 5 = plan B explicite).

## 6. Critères d'acceptation

- [ ] 10 phrases longues (> 8 s, avec pauses naturelles) transcrites en entier, sans coupure.
- [ ] Barge-in : parler pendant une réponse coupe l'audio < 500 ms et la génération LLM
      s'arrête ; l'utterance interruptrice complète devient le tour suivant.
- [ ] Aucune auto-interruption par le TTS sur 10 réponses lues aux enceintes.
- [ ] `voice-check` affiche la calibration (floor silence, RMS parole, bleed, lag event-loop).
- [ ] `npm test` vert, nouveaux tests inclus.
- [ ] Latence Supertonic par chunk réduite (cache style) — chiffres avant/après en §7.

## 7. Statut d'implémentation (2026-07-10)

Étapes 0, 1 et 2 implémentées (`npm test` : 50/50 verts) :

- **Étape 0** : télémétrie VAD JSONL (`type: "vad"`, phases `listen`/`barge-in`) ;
  `voice-check` a une section calibration interactive (bruit 3 s / parole 5 s / bleed
  TTS) qui imprime des suggestions `VOICE_VAD_MIN_THRESHOLD` et
  `VOICE_BARGEIN_THRESHOLD`, plus une sonde de lag event-loop pendant la synthèse TTS
  (`--skip-calibration` pour l'ignorer).
- **Étape 1** : montée du noise floor gelée pendant la parole (`vad.ts`) ;
  `VOICE_VAD_SILENCE_MS` 500 → 900 par défaut ; `VOICE_VAD_MIN_THRESHOLD` configurable.
- **Étape 2** : barge-in sans seuil fixe aveugle — `VOICE_BARGEIN_THRESHOLD` (fixe,
  issu de la calibration) sinon VAD adaptatif ratio 3,5 + onset `VOICE_BARGEIN_SPEECH_MS`
  (250 ms) ; `streamChat(signal)` annule le stream LLM à l'interruption (google/github/
  ollama, résolution avec le texte partiel) ; cache des styles Supertonic par chunk.
  Non couvert : annulation du LLM en mode agent (`runAgentLoop`), hors périmètre.

**Correctif post-test (2026-07-11)** : crash `Error: Supertonic synthesis was cancelled`
lors d'un barge-in précoce (pendant la synthèse du premier chunk, stream LLM encore
ouvert). Cause : `ttsPromise` rejetée avant que `done()` n'atteigne son `await` →
`unhandledRejection` → le handler global de `yoga-layout-prebuilt` (nbind.js) fait
`throw` et tue le process. Corrigé en pré-attachant un handler à `ttsPromise` (les deux
variantes de tour), en attrapant les rejets du moniteur de barge-in, de l'interrupt
fire-and-forget et du poll de commandes. Test de régression :
`voiceLoop.test.ts` « does not leak an unhandled rejection… » (vérifié rouge sans le
correctif, vert avec).

Premier test réel (2026-07-11) : le barge-in fonctionne (plusieurs tours interrompus
au vol). Niveaux observés : parole peak RMS ~0,0021 pour un plancher ~0,0002 — la marge
au-dessus de `VOICE_VAD_MIN_THRESHOLD` (0,002) est quasi nulle : augmenter le gain
d'entrée Windows reste fortement recommandé (étape 3). Latence Supertonic par chunk
toujours élevée (3,4–9,4 s) : voir la sonde event-loop de `voice-check` pour trancher
l'étape 2.3.

Étapes 3 (routage/gain périphérique) et 4 (validation) : à faire par l'utilisateur —
lancer `npm run dev -- voice-check` au micro et reporter les chiffres ci-dessous.

## 8. Mesures (à remplir)

| Mesure | Avant (audit 2026-07-10) | Après |
|---|---|---|
| Noise floor silence (peak RMS) | 0,0002–0,0004 (VB-Cable) | |
| Peak RMS parole | non mesuré | |
| Bleed TTS pendant lecture | non mesuré | |
| Lag event-loop max pendant synthèse | non mesuré | |
| Supertonic ms/chunk | 2 800–8 900 | |
| Tour complet | 14 700–38 900 ms | |
| Délai interrupt → tour suivant | ∞ (barge-in inopérant) | |
