'use strict';

/* ============================================================
   Offline support (service worker)
   ============================================================ */

/* Registered here, before any game code runs, and deliberately not from inside
   init(): this used to be the last statement of init(), so any earlier failure
   -- a corrupt saved game, an unexpected DOM state -- skipped it silently. The
   game still worked while online, and then the first launch without wifi hit
   the browser's "no internet" page, because nothing had ever been cached. */
function registerWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => null);
}
registerWorker();

/* Ask the browser to keep this game for good.

   Without this the stored copy is "best effort": the browser is free to throw
   it away whenever the tablet runs low on space or does a periodic cleanup of
   sites it thinks are idle, and it throws away the whole site at once -- the
   cached files AND the service worker that serves them. That is what turns a
   game that worked offline for weeks into "Tento web není dostupný": nothing
   broke in the game, the tablet simply deleted it while nobody was looking.

   The quota is per site, and all the games live on the same one, so a single
   cleanup takes every one of them down together -- and grants made here cover
   every one of them together too. */
async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return null; // unknown
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (e) {
    return null;
  }
}

/* Say on the start screen what is actually stored, so it is visible when it is
   safe to close the game or switch wifi off -- and visible when it is not.
   On its own load listener, so a failure in init() cannot take it down. */
const OFFLINE_MESSAGES = {
  saving:  { text: 'Ukládám hru do tabletu…', cls: 'offline-working' },
  ready:   { text: '✓ Hra je uložena v tabletu – funguje i bez internetu', cls: 'offline-ok' },
  fragile: { text: '✓ Hra je uložena, ale tablet ji může smazat. Přidejte si hru na plochu (v prohlížeči nabídka ⋮ → Přidat na plochu) a bude uložena natrvalo.', cls: 'offline-warn' },
  failed:  { text: '⚠ Hru se zatím nepodařilo uložit do tabletu. Připojte se k internetu a spusťte ji znovu – bez toho nebude fungovat offline.', cls: 'offline-bad' },
};

let offlineStatusKey = 'saving'; // matches what index.html starts out saying

function setOfflineStatus(key) {
  const el = document.getElementById('offline-ready');
  const msg = OFFLINE_MESSAGES[key];
  if (!el || !msg) return;
  offlineStatusKey = key;
  el.textContent = msg.text;
  el.className = 'offline-ready ' + msg.cls;
  el.hidden = false; // the games hide this line either way round
}

const OFFLINE_NEEDED = ['./index.html', './style.css', './app.js'];

async function cachedFilesPresent() {
  const hits = await Promise.all(OFFLINE_NEEDED.map(u => caches.match(u, { ignoreSearch: true })));
  return hits.every(Boolean);
}

let verifyRunning = false;

async function verifyOfflineReady() {
  if (!('caches' in window) || !('serviceWorker' in navigator)) {
    // Nothing can be stored here, so promising anything would be a lie.
    const el = document.getElementById('offline-ready');
    if (el) { el.hidden = true; el.classList.add('hidden'); }
    return;
  }
  if (verifyRunning) return;
  verifyRunning = true;
  /* Re-checks happen every time the game is reopened. Only say "saving" again
     if the last word on the subject was that it had not worked -- otherwise a
     message that already reads "stored" would flicker back for no reason. */
  if (offlineStatusKey === 'failed') setOfflineStatus('saving');
  let persisted = await requestPersistentStorage();
  let asked = 0;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      let reg = null;
      try { reg = await navigator.serviceWorker.getRegistration('./'); } catch (e) { return; }
      /* The registration itself can be gone -- cleared with the rest of the
         site's storage. Put it back; offline this fails harmlessly and the
         next launch with wifi gets another go. */
      if (!reg) reg = await registerWorker();

      let present = false;
      try { present = await cachedFilesPresent(); } catch (e) { return; }
      const worker = (reg && (reg.active || reg.waiting)) || navigator.serviceWorker.controller;

      if (present && worker) {
        /* Chrome only grants persistence once the game has been used enough or
           added to the home screen, so a refusal early on is worth retrying. */
        if (persisted !== true) persisted = await requestPersistentStorage();
        setOfflineStatus(persisted === false ? 'fragile' : 'ready');
        return;
      }

      /* Registered but the files are missing -- evicted, or an install that
         never finished. Ask the worker to stock up again. Asked more than once,
         spaced out, because the first attempt may have been made offline. */
      if (worker && asked < 4 && attempt % 5 === 4) {
        asked++;
        worker.postMessage('ensure-cache');
      }
      await new Promise(r => setTimeout(r, 500));
    }
    setOfflineStatus('failed');
  } finally {
    verifyRunning = false;
  }
}

/* Shown on the start screen. Without it there is no way to tell, from the tablet
   itself, whether an update ever arrived: every line the start screen used to
   have reads exactly the same before and after one. A version that is missing
   altogether is the old build, which had nowhere to print it. */
const APP_VERSION = '18. 9. 2026';

function showVersion() {
  const el = document.getElementById('app-version');
  if (el) el.textContent = 'verze ' + APP_VERSION;
}
document.addEventListener('DOMContentLoaded', showVersion);

/* An update reaches the tablet as new files in the cache, but the page in front
   of the player goes on running the old ones until something reloads it, so it
   used to take a second launch before an update was the thing being played --
   and on a tablet opened once a day, that is a day late, with no way to tell
   which of the two launches you are on.

   The reload is driven from the worker rather than from here, because the page
   that needs replacing is by definition running the previous build: whatever we
   write here can only ever help the update after this one. All this side does is
   answer the question the worker asks first, so a game in progress is left alone
   and only an idle start screen gets refreshed underneath. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (!event.data || event.data.type !== 'may-i-refresh') return;
    const port = event.ports && event.ports[0];
    const start = document.getElementById('screen-start');
    const midGame = !!start && !start.classList.contains('active');
    if (port) port.postMessage({ busy: midGame });
  });
}

window.addEventListener('load', verifyOfflineReady);
/* A launch with no wifi cannot store anything. Try again the moment there is a
   connection, instead of waiting for the next launch that may never come. */
