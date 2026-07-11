# Fix — Corruption audio Piper (grésillements) : CRLF sur stdout Windows

> Plan d'implémentation destiné à un agent. Chaque étape se termine par une vérification.
> Langue de travail du code : anglais (conventions du repo).

## 1. Diagnostic (audit du 2026-07-11, reproduit et mesuré)

**Symptôme** (phase 8, section 9) : toute synthèse Piper produit de forts grésillements
par-dessus une voix très dégradée mais reconnaissable.

**Cause racine — confirmée expérimentalement** : le binaire Windows
`rhasspy/piper 2023.11.14-2` (installé par `tools/piper/setup.ps1`) n'active **pas le
mode binaire sur stdout** quand on utilise `--output_file -`. Le runtime C de Windows
traduit alors chaque octet `0x0A` du flux WAV en `0x0D 0x0A`. Chaque `0x0D` injecté
décale les échantillons 16 bits suivants → bruit impulsionnel fort, voix dégradée.

Preuve (même texte, voix `fr_FR-siwis-medium`) :

| Mesure | `--output_file direct.wav` | `--output_file -` (stdout capturé par Node) |
|---|---|---|
| Octets `0x0A` précédés de `0x0D` | 9 / 1101 (co-occurrences naturelles) | **1206 / 1206 (100 % — traduction CRLF)** |
| Taille de données déclarée dans l'en-tête WAV vs octets réellement reçus | cohérente | **écart = exactement 1206 octets = nombre de CR injectés** |

Contre-vérifications (mêmes conditions) :
- `--output_file <fichier.wav>` : sortie **propre** (~1 051 ms au total, spawn + chargement
  du modèle + synthèse compris).
- `--output-raw` (PCM brut sur stdout) : sortie **propre** — le binaire active bien le
  mode binaire pour le mode raw ; seul le chemin WAV→stdout est bogué.

**Hors de cause** : le provider Node (`src/speech/tts/piperTts.ts`, collecte de Buffers
correcte), le player (`src/audio/player.ts` — Supertonic passe par le même chemin et est
validé à l'écoute), `decodePcm16Wav`, les modèles de voix.

## 2. Correctif retenu

Passer le provider de `--output_file -` à **`--output-raw`** :
- flux propre (vérifié), et **streamé** pendant la synthèse (pas d'attente de fin de
  process pour les premiers octets, utile plus tard) ;
- pas de fichier temporaire, pas de nettoyage, pas de collision de chemins ;
- le PCM brut est encapsulé côté Node avec `encodePcm16Wav` (déjà dans
  `src/audio/wav.ts`), au sample rate lu dans le `<voix>.onnx.json`
  (`audio.sample_rate`, ex. 22050 pour siwis-medium).

L'alternative « fichier temporaire » est le plan B si un problème inattendu apparaît
avec le raw (elle est vérifiée propre aussi).

## 3. Étapes d'implémentation

### Étape 1 — Provider `src/speech/tts/piperTts.ts`

1. Dans `synthesize()` : remplacer `["--model", voice, "--output_file", "-"]` par
   `["--model", voice, "--output-raw"]` (conserver `--speaker` le cas échéant).
2. Ajouter une lecture (avec cache par chemin de voix) du fichier `<voice>.onnx.json` :
   `audio.sample_rate` → nombre. Erreur claire si absent/illisible. Injecter
   `readFileSync` via `PiperInternals` (comme `existsSync`) pour les tests.
3. Après `run()` : le Buffer reçu est du PCM brut. Construire :
   `const pcm = output; const format = { sampleRate, channels: 1, bitDepth: 16, encoding: "pcm_s16le" }`
   puis `const wav = encodePcm16Wav(pcm, format)` et retourner
   `{ data: wav, format, container: "wav" }`. Supprimer l'appel à `decodePcm16Wav`.
4. Dans `run()` : remplacer la garde `output.length < 44` (en-tête WAV) par
   « longueur nulle ou impaire » (PCM 16 bits ⇒ nombre d'octets pair) avec un message
   d'erreur adapté. Ne rien changer aux sémantiques timeout / `options.signal` / kill.
5. `checkSetup` : inchangé sur le fond (binaire + `.onnx` + `.onnx.json` + synthèse
   d'un mot chronométrée) — il bénéficie automatiquement du correctif.

### Étape 2 — Tests (`tests/ttsCpuProviders.test.ts`)

1. Adapter `mockPiperProcess` : émettre du **PCM brut** (utiliser
   `createSineWavePcm16`) au lieu d'un WAV complet.
2. Mocker `readFileSync` (via internals) pour renvoyer
   `{"audio":{"sample_rate":22050}}` ; vérifier que `result.audio.format.sampleRate`
   vaut 22050 et que `result.audio.data` commence par un en-tête `RIFF` valide
   (le décoder avec `decodePcm16Wav` et comparer le PCM aux octets du mock, à
   l'identique — c'est le test anti-régression de la corruption).
3. Ajouter un cas : PCM de longueur impaire sur stdout → rejet avec message explicite.
4. Conserver les cas existants (texte vide, abort, ordre des chunks).
5. **Vérification** : `npm test` vert.

### Étape 3 — Vérification bout en bout

1. `npm run dev -- voice-check` : section Piper OK, temps de warm-up rapporté
   (~1 s par spawn attendu, modèle medium ; déjà nettement sous les temps par chunk
   mesurés pour Supertonic en phase 8 : 2,8–8,9 s).
2. Générer **une** phrase témoin par voix installée (siwis, upmc, tom) via
   `npm run dev -- tts-compare "<phrase>"` et s'arrêter là : **l'écoute et le verdict
   qualité reviennent à l'utilisateur** (mémoire projet — pas de boucles de test audio).
3. Mettre à jour `docs/phase-8-realtime-tts-piper-supertonic.md` section 9 : cause
   racine trouvée + correctif appliqué ; Piper redevient candidat pour l'A/B.

### Étape 4 (optionnelle, hors périmètre du bug) — Latence par process persistant

À ne faire que si, après écoute, l'utilisateur retient Piper et veut < 500 ms/phrase :
remplacer le spawn par phrase par un process persistant `piper --json-input
--output_dir <dir>` (une ligne JSON `{"text": ..., "output_file": ...}` par chunk,
chemin confirmé sur stdout), recréé par `/tts-voice` lors d'un changement de modèle.
Le spawn par phrase (~1 s) est déjà utilisable ; cette étape est une optimisation.

## 4. Critères d'acceptation

- [x] `npm test` vert, y compris le test anti-régression PCM-identité (53 tests, 2026-07-11).
- [x] Synthèse réelle via le provider corrigé : flux propre (5/999 co-occurrences CR-LF
  naturelles vs 1206/1206 avant correctif), 1 024 ms spawn compris.
- [ ] Une synthèse Piper écoutée par l'utilisateur **sans grésillements** (tts-compare
  exécuté le 2026-07-11 : siwis 1,8 s / upmc 2,0 s / tom 3,5 s sur la phrase longue,
  contre ~9 s par voix Supertonic — verdict d'écoute en attente).
- [x] Aucune modification de `ITTSProvider`, du player, du chunker ni des autres providers.
- [x] Sortie 22 050 Hz correctement déclarée dans l'en-tête WAV (le player lit l'en-tête).
