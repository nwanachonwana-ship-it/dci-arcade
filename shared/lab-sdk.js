// Launch Lab Arcade — shared SDK
// Include in any game with:
//   <script type="module" src="https://<you>.github.io/launch-lab-arcade/shared/lab-sdk.js"></script>
// Then use:
//   LabSDK.getHandle()                  — permanent player name
//   LabSDK.recordScore(gameId, score)   — logs the play AND updates best-score leaderboard
//   LabSDK.getGameLeaderboard(gameId)   — top N players for one game
//   LabSDK.getMyRank(gameId)            — this player's rank in one game
//   LabSDK.getMyStats()                 — this player's rank across EVERY game they've played
//   LabSDK.getArcadePoints()            — this player's total placement-based points across all games
//   LabSDK.getGlobalLeaderboard()       — top players site-wide, ranked by total Arcade Points
//   LabSDK.getMyGlobalRank()            — this player's own site-wide rank, even outside the top N
// recordScore() also shows a brief on-screen toast with the result, so
// players get instant feedback without needing to visit a stats page.

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
  getDocs,
  addDoc,
  serverTimestamp
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

// ---- On-screen toast (so a score never records silently) ----
// Optionally includes a built-in Share button — this is the main lever
// for word-of-mouth growth: every good score becomes a one-tap invite
// back to the exact game that produced it, with no per-game code needed.

function showToast(message, shareText) {
  const el = document.createElement("div");
  el.style.cssText = `
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%) translateY(-20px);
    background: #1a1d24; color: #fff; padding: 14px 18px; border-radius: 10px;
    font-family: -apple-system, sans-serif; font-size: 14px; font-weight: 600;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35); z-index: 999999;
    opacity: 0; transition: opacity 0.25s ease, transform 0.25s ease;
    max-width: 90vw; text-align: center; pointer-events: auto;
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center;
  `;

  const msgSpan = document.createElement("span");
  msgSpan.textContent = message;
  el.appendChild(msgSpan);

  if (shareText) {
    const shareBtn = document.createElement("button");
    shareBtn.textContent = "📤 Share";
    shareBtn.style.cssText = `
      background: #d62f2f; color: #fff; border: none; border-radius: 999px;
      padding: 5px 14px; font-size: 13px; font-weight: 700; cursor: pointer;
      font-family: inherit; white-space: nowrap;
    `;
    shareBtn.addEventListener("click", async () => {
      const url = window.location.href;
      try {
        if (navigator.share) {
          await navigator.share({ title: "DCI Arcade", text: shareText, url });
        } else if (navigator.clipboard) {
          await navigator.clipboard.writeText(`${shareText} ${url}`);
          shareBtn.textContent = "Copied! ✅";
          setTimeout(() => { shareBtn.textContent = "📤 Share"; }, 1800);
        }
      } catch (e) {
        // user cancelled the native share sheet — not an error worth logging
      }
    });
    el.appendChild(shareBtn);
  }

  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateX(-50%) translateY(0)";
  });
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(-20px)";
    setTimeout(() => el.remove(), 300);
  }, 6000);
}

// Records a play in the permanent log, AND updates the student's
// best-score row for this game if this score beats their previous best.
// `meta` is optional — any extra JSON you want attached to this one play
// (level reached, time taken, etc.) for later analysis. Only `score`
// drives ranking. Shows an on-screen toast with the result automatically.
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
  let isNewBest = false;
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(lbRef);
    if (!snap.exists() || score > snap.data().best_score) {
      isNewBest = true;
      tx.set(lbRef, {
        game_id: gameId,
        uid: user.uid,
        handle,
        best_score: score,
        updated_at: serverTimestamp()
      });
    }
  });

  // 3. Immediate feedback — fetch rank right after and show it on screen,
  // with a one-tap Share so a good run can turn into a new player.
  try {
    const rows = await fetchGameRows(gameId);
    const ranked = rankEntries(rows);
    const mine = ranked.find((r) => r.uid === user.uid);
    const rank = mine ? mine.rank : 1;
    const total = ranked.length;
    const prefix = isNewBest ? "🏆 New best!" : "Score saved.";
    showToast(
      `${prefix} Rank #${rank} of ${total} — ${score} pts`,
      `I just scored ${score} and ranked #${rank} of ${total} on ${gameId} in DCI Arcade. Think you can beat me?`
    );
  } catch (e) {
    console.error("LabSDK: toast feedback failed", e);
    showToast(`Score saved: ${score} pts`);
  }
}