window.addEventListener('online', verifyOfflineReady);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) verifyOfflineReady();
});

/* ============================================================
   Constants
   ============================================================ */

const SUITS = ['H', 'D', 'S', 'C'];
const FOUND_SUITS = ['H', 'S', 'D', 'C']; // visual order of the 4 foundation slots

const STAGE_W = 2560, STAGE_H = 1600;
const TOOLBAR_H = 170;
const CARD_W = 300, CARD_H = 420;
const MARGIN_X = 60;
const GAP_X = (STAGE_W - 2 * MARGIN_X - 7 * CARD_W) / 6;
const ROW1_Y = 40;
const TABLEAU_Y = ROW1_Y + CARD_H + 70;
const BOTTOM_MARGIN = 40;
const BOARD_H = STAGE_H - TOOLBAR_H;
const TABLEAU_BUDGET = BOARD_H - TABLEAU_Y - BOTTOM_MARGIN;
const FACEDOWN_OFFSET = 50;
const FACEUP_OFFSET = 88;
const FAN_STEP = 70;

const SAVE_KEY = 'pasians_save_v1';
const STATS_KEY = 'pasians_stats_v1';
const SETTINGS_KEY = 'pasians_settings_v1';

function colX(i) { return MARGIN_X + i * (CARD_W + GAP_X); }
const STOCK_X = colX(0), WASTE_X = colX(1);
function foundX(i) { return colX(3 + i); }
function tableauX(i) { return colX(i); }

function rankLabel(r) {
  if (r === 1) return 'A';
  if (r === 11) return 'J';
  if (r === 12) return 'Q';
  if (r === 13) return 'K';
  return String(r);
}
function suitColor(suit) { return (suit === 'H' || suit === 'D') ? 'red' : 'black'; }

function suitShapeMarkup(suit) {
  switch (suit) {
    case 'S':
      return '<polygon points="50,4 14,62 86,62"/><circle cx="28" cy="60" r="24"/><circle cx="72" cy="60" r="24"/>' +
             '<polygon points="43,58 57,58 50,88"/><polygon points="50,78 28,97 72,97"/>';
    case 'H':
      return '<circle cx="30" cy="35" r="23"/><circle cx="70" cy="35" r="23"/><polygon points="10,42 90,42 50,96"/>';
    case 'D':
      return '<polygon points="50,4 90,50 50,96 10,50"/>';
    case 'C':
      return '<circle cx="50" cy="28" r="23"/><circle cx="26" cy="55" r="23"/><circle cx="74" cy="55" r="23"/>' +
             '<polygon points="43,55 57,55 50,88"/><polygon points="50,78 28,97 72,97"/>';
    default:
      return '';
  }
}
function suitSvg(suit, cls) {
  return `<svg class="${cls}" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">${suitShapeMarkup(suit)}</svg>`;
}

/* ============================================================
   Deck / dealing
   ============================================================ */

function getSecureRandomInt(maxExclusive) {
  if (window.crypto && window.crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(4294967296 / maxExclusive) * maxExclusive;
    let x;
    do { window.crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}
function shuffleDeck(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const r = getSecureRandomInt(i + 1);
    [arr[i], arr[r]] = [arr[r], arr[i]];
  }
  return arr;
}

function dealNewGame(drawCount) {
  const deck = [];
  for (const s of SUITS) for (let r = 1; r <= 13; r++) deck.push({ suit: s, rank: r });
  shuffleDeck(deck);

  const tableau = [[], [], [], [], [], [], []];
  for (let c = 0; c < 7; c++) {
    for (let k = 0; k <= c; k++) {
      const card = deck.pop();
      tableau[c].push({ suit: card.suit, rank: card.rank, faceUp: k === c });
    }
  }
  const stock = deck.map(c => ({ suit: c.suit, rank: c.rank }));

  return {
    tableau,
    foundations: { H: 0, D: 0, S: 0, C: 0 },
    waste: [],
    stock,
    drawCount,
    moveCount: 0,
    hintsUsed: 0,
    playedMs: 0,
    startedAt: Date.now(),
    finished: false,
  };
}

/* ============================================================
   Persistence
   ============================================================ */

/* The play time is kept as a total of finished segments plus the one running
   since `startedAt`, because the app can be closed at any moment. Every save
   closes the running segment, which keeps the stored total honest without
   needing to know when the tablet gets switched off. */
function elapsedPlayMs() {
  return (state.playedMs || 0) + Math.max(0, Date.now() - state.startedAt);
}

function persistCurrentGame() {
  if (!state) return;
  state.playedMs = elapsedPlayMs();
  state.startedAt = Date.now();
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* ignore quota errors */ }
}
function loadSavedGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearSaveGame() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return { drawCount: parsed.drawCount === 3 ? 3 : 1 };
  } catch (e) { return { drawCount: 1 }; }
}
function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
}

function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveStats(stats) {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) { /* ignore */ }
}
function recordStatEntry(won) {
  const stats = loadStats();
  stats.push({ ts: Date.now(), won, moves: state.moveCount, hints: state.hintsUsed });
  saveStats(stats);
}

/* ============================================================
   Game state & rules
   ============================================================ */

let state = null;
let historyStack = [];
let selection = null;
let lastTap = null;
let settings = loadSettings();

// `pos` lets the rules be asked about a hypothetical position (see hasProgressAhead)
function canCardGoToFoundation(card, pos = state) {
  return pos.foundations[card.suit] === card.rank - 1;
}
function canCardGoToTableauCol(card, colIndex, pos = state) {
  const col = pos.tableau[colIndex];
  if (col.length === 0) return card.rank === 13;
  const top = col[col.length - 1];
  return top.faceUp && top.rank === card.rank + 1 && suitColor(top.suit) !== suitColor(card.suit);
}
function isValidRunSuffix(col, idx) {
  for (let i = idx; i < col.length - 1; i++) {
    const a = col[i], b = col[i + 1];
    if (!a.faceUp || !b.faceUp) return false;
    if (a.rank !== b.rank + 1 || suitColor(a.suit) === suitColor(b.suit)) return false;
  }
  return true;
}
function autoFlipTop(colIndex) {
  const col = state.tableau[colIndex];
  if (col.length) col[col.length - 1].faceUp = true;
}

