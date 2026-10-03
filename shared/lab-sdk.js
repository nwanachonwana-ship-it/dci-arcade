// Launch Lab Arcade — shared SDK
// Include in any game with:
//   <script type="module" src="https://<you>.github.io/launch-lab-arcade/shared/lab-sdk.js"></script>
// Then use:
//   LabSDK.getHandle()                  — permanent player name
//   LabSDK.recordScore(gameId, score)   — logs the play AND updates best-score leaderboard
//   LabSDK.getGameLeaderboard(gameId)   — top N players for one game
//   LabSDK.getMyRank(gameId)            — this player's rank in one game
//   LabSDK.getMyStats()                 — this player's rank across EVERY game they've played

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  runTransaction,
  collection,
  query,
  where,
  orderBy,
  limit as fbLimit,
  getDocs,
  addDoc,
  setDoc,
  serverTimestamp,
  getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAmuzIcm7q8KBRkoWQAHJkMyY0AUD_XXi4",
  authDomain: "dciarcade1.firebaseapp.com",
  projectId: "dciarcade1",
  storageBucket: "dciarcade1.firebasestorage.app",
  messagingSenderId: "224229607861",
  appId: "1:224229607861:web:f7d735fc4d105ac62c31fc"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---- Auth bootstrap ----

let authReadyResolve;
const authReady = new Promise((resolve) => { authReadyResolve = resolve; });

onAuthStateChanged(auth, (user) => {
  if (user) authReadyResolve(user);
});

signInAnonymously(auth).catch((err) => {
  console.error("LabSDK: anonymous sign-in failed", err);
});

function waitForAuth() {
  return authReady;
}

// ---- Username modal ----

const LOCAL_UID_KEY = "labsdk_uid";
const LOCAL_HANDLE_KEY = "labsdk_handle";

function showHandleModal({ errorMessage } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
      z-index: 999999; font-family: sans-serif;
    `;
    overlay.innerHTML = `
      <div style="background:#fff; padding:24px; border-radius:12px; width:300px; max-width:90vw; text-align:center;">
        <h2 style="margin:0 0 8px; font-size:18px; color:#111;">Choose your player name</h2>
        <p style="margin:0 0 12px; font-size:13px; color:#555;">
          This is permanent and used across all Launch Lab games. No real names.
        </p>
        ${errorMessage ? `<p style="color:#c0392b; font-size:13px; margin:0 0 8px;">${errorMessage}</p>` : ""}
        <input id="labsdk-handle-input" type="text" maxlength="20" placeholder="e.g. mathwizard42"
          style="width:100%; box-sizing:border-box; padding:8px; font-size:14px; border:1px solid #ccc; border-radius:6px; margin-bottom:12px;" />
        <button id="labsdk-handle-submit"
          style="width:100%; padding:10px; font-size:14px; background:#2d6cdf; color:#fff; border:none; border-radius:6px; cursor:pointer;">
          Confirm
        </button>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector("#labsdk-handle-input");
    const button = overlay.querySelector("#labsdk-handle-submit");
    input.focus();

    function submit() {
      const val = input.value.trim();
      if (val.length < 3 || val.length > 20) {
        alert("Name must be 3-20 characters.");
        return;
      }
      if (!/^[a-zA-Z0-9_]+$/.test(val)) {
        alert("Letters, numbers, and underscores only.");
        return;
      }
      document.body.removeChild(overlay);
      resolve(val);
    }

    button.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  });
}

// ---- Claim a handle atomically ----

async function claimHandle(uid, handle) {
  const handleRef = doc(db, "handles", handle);
  const userRef = doc(db, "usernames", uid);

  await runTransaction(db, async (tx) => {
    const handleSnap = await tx.get(handleRef);
    if (handleSnap.exists()) {
      throw new Error("TAKEN");
    }
    tx.set(handleRef, { uid, created_at: serverTimestamp() });
    tx.set(userRef, { handle, created_at: serverTimestamp() });
  });
}

// ---- Public API ----

