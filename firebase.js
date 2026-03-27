// firebase.js – Initialisierung & Export
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  push,
  onValue,
  onChildAdded,
  onChildRemoved,
  onDisconnect,
  serverTimestamp,
  remove,
  get,
  update
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDerAddtDUSTfGDcgBWicwEwvuRM-MHiJE",
  authDomain: "skizzengemeinsam.firebaseapp.com",
  databaseURL: "https://skizzengemeinsam-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "skizzengemeinsam",
  storageBucket: "skizzengemeinsam.firebasestorage.app",
  messagingSenderId: "33478341512",
  appId: "1:33478341512:web:dc84017e00c73a37ecc03d"
};

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

export {
  db, ref, set, push, onValue, onChildAdded, onChildRemoved,
  onDisconnect, serverTimestamp, remove, get, update
};