function findCardLocation(id) {
  const suit = id[0], rank = parseInt(id.slice(1), 10);
  let i = state.stock.findIndex(c => c.suit === suit && c.rank === rank);
  if (i >= 0) return { type: 'stock', idx: i };
  i = state.waste.findIndex(c => c.suit === suit && c.rank === rank);
  if (i >= 0) return { type: 'waste', idx: i };
  for (let c = 0; c < 7; c++) {
    const idx = state.tableau[c].findIndex(cd => cd.suit === suit && cd.rank === rank);
    if (idx >= 0) return { type: 'tableau', col: c, idx };
  }
  if (state.foundations[suit] >= rank && rank >= 1) return { type: 'foundation', suit, rank };
  return null;
}

function selectionKey(info) {
  if (!info) return '';
  return `${info.type}:${info.col ?? ''}:${info.idx ?? ''}:${info.suit ?? ''}`;
}

/* ---------- Move dispatch ---------- */

function attemptMove(from, to) {
  if (!from || !to) return false;
  let card;
  if (from.type === 'tableau') {
    const col = state.tableau[from.col];
    if (from.idx < 0 || from.idx >= col.length || !col[from.idx].faceUp) return false;
    card = col[from.idx];
  } else if (from.type === 'waste') {
    if (!state.waste.length) return false;
    card = state.waste[state.waste.length - 1];
  } else if (from.type === 'foundation') {
    if (state.foundations[from.suit] === 0) return false;
    card = { suit: from.suit, rank: state.foundations[from.suit] };
  } else {
    return false;
  }

  if (to.type === 'foundation') {
    if (from.type === 'tableau' && from.idx !== state.tableau[from.col].length - 1) return false;
    if (from.type === 'foundation') return false;
    if (!canCardGoToFoundation(card)) return false;
    pushHistory();
    if (from.type === 'tableau') { state.tableau[from.col].pop(); autoFlipTop(from.col); }
    else { state.waste.pop(); }
    state.foundations[card.suit] = card.rank;
    finalizeMove();
    return true;
  }

  if (to.type === 'tableau') {
    if (from.type === 'foundation') {
      if (!canCardGoToTableauCol(card, to.col)) return false;
      pushHistory();
      state.foundations[from.suit] = card.rank - 1;
      state.tableau[to.col].push({ suit: card.suit, rank: card.rank, faceUp: true });
      finalizeMove();
      return true;
    }
    if (from.type === 'waste') {
      if (!canCardGoToTableauCol(card, to.col)) return false;
      pushHistory();
      state.waste.pop();
      state.tableau[to.col].push({ suit: card.suit, rank: card.rank, faceUp: true });
      finalizeMove();
      return true;
    }
    if (from.type === 'tableau') {
      if (from.col === to.col) return false;
      const col = state.tableau[from.col];
      if (!isValidRunSuffix(col, from.idx)) return false;
      const headCard = col[from.idx];
      if (!canCardGoToTableauCol(headCard, to.col)) return false;
      pushHistory();
      const moving = col.splice(from.idx);
      state.tableau[to.col].push(...moving);
      autoFlipTop(from.col);
      finalizeMove();
      return true;
    }
  }
  return false;
}

function finalizeMove() {
  state.moveCount++;
  persistCurrentGame();
  renderAll();
  checkWinCondition();
  maybeFlagNoMoves();
  maybeAutoFinish();
}

function pushHistory() {
  historyStack.push(JSON.stringify({
    tableau: state.tableau, foundations: state.foundations,
    waste: state.waste, stock: state.stock,
    moveCount: state.moveCount, hintsUsed: state.hintsUsed,
  }));
  if (historyStack.length > 500) historyStack.shift();
}

function undo() {
  if (inputLocked() || !historyStack.length) return;
  const snap = JSON.parse(historyStack.pop());
  state.tableau = snap.tableau;
  state.foundations = snap.foundations;
  state.waste = snap.waste;
  state.stock = snap.stock;
  state.moveCount = snap.moveCount;
  state.hintsUsed = snap.hintsUsed;
  clearSelection();
  clearHintHighlights();
  persistCurrentGame();
  renderAll();
  maybeFlagNoMoves();
}

function onStockClick() {
  if (inputLocked()) return;
  hideNoMovesOverlay();
  clearSelection();
  if (state.stock.length === 0 && state.waste.length === 0) return;
  pushHistory();
  if (state.stock.length === 0) {
    state.stock = state.waste.slice().reverse();
    state.waste = [];
  } else {
    const n = Math.min(state.drawCount, state.stock.length);
    for (let i = 0; i < n; i++) state.waste.push(state.stock.pop());
  }
  state.moveCount++;
  persistCurrentGame();
  renderAll();
  maybeFlagNoMoves();
}

function tryAutoFoundation(sourceInfo) {
  if (sourceInfo.type === 'foundation') return;
  if (attemptMove(sourceInfo, { type: 'foundation' })) {
    clearSelection();
    renderSelectionHighlight();
  }
}

/* ---------- Win / stuck detection ---------- */

function checkWinCondition() {
  if (!state || state.finished) return;
  const won = SUITS.every(s => state.foundations[s] === 13);
  if (!won) return;
  state.finished = true;
  recordStatEntry(true);
  clearSaveGame();
  showWinOverlay();
}

