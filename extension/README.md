# Voxara Browser Bridge — Guide d'installation et d'utilisation

Ce guide explique comment installer l'extension Chrome, l'appairer avec
Voxara, puis piloter le navigateur à la voix ou au texte.

## Comment ça marche (en 30 secondes)

Voxara (le processus `llmtest` sur ta machine) ouvre un petit serveur local
sur `127.0.0.1:7863`. L'extension Chrome s'y connecte toute seule et lui
donne accès à **tes vrais onglets** : lire une page, cliquer, remplir un
champ, ouvrir/fermer des onglets, prendre une capture d'onglet.

- Tout reste sur ta machine : l'extension ne parle qu'à `127.0.0.1`.
- Un **token d'appairage** empêche tout autre programme de se faire passer
  pour Voxara.
- Chaque action est journalisée, et les actions sensibles (fermer un onglet,
  soumettre un formulaire) demandent toujours ta confirmation.

## 1. Installation (une seule fois)

### Étape A — Récupérer le token d'appairage

Dans un terminal, à la racine du projet :

```
npm run dev -- control doctor
```

La commande affiche quelque chose comme :

```
Chrome extension pairing
  Pairing token:      uPyp3UhAQ0ovSVwcr-zmSirl8K-qZtQY
```

Copie ce token (il ne change pas d'une fois sur l'autre).

### Étape B — Charger l'extension dans Chrome

1. Ouvre Chrome et va sur `chrome://extensions`
2. Active le **Mode développeur** (interrupteur en haut à droite)
3. Clique **« Charger l'extension non empaquetée »**
4. Sélectionne le dossier `extension/` de ce projet
   (`D:\Documents\MANTARA\AI COMPAGNON APP\extension`)

L'extension « Voxara Browser Bridge » apparaît dans la liste.

### Étape C — Coller le token

1. Sur la carte de l'extension, clique **« Détails »** →
   **« Options de l'extension »**
   (ou clic droit sur son icône → **Options**)
2. Colle le token dans le champ **Pairing token**
3. Laisse le port sur `7863` (sauf si tu as changé `CONTROL_BRIDGE_PORT`
   dans ton `.env`)
4. Clique **Save**

La ligne *Status* en bas de la page d'options indique l'état de la
connexion en direct.

### Étape D — Vérifier

Relance :

```
npm run dev -- control doctor
```

Attends quelques secondes : tu dois voir
`OK — extension v0.1.0 connected.` Si ce n'est pas le cas, va voir la
section Dépannage en bas.

## 2. Utilisation

### Démarrer une session

L'extension se connecte à une session Voxara **en cours d'exécution**.
Lance l'une des deux :

```
# Session vocale avec outils
npm run dev -- voice-chat --agent

# Session texte avec outils
npm run dev -- agent-chat
```

Le bridge démarre automatiquement avec la session ; l'extension s'y
raccroche en quelques secondes (elle réessaie en boucle, tu n'as rien à
faire — même si tu lances Chrome après la session).

### Ce que tu peux demander

**Observer (jamais de confirmation) :**

> « Qu'est-ce qu'il y a sur cette page ? »
> « Liste mes onglets ouverts. »
> « Regarde cet onglet et dis-moi ce que tu vois. » *(capture d'onglet)*

**Agir — actions réversibles :**

> « Ouvre YouTube. »
> « Va sur le deuxième onglet. »
> « Descends jusqu'aux commentaires. »
> « Remplis le champ recherche avec "recette pancakes". »

À la **première** action de la session, Voxara demande une fois :
*« Je prends la main quand il faut pour cette session ? »* — dis oui, et
toutes les actions réversibles passent ensuite sans re-demander (c'est le
mode par défaut `session_grant`).

**Agir — actions sensibles (confirmation à chaque fois) :**

> « Ferme cet onglet. »
> « Clique sur Envoyer. » *(soumission de formulaire)*

Voxara décrit l'effet concret (« Je ferme l'onglet YouTube — je
confirme ? ») et n'agit qu'après ton oui explicite.

**Co-pilotage :** tu peux enchaîner naturellement —
« clique là… maintenant descends… ouvre le troisième lien » — chaque
demande est un tour de conversation normal, il n'y a pas de « mode
contrôle » à activer ou quitter.

### Régler le niveau de confiance

Dans ton `.env` :

```
# Par défaut : une seule question par session pour les actions réversibles
CONTROL_TRUST_LEVEL=session_grant

# Paranoïaque : confirmation à CHAQUE action
CONTROL_TRUST_LEVEL=confirm_each

# Confiance totale : aucune confirmation (tout reste journalisé)
CONTROL_TRUST_LEVEL=auto
```

## 3. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| *Status : no pairing token* | Token jamais collé | Options de l'extension → coller le token de `control doctor` |
| *Status : pairing token rejected* | Mauvais token (espace parasite, ancien token) | Recopier le token exact affiché par `control doctor` |
| *Status : disconnected — Voxara is not running* | Aucune session en cours | Lancer `voice-chat --agent` ou `agent-chat` (ou `control doctor` pour un test) |
| Voxara répond « l'extension Chrome n'est pas connectée » | Chrome fermé, extension désactivée ou mal appairée | Vérifier `chrome://extensions`, puis la ligne *Status* dans les options |
| `control doctor` dit « Bridge port already in use » | Une session Voxara tourne déjà et possède le port | C'est normal — le doctor ne peut pas tester en parallèle ; teste directement dans la session |
| « stale ref » dans les réponses | La page a changé depuis la dernière lecture | Rien à faire : Voxara relit la page et réessaie |
| Rien ne marche sur une page précise | Page protégée (`chrome://`, Chrome Web Store, PDF viewer) | Ces pages sont inaccessibles aux extensions, c'est une limite de Chrome |

**Changer de port :** mets `CONTROL_BRIDGE_PORT=<port>` dans ton `.env`
**et** le même port dans les options de l'extension.

**Journal des actions :** chaque intent (lu, exécuté, bloqué) est ajouté en
JSONL sous `~/.llmtest/state/control/<session>.jsonl` — demande simplement
« qu'est-ce que tu viens de faire ? » en session, ou ouvre le fichier.

## 4. Limites actuelles (slice C3b)

- Chrome/Chromium uniquement (Edge/Brave probablement compatibles, non testés).
- Pas encore de contrôle du bureau ni de tâches de fond multi-étapes
  (« compare ce produit sur trois sites ») — ça arrive avec la slice C3c.
- Une seule instance de Chrome appairée à la fois (la connexion la plus
  récente gagne).
