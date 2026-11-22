// D1 owns all shared race transitions. Never return credential digests to a client.
const ttl = 12 * 60 * 60 * 1000;
const countdown = 3000;
const bodyLimit = 2048;
const roomPath = /^\/rooms\/(sudoku-[0-9a-f]{32})(?:\/(join|ready|finish|leave))?$/;
const uuidV4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const dbNow = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const text = new TextEncoder();

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  if (origin !== new URL(request.url).origin && origin !== 'https://ghohgujn.github.io' &&
      !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin)) {
    throw new ApiError(403, 'Публикация запросов с этого сайта запрещена.');
  }
  return {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600'};
}

async function bodyFields(request, keys) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new ApiError(415, 'Требуется запрос в формате JSON.');
  }
  if (Number(request.headers.get('Content-Length')) > bodyLimit) throw new ApiError(413, 'Слишком большой запрос.');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'Отсутствуют данные запроса.');
  const buffer = new Uint8Array(bodyLimit);
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (size + value.byteLength > bodyLimit) {
        await reader.cancel();
        throw new ApiError(413, 'Слишком большой запрос.');
      }
      buffer.set(value, size);
      size += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  let obj;
  try { obj = JSON.parse(new TextDecoder().decode(buffer.subarray(0, size))); }
  catch { throw new ApiError(400, 'Некорректный JSON.'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).some(k => !keys.includes(k))) {
    throw new ApiError(400, 'Некорректные поля запроса.');
  }
  return obj;
}

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', text.encode(value)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function attemptId(requestId) {
  if (requestId === undefined) return crypto.randomUUID();
  if (typeof requestId !== 'string' || !uuidV4.test(requestId)) throw new ApiError(400, 'Некорректный идентификатор запроса.');
  return requestId.toLowerCase();
}

function validGrid(values, complete) {
  if (!Array.isArray(values) || values.length !== 81) return false;
  const masks = new Uint16Array(27);
  let filled = 0;
  for (let i = 0; i < values.length; i++) {
    const n = values[i];
    if (!Number.isInteger(n) || n < 0 || n > 9) return false;
    if (!n) continue;
    filled++;
    const r = Math.floor(i / 9), c = i % 9, block = 3 * Math.floor(r / 3) + Math.floor(c / 3);
    for (const group of [r, 9+c, 18+block]) {
      const bit = 1 << n;
      if (masks[group] & bit) return false;
      masks[group] |= bit;
    }
  }
  return complete ? filled === 81 : filled >= 17 && filled < 81;
}

function state(row) {
  return {
    level: row.level, puzzle: Array.from(row.puzzle, Number),
    hostReady: !!row.host_ready, guestReady: !!row.guest_ready,
    guestJoined: row.guest_token !== null, startAt: row.start_at,
    serverNow: Date.now(), winner: row.winner,
    elapsedMs: row.winner ? row.finish_at - row.start_at : null,
    closed: !!row.closed
  };
}

function live(row) {
  if (!row) throw new ApiError(404, 'Комната не найдена. Проверьте ссылку или создайте новую дуэль.');
  if (row.expires_at <= Date.now()) throw new ApiError(410, 'Время действия приглашения истекло.');
  return row;
}

async function readRoom(db, id) {
  return live(await db.prepare('SELECT * FROM duel_rooms WHERE id = ?').bind(id).first());
}

async function createRoom(request, db) {
  const {requestId, level, puzzle} = await bodyFields(request, ['requestId', 'level', 'puzzle']);
  if (!Number.isInteger(level) || level < 0 || level > 4 || !validGrid(puzzle, false)) {
    throw new ApiError(400, 'Некорректное поле или уровень сложности.');
  }
  const attempt = attemptId(requestId);
  const hostRequest = await digest('create:' + attempt);
  const token = await digest('host:' + attempt);
  const tokenHash = await digest(token);
  const id = 'sudoku-' + crypto.randomUUID().replaceAll('-', '');
  const seed = puzzle.join('');
  const now = Date.now();
  const insert = db.prepare(
    'INSERT INTO duel_rooms (id, host_request, host_token, level, puzzle, expires_at) VALUES (?,?,?,?,?,?) ON CONFLICT(host_request) DO NOTHING'
  ).bind(id, hostRequest, tokenHash, level, seed, now + ttl);
  const [,, result] = await db.batch([
    db.prepare('DELETE FROM duel_rooms WHERE id IN (SELECT id FROM duel_rooms WHERE expires_at <= ? ORDER BY expires_at LIMIT 64)').bind(now),
    insert, db.prepare('SELECT * FROM duel_rooms WHERE host_request = ?').bind(hostRequest)
  ]);
  const row = live(result.results[0]);
  if (row.level !== level || row.puzzle !== seed) throw new ApiError(409, 'Этот запрос уже использован для другого листа.');
  return {roomId: row.id, token, role: 'host', state: state(row)};
}