function findImmediateMove() {
  for (let c = 0; c < 7; c++) {
    const col = state.tableau[c];
    if (col.length) {
      const top = col[col.length - 1];
      if (top.faceUp && canCardGoToFoundation(top)) return { from: { type: 'tableau', col: c, idx: col.length - 1 }, to: { type: 'foundation' } };
    }
  }
  if (state.waste.length) {
    const top = state.waste[state.waste.length - 1];
    if (canCardGoToFoundation(top)) return { from: { type: 'waste' }, to: { type: 'foundation' } };
  }
  for (let c = 0; c < 7; c++) {
    const col = state.tableau[c];
    for (let idx = col.length - 1; idx >= 0; idx--) {
      if (!col[idx].faceUp) break;
      if (!isValidRunSuffix(col, idx)) continue;
      const card = col[idx];
      for (let d = 0; d < 7; d++) {
        if (d === c) continue;
        if (canCardGoToTableauCol(card, d)) return { from: { type: 'tableau', col: c, idx }, to: { type: 'tableau', col: d } };
      }
    }
  }
  if (state.waste.length) {
    const top = state.waste[state.waste.length - 1];
    for (let d = 0; d < 7; d++) {
      if (canCardGoToTableauCol(top, d)) return { from: { type: 'waste' }, to: { type: 'tableau', col: d } };
    }
  }
  return null;
}

/* A dead game can still be full of legal moves: a red 7 hopping between two
   black 8s, the stock turning over and over. Only two events are ever real
   progress -- a card reaching a foundation, or a face-down card being turned
   over -- and every win needs the first one. So walk the reachable positions
   looking for either event; if neither can ever happen, the game is over no
   matter how many moves are still legal. Positions are visited at most once,
   which is what stops the futile shuffling from looking like a way forward.

   The budget is on the positions held in the queue, not on the ones taken off
   it. Every position is a full copy of the board and one expansion can push a
   hundred of them, so limiting expansions alone left the queue itself unbounded:
   a single tap could build over a hundred thousand copies and hold them all at
   once, which on a tablet meant seconds of work and a thrashing heap for every
   move of a game -- and the search runs after every move.

   Giving up early costs little, because it is the games that are still alive
   that explode: a dead position has nowhere to go, so the queue empties almost
   at once. And a search that hits the budget answers "playable", so any verdict
   of "no way forward" is by construction a search that finished inside it --
   over 26 games and 12676 searches, all 5012 such verdicts did. Past the budget
   the position counts as playable, which is the safe direction: an unfinished
   search must never trap the player behind the overlay. */
const PROGRESS_SEARCH_POSITION_LIMIT = 4000;

function progressPosition(src) {
  return {
    tableau: src.tableau.map(col => col.map(c => ({ suit: c.suit, rank: c.rank, faceUp: c.faceUp }))),
    foundations: Object.assign({}, src.foundations),
    stock: src.stock.map(c => ({ suit: c.suit, rank: c.rank })),
    waste: src.waste.map(c => ({ suit: c.suit, rank: c.rank })),
  };
}

function progressPositionKey(pos) {
  return pos.tableau.map(col => col.map(c => c.suit + c.rank + (c.faceUp ? '' : '#')).join()).join('|') +
    '/' + SUITS.map(suit => pos.foundations[suit]).join() +
    '/' + pos.stock.map(c => c.suit + c.rank).join() +
    '/' + pos.waste.map(c => c.suit + c.rank).join();
}

function foundationTotal(pos) {
  return SUITS.reduce((sum, suit) => sum + pos.foundations[suit], 0);
}

function hasProgressAhead() {
  const start = progressPosition(state);
  const startTotal = foundationTotal(start);
  const seen = new Set([progressPositionKey(start)]);
  const queue = [start];

  const push = next => {
    const key = progressPositionKey(next);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(next);
  };

  for (let head = 0; head < queue.length; head++) {
    // the queue is the budget: every entry in it is a full copy of the board
    if (queue.length >= PROGRESS_SEARCH_POSITION_LIMIT) return true;
    const pos = queue[head];

    // cards can also be taken back off a foundation, so putting one there only
    // counts once the pile is past where the search started
    const gains = foundationTotal(pos) + 1 > startTotal;
    const toFoundation = [];
    if (pos.waste.length && canCardGoToFoundation(pos.waste[pos.waste.length - 1], pos)) toFoundation.push(-1);
    for (let c = 0; c < 7; c++) {
      const col = pos.tableau[c];
      if (col.length && col[col.length - 1].faceUp && canCardGoToFoundation(col[col.length - 1], pos)) toFoundation.push(c);
    }
    if (toFoundation.length && gains) return true;
    for (const c of toFoundation) {
      const col = c >= 0 ? pos.tableau[c] : null;
      if (col && col.length >= 2 && !col[col.length - 2].faceUp) return true; // turns a card over
      const next = progressPosition(pos);
      const card = col ? next.tableau[c].pop() : next.waste.pop();
      next.foundations[card.suit] = card.rank;
      push(next);
    }

    for (let c = 0; c < 7; c++) {
      const col = pos.tableau[c];
      for (let idx = col.length - 1; idx >= 0; idx--) {
        if (!col[idx].faceUp) break;
        if (!isValidRunSuffix(col, idx)) continue;
        const turnsCardOver = idx > 0 && !col[idx - 1].faceUp;
        for (let d = 0; d < 7; d++) {
          if (d === c || !canCardGoToTableauCol(col[idx], d, pos)) continue;
          if (turnsCardOver) return true;
          const next = progressPosition(pos);
          next.tableau[d].push(...next.tableau[c].splice(idx));
          push(next);
        }
      }
    }

    if (pos.waste.length) {
      const top = pos.waste[pos.waste.length - 1];
      for (let d = 0; d < 7; d++) {
        if (!canCardGoToTableauCol(top, d, pos)) continue;
        const next = progressPosition(pos);
        next.tableau[d].push(Object.assign(next.waste.pop(), { faceUp: true }));
        push(next);
      }
    }

    // never progress in itself, but it is a legal move and may unlock one
    for (const suit of SUITS) {
      const rank = pos.foundations[suit];
      if (!rank) continue;
      for (let d = 0; d < 7; d++) {
        if (!canCardGoToTableauCol({ suit, rank }, d, pos)) continue;
        const next = progressPosition(pos);
        next.foundations[suit] = rank - 1;
        next.tableau[d].push({ suit, rank, faceUp: true });
        push(next);
      }
    }

    if (pos.stock.length || pos.waste.length) {
      const next = progressPosition(pos);
      if (!next.stock.length) {
        next.stock = next.waste.reverse();
        next.waste = [];
      } else {
        const n = Math.min(state.drawCount, next.stock.length);
        for (let i = 0; i < n; i++) next.waste.push(next.stock.pop());
      }
      push(next);
    }
  }
  return false;
}

