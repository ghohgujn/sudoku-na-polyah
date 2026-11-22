let transportLoading;

function loadDuelTransport() {
  if (!transportLoading) {
    const loadScript = src => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Не удалось загрузить сетевой режим. Проверьте интернет и попробуйте ещё раз.'));
      document.head.append(script);
    });
    transportLoading = loadScript('duel-network.js?v=3')
      .catch(error => { transportLoading = null; throw error; });
  }
  return transportLoading;
}

function refreshResumeButton() {
  $('resume-duel').hidden = !!race || !DuelRecovery.find();
}

function saveRace() {
  if (!race?.ownsSeat || !race.auth || ['finished','interrupted'].includes(game.phase)) return;
  const saved = DuelRecovery.put(race.key, {
    auth:race.auth, game, createdAt:race.createdAt, startAt:race.startAt,
    finishRequested:race.submitted
  });
  $('race-storage-warning').hidden = saved;
}

function updateLinkStatus() {
  const offline = !!race && race.offline && !['finished','interrupted'].includes(game.phase);
  $('duel-connection').hidden = !offline;
  if (offline) {
    let status = 'Подключаемся к вашей дуэли…';
    if (game.phase === 'play') status = race.submitted
      ? 'Связь потеряна. Отправим готовый лист при подключении.'
      : 'Связь потеряна. Можно продолжать решать. Подключаемся снова…';
    $('duel-connection-text').textContent = status;
  }
}

function sendRequestedFinish() {
  if (!race?.submitted || race.finishInFlight || race.net?.phase !== 'playing') return;
  const vals = game.puzzle.map((d,i) => d || activeBoard().values[i]);
  race.finishInFlight = race.net.finish(vals);
  if (!race.finishInFlight) {
    race.submitted = false;
    $('message').textContent = 'Проверьте лист ещё раз.';
    saveRace();
  }
}

