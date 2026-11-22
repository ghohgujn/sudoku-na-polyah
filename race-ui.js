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
    transportLoading = loadScript('duel-network.js')
      .catch(error => { transportLoading = null; throw error; });
  }
  return transportLoading;
}

async function openRace(level, roomId) {
  if (race) return;
  settle();
  persist();
  const session = {previous: game, role: roomId ? 'guest' : 'host', connected: false,
    selfReady: false, otherReady: false, submitted: false, startAt: 0, net: null};
  race = session;
  game = {...session.previous, mode: 'online', level, selected: -1, note: false,
    puzzle: Array(81).fill(0), boards: [emptyBoard(), emptyBoard()], phase: 'lobby',
    player: 0, times: [0, 0]};
  $('message').textContent = '';
  render();

  try {
    await loadDuelTransport();
    if (race !== session) return;
    session.net = new DuelNetwork({
      onEvent: (type, data) => { if (race === session) handleRaceEvent(type, data); },
      validate: (values, puzzle) => correct(values) &&
        puzzle.length === 81 && puzzle.every((given, i) => !given || given === values[i])
    });
    if (roomId) await session.net.join(roomId);
    else {
      game.puzzle = newPuzzle(level);
      await session.net.host({level, puzzle: game.puzzle});
    }
  } catch (error) {
    if (race === session) handleRaceEvent('error', {message: error.message});
  }
}

function handleRaceEvent(type, data = {}) {
  if (!race || game.phase === 'finished' || game.phase === 'interrupted') return;
  switch (type) {
    case 'invite':
      race.url = data.url;
      break;
    case 'connected':
      race.role = data.role;
      race.connected = true;
      game.level = data.level;
      game.puzzle = data.puzzle.slice();
      break;
    case 'ready':
      race.selfReady = data.self;
      race.otherReady = data.other;
      break;
    case 'countdown':
    case 'start':
      race.startAt = data.startAt;
      game.phase = type === 'start' ? 'play' : 'countdown';
      break;
    case 'rejected':
      race.submitted = false;
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
  render();
}

function raceButton(text, id, action, className = 'primary') {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = text; btn.id = id; btn.className = className;
  btn.onclick = action;
  return btn;
}

function renderRaceCover() {
  const cover = $('cover');
  const title = document.createElement('h2'), info = document.createElement('p');
  cover.replaceChildren(title, info);
  if (game.phase === 'finished' || game.phase === 'interrupted') {
    if (game.phase === 'finished') {
      title.textContent = race.result.winner === race.role ? 'Вы победили!' : 'Соперник победил';
      info.textContent = 'Победитель верно заполнил лист за ' + formatTime(race.result.elapsedMs) + '.';
    } else {
      title.textContent = 'Дуэль прервана';
      info.textContent = race.failure;
    }
    cover.append(raceButton('Вернуться к своей партии', 'leave-duel', leaveRace));
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
    info.textContent = 'Отправьте ссылку сопернику и оставьте эту вкладку открытой.';
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
    const ready = raceButton(race.selfReady ? 'Ждём старта' : 'Готов', 'ready-duel', () => race.net.ready());
    ready.disabled = race.selfReady;
    cover.append(ready);
  }
}

function leaveRace() {
  if (!race) return;
  const previous = race.previous, net = race.net;
  race = null;
  if (net) net.close();
  if (new URLSearchParams(location.hash.slice(1)).has('duel')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  game = previous;
  $('message').textContent = '';
  render(); resume();
}

function askLeaveRace() {
  if (game.phase === 'finished' || game.phase === 'interrupted') { leaveRace(); return; }
  dialog('Выйти из дуэли?', '<p>Связь с соперником закроется. Вы вернётесь к своей сохранённой партии.</p><button id="confirm-leave" class="primary">Выйти из дуэли</button>');
  $('confirm-leave').onclick = () => { $('modal').close(); leaveRace(); };
}

const invitation = new URLSearchParams(location.hash.slice(1)).get('duel');
if (invitation !== null) openRace(game.level, invitation || 'invalid');
