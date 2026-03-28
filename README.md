# SkizzenGemeinsam – Firebase Security Rules

## Empfohlene Produktions-Regeln

Gehe in der Firebase Console zu:
**Realtime Database → Regeln**

### Option A: Nur deine GitHub-Pages-Domain erlauben
Firebase Realtime Database unterstützt keine Domain-Whitelist direkt in den Rules.
Stattdessen: In der Firebase Console unter **Authentifizierung → Einstellungen → Autorisierte Domains**
nur deine GitHub Pages Domain eintragen (z.B. `deinname.github.io`).

### Option B: Rate-Limit über Rules (empfohlen)
```json
{
  "rules": {
    "boards": {
      "$boardId": {
        ".read": true,
        ".write": true,
        "strokes": {
          "$strokeId": {
            ".validate": "newData.hasChildren(['color','size','tool','points'])"
          }
        }
      }
    },
    "saved": {
      "$userId": {
        ".read": "auth == null || true",
        ".write": true
      }
    }
  }
}
```

### Hinweis zum API Key
Der Firebase API Key im Browser ist **by design öffentlich** – das ist Firebase-Standard.
Der Schutz läuft ausschließlich über die Security Rules oben.
Mehr Info: https://firebase.google.com/docs/projects/api-keys