function maybeFlagNoMoves() {
  if (!state || state.finished) return;
  if (hasProgressAhead()) hideNoMovesOverlay();
  else showNoMovesOverlay();
}

/* ---------- Automatic finish ---------- */

/* Once every card lies face up and the stock is gone, what is left is usually
   no game at all: the cards only have to be carried to the foundations in rank
   order, one tap each, with no decision anywhere in it. Play that out instead.

   The shape of the piles is not enough to tell when it is safe, because a card
   turned over early can end up buried under a higher run -- an 8 under K-Q-J --
   and no amount of tapping frees it. So walk the accessible cards greedily on a
   copy of the position and only take over when all four foundations really do
   fill up. Each step removes a card, so the walk cannot run away. */
function canAutoFinish() {
  if (!state || state.finished) return false;
  if (state.stock.length || state.waste.length) return false;
  if (state.tableau.some(col => col.some(c => !c.faceUp))) return false;

  const foundations = Object.assign({}, state.foundations);
  const cols = state.tableau.map(col => col.map(c => ({ suit: c.suit, rank: c.rank })));
  let moved = true;
  while (moved) {
    moved = false;
    for (const col of cols) {
      if (!col.length) continue;
      const card = col[col.length - 1];
      if (foundations[card.suit] !== card.rank - 1) continue;
      foundations[card.suit] = card.rank;
      col.pop();
      moved = true;
    }
  }
  return SUITS.every(suit => foundations[suit] === 13);
}

/* Slow enough that the cards are seen arriving, and it matches the card
   transition, so the movement stays continuous rather than stepping. */
const AUTO_FINISH_STEP_MS = 180;
let autoFinishTimer = null;

/* Taps are ignored while the cards are on their way, so a stray touch cannot
   reroute a game that is already decided. */
function inputLocked() {
  return !state || state.finished || autoFinishTimer !== null;
}

function maybeAutoFinish() {
  if (autoFinishTimer !== null || !canAutoFinish()) return;
  clearSelection();
  renderSelectionHighlight();
  clearHintHighlights();
  autoFinishTimer = setInterval(autoFinishStep, AUTO_FINISH_STEP_MS);
}

function autoFinishStep() {
  if (!state || state.finished) { cancelAutoFinish(); return; }
  for (let c = 0; c < 7; c++) {
    const col = state.tableau[c];
    if (!col.length || !canCardGoToFoundation(col[col.length - 1])) continue;
    attemptMove({ type: 'tableau', col: c, idx: col.length - 1 }, { type: 'foundation' });
    return;
  }
  cancelAutoFinish();
}

function cancelAutoFinish() {
  if (autoFinishTimer === null) return;
  clearInterval(autoFinishTimer);
  autoFinishTimer = null;
}

function findHintMove() {
  const mv = findImmediateMove();
  if (mv) return mv;
  if (state.stock.length > 0 || state.waste.length > 0) return { from: { type: 'stock' }, to: null };
  return null;
}

/* ============================================================
   Rendering
   ============================================================ */

let cardEls = {};

function buildStaticSlots() {
  const layer = document.getElementById('slots-layer');
  layer.innerHTML = '';

  const stockSlot = document.createElement('div');
  stockSlot.className = 'pile-slot stock-slot';
  stockSlot.style.left = STOCK_X + 'px';
  stockSlot.style.top = ROW1_Y + 'px';
  stockSlot.innerHTML = '<span class="stock-icon">↻</span>';
  layer.appendChild(stockSlot);

  const wasteSlot = document.createElement('div');
  wasteSlot.className = 'pile-slot waste-slot';
  wasteSlot.style.left = WASTE_X + 'px';
  wasteSlot.style.top = ROW1_Y + 'px';
  layer.appendChild(wasteSlot);

  for (let i = 0; i < 4; i++) {
    const slot = document.createElement('div');
    slot.className = 'pile-slot foundation-slot';
    slot.dataset.suit = FOUND_SUITS[i];
    slot.style.left = foundX(i) + 'px';
    slot.style.top = ROW1_Y + 'px';
    slot.innerHTML = suitSvg(FOUND_SUITS[i], 'slot-watermark');
    layer.appendChild(slot);
  }

  for (let i = 0; i < 7; i++) {
    const slot = document.createElement('div');
    slot.className = 'pile-slot tableau-slot';
    slot.dataset.col = String(i);
    slot.style.left = tableauX(i) + 'px';
    slot.style.top = TABLEAU_Y + 'px';
    layer.appendChild(slot);
  }
}

function buildCardEl(suit, rank) {
  const el = document.createElement('div');
  el.className = 'card face-down';
  el.dataset.id = suit + rank;
  el.dataset.suit = suit;
  el.dataset.rank = String(rank);
  const label = rankLabel(rank);
  el.innerHTML =
    `<div class="card-inner">
      <div class="card-face">
        <div class="idx idx-tl"><div class="rank">${label}</div>${suitSvg(suit, 'pip-mini')}</div>
        <div class="idx idx-br"><div class="rank">${label}</div>${suitSvg(suit, 'pip-mini')}</div>
        ${suitSvg(suit, 'pip-big')}
      </div>
      <div class="card-back"></div>
    </div>`;
  return el;
}

function buildCardElements() {
  const layer = document.getElementById('cards-layer');
  layer.innerHTML = '';
  cardEls = {};
  for (const s of SUITS) {
    for (let r = 1; r <= 13; r++) {
      const el = buildCardEl(s, r);
      layer.appendChild(el);
      cardEls[s + r] = el;
    }
  }
}

function tableauYPositions(col) {
  const n = col.length;
  if (n === 0) return [];
  const gaps = [];
  for (let k = 1; k < n; k++) gaps.push(col[k - 1].faceUp ? FACEUP_OFFSET : FACEDOWN_OFFSET);
  const gapSum = gaps.reduce((a, b) => a + b, 0);
  let scale = 1;
  const naiveHeight = gapSum + CARD_H;
  if (naiveHeight > TABLEAU_BUDGET && gapSum > 0) {
    const available = TABLEAU_BUDGET - CARD_H;
    scale = Math.max(0.26, available / gapSum);
  }
  const ys = [TABLEAU_Y];
  for (let k = 0; k < gaps.length; k++) ys.push(ys[ys.length - 1] + gaps[k] * scale);
  return ys;
}

