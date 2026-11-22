// Each local attempt has its own key. Network credentials never enter invitation URLs.
(() => {
  'use strict';
  const prefix = 'na-polyah-sudoku.duel.v1.';
  const lifetime = 12 * 60 * 60 * 1000;
  const maxHistory = 4096;
  const maxLength = 256 * 1024;
  let lastWrite = 0;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const room = /^sudoku-[0-9a-f]{32}$/;
  const token = /^[0-9a-f]{64}$/;
  const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
  const bounded = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  const digits = (arr, max) => Array.isArray(arr) && arr.length === 81 && arr.every(n => bounded(n, 0, max));
  const validLevel = level => bounded(level, 0, 4);

  function validAuth(auth) {
    if (!auth || !['host','guest'].includes(auth.role)) return false;
    if (auth.token !== undefined) return matches(room, auth.roomId) && matches(token, auth.token);
    if (!matches(uuid, auth.requestId)) return false;
    if (auth.role === 'guest') return matches(room, auth.roomId);
    const sheet = auth.sheet;
    return sheet && validLevel(sheet.level) && digits(sheet.puzzle, 9) &&
      (sheet.sheets === undefined || (Array.isArray(sheet.sheets) && sheet.sheets.length === 5 &&
        sheet.sheets.every(p => digits(p, 9))));
  }

  function validBoard(board) {
    return board && digits(board.values, 9) && digits(board.notes, 1022) && digits(board.owners, 1) &&
      Array.isArray(board.history) && board.history.length <= maxHistory &&
      board.history.every(entry => Array.isArray(entry) && entry.length === 4 &&
        bounded(entry[0], 0, 80) && bounded(entry[1], 0, 9) &&
        bounded(entry[2], 0, 1022) && bounded(entry[3], 0, 1));
  }

  function validRecord(record, now) {
    if (!record || !validAuth(record.auth) || !Number.isSafeInteger(record.createdAt) ||
        record.createdAt <= 0 || record.createdAt > now + 60000 || now >= record.createdAt + lifetime ||
        !Number.isSafeInteger(record.timestamp) ||
        (record.startAt != null && (!Number.isFinite(record.startAt) || record.startAt < 0))) return false;
    const g = record.game;
    return g && (record.finishRequested === undefined || typeof record.finishRequested === 'boolean') &&
      (!record.finishRequested || g.phase === 'play') &&
      g.mode === 'online' && validLevel(g.level) && digits(g.puzzle, 9) && g.player === 0 &&
      Number.isSafeInteger(g.number) && g.number > 0 && typeof g.phase === 'string' && g.phase.length <= 32 &&
      typeof g.note === 'boolean' && bounded(g.selected, -1, 80) &&
      Array.isArray(g.times) && g.times.length === 2 && g.times.every(t => Number.isFinite(t) && t >= 0) &&
      Array.isArray(g.boards) && g.boards.length === 2 && g.boards.every(validBoard);
  }

  function get(key) {
    if (!matches(uuid, key)) return null;
    const name = prefix + key;
    try {
      const raw = localStorage.getItem(name);
      if (raw === null) return null;
      let record;
      if (raw.length <= maxLength) {
        try { record = JSON.parse(raw); } catch { /* Discard invalid bytes below. */ }
      }
      if (validRecord(record, Date.now())) return {...record, key};
      if (localStorage.getItem(name) === raw) localStorage.removeItem(name);
    } catch { /* The browser may restrict storage. */ }
    return null;
  }

  function list() {
    const keys = [];
    try {
      // Collect keys first: get() also removes invalid or expired records.
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        if (name?.startsWith(prefix)) keys.push(name.slice(prefix.length));
      }
    } catch { return []; }
    return keys.map(get).filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
  }

  function find(roomId) {
    if (roomId != null && !matches(room, roomId)) return null;
    return list().find(record => roomId == null || record.auth.roomId === roomId) || null;
  }

  function put(key, record) {
    if (!matches(uuid, key) || !record?.game || !Array.isArray(record.game.boards)) return false;
    try {
      const now = Date.now();
      const boards = record.game.boards.map(b => {
        if (!Array.isArray(b?.history) || b.history.length <= maxHistory) return b;
        return {...b, history: b.history.slice(-maxHistory)};
      });
      const timestamp = Math.max(now, lastWrite + 1);
      const entry = {...record, game: {...record.game, boards}, timestamp};
      if (!validRecord(entry, now)) {
        if (entry.createdAt + lifetime <= now) get(key);
        return false;
      }
      const encoded = JSON.stringify(entry);
      if (encoded.length > maxLength) return false;
      localStorage.setItem(prefix + key, encoded);
      lastWrite = timestamp;
      return true;
    } catch { return false; }
  }

  function drop(key) {
    if (!matches(uuid, key)) return false;
    try { localStorage.removeItem(prefix + key); return true; }
    catch { return false; }
  }

  window.DuelRecovery = Object.freeze({get, list, find, put, drop});
})();