async function getHandle() {
  const user = await waitForAuth();
  const uid = user.uid;

  // Fast path: cached locally for this exact uid
  if (localStorage.getItem(LOCAL_UID_KEY) === uid) {
    const cached = localStorage.getItem(LOCAL_HANDLE_KEY);
    if (cached) return cached;
  }

  // Check Firestore for an existing handle tied to this uid
  const userRef = doc(db, "usernames", uid);
  const snap = await getDoc(userRef);
  if (snap.exists()) {
    const handle = snap.data().handle;
    localStorage.setItem(LOCAL_UID_KEY, uid);
    localStorage.setItem(LOCAL_HANDLE_KEY, handle);
    return handle;
  }

  // No handle yet — prompt, retry on collision
  let errorMessage;
  while (true) {
    const candidate = await showHandleModal({ errorMessage });
    try {
      await claimHandle(uid, candidate);
      localStorage.setItem(LOCAL_UID_KEY, uid);
      localStorage.setItem(LOCAL_HANDLE_KEY, candidate);
      return candidate;
    } catch (err) {
      errorMessage = err.message === "TAKEN"
        ? `"${candidate}" is already taken. Try another.`
        : "Something went wrong. Try again.";
      console.error("LabSDK: failed to claim handle", err);
    }
  }
}

// Records a play in the permanent log, AND updates the student's
// best-score row for this game if this score beats their previous best.
// `meta` is optional — any extra JSON you want attached to this one play
// (level reached, time taken, etc.) for later analysis. Only `score`
// drives ranking.
async function recordScore(gameId, score, meta = {}) {
  const user = await waitForAuth();
  const handle = await getHandle();

  // 1. Permanent raw log — every play, never overwritten.
  await addDoc(collection(db, "game_data"), {
    game_id: gameId,
    uid: user.uid,
    handle,
    score,
    meta,
    created_at: serverTimestamp()
  });

  // 2. Best-score row — upsert only if this beats their prior best.
  const lbRef = doc(db, "leaderboards", `${gameId}_${user.uid}`);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(lbRef);
    if (!snap.exists() || score > snap.data().best_score) {
      tx.set(lbRef, {
        game_id: gameId,
        uid: user.uid,
        handle,
        best_score: score,
        updated_at: serverTimestamp()
      });
    }
  });
}

// Top N players for one game, by best score.
async function getGameLeaderboard(gameId, max = 10) {
  const q = query(
    collection(db, "leaderboards"),
    where("game_id", "==", gameId),
    orderBy("best_score", "desc"),
    fbLimit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

// This player's rank in one game (1 = first place). Returns null if
// they haven't recorded a score for this game yet.
async function getMyRank(gameId) {
  const user = await waitForAuth();
  const myRef = doc(db, "leaderboards", `${gameId}_${user.uid}`);
  const mySnap = await getDoc(myRef);
  if (!mySnap.exists()) return null;

  const myScore = mySnap.data().best_score;
  const higherQuery = query(
    collection(db, "leaderboards"),
    where("game_id", "==", gameId),
    where("best_score", ">", myScore)
  );
  const countSnap = await getCountFromServer(higherQuery);
  return countSnap.data().count + 1;
}

// This player's rank across EVERY game they've played — the data
// a cross-game "my stats" / profile page needs, in one call.
// Returns: [{ game_id, best_score, rank, total_players }, ...]
async function getMyStats() {
  const user = await waitForAuth();
  const q = query(collection(db, "leaderboards"), where("uid", "==", user.uid));
  const snap = await getDocs(q);
  const entries = snap.docs.map((d) => d.data());

  return Promise.all(
    entries.map(async (entry) => {
      const higherQuery = query(
        collection(db, "leaderboards"),
        where("game_id", "==", entry.game_id),
        where("best_score", ">", entry.best_score)
      );
      const totalQuery = query(
        collection(db, "leaderboards"),
        where("game_id", "==", entry.game_id)
      );
      const [higherSnap, totalSnap] = await Promise.all([
        getCountFromServer(higherQuery),
        getCountFromServer(totalQuery)
      ]);
      return {
        game_id: entry.game_id,
        best_score: entry.best_score,
        rank: higherSnap.data().count + 1,
        total_players: totalSnap.data().count
      };
    })
  );
}

window.LabSDK = {
  getHandle,
  recordScore,
  getGameLeaderboard,
  getMyRank,
  getMyStats
};