function renderAll() {
  if (!state) return;
  let z = 1;
  const draggedIds = pointerState && pointerState.dragging
    ? new Set(pointerState.cardEls.map(el => el.dataset.id))
    : null;

  function place(card, x, y, faceUp) {
    const el = cardEls[card.suit + card.rank];
    if (draggedIds && draggedIds.has(el.dataset.id)) { z++; return; }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.zIndex = String(++z);
    el.classList.toggle('face-down', !faceUp);
  }

  for (const card of state.stock) place(card, STOCK_X, ROW1_Y, false);

  const wasteLen = state.waste.length;
  const fanN = state.drawCount === 3 ? Math.min(3, wasteLen) : Math.min(1, wasteLen);
  for (let i = 0; i < wasteLen; i++) {
    const fromTop = wasteLen - 1 - i;
    const fanIdx = fromTop < fanN ? (fanN - 1 - fromTop) : 0;
    place(state.waste[i], WASTE_X + fanIdx * FAN_STEP, ROW1_Y, true);
  }

  for (const suit of SUITS) {
    const top = state.foundations[suit];
    const slotIdx = FOUND_SUITS.indexOf(suit);
    for (let r = 1; r <= top; r++) place({ suit, rank: r }, foundX(slotIdx), ROW1_Y, true);
  }

  for (let c = 0; c < 7; c++) {
    const col = state.tableau[c];
    const ys = tableauYPositions(col);
    for (let idx = 0; idx < col.length; idx++) place(col[idx], tableauX(c), ys[idx], col[idx].faceUp);
  }

  document.getElementById('btn-undo').classList.toggle('btn-disabled', historyStack.length === 0);
  renderSelectionHighlight();
}

function renderSelectionHighlight() {
  document.querySelectorAll('.card.selected').forEach(el => el.classList.remove('selected'));
  if (!selection) return;
  collectSelectionEls(selection).forEach(el => el.classList.add('selected'));
}

function collectSelectionEls(info) {
  if (info.type === 'tableau') return state.tableau[info.col].slice(info.idx).map(c => cardEls[c.suit + c.rank]);
  if (info.type === 'waste') return state.waste.length ? [cardEls[state.waste[state.waste.length - 1].suit + state.waste[state.waste.length - 1].rank]] : [];
  if (info.type === 'foundation') return state.foundations[info.suit] ? [cardEls[info.suit + state.foundations[info.suit]]] : [];
  return [];
}

function clearSelection() { selection = null; }

/* ---------- Hint highlighting ---------- */

let hintTimeout = null;
function clearHintHighlights() {
  document.querySelectorAll('.hint-glow').forEach(el => el.classList.remove('hint-glow'));
  if (hintTimeout) { clearTimeout(hintTimeout); hintTimeout = null; }
}
function highlightHintTarget(slotSelector) {
  document.querySelectorAll(slotSelector).forEach(el => el.classList.add('hint-glow'));
}

function onHintClick() {
  if (inputLocked()) return;
  const mv = findHintMove();
  clearHintHighlights();
  if (!mv) { showNoMovesOverlay(); return; }
  state.hintsUsed++;
  persistCurrentGame();

  if (mv.from.type === 'stock') {
    highlightHintTarget('.stock-slot');
  } else {
    collectSelectionEls(mv.from).forEach(el => el.classList.add('hint-glow'));
    if (mv.to.type === 'foundation') highlightHintTarget('.foundation-slot');
    else highlightHintTarget(`.tableau-slot[data-col="${mv.to.col}"]`);
  }
  hintTimeout = setTimeout(clearHintHighlights, 2600);
}

/* ---------- Win overlay / confetti ---------- */

function spawnConfetti() {
  const layer = document.getElementById('confetti-layer');
  layer.innerHTML = '';
  const colors = ['#e8b93a', '#b5231f', '#2C6E49', '#f0f0f0', '#17181a'];
  for (let i = 0; i < 40; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + '%';
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = (2 + Math.random() * 1.4) + 's';
    piece.style.animationDelay = (Math.random() * 0.6) + 's';
    layer.appendChild(piece);
  }
}

/* Czech counts in three plural forms: 1 minuta, 2-4 minuty, 5 and more minut. */
function czechPlural(n, one, few, many) {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return 'necelá minuta';
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  const minutesText = `${minutes} ${czechPlural(minutes, 'minuta', 'minuty', 'minut')}`;
  if (!hours) return minutesText;
  const hoursText = `${hours} ${czechPlural(hours, 'hodina', 'hodiny', 'hodin')}`;
  return minutes ? `${hoursText} ${minutesText}` : hoursText;
}

function showWinOverlay() {
  document.getElementById('win-stats').textContent =
    `Čas hry: ${formatDuration(elapsedPlayMs())}\nPočet tahů: ${state.moveCount}\nPočet nápověd: ${state.hintsUsed}`;
  spawnConfetti();
  document.getElementById('overlay-win').classList.remove('hidden');
}
function hideWinOverlay() { document.getElementById('overlay-win').classList.add('hidden'); }

function showNoMovesOverlay() {
  document.getElementById('btn-nomoves-undo').classList.toggle('hidden', historyStack.length === 0);
  document.getElementById('overlay-nomoves').classList.remove('hidden');
}

/* The overlay covers the toolbar, so its own way back is needed. One step back
   usually lands in another dead position -- undoing the futile move that ended
   the game just returns to the position that was already lost -- so keep
   stepping back until the game can go somewhere again. */
function undoToPlayablePosition() {
  hideNoMovesOverlay();
  do { undo(); } while (historyStack.length && !hasProgressAhead());
}
function hideNoMovesOverlay() { document.getElementById('overlay-nomoves').classList.add('hidden'); }

