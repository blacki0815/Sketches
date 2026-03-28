// config.js – Firebase Konfiguration
// Sicherheit läuft über Firebase Security Rules (siehe README.md)
// Dieser Key ist browser-seitig sichtbar – das ist bei Firebase normal und gewollt.
// Schütze dein Projekt über: Firebase Console → Realtime Database → Regeln

export const firebaseConfig = {
  apiKey:            "AIzaSyDerAddtDUSTfGDcgBWicwEwvuRM-MHiJE",
  authDomain:        "skizzengemeinsam.firebaseapp.com",
  databaseURL:       "https://skizzengemeinsam-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "skizzengemeinsam",
  storageBucket:     "skizzengemeinsam.firebasestorage.app",
  messagingSenderId: "33478341512",
  appId:             "1:33478341512:web:dc84017e00c73a37ecc03d"
};