function openRace(level, roomId, record = null) {
  if (race) return;
  settle();
  persist();
  const session = {
    previous:game, role:record?.auth.role ?? (roomId ? 'guest' : 'host'),
    key:record?.key ?? (roomId?.match(/^sudoku-([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/)?.slice(1).join('-') || crypto.randomUUID()),
    roomId, level, auth:null, createdAt:record?.createdAt ?? Date.now(),
    ownsSeat:false, connected:false, selfReady:false, otherReady:false, submitted:false,
    startAt:0, net:null, offline:!navigator.onLine
  };
  race = session;
  game = {number:session.previous.number, mode:'online', level, selected:-1, note:false,
    puzzle:Array(81).fill(0), boards:[emptyBoard(), emptyBoard()], phase:'lobby',
    player:0, times:[0,0]};
  $('message').textContent = '';
  $('resume-duel').hidden = true;
  updateLinkStatus();
  render();
  acquireRaceSeat(session, !!record);
}

function acquireRaceSeat(session, restoring) {
  // Only one tab may write this player's board. Re-read it after a tab handoff.
  const start = () => {
    if (race !== session) return;
    const latest = DuelRecovery.get(session.key);
    session.ownsSeat = true;
    if (restoring && !latest) {
      handleRaceEvent('error', {message:'Эта сохранённая дуэль уже завершена или истекла.'});
      return;
    }
    if (latest) {
      session.auth = latest.auth;
      session.role = latest.auth.role;
      session.createdAt = latest.createdAt;
      session.startAt = latest.startAt || 0;
      session.submitted = latest.finishRequested === true;
      game = latest.game;
      // Countdown and lobby are reconciled with the server before a new start.
      if (game.phase !== 'play') game.phase = 'lobby';
      if (session.submitted) $('message').textContent = 'Отправим готовый лист, когда связь восстановится.';
    }
    session.waitingForTab = false;
    updateLinkStatus();
    render();
    connectRace(session);
  };
  if (!navigator.locks) { start(); return; }
  session.lockAbort = new AbortController();
  const waiting = setTimeout(() => {
    if (race === session && !session.ownsSeat) { session.waitingForTab = true; render(); }
  }, 250);
  navigator.locks.request('na-polyah-duel:' + session.key, {signal:session.lockAbort.signal}, async () => {
    clearTimeout(waiting);
    if (race !== session) return;
    const held = new Promise(resolve => { session.release = resolve; });
    start();
    await held;
  }).catch(error => {
    clearTimeout(waiting);
    if (race === session && error.name !== 'AbortError') {
      handleRaceEvent('error', {message:'Не удалось открыть сохранение дуэли в этой вкладке.'});
    }
  });
}

async function connectRace(session) {
  if (session.loading || session.net || !session.ownsSeat) return;
  session.loading = true;
  try {
    await loadDuelTransport();
    if (race !== session || !session.ownsSeat) return;
    session.net = new DuelNetwork({
      onEvent:(type,data) => { if (race === session) handleRaceEvent(type,data); },
      validate:(values,puzzle) => correct(values) &&
        puzzle.length === 81 && puzzle.every((given,i) => !given || given === values[i])
    });
    if (session.auth) await session.net.resume(session.auth);
    else if (session.roomId) await session.net.join(session.roomId);
    else {
      const {sheets} = makeDuelSheets();
      game.puzzle = sheets[session.level];
      await session.net.host({level:session.level, puzzle:game.puzzle, sheets});
    }
  } catch {
    if (race === session) {
      session.net?.suspend(); session.net = null;
      session.offline = true;
      updateLinkStatus();
    }
  } finally { session.loading = false; }
}

function retryRace() {
  if (!race?.ownsSeat) return;
  if (race.net) race.net.retryNow();
  else connectRace(race);
}

function handleRaceEvent(type, data = {}) {
  if (!race || game.phase === 'finished' || game.phase === 'interrupted') return;
  switch (type) {
    case 'pending':
    case 'session':
      race.auth = data;
      saveRace();
      return;
    case 'connection':
      race.offline = !data.online;
      updateLinkStatus();
      return;
    case 'invite':
      race.url = data.url;
      break;
    case 'connected':
      race.role = data.role;
      race.connected = true;
      game.level = data.level;
      game.puzzle = data.puzzle.slice();
      break;
    case 'levels':
      game.level = data.level;
      game.puzzle = data.puzzle.slice();
      race.canChooseLevel = data.canChooseLevel;
      race.hostLevel = data.hostLevel;
      race.guestLevel = data.guestLevel;
      break;
    case 'ready':
      race.selfReady = data.self;
      race.otherReady = data.other;
      break;
    case 'countdown':
    case 'start':
      race.startAt = data.startAt;
      if (type === 'start') game.phase = 'play';
      else if (game.phase !== 'play') game.phase = 'countdown';
      break;
    case 'rejected':
      if (data.action === 'finish') { race.submitted = false; race.finishInFlight = false; }
      $('message').textContent = data.message || 'Сервер не принял решение. Можно продолжить игру.';
      break;
    case 'result':
      race.result = data;
      game.phase = 'finished';
      $('message').textContent = '';
      break;
    case 'error':
      race.failure = data.message || 'Связь прервалась. Создайте новое приглашение.';
      game.phase = 'interrupted';
      $('message').textContent = '';
      break;
    default:
      return;
  }
  if (type === 'result' || type === 'error') {
    if (race.ownsSeat) DuelRecovery.drop(race.key);
    $('race-storage-warning').hidden = true;
  } else saveRace();
  if (type === 'start') sendRequestedFinish();
  updateLinkStatus();
  render();
}

function raceButton(text, id, action, className = 'primary') {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = text; btn.id = id; btn.className = className;
  btn.onclick = action;
  return btn;
}

function showRaceLevels(cover) {
  const group = document.createElement('div');
  group.className = 'race-levels';
  const label = document.createElement('label');
  label.htmlFor = 'race-level';
  label.textContent = 'Мой уровень';
  const select = document.createElement('select');
  select.id = 'race-level';
  levels.forEach((name, index) => select.add(new Option(name, index)));
  select.value = game.level;
  select.disabled = !race.canChooseLevel || race.selfReady || race.levelPending;
  select.onchange = async () => {
    const session = race;
    const chosen = Number(select.value);
    session.levelPending = true;
    select.disabled = true;
    $('ready-duel').disabled = true;
    try { await session.net.chooseLevel(chosen); }
    finally {
      session.levelPending = false;
      if (race === session && game.phase === 'lobby') render();
    }
  };
  const opponent = document.createElement('small');
  opponent.id = 'opponent-level';
  const otherLevel = race.role === 'host' ? race.guestLevel : race.hostLevel;
  opponent.textContent = 'У соперника — ' + levels[otherLevel ?? game.level];
  group.append(label, select, opponent);
  cover.append(group);
}

function renderRaceCover() {
  const cover = $('cover');
  const title = document.createElement('h2'), info = document.createElement('p');
  cover.replaceChildren(title, info);
  if (race.waitingForTab && !race.ownsSeat) {
    title.textContent = 'Дуэль открыта в другой вкладке';
    info.textContent = 'Закройте ту вкладку, чтобы продолжить здесь с последнего хода.';
    cover.append(raceButton('К моей партии', 'back-to-sheet', () => leaveRace(false)));
    return;
  }
  if (game.phase === 'finished' || game.phase === 'interrupted') {
    if (game.phase === 'finished') {
      title.textContent = race.result.winner === race.role ? 'Вы победили!' : 'Соперник победил';
      info.textContent = 'Победитель верно заполнил лист за ' + formatTime(race.result.elapsedMs) + '.';
    } else {
      title.textContent = 'Дуэль прервана';
      info.textContent = race.failure;
    }
    cover.append(raceButton('Вернуться к своей партии', 'leave-duel', () => leaveRace(false)));
    return;
  }
  if (game.phase === 'countdown') {
    title.textContent = 'Оба готовы';
    info.textContent = 'Начинаем через';
    const count = document.createElement('strong');
    count.id = 'countdown';
    cover.append(count);
    return;
  }
  title.textContent = race.connected ? 'Готовы к старту?' : 'Дуэль по ссылке';
  if (race.connected) {
    info.textContent = (race.selfReady ? 'Вы готовы.' : 'Вы на месте.') + ' ' +
      (race.otherReady ? 'Соперник готов.' : 'Соперник на месте.');
  } else if (race.url) {
    info.textContent = 'Отправьте ссылку сопернику. В эту комнату можно вернуться с этого устройства.';
  } else if (race.auth?.token) {
    info.textContent = 'Восстанавливаем ваше место в комнате…';
  } else {
    info.textContent = race.role === 'guest' ? 'Подключаемся к сопернику…' : 'Создаём приглашение…';
  }
  if (race.url && !race.connected) {
    const link = document.createElement('input');
    link.id = 'invite-url'; link.type = 'url'; link.readOnly = true;
    link.value = race.url; link.setAttribute('aria-label', 'Ссылка для соперника');
    link.onclick = () => link.select();
    const actions = document.createElement('div');
    actions.className = 'invite-actions';
    actions.append(raceButton('Скопировать ссылку', 'copy-duel', async () => {
      try {
        await navigator.clipboard.writeText(link.value);
        $('message').textContent = 'Ссылка скопирована.';
      } catch {
        link.focus(); link.select();
        $('message').textContent = 'Выделили ссылку. Скопируйте её через меню браузера.';
      }
    }));
    if (navigator.share) actions.append(raceButton('Поделиться', 'share-duel', async () => {
      try { await navigator.share({title: 'Дуэль в судоку', url: link.value}); }
      catch (error) { if (error.name !== 'AbortError') $('message').textContent = 'Скопируйте ссылку и отправьте её сопернику.'; }
    }, 'lined'));
    cover.append(link, actions);
  }
  if (race.connected) {
    showRaceLevels(cover);
    const ready = raceButton(race.selfReady ? 'Ждём старта' : 'Готов', 'ready-duel', () => race.net.ready());
    ready.disabled = race.selfReady || race.levelPending;
    cover.append(ready);
  }
}

function leaveRace(roomEnded = false) {
  if (!race) return;
  const session = race;
  if (roomEnded && session.ownsSeat) DuelRecovery.drop(session.key);
  else saveRace();
  race = null;
  session.net?.suspend();
  session.release?.();
  session.lockAbort?.abort();
  const invite = new URLSearchParams(location.hash.slice(1)).get('duel');
  if (invite !== null && (invite === session.roomId || invite === session.auth?.roomId)) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  game = session.previous;
  $('message').textContent = '';
  $('race-storage-warning').hidden = true;
  updateLinkStatus();
  refreshResumeButton();
  render(); resume();
}

function askLeaveRace() {
  if (!race.ownsSeat || ['finished','interrupted'].includes(game.phase)) { leaveRace(false); return; }
  const session = race;
  dialog('Выйти из дуэли?', '<p>Место и ходы сохранятся в этом браузере. Секундомер продолжит идти.</p><button id="keep-duel" class="primary">Вернуться позже</button><button id="confirm-leave" class="lined end-duel">Завершить дуэль для обоих</button><p id="end-status" role="status"></p>');
  $('keep-duel').onclick = () => { $('modal').close(); leaveRace(false); };
  const end = $('confirm-leave');
  end.disabled = !session.net?.token || session.ending;
  if (session.ending) $('end-status').textContent = 'Ждём подтверждения сервера…';
  end.onclick = async () => {
    session.ending = true;
    end.disabled = true;
    $('end-status').textContent = 'Ждём подтверждения сервера…';
    const ended = await session.net.endRoom();
    session.ending = false;
    if (race !== session) return;
    if (ended) {
      if ($('modal').open) $('modal').close();
      leaveRace(true);
    } else if ($('end-status')) {
      $('end-status').textContent = 'Закрытие комнаты не подтверждено. Вы можете вернуться в неё позже.';
      $('confirm-leave').disabled = !session.net?.token;
    }
  };
}

$('resume-duel').onclick = () => {
  const record = DuelRecovery.find();
  if (record) openRace(record.game.level, null, record);
  else refreshResumeButton();
};
$('retry-duel').onclick = retryRace;
window.addEventListener('online', retryRace);
window.addEventListener('pagehide', () => {
  if (!race) return;
  saveRace();
  race.net?.suspend();
  race.ownsSeat = false;
  race.release?.(); race.lockAbort?.abort();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted || !race) return;
  if (['finished','interrupted'].includes(game.phase)) return;
  race.net = null; race.finishInFlight = false; race.loading = false; race.levelPending = false;
  acquireRaceSeat(race, !!race.auth);
});
window.addEventListener('storage', () => { if (!race) refreshResumeButton(); });
window.addEventListener('hashchange', () => {
  const room = new URLSearchParams(location.hash.slice(1)).get('duel');
  if (!room || room === race?.roomId || room === race?.auth?.roomId) return;
  const record = DuelRecovery.find(room);
  if (race) leaveRace(false);
  openRace(record?.game.level ?? game.level, room, record);
});
const invitation = new URLSearchParams(location.hash.slice(1)).get('duel');
const savedRace = DuelRecovery.find(invitation ?? undefined);
if (savedRace || invitation !== null) openRace(savedRace?.game.level ?? game.level, invitation ?? null, savedRace);
else refreshResumeButton();