/* ============================================================
   Input handling — drag & tap-tap, unified via Pointer Events
   ============================================================ */

let pointerState = null;

function getStageScale() {
  const stage = document.getElementById('stage');
  return stage.getBoundingClientRect().width / STAGE_W;
}
function clientToBoard(clientX, clientY) {
  const stage = document.getElementById('stage');
  const rect = stage.getBoundingClientRect();
  const scale = rect.width / STAGE_W;
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale - TOOLBAR_H };
}

function computeDropTarget(clientX, clientY) {
  const p = clientToBoard(clientX, clientY);
  for (let i = 0; i < 7; i++) {
    const x0 = tableauX(i);
    if (p.x >= x0 && p.x <= x0 + CARD_W && p.y >= TABLEAU_Y - 60) return { type: 'tableau', col: i };
  }
  const fx0 = foundX(0), fx1 = foundX(3) + CARD_W;
  if (p.x >= fx0 && p.x <= fx1 && p.y >= ROW1_Y - 30 && p.y <= ROW1_Y + CARD_H + 50) return { type: 'foundation' };
  return null;
}

function clearDropHighlight() {
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
}
function updateDropHighlight(dest) {
  clearDropHighlight();
  if (!dest) return;
  if (dest.type === 'tableau') {
    const slot = document.querySelector(`.tableau-slot[data-col="${dest.col}"]`);
    if (slot) slot.classList.add('drop-target');
  } else if (dest.type === 'foundation') {
    document.querySelectorAll('.foundation-slot').forEach(el => el.classList.add('drop-target'));
  }
}

function actionableSourceForLocation(loc) {
  if (!loc) return null;
  if (loc.type === 'tableau') {
    const card = state.tableau[loc.col][loc.idx];
    return card.faceUp ? { type: 'tableau', col: loc.col, idx: loc.idx } : null;
  }
  if (loc.type === 'waste') {
    return loc.idx === state.waste.length - 1 ? { type: 'waste' } : null;
  }
  if (loc.type === 'foundation') {
    return loc.rank === state.foundations[loc.suit] ? { type: 'foundation', suit: loc.suit } : null;
  }
  return null;
}

function collectCardEls(sourceInfo) {
  return collectSelectionEls(sourceInfo);
}

function onCardPointerDown(e) {
  if (inputLocked()) return;
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const loc = findCardLocation(cardEl.dataset.id);
  const sourceInfo = actionableSourceForLocation(loc);
  if (!sourceInfo) return;

  const els = collectCardEls(sourceInfo);
  if (!els.length) return;

  pointerState = {
    pointerId: e.pointerId,
    startClientX: e.clientX,
    startClientY: e.clientY,
    dragging: false,
    source: sourceInfo,
    tappedCardId: cardEl.dataset.id,
    cardEls: els,
    origStyles: els.map(el => ({ left: el.style.left, top: el.style.top, zIndex: el.style.zIndex })),
    scale: getStageScale(),
  };
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
  e.preventDefault();
}

function onPointerMove(e) {
  if (!pointerState || e.pointerId !== pointerState.pointerId) return;
  const dx = e.clientX - pointerState.startClientX;
  const dy = e.clientY - pointerState.startClientY;
  if (!pointerState.dragging) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    pointerState.dragging = true;
    pointerState.cardEls.forEach((el, i) => {
      el.classList.add('dragging');
      el.style.zIndex = String(9000 + i);
    });
  }
  const ldx = dx / pointerState.scale, ldy = dy / pointerState.scale;
  pointerState.cardEls.forEach((el, i) => {
    const base = pointerState.origStyles[i];
    el.style.left = (parseFloat(base.left) + ldx) + 'px';
    el.style.top = (parseFloat(base.top) + ldy) + 'px';
  });
  updateDropHighlight(computeDropTarget(e.clientX, e.clientY));
}

function onPointerUp(e) {
  if (!pointerState || e.pointerId !== pointerState.pointerId) return;
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('pointercancel', onPointerUp);
  clearDropHighlight();

  const wasDragging = pointerState.dragging;
  const src = pointerState.source;
  const cardEls2 = pointerState.cardEls;
  const origStyles = pointerState.origStyles;
  const tappedCardId = pointerState.tappedCardId;
  cardEls2.forEach(el => el.classList.remove('dragging'));
  pointerState = null; // clear before attemptMove/renderAll so repositioning isn't skipped

  if (wasDragging) {
    const dest = computeDropTarget(e.clientX, e.clientY);
    const moved = dest ? attemptMove(src, dest) : false;
    if (!moved) {
      cardEls2.forEach((el, i) => {
        el.classList.add('returning');
        el.style.left = origStyles[i].left;
        el.style.top = origStyles[i].top;
        el.style.zIndex = origStyles[i].zIndex;
      });
      setTimeout(() => {
        cardEls2.forEach(el => el.classList.remove('returning'));
        renderAll();
      }, 240);
    }
  } else {
    handleTap(src, tappedCardId);
  }
}

function handleTap(sourceInfo, cardId) {
  const now = Date.now();
  const isDouble = lastTap && lastTap.cardId === cardId && (now - lastTap.time) < 380;
  lastTap = { cardId, time: now };

  if (isDouble) {
    lastTap = null;
    tryAutoFoundation(sourceInfo);
    return;
  }

  if (selection && selectionKey(selection) === selectionKey(sourceInfo)) {
    clearSelection();
    renderSelectionHighlight();
    return;
  }

  if (selection) {
    let dest = null;
    if (sourceInfo.type === 'foundation') dest = { type: 'foundation' };
    else if (sourceInfo.type === 'tableau') dest = { type: 'tableau', col: sourceInfo.col };
    if (dest && attemptMove(selection, dest)) {
      clearSelection();
      renderSelectionHighlight();
      return;
    }
  }

  selection = sourceInfo;
  renderSelectionHighlight();
}

