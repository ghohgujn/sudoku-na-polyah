// Realtime duels on GitHub Pages, backed by a two-seat HTTPS room.
(() => {
  'use strict';
  const service = 'https://sudoku-na-polyah-duels.roanhaven8.chatgpt.site';
  const roomPattern = /^sudoku-[0-9a-f]{32}$/;
  const pollMs = 1500;
  const timeoutMs = 9000;
  const requestPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const tokenPattern = /^[a-f0-9]{64}$/;
  const temporary = err => !err.status || err.status === 408 || err.status === 429 || err.status >= 500;
  const digits = (value, min) => Array.isArray(value) && value.length === 81 &&
    value.every(d => Number.isInteger(d) && d >= min && d <= 9);
  const validLevel = level => Number.isInteger(level) && level >= 0 && level < 5;
  const sheetIsValid = state => state && validLevel(state.level) &&
    digits(state.puzzle, 0) && state.puzzle.includes(0) && state.puzzle.some(Boolean);
  const validState = state => sheetIsValid(state) && Number.isFinite(state.serverNow) &&
    ['closed','hostReady','guestReady','guestJoined'].every(key => typeof state[key] === 'boolean') &&
    (state.startAt === null || (Number.isFinite(state.startAt) && state.startAt > 0 &&
      state.hostReady && state.guestReady && state.guestJoined)) &&
    ((state.winner === null && state.elapsedMs === null) ||
      (['host','guest'].includes(state.winner) && state.startAt !== null &&
        Number.isFinite(state.elapsedMs) && state.elapsedMs >= 0));
  // Only these messages from the room API mean the saved seat is invalid or gone.
  // Access gateways can return 401/403/404 for a perfectly healthy room.
  const seatErrors = {
    401:['Требуется ключ игрока.'],
    403:['Неверный ключ игрока.'],
    404:['Комната не найдена. Проверьте ссылку или создайте новую дуэль.'],
    410:['Время действия приглашения истекло.', 'Эта дуэль уже закрыта.']
  };
  const initialErrors = new Set([
    'Второе место уже занято.', 'Этот запрос уже использован для другого листа.',
    'Некорректное поле или уровень сложности.', 'Некорректный набор полей.',
    'Стартовые цифры пяти уровней должны быть вложены.', 'Некорректные поля запроса.',
    'Некорректный идентификатор запроса.', 'Слишком большой запрос.'
  ]);

  class DuelNetwork {
    constructor({onEvent, validate}) {
      this.notify = onEvent;
      this.validate = validate;
      this.phase = 'idle';
      this.selfReady = false;
      this.otherReady = false;
      this.bestRtt = Infinity;
      this.online = null;
      this.failures = 0;
      this.onOnline = () => this.retryNow();
      this.onOffline = () => this.connection(false);
      this.onVisible = () => { if (!document.hidden) this.retryNow(); };
      this.onPageHide = () => this.suspend();
    }

    get active() { return !['closed','done','suspended'].includes(this.phase); }
    get roomPath() { return '/rooms/' + this.roomId; }

    async request(path, {body, token = this.token} = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const before = performance.now();
      try {
        const headers = {Accept:'application/json'};
        if (token) headers.Authorization = 'Bearer ' + token;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(service + path, {
          method:body === undefined ? 'GET' : 'POST', credentials:'omit',
          cache:'no-store', referrerPolicy:'no-referrer', headers,
          body:body === undefined ? undefined : JSON.stringify(body), signal:controller.signal
        });
        const contentType = response.headers.get('Content-Type') || '';
        if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new Error('Нет ответа сервера дуэли.');
        const json = await response.json();
        if (!response.ok) {
          const message = json?.error;
          if (typeof message !== 'string' || !message.trim() || message.length > 300 ||
              (seatErrors[response.status] && !seatErrors[response.status].includes(message))) {
            throw new Error('Не удалось получить ответ API дуэли.');
          }
          throw Object.assign(new Error(message), {status:response.status});
        }
        // Match server time to the midpoint of the fastest observed round trip.
        // Use monotonic local time so device clock changes do not alter the start.
        const state = json?.state || json;
        if (!validState(state)) throw new Error('Данные дуэли временно недоступны.');
        const after = performance.now();
        const rtt = after - before;
        if (Number.isFinite(state.serverNow) && rtt < this.bestRtt) {
          this.bestRtt = rtt;
          this.clockOffset = state.serverNow - (before + after) / 2;
        }
        return json;
      } finally { clearTimeout(timer); }
    }

    host(sheet, requestId = crypto.randomUUID()) {
      if (this.phase !== 'idle') return;
      if (!sheetIsValid(sheet) || !requestPattern.test(requestId)) return this.fail('Не удалось подготовить задачу.');
      const {level, puzzle, sheets} = sheet;
      if (sheets !== undefined && (!Array.isArray(sheets) || sheets.length !== 5 ||
          !sheets.every((p, i) => sheetIsValid({level:i, puzzle:p})) ||
          !puzzle.every((d,i) => d === sheets[level]?.[i]))) {
        return this.fail('Не удалось подготовить задачи для всех уровней.');
      }
      return this.begin({role:'host', requestId, sheet:{level, puzzle, sheets}});
    }

    join(roomId, requestId = crypto.randomUUID()) {
      if (this.phase !== 'idle') return;
      if (!roomPattern.test(roomId) || !requestPattern.test(requestId)) {
        return this.fail('Ссылка на дуэль неполная. Попросите новое приглашение.');
      }
      return this.begin({role:'guest', roomId, requestId});
    }

    resume(saved) {
      if (this.phase !== 'idle') return;
      if (saved && ['guest','host'].includes(saved.role)) {
        if (!saved.token && requestPattern.test(saved.requestId)) {
          return saved.role === 'host' ? this.host(saved.sheet, saved.requestId) : this.join(saved.roomId, saved.requestId);
        }
        if (roomPattern.test(saved.roomId) && tokenPattern.test(saved.token)) return this.begin(saved);
      }
      return this.fail('Не удалось восстановить место игрока. Откройте новое приглашение.');
    }

    begin(saved) {
      this.role = saved.role;
      this.phase = 'connecting';
      // The UI saves this descriptor synchronously before the first POST. Replaying it
      // cannot create another room or consume a second seat if a response was lost.
      if (saved.token) this.establish(saved.roomId, saved.token);
      else {
        this.initial = saved;
        this.notify('pending', saved);
      }
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
      window.addEventListener('pagehide', this.onPageHide);
      document.addEventListener('visibilitychange', this.onVisible);
      return this.poll();
    }

    establish(roomId, token) {
      this.roomId = roomId;
      this.token = token;
      this.initial = null;
      this.phase = 'waiting';
      this.notify('session', {role:this.role, roomId, token});
      if (this.role === 'host') {
        const url = new URL(location.href);
        url.hash = 'duel=' + roomId;
        this.notify('invite', {url:url.href, roomId});
      }
    }

    connection(online) {
      if (this.active && this.online !== online) {
        this.online = online;
        this.notify('connection', {online});
      }
    }

    retryNow() {
      if (!this.active || this.phase === 'idle') return;
      if (this.polling) this.retryRequested = true;
      else return this.poll();
    }

    schedulePoll() {
      clearTimeout(this.pollTimer);
      if (!this.active) return;
      const delay = this.retryRequested ? 0 : Math.min(20000, pollMs * 2 ** Math.min(4, this.failures));
      this.retryRequested = false;
      this.pollTimer = setTimeout(() => this.poll(), delay);
    }

    async poll() {
      if (!this.active || this.polling || this.phase === 'idle') return;
      clearTimeout(this.pollTimer);
      this.polling = true;
      // Serialize reads and writes. A slow GET must never overwrite a newer mutation.
      const action = this.pendingAction;
      const initial = this.initial;
      try {
        let state;
        if (initial) {
          const creating = this.role === 'host';
          const path = creating ? '/rooms' : '/rooms/' + initial.roomId + '/join';
          const data = await this.request(path, {body:{...initial.sheet, requestId:initial.requestId}});
          const room = data.roomId || initial.roomId;
          if (!roomPattern.test(room) || !tokenPattern.test(data.token) || !validState(data.state) ||
              data.role !== this.role || (!creating && room !== initial.roomId)) {
            throw new Error('Сервис вернул неполные данные дуэли.');
          }
          if (!this.active) {
            if (this.explicitlyLeft) this.leave(room, data.token);
            return;
          }
          this.establish(room, data.token);
          state = data.state;
        } else if (action) {
          state = await this.request(this.roomPath + '/' + action.name, {body:action.body});
        } else state = await this.request(this.roomPath);
        if (!this.active) return;
        if (!validState(state)) throw new Error('Данные дуэли временно недоступны.');
        if (action?.name === 'leave' && !state.closed && !state.winner) {
          throw new Error('Сервер пока не подтвердил завершение дуэли.');
        }
        this.failures = 0;
        this.connection(true);
        if (this.pendingAction?.name === 'leave') {
          if (state.closed || state.winner) this.confirmEnd();
          return;
        }
        this.apply(state);
        if (action && this.pendingAction === action) {
          this.settleAction(this.phase !== 'closed' && (action.name !== 'level' || this.sheet.level === action.body.level));
        }
      } catch (err) {
        if (!this.active) return;
        if (temporary(err)) {
          this.failures++;
          this.connection(false);
        } else if ([404,410].includes(err.status) && this.pendingAction?.name === 'leave') {
          this.confirmEnd();
        } else if (seatErrors[err.status] || (initial && initialErrors.has(err.message))) {
          if ([404,410].includes(err.status)) this.roomEnded = true;
          this.fail(err.message);
        } else if (action && action === this.pendingAction) {
          this.failures = 0;
          this.connection(true);
          this.settleAction(false);
          this.notify('rejected', {action:action.name, message:err.message});
          this.retryRequested = true;
        } else if (!this.pendingAction) {
          // An authenticated GET can only lose its seat through the recognized errors above.
          this.failures++;
          this.connection(false);
        }
      } finally {
        this.polling = false;
        this.schedulePoll();
      }
    }

    apply(state) {
      if (!this.active) return;
      const self = this.selfReady || Boolean(this.role === 'host' ? state.hostReady : state.guestReady);
      const other = this.otherReady || Boolean(this.role === 'host' ? state.guestReady : state.hostReady);
      // Old rooms expose a single shared sheet and do not accept level changes.
      const hostLevel = validLevel(state.hostLevel) ? state.hostLevel : state.level;
      const guestLevel = validLevel(state.guestLevel) ? state.guestLevel : state.level;
      const canChooseLevel = state.canChooseLevel === true && !self && !state.closed &&
        !state.winner && !Number.isFinite(state.startAt);
      const changed = !this.sheet || this.sheet.level !== state.level || this.sheet.hostLevel !== hostLevel ||
        this.sheet.guestLevel !== guestLevel || this.sheet.canChooseLevel !== canChooseLevel ||
        !this.sheet.puzzle.every((d,i) => d === state.puzzle[i]);
      if (changed) {
        this.sheet = {level:state.level, puzzle:state.puzzle.slice(), hostLevel, guestLevel, canChooseLevel};
      }
      if (state.guestJoined && this.phase === 'waiting') {
        this.phase = 'lobby';
        this.notify('connected', {role:this.role, level:this.sheet.level, puzzle:this.sheet.puzzle.slice()});
      }
      if (changed) this.notify('levels', {...this.sheet, puzzle:this.sheet.puzzle.slice()});
      if (self !== this.selfReady || other !== this.otherReady) {
        this.selfReady = self;
        this.otherReady = other;
        this.notify('ready', {self, other});
      }
      if (state.winner === 'host' || state.winner === 'guest') {
        this.phase = 'done';
        this.settleAction(true);
        this.cleanup();
        this.notify('result', {winner:state.winner, elapsedMs:state.elapsedMs, role:this.role});
        return;
      }
      if (state.closed) {
        this.roomEnded = true;
        return this.fail('Соперник вышел или время дуэли истекло. Создайте новое приглашение.');
      }
      if (this.phase === 'lobby' && Number.isFinite(state.startAt)) {
        this.phase = 'countdown';
        this.startTick = state.startAt - this.clockOffset;
        this.startAt = Date.now() + this.startTick - performance.now();
        this.notify('countdown', {startAt:this.startAt});
      }
      this.startIfDue();
    }

    startIfDue() {
      if (this.phase !== 'countdown') return;
      clearTimeout(this.startTimer);
      const remaining = this.startTick - performance.now();
      if (remaining > 0) {
        this.startTimer = setTimeout(() => this.startIfDue(), Math.ceil(remaining));
        return;
      }
      this.phase = 'playing';
      this.notify('start', {startAt:this.startAt});
    }

    ready() {
      if (this.phase !== 'lobby' || this.selfReady || this.pendingAction) return;
      return this.action('ready', {});
    }

    async chooseLevel(level) {
      if (!validLevel(level) || !['waiting','lobby'].includes(this.phase) ||
          !this.sheet?.canChooseLevel || this.selfReady || this.pendingAction) return false;
      if (this.sheet.level === level) return true;
      return this.action('level', {level});
    }

    finish(values) {
      this.startIfDue();
      if (this.phase !== 'playing' || this.pendingAction || !digits(values,1) ||
          !this.sheet.puzzle.every((d,i) => !d || d === values[i]) || !this.validate(values, this.sheet.puzzle)) return false;
      this.action('finish', {values:values.slice()});
      return true;
    }

    action(name, body) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      this.pendingAction = {name, body, resolve, promise};
      this.retryNow();
      return promise;
    }

    endRoom() {
      if (this.roomEnded || this.phase === 'done') return Promise.resolve(true);
      if (!this.active || !this.token) return Promise.resolve(false);
      if (this.pendingAction?.name === 'leave') return this.pendingAction.promise;
      this.settleAction(false);
      clearTimeout(this.startTimer);
      return this.action('leave', {});
    }

    confirmEnd() {
      this.roomEnded = true;
      this.phase = 'closed';
      this.cleanup();
      this.settleAction(true);
    }

    settleAction(ok) {
      if (!this.pendingAction) return;
      const action = this.pendingAction;
      this.pendingAction = null;
      action.resolve(ok);
    }

    cleanup() {
      clearTimeout(this.pollTimer);
      clearTimeout(this.startTimer);
      document.removeEventListener('visibilitychange', this.onVisible);
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
      window.removeEventListener('pagehide', this.onPageHide);
    }

    leave(room, token) {
      // Authenticated normal exit also lets the opponent see the disconnect on its next poll.
      fetch(service + '/rooms/' + room + '/leave', {
        method:'POST', headers:{Authorization:'Bearer ' + token, 'Content-Type':'application/json'},
        body:'{}', keepalive:true,
        credentials:'omit', referrerPolicy:'no-referrer'
      }).catch(() => {});
    }

    close() {
      if (this.phase === 'closed') return;
      this.explicitlyLeft = true;
      if (this.token && this.active) return this.endRoom();
      this.phase = 'closed';
      this.settleAction(false);
      this.cleanup();
    }

    suspend() {
      if (!this.active) return;
      this.phase = 'suspended';
      this.settleAction(false);
      this.cleanup();
    }

    fail(message) {
      if (!this.active) return;
      this.phase = 'closed';
      this.settleAction(false);
      this.cleanup();
      this.notify('error', {message});
    }
  }
  window.DuelNetwork = DuelNetwork;
})();