async function joinRoom(request, db, id) {
  const {requestId} = await bodyFields(request, ['requestId']);
  const token = await digest('guest:' + id + ':' + attemptId(requestId));
  const tokenHash = await digest(token);
  // A single conditional write seats the guest. A retry by that same guest retains its seat.
  const [, result] = await db.batch([
    db.prepare('UPDATE duel_rooms SET guest_token = ? WHERE id = ? AND guest_token IS NULL AND closed = 0 AND expires_at > ?').bind(tokenHash, id, Date.now()),
    db.prepare('SELECT * FROM duel_rooms WHERE id = ?').bind(id)
  ]);
  const row = live(result.results[0]);
  if (row.closed) throw new ApiError(410, 'Эта дуэль уже закрыта.');
  if (row.guest_token !== tokenHash) throw new ApiError(409, 'Второе место уже занято.');
  return {roomId: id, token, role: 'guest', state: state(row)};
}

async function playerAction(request, db, id, action) {
  const auth = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!auth) throw new ApiError(401, 'Требуется ключ игрока.');
  const hash = await digest(auth[1]);
  const row = await readRoom(db, id);
  const role = hash === row.host_token ? 'host' : hash === row.guest_token ? 'guest' : null;
  if (!role) throw new ApiError(403, 'Неверный ключ игрока.');
  if (!action) return state(row);
  const body = await bodyFields(request, action === 'finish' ? ['values'] : []);
  if (row.closed || row.winner) return state(row);
  let update;
  switch (action) {
    case 'ready': {
      if (!row.guest_token) throw new ApiError(409, 'Дождитесь второго игрока.');
      const other = role === 'host' ? 'guest_ready' : 'host_ready';
      update = db.prepare(`UPDATE duel_rooms SET ${role}_ready = 1,
        start_at = CASE WHEN start_at IS NULL AND ${other} = 1 THEN ${dbNow} + ? ELSE start_at END
        WHERE id = ? AND closed = 0 AND winner IS NULL AND expires_at > ${dbNow}`).bind(countdown, id);
      break;
    }
    case 'finish': {
      if (!row.start_at || Date.now() < row.start_at) throw new ApiError(409, 'Дождитесь старта дуэли.');
      if (!validGrid(body.values, true) || body.values.some((n, i) => row.puzzle[i] !== '0' && +row.puzzle[i] !== n)) {
        throw new ApiError(422, 'Решение не сходится. Можно продолжить игру.');
      }
      update = db.prepare(`UPDATE duel_rooms SET winner = ?, finish_at = ${dbNow} WHERE id = ?
        AND winner IS NULL AND closed = 0 AND start_at <= ${dbNow} AND expires_at > ${dbNow}`).bind(role, id);
      break;
    }
    case 'leave':
      update = db.prepare('UPDATE duel_rooms SET closed = 1 WHERE id = ? AND winner IS NULL AND closed = 0').bind(id);
      break;
  }
  const [, result] = await db.batch([update, db.prepare('SELECT * FROM duel_rooms WHERE id = ?').bind(id)]);
  return state(live(result.results[0]));
}

async function dispatch(request, env) {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/') return {service: 'Судоку на полях', status: 'ok'};
  if (request.method === 'POST' && path === '/rooms') return createRoom(request, env.DB);
  const match = roomPath.exec(path);
  if (!match) throw new ApiError(404, 'Неизвестный адрес.');
  const [, id, action] = match;
  if ((action && request.method !== 'POST') || (!action && request.method !== 'GET')) throw new ApiError(405, 'Неверный метод.');
  if (action === 'join') return joinRoom(request, env.DB, id);
  return playerAction(request, env.DB, id, action);
}

export default {
  async fetch(request, env) {
    const headers = {'Cache-Control': 'no-store', 'Vary': 'Origin'};
    try {
      Object.assign(headers, corsHeaders(request));
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers});
      const data = await dispatch(request, env);
      return Response.json(data, {headers});
    } catch (error) {
      const known = error instanceof ApiError;
      if (!known) console.error('Sudoku D1 operation failed', error.name);
      return Response.json({error: known ? error.message : 'Сервер временно недоступен. Попробуйте ещё раз.'},
        {status: known ? error.status : 503, headers});
    }
  }
};