// Shared internal helpers — every ranking function in this file reads
// via a plain equality-only query (`where game_id == X`, nothing else)
// and ranks client-side afterward. Firestore always serves an
// equality-only query with its automatic single-field index, so none
// of this ever depends on a manually-created composite index existing
// (or being rebuilt after someone edits rules). Sorting/ranking a few
// hundred rows in JS is instant at classroom scale.

async function fetchGameRows(gameId) {
  const q = query(collection(db, "leaderboards"), where("game_id", "==", gameId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

// Sorts by best_score desc and tags each row with a tie-aware rank —
// equal scores share the same rank (1,1,3,4...).
function rankEntries(rows) {
  const sorted = [...rows].sort((a, b) => b.best_score - a.best_score);
  let rank = 0, lastScore = null, seen = 0;
  sorted.forEach((r) => {
    seen++;
    if (r.best_score !== lastScore) { rank = seen; lastScore = r.best_score; }
    r.rank = rank;
  });
  return sorted;
}

// Top N players for one game, by best score. Ranks are tie-aware —
// equal scores share the same rank, matching how getMyRank computes
// rank everywhere else, so a player never sees a different rank on
// their own stats than on this public board.
async function getGameLeaderboard(gameId, max = 10) {
  const rows = await fetchGameRows(gameId);
  return rankEntries(rows).slice(0, max);
}

// This player's rank in one game (1 = first place). Returns null if
// they haven't recorded a score for this game yet.
async function getMyRank(gameId) {
  const user = await waitForAuth();
  const rows = await fetchGameRows(gameId);
  const ranked = rankEntries(rows);
  const mine = ranked.find((r) => r.uid === user.uid);
  return mine ? mine.rank : null;
}

// This player's rank across EVERY game they've played — the data
// a cross-game "my stats" / profile page needs. Pulls the WHOLE
// leaderboards collection once (same proven pattern as the Hall of
// Fame page) rather than one query per game, so this is a single
// network round trip regardless of how many games this player has
// played.
// Returns: [{ game_id, best_score, rank, total_players }, ...]
async function getMyStats() {
  const user = await waitForAuth();
  const snap = await getDocs(collection(db, "leaderboards"));
  const allRows = snap.docs.map((d) => d.data());

  const byGame = {};
  allRows.forEach((r) => {
    if (!byGame[r.game_id]) byGame[r.game_id] = [];
    byGame[r.game_id].push(r);
  });

  const myGameIds = allRows.filter((r) => r.uid === user.uid).map((r) => r.game_id);

  return myGameIds.map((gameId) => {
    const ranked = rankEntries(byGame[gameId]);
    const mine = ranked.find((r) => r.uid === user.uid);
    return {
      game_id: gameId,
      best_score: mine.best_score,
      rank: mine.rank,
      total_players: ranked.length
    };
  });
}

// Converts a rank (out of totalPlayers) into Arcade Points.
// Placement-based, not score-based — a 1st place is worth the same
// whether 3 people played that game or 300. Keeps every game
// comparable regardless of its own scoring scale.
function pointsForRank(rank, totalPlayers) {
  if (rank === 1) return 10;
  if (rank === 2) return 7;
  if (rank === 3) return 5;
  if (rank <= Math.ceil(totalPlayers / 2)) return 3;
  return 1;
}

// This player's Arcade Rating: their AVERAGE placement-points per game
// played, not the sum. Averaging (rather than summing) means playing
// more games never inflates your rating on its own — only actually
// placing well does. A player who's great at one game can outrank
// someone who's just played a lot of games without doing well in them.
// Returns: { rating, breakdown: [{ game_id, rank, total_players, points }, ...] }
async function getArcadePoints() {
  const stats = await getMyStats();
  const breakdown = stats.map(s => ({
    game_id: s.game_id,
    rank: s.rank,
    total_players: s.total_players,
    points: pointsForRank(s.rank, s.total_players)
  }));
  const sum = breakdown.reduce((total, b) => total + b.points, 0);
  const rating = breakdown.length ? +(sum / breakdown.length).toFixed(1) : 0;
  return { rating, breakdown };
}

// Shared internal helper: pulls the whole leaderboards collection once
// and computes each player's Arcade Rating (AVERAGE placement-points
// per game, not a sum) site-wide. Both getGlobalLeaderboard and
// getMyGlobalRank build on this so the ranking logic only lives in one
// place. Sorted by rating first; players tied on rating are broken by
// who's proven it across more games.
async function computeAllTotals() {
  const snap = await getDocs(collection(db, "leaderboards"));
  const allEntries = snap.docs.map((d) => d.data());

  const byGame = {};
  allEntries.forEach((e) => {
    if (!byGame[e.game_id]) byGame[e.game_id] = [];
    byGame[e.game_id].push(e);
  });

  const totals = {}; // uid -> { uid, handle, total_points, games_played }
  Object.values(byGame).forEach((entries) => {
    // Tie-aware rank within this game (shared with every other ranking
    // function): equal scores earn equal points, rather than whichever
    // player's row Firestore happened to return first.
    const ranked = rankEntries(entries);
    const totalPlayers = ranked.length;
    ranked.forEach((entry) => {
      const points = pointsForRank(entry.rank, totalPlayers);
      if (!totals[entry.uid]) {
        totals[entry.uid] = { uid: entry.uid, handle: entry.handle, total_points: 0, games_played: 0 };
      }
      totals[entry.uid].total_points += points;
      totals[entry.uid].games_played += 1;
      totals[entry.uid].handle = entry.handle; // keep freshest handle
    });
  });

  const withRating = Object.values(totals)
    .map((p) => ({ ...p, rating: +(p.total_points / p.games_played).toFixed(1) }))
    .sort((a, b) => b.rating - a.rating || b.games_played - a.games_played);

  // Site-wide rank is based on rating ALONE — if two players show the
  // same rating, they share the same rank and the same medal, full
  // stop. games_played only decided their left-to-right SORT ORDER
  // above (so a proven 10.0 lists before a one-game 10.0), it never
  // invents a different rank for an identical number on screen.
  let rank = 0, lastRating = null, seen = 0;
  withRating.forEach((p) => {
    seen++;
    if (p.rating !== lastRating) { rank = seen; lastRating = p.rating; }
    p.rank = rank;
  });

  return withRating;
}

// Top players site-wide, ranked by Arcade Rating (average points per
// game played) — NOT total points, so playing more games never inflates
// your spot on its own.
// Returns: [{ uid, handle, rating, total_points, games_played }, ...]
async function getGlobalLeaderboard(max = 20) {
  const sorted = await computeAllTotals();
  return sorted.slice(0, max);
}

// This player's own site-wide rank and Arcade Rating, even when they're
// well outside the top N shown on the public leaderboard. This is what
// powers a "you are #47 of 230" callout without needing to pull 47 rows
// just to count them.
// Returns: { rank, rating, total_points, games_played, total_players }
// or null if this player hasn't recorded a score anywhere yet.
async function getMyGlobalRank() {
  const user = await waitForAuth();
  const sorted = await computeAllTotals();
  const mine = sorted.find((p) => p.uid === user.uid);
  if (!mine) return null;
  return {
    rank: mine.rank,
    rating: mine.rating,
    total_points: mine.total_points,
    games_played: mine.games_played,
    total_players: sorted.length
  };
}

window.LabSDK = {
  getHandle,
  recordScore,
  getGameLeaderboard,
  getMyRank,
  getMyStats,
  getArcadePoints,
  getGlobalLeaderboard,
  getMyGlobalRank
};
