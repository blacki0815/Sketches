// firebase.js – Initialisierung & Export
import { initializeApp }    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, set, push, onValue,
  onDisconnect, serverTimestamp, remove, get, update
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import { firebaseConfig } from "./config.js";

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

export {
  db, ref, set, push, onValue,
  onDisconnect, serverTimestamp, remove, get, update
};