function onBoardClick(e) {
  if (inputLocked()) return;
  const cardEl = e.target.closest('.card');
  if (cardEl) {
    const loc = findCardLocation(cardEl.dataset.id);
    if (loc && loc.type === 'stock') onStockClick();
    return;
  }
  const slot = e.target.closest('.pile-slot');
  if (!slot) return;
  if (slot.classList.contains('stock-slot')) { onStockClick(); return; }
  if (slot.classList.contains('tableau-slot')) {
    const col = parseInt(slot.dataset.col, 10);
    if (state.tableau[col].length === 0 && selection) {
      if (attemptMove(selection, { type: 'tableau', col })) { clearSelection(); renderSelectionHighlight(); }
    }
    return;
  }
  if (slot.classList.contains('foundation-slot')) {
    if (selection) {
      if (attemptMove(selection, { type: 'foundation' })) { clearSelection(); renderSelectionHighlight(); }
    }
  }
}

/* ============================================================
   Screens / flow
   ============================================================ */

let statsReturnScreen = 'start';

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  if (name === 'game') updateStageScale();
}

function updateStageScale() {
  const stage = document.getElementById('stage');
  const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
}

function startNewGame() {
  cancelAutoFinish();
  if (state && !state.finished && state.moveCount > 0) recordStatEntry(false);
  hideWinOverlay();
  hideNoMovesOverlay();
  clearHintHighlights();
  clearSelection();
  historyStack = [];
  state = dealNewGame(settings.drawCount);
  persistCurrentGame();
  showScreen('game');
  renderAll();
}

function continueSavedGame() {
  const saved = loadSavedGame();
  if (!saved) return;
  cancelAutoFinish();
  state = saved;
  state.startedAt = Date.now();
  historyStack = [];
  clearSelection();
  clearHintHighlights();
  showScreen('game');
  renderAll();
  maybeFlagNoMoves();
  maybeAutoFinish();
}

function goToMenu() {
  cancelAutoFinish();
  hideWinOverlay();
  hideNoMovesOverlay();
  if (state && !state.finished) persistCurrentGame();
  refreshContinueButton();
  showScreen('start');
}

function refreshContinueButton() {
  const saved = loadSavedGame();
  document.getElementById('btn-start-continue').classList.toggle('hidden', !saved);
}

/* ---------- Stats screen ---------- */

function formatDateTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function addStatsRow(el, label, value) {
  const row = document.createElement('div');
  row.className = 'stats-row';
  const l = document.createElement('span'); l.textContent = label;
  const v = document.createElement('span'); v.className = 'stats-big'; v.textContent = String(value);
  row.appendChild(l); row.appendChild(v);
  el.appendChild(row);
}
function renderStats() {
  const stats = loadStats();
  const el = document.getElementById('stats-content');
  el.innerHTML = '';
  addStatsRow(el, 'Celkem odehraných her', stats.length);
  addStatsRow(el, 'Úspěšně dokončených her', stats.filter(g => g.won).length);

  const title = document.createElement('div');
  title.className = 'stats-section-title';
  title.textContent = 'Posledních 10 her';
  el.appendChild(title);

  const list = document.createElement('div');
  list.className = 'history-list';
  const last10 = stats.slice(-10).reverse();
  if (!last10.length) {
    const p = document.createElement('div');
    p.textContent = 'Zatím žádná odehraná hra.';
    list.appendChild(p);
  } else {
    for (const g of last10) {
      const item = document.createElement('div');
      item.className = 'history-item ' + (g.won ? 'history-won' : 'history-lost');
      const left = document.createElement('span');
      left.textContent = `${formatDateTime(g.ts)} — ${g.moves} tahů`;
      const right = document.createElement('span');
      right.className = 'history-status';
      right.textContent = g.won ? 'Dokončeno' : 'Nedokončeno';
      item.appendChild(left); item.appendChild(right);
      list.appendChild(item);
    }
  }
  el.appendChild(list);
}

/* ============================================================
   Wiring
   ============================================================ */

function applyDrawToggleUI() {
  document.getElementById('btn-draw-1').classList.toggle('active', settings.drawCount === 1);
  document.getElementById('btn-draw-3').classList.toggle('active', settings.drawCount === 3);
}

function init() {
  buildStaticSlots();
  buildCardElements();
  applyDrawToggleUI();
  refreshContinueButton();
  updateStageScale();

  document.getElementById('btn-draw-1').addEventListener('click', () => { settings.drawCount = 1; saveSettings(settings); applyDrawToggleUI(); });
  document.getElementById('btn-draw-3').addEventListener('click', () => { settings.drawCount = 3; saveSettings(settings); applyDrawToggleUI(); });

  document.getElementById('btn-start-new').addEventListener('click', startNewGame);
  document.getElementById('btn-start-continue').addEventListener('click', continueSavedGame);
  document.getElementById('btn-start-stats').addEventListener('click', () => { statsReturnScreen = 'start'; renderStats(); showScreen('stats'); });

  document.getElementById('btn-menu').addEventListener('click', goToMenu);
  document.getElementById('btn-new-game').addEventListener('click', startNewGame);
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-hint').addEventListener('click', onHintClick);
  document.getElementById('btn-stats-ingame').addEventListener('click', () => { statsReturnScreen = 'game'; renderStats(); showScreen('stats'); });

  document.getElementById('btn-stats-back').addEventListener('click', () => {
    if (statsReturnScreen === 'game' && state) showScreen('game');
    else showScreen('start');
  });

  document.getElementById('btn-win-newgame').addEventListener('click', startNewGame);
  document.getElementById('btn-win-menu').addEventListener('click', goToMenu);
  document.getElementById('btn-nomoves-newgame').addEventListener('click', startNewGame);
  document.getElementById('btn-nomoves-undo').addEventListener('click', undoToPlayablePosition);
  document.getElementById('btn-nomoves-menu').addEventListener('click', goToMenu);

  const board = document.getElementById('board');
  board.addEventListener('pointerdown', onCardPointerDown);
  board.addEventListener('click', onBoardClick);

  window.addEventListener('resize', updateStageScale);
  window.addEventListener('orientationchange', updateStageScale);

  window.addEventListener('beforeunload', () => { if (state && !state.finished) persistCurrentGame(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state && !state.finished) persistCurrentGame();
  });
}

document.addEventListener('DOMContentLoaded', init);
