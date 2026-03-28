# ✏ SkizzenGemeinsam

> A real-time collaborative drawing app — draw together, instantly.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Firebase](https://img.shields.io/badge/Firebase-Realtime_Database-orange?logo=firebase)
![GitHub Pages](https://img.shields.io/badge/Deployed-GitHub_Pages-222?logo=github)

---

## 🖼 Features

- **Real-time collaboration** — multiple users draw on the same board simultaneously, with live cursor tracking
- **Smooth drawing** — quadratic spline interpolation + moving-average smoothing for natural-looking strokes
- **Pinch-to-zoom** — two-finger zoom on mobile, mouse wheel on desktop, with zoom buttons in the toolbar
- **Undo / Redo** — per-user undo/redo stack (`Ctrl+Z` / `Ctrl+Y`), non-destructive via Firebase hidden flag
- **PNG Export** — download the current board as a `.png` file with one click
- **Board sharing** — share a board via link or 6-character code; anyone with the code can join instantly
- **Save boards** — boards are saved per user with a thumbnail preview and date
- **Color picker** — 6 preset colors + full custom color input
- **Brush size** — adjustable from 1–40px
- **Eraser tool** — non-destructive canvas erasing
- **Anonymous users** — no login required, just enter a display name

---

## 🗂 Project Structure

```
skizzengemeinsam/
├── index.html      # App shell — home screen + canvas screen
├── style.css       # All styling (dark theme, toolbar, layout)
├── app.js          # Main logic: drawing, zoom, undo/redo, sync, export
├── firebase.js     # Firebase initialization + export of DB helpers
├── config.js       # Firebase config object (kept separate for clarity)
└── README.md       # This file
```

---

## 🚀 Deployment (GitHub Pages)

### 1. Clone or fork this repository

```bash
git clone https://github.com/YOUR_USERNAME/skizzengemeinsam.git
cd skizzengemeinsam
```

### 2. Push all files to the `main` branch

```bash
git add .
git commit -m "Initial deploy"
git push origin main
```

### 3. Enable GitHub Pages

Go to your repository on GitHub:

```
Settings → Pages → Source → Deploy from branch → main / (root)
```

Your app will be live at:
```
https://YOUR_USERNAME.github.io/skizzengemeinsam/
```

---

## 🔥 Firebase Setup

### Required services

| Service | Used for |
|---|---|
| **Realtime Database** | Live stroke sync, cursor positions, user presence |

Firestore is **not** used — all data goes through the Realtime Database for lowest latency.

### Configuration

Edit `config.js` and replace the values with your own Firebase project:

```js
export const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT-default-rtdb.REGION.firebasedatabase.app",
  projectId:         "YOUR_PROJECT",
  storageBucket:     "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};
```

### Security Rules

In the Firebase Console go to **Realtime Database → Rules** and paste:

```json
{
  "rules": {
    "boards": {
      "$boardId": {
        ".read": true,
        ".write": true,
        "strokes": {
          "$strokeId": {
            ".validate": "newData.hasChildren(['color', 'size', 'tool', 'points'])"
          }
        }
      }
    },
    "saved": {
      "$userId": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

### Authorized Domains

In the Firebase Console go to **Authentication → Settings → Authorized Domains** and add your GitHub Pages domain:

```
YOUR_USERNAME.github.io
```

This prevents the Firebase project from being used by other websites.

---

## 🗄 Database Schema

```
boards/
  {boardCode}/
    users/
      {userId}/
        name:   "Mia"
        color:  "#e63946"
        x:      412          ← live cursor position (world coords)
        y:      230
    strokes/
      {strokeId}/
        color:  "#2a9d8f"
        size:   4
        tool:   "pen"        ← "pen" | "eraser"
        owner:  "{userId}"
        hidden: false        ← true when undone
        points:
          0: { x: 100, y: 200 }
          1: { x: 105, y: 204 }
          ...

saved/
  {userId}/
    {boardCode}/
      code:      "abc123"
      savedAt:   1712345678000
      thumbnail: "data:image/jpeg;base64,..."
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl + Z` | Undo last stroke |
| `Ctrl + Y` | Redo |
| `Ctrl + Shift + Z` | Redo (alternative) |
| Mouse wheel | Zoom in / out |

---

## 🔒 Security Notes

The Firebase API key is visible in `config.js` — **this is intentional and normal for Firebase web apps**. The key alone does not grant unrestricted access. Protection is enforced through:

1. **Firebase Security Rules** — validate data structure, prevent malformed writes
2. **Authorized Domains** — restrict which origins can make authenticated requests to your Firebase project

For more information see the [official Firebase documentation on API keys](https://firebase.google.com/docs/projects/api-keys).

---

## 📦 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript (ES Modules) |
| Realtime sync | Firebase Realtime Database (WebSocket) |
| Hosting | GitHub Pages |
| Fonts | [Syne](https://fonts.google.com/specimen/Syne) + [Space Mono](https://fonts.google.com/specimen/Space+Mono) via Google Fonts |
| Drawing | HTML5 Canvas API |

No build step. No npm. No framework. Just files.

---

## 📄 License

MIT — do whatever you want with it.
