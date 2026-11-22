// Realtime duels on GitHub Pages, backed by a two-seat HTTPS room.
(() => {
  'use strict';
  const service = 'https://sudoku-na-polyah-duels.roanhaven8.chatgpt.site';
  const roomPattern = /^sudoku-[0-9a-f]{32}$/;
  const pollMs = 1500;
  const timeoutMs = 9000;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const digits = (value, min) => Array.isArray(value) && value.length === 81 &&
    value.every(d => Number.isInteger(d) && d >= min && d <= 9);
  const sheetIsValid = state => state && Number.isInteger(state.level) && state.level >= 0 && state.level < 5 &&
    digits(state.puzzle, 0) && state.puzzle.includes(0) && state.puzzle.some(Boolean);

  class DuelNetwork {
    constructor({onEvent, validate}) {
      this.notify = onEvent;
      this.validate = validate;
      this.phase = 'idle';
      this.selfReady = false;
      this.otherReady = false;
      this.bestRtt = Infinity;
      this.onVisibility = () => { if (!document.hidden && this.token) this.poll(); };
      this.onPageHide = () => {
        // A page restored from the back-forward cache should visibly end the old session.
        this.close();
        this.notify('error', {message:'Вы покинули дуэль. Для новой игры создайте приглашение.'});
      };
    }

    get active() { return this.phase !== 'closed' && this.phase !== 'done'; }
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
        const json = await response.json();
        if (!response.ok) {
          const message = typeof json.error === 'string' && json.error.length <= 300
            ? json.error : 'Сервис не принял запрос.';
          throw Object.assign(new Error(message), {status:response.status});
        }
        // Match server time to the midpoint of the fastest observed round trip.
        // Use monotonic local time so device clock changes do not alter the start.
        const state = json.state || json;
        const after = performance.now();
        const rtt = after - before;
        if (Number.isFinite(state.serverNow) && rtt < this.bestRtt) {
          this.bestRtt = rtt;
          this.clockOffset = state.serverNow - (before + after) / 2;
        }
        return json;
      } finally { clearTimeout(timer); }
    }

    async retry(path, options) {
      let last;
      for (let i = 0; i < 3 && this.active; i++) {
        try { return await this.request(path, options); }
        catch (err) {
          last = err;
          if (err.status && err.status < 500 && err.status !== 429) throw err;
          if (i < 2 && this.active) await wait((i + 1) * 950);
        }
      }
      throw last || new Error('Дуэль закрыта.');
    }

    host(sheet) {
      if (this.phase !== 'idle') return;
      if (!sheetIsValid(sheet)) return this.fail('Не удалось подготовить задачу.');
      return this.connect('host', '/rooms', {level:sheet.level, puzzle:sheet.puzzle});
    }

    join(roomId) {
      if (this.phase !== 'idle') return;
      if (!roomPattern.test(roomId)) return this.fail('Ссылка на дуэль неполная. Попросите новое приглашение.');
      this.roomId = roomId;
      return this.connect('guest', this.roomPath + '/join', {});
    }

    async connect(role, path, body) {
      this.role = role;
      this.phase = 'connecting';
      try {
        // Keep the same key if the server committed the join but its response was lost.
        const data = await this.retry(path, {body:{...body, requestId:crypto.randomUUID()}});
        const room = data.roomId || this.roomId;
        if (!roomPattern.test(room) || !data.token || !sheetIsValid(data.state)) {
          return this.fail('Сервис вернул неполные данные дуэли. Откройте приглашение снова.');
        }
        if (!this.active) {
          this.leave(room, data.token);
          return;
        }
        this.roomId = room;
        this.token = data.token;
        this.phase = 'waiting';
        this.lastSuccess = performance.now();
        document.addEventListener('visibilitychange', this.onVisibility);
        window.addEventListener('pagehide', this.onPageHide);
        if (role === 'host') {
          const url = new URL(location.href);
          url.hash = 'duel=' + room;
          this.notify('invite', {url:url.href, roomId:room});
        }
        this.apply(data.state);
        this.schedulePoll();
      } catch (err) {
        if (this.active) this.fail(err.status ? err.message : 'Не удалось подключиться к дуэли. Проверьте интернет и попробуйте снова.');
      }
    }

    schedulePoll() {
      clearTimeout(this.pollTimer);
      if (this.active) this.pollTimer = setTimeout(() => this.poll(), pollMs);
    }

    async poll() {
      if (!this.active || this.polling || !this.token) return;
      clearTimeout(this.pollTimer);
      this.polling = true;
      try {
        const state = await this.request(this.roomPath);
        if (this.active) this.apply(state);
      } catch (err) {
        if (!this.active) return;
        if ([401,403,404,410].includes(err.status)) this.fail(err.message);
        else if (performance.now() - this.lastSuccess > 60000) {
          this.fail('Связь с дуэлью прервана. Проверьте интернет и создайте новое приглашение.');
        }
      } finally {
        this.polling = false;
        this.schedulePoll();
      }
    }

    apply(state) {
      if (!this.active) return;
      if (!sheetIsValid(state) || !Number.isFinite(state.serverNow)) {
        this.fail('Не удалось прочитать данные дуэли. Попробуйте открыть ссылку снова.');
        return;
      }
      this.lastSuccess = performance.now();
      // A poll started before a mutation can finish after its response.
      if (state.serverNow < this.latestTime) return;
      this.latestTime = state.serverNow;
      if (state.guestJoined && this.phase === 'waiting') {
        this.sheet = {level:state.level, puzzle:state.puzzle.slice()};
        this.phase = 'lobby';
        this.notify('connected', {role:this.role, level:this.sheet.level, puzzle:this.sheet.puzzle.slice()});
      }
      const self = this.selfReady || Boolean(this.role === 'host' ? state.hostReady : state.guestReady);
      const other = this.otherReady || Boolean(this.role === 'host' ? state.guestReady : state.hostReady);
      if (self !== this.selfReady || other !== this.otherReady) {
        this.selfReady = self;
        this.otherReady = other;
        this.notify('ready', {self, other});
      }
      if (state.winner === 'host' || state.winner === 'guest') {
        this.phase = 'done';
        this.cleanup();
        this.notify('result', {winner:state.winner, elapsedMs:state.elapsedMs, role:this.role});
        return;
      }
      if (state.closed) return this.fail('Соперник вышел или время дуэли истекло. Создайте новое приглашение.');
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
      if (this.phase !== 'lobby' || this.selfReady || this.readyPending) return;
      this.readyPending = true;
      this.action('ready', {}).finally(() => { this.readyPending = false; });
    }

    finish(values) {
      this.startIfDue();
      if (this.phase !== 'playing' || this.finishPending || !digits(values,1) ||
          !this.sheet.puzzle.every((d,i) => !d || d === values[i]) || !this.validate(values, this.sheet.puzzle)) return false;
      this.finishPending = true;
      this.action('finish', {values:values.slice()}).finally(() => { this.finishPending = false; });
      return true;
    }

    async action(name, body) {
      try {
        const state = await this.retry(this.roomPath + '/' + name, {body});
        if (this.active) this.apply(state);
      } catch (err) {
        if (!this.active) return;
        if ([401,403,404,410].includes(err.status)) return this.fail(err.message);
        this.notify('rejected', {message:err.status ? err.message : 'Сервис не подтвердил запрос. Попробуйте ещё раз.'});
        this.poll();
      }
    }

    cleanup() {
      clearTimeout(this.pollTimer);
      clearTimeout(this.startTimer);
      document.removeEventListener('visibilitychange', this.onVisibility);
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
      if (this.token && this.phase !== 'done') this.leave(this.roomId, this.token);
      this.phase = 'closed';
      this.cleanup();
    }

    fail(message) {
      if (!this.active) return;
      this.close();
      this.notify('error', {message});
    }
  }
  window.DuelNetwork = DuelNetwork;
})();
