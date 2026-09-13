// Escalera - cliente
(() => {
  const socket = io();

  const state = {
    screen: 'home',
    mode: null, // 'practice' | 'pvp' | 'party'
    roomCode: null,
    playerId: null,
    isHost: false,
    room: null, // último estado público de sala recibido
    avatars: [],
    selectedAvatarCreate: null,
    selectedAvatarJoin: null,
    selectedCategoriesPractice: new Set(),
    selectedCategoriesCreate: new Set(),
    timerInterval: null,
    // práctica solo (sin servidor de sala, lógica local)
    practice: null,
  };

  // ---------- Utilidades DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => [...document.querySelectorAll(sel)];

  function showScreen(id) {
    $all('.screen').forEach((s) => s.classList.remove('active'));
    $(`#${id}`).classList.add('active');
    state.screen = id;
  }

  function stripAccents(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ñ/g, 'n');
  }

  // ---------- Carga inicial: avatares y categorías ----------
  async function loadAvatars() {
    const res = await fetch('/api/avatars');
    const data = await res.json();
    state.avatars = data.avatars || [];
    renderAvatarPicker('#create-avatar-picker', 'selectedAvatarCreate');
    renderAvatarPicker('#join-avatar-picker', 'selectedAvatarJoin');
  }

  function renderAvatarPicker(selector, stateKey) {
    const el = $(selector);
    if (!el) return;
    el.innerHTML = '';
    state.avatars.forEach((url, idx) => {
      const img = document.createElement('img');
      img.src = url;
      img.loading = 'lazy';
      img.addEventListener('click', () => {
        state[stateKey] = url;
        [...el.children].forEach((c) => c.classList.remove('selected'));
        img.classList.add('selected');
      });
      if (idx === 0) {
        img.classList.add('selected');
        state[stateKey] = url;
      }
      el.appendChild(img);
    });
  }

  async function loadCategories(lang, listSelector, selectedSet) {
    const res = await fetch(`/api/categories/${lang}`);
    const data = await res.json();
    const el = $(listSelector);
    el.innerHTML = '';
    selectedSet.clear();
    data.categories.forEach((cat) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = categoryLabel(cat);
      chip.dataset.cat = cat;
      chip.addEventListener('click', () => {
        if (selectedSet.has(cat)) {
          selectedSet.delete(cat);
          chip.classList.remove('selected');
        } else {
          selectedSet.add(cat);
          chip.classList.add('selected');
        }
      });
      el.appendChild(chip);
    });
  }

  function categoryLabel(cat) {
    const labels = {
      verbs: 'Verbos', animals: 'Animales', cities: 'Ciudades', colors: 'Colores',
      food: 'Comida', countries: 'Países', sports: 'Deportes',
      verbos: 'Verbos', animales: 'Animales', ciudades: 'Ciudades', colores: 'Colores',
      comida: 'Comida', paises: 'Países', deportes: 'Deportes',
    };
    return labels[cat] || cat;
  }

  // ---------- Navegación ----------
  $all('[data-back]').forEach((btn) =>
    btn.addEventListener('click', () => {
      stopTimerDisplay();
      showScreen('screen-home');
    })
  );

  $('#btn-practice').addEventListener('click', async () => {
    await loadCategories('en', '#practice-categories-list', state.selectedCategoriesPractice);
    showScreen('screen-practice');
  });
  $('#practice-lang').addEventListener('change', (e) => {
    loadCategories(e.target.value, '#practice-categories-list', state.selectedCategoriesPractice);
  });

  $('#btn-pvp').addEventListener('click', async () => {
    state.mode = 'pvp';
    $('#create-title').textContent = '⚔️ Crear duelo PvP 1 vs 1';
    $('#create-teams').closest('label').classList.add('hidden');
    $('#create-host-plays').checked = true;
    await loadCategories('en', '#create-categories-list', state.selectedCategoriesCreate);
    showScreen('screen-create');
  });

  $('#btn-create-room').addEventListener('click', async () => {
    state.mode = 'party';
    $('#create-title').textContent = '📶 Crear sala';
    $('#create-teams').closest('label').classList.remove('hidden');
    $('#create-host-plays').checked = false;
    await loadCategories('en', '#create-categories-list', state.selectedCategoriesCreate);
    showScreen('screen-create');
  });
  $('#create-lang').addEventListener('change', (e) => {
    loadCategories(e.target.value, '#create-categories-list', state.selectedCategoriesCreate);
  });

  $('#btn-join-room').addEventListener('click', () => {
    showScreen('screen-join');
    const params = new URLSearchParams(location.search);
    const codeFromQr = params.get('join');
    if (codeFromQr) $('#join-code').value = codeFromQr.toUpperCase();
  });

  // Si venimos de un link con ?join=CODE, saltar directo a unirse
  (function autoJoinFromQr() {
    const params = new URLSearchParams(location.search);
    const code = params.get('join');
    if (code) {
      $('#btn-join-room').click();
    }
  })();

  // ---------- PRACTICAR SOLO (usa el mismo motor de sala del servidor, un solo jugador) ----------
  async function fetchDictionaryWords() {
    // no-op placeholder removed; la práctica usa room:create directamente (ver listener abajo)
  }

  function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  $('#practice-start').addEventListener('click', () => {
    const lang = $('#practice-lang').value;
    const categories = [...state.selectedCategoriesPractice];
    const startWord = $('#practice-start-word').value.trim();
    const turnTimeLimitSec = parseInt($('#practice-time').value, 10) || 20;

    socket.emit(
      'room:create',
      {
        mode: 'practice',
        language: lang,
        categories,
        startWord: startWord || null,
        turnTimeLimitSec,
        noRepeatAcrossRounds: true,
        disqualifyOnFail: true,
        hostReviewsAnswers: false,
        teamsEnabled: false,
        hostPlays: true,
        hostName: 'Yo',
      },
      (resp) => {
        if (!resp || !resp.ok) {
          alert('No se pudo iniciar la práctica.');
          return;
        }
        state.roomCode = resp.code;
        state.playerId = resp.playerId;
        state.isHost = true;
        state.mode = 'practice';
        socket.emit('game:start', () => {});
        showScreen('screen-game');
      }
    );
  });

  // ---------- CREAR SALA (host) ----------
  $('#create-submit').addEventListener('click', () => {
    const hostName = $('#create-host-name').value.trim() || 'Host';
    const lang = $('#create-lang').value;
    const categories = [...state.selectedCategoriesCreate];
    const startWord = $('#create-start-word').value.trim();
    const turnTimeLimitSec = parseInt($('#create-time').value, 10) || 20;
    const noRepeatAcrossRounds = $('#create-no-repeat').checked;
    const disqualifyOnFail = $('#create-disqualify').checked;
    const hostReviewsAnswers = $('#create-host-reviews').checked;
    const teamsEnabled = state.mode === 'party' && $('#create-teams').checked;
    const hostPlays = $('#create-host-plays').checked;

    socket.emit(
      'room:create',
      {
        mode: state.mode === 'pvp' ? 'pvp' : 'party',
        language: lang,
        categories,
        startWord: startWord || null,
        turnTimeLimitSec,
        noRepeatAcrossRounds,
        disqualifyOnFail,
        hostReviewsAnswers,
        teamsEnabled,
        hostPlays,
        hostName,
        avatar: state.selectedAvatarCreate,
      },
      (resp) => {
        if (!resp || !resp.ok) {
          alert('No se pudo crear la sala.');
          return;
        }
        state.roomCode = resp.code;
        state.playerId = resp.playerId;
        state.isHost = true;
        state.room = resp.room;
        enterLobby(resp.code);
      }
    );
  });

  // ---------- UNIRSE A SALA ----------
  $('#join-submit').addEventListener('click', () => {
    const code = $('#join-code').value.trim().toUpperCase();
    const name = $('#join-name').value.trim() || 'Jugador';
    if (!code) return alert('Ingresa el código de la sala.');
    socket.emit('room:join', { code, name, avatar: state.selectedAvatarJoin }, (resp) => {
      if (!resp || !resp.ok) {
        alert('No se encontró la sala. Verifica el código.');
        return;
      }
      state.roomCode = resp.code;
      state.playerId = resp.playerId;
      state.isHost = false;
      state.room = resp.room;
      enterLobby(resp.code);
    });
  });

  // ---------- LOBBY ----------
  async function enterLobby(code) {
    showScreen('screen-lobby');
    $('#lobby-code').textContent = code;
    try {
      const res = await fetch(`/api/qr/${code}`);
      const data = await res.json();
      $('#lobby-qr').src = data.qr;
    } catch (e) {
      // silencioso, el QR es un extra
    }
    $('#lobby-start-btn').classList.toggle('hidden', !state.isHost);
    $('#lobby-wait-msg').classList.toggle('hidden', state.isHost);
  }

  $('#lobby-start-btn').addEventListener('click', () => {
    socket.emit('game:start', (resp) => {
      if (!resp || !resp.ok) alert('No se pudo iniciar el juego.');
    });
  });

  $('#lobby-create-team').addEventListener('click', () => {
    const name = prompt('Nombre del equipo:');
    if (!name) return;
    socket.emit('team:create', { name }, () => {});
  });

  // ---------- RENDER SALA (lobby + scoreboard en vivo) ----------
  function renderRoom(room) {
    state.room = room;

    // Lobby: lista de jugadores / equipos
    if (state.screen === 'screen-lobby' || room.state === 'lobby') {
      const teamsEnabled = room.settings.teamsEnabled;
      $('#lobby-teams-box').classList.toggle('hidden', !teamsEnabled);

      if (teamsEnabled) {
        renderTeamsLobby(room);
      } else {
        const ul = $('#lobby-players-list');
        ul.innerHTML = '';
        room.players.forEach((p) => ul.appendChild(playerListItem(p)));
      }
    }

    // Juego: estado de turno, palabra, scoreboard
    if (room.state === 'playing') {
      if (state.screen !== 'screen-game') showScreen('screen-game');
      renderGameState(room);
    }

    if (room.state === 'finished') {
      renderEndScreen(room);
      if (state.screen !== 'screen-end') showScreen('screen-end');
    }
  }

  function renderTeamsLobby(room) {
    const box = $('#lobby-teams-list');
    box.innerHTML = '';
    const noTeam = room.players.filter((p) => !p.teamId);
    room.teams.forEach((team) => {
      const div = document.createElement('div');
      div.className = 'team-block';
      const members = room.players.filter((p) => p.teamId === team.id);
      div.innerHTML = `<h4>👥 ${escapeHtml(team.name)} — ${team.score} pts</h4>`;
      const ul = document.createElement('ul');
      members.forEach((p) => ul.appendChild(playerListItem(p)));
      div.appendChild(ul);
      if (!state.isHost) {
        const btn = document.createElement('button');
        btn.className = 'btn-secondary';
        btn.textContent = 'Unirme a este equipo';
        btn.addEventListener('click', () => {
          socket.emit('team:join', { teamId: team.id }, () => {});
        });
        div.appendChild(btn);
      }
      box.appendChild(div);
    });
    if (noTeam.length) {
      const div = document.createElement('div');
      div.className = 'team-block';
      div.innerHTML = '<h4>🙋 Sin equipo</h4>';
      const ul = document.createElement('ul');
      noTeam.forEach((p) => ul.appendChild(playerListItem(p)));
      div.appendChild(ul);
      box.appendChild(div);
    }
  }

  function playerListItem(p) {
    const li = document.createElement('li');
    li.className = 'player-item' + (!p.alive ? ' dead' : '');
    const avatar = p.avatar
      ? `<img src="${p.avatar}" alt="" />`
      : '';
    li.innerHTML = `${avatar}<span class="name">${escapeHtml(p.name)}${
      p.isHost ? ' <span class="badge-host">HOST</span>' : ''
    }</span><span class="score">${p.score}</span>`;
    return li;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- JUEGO ----------
  function renderGameState(room) {
    $('#game-round-num').textContent = room.round;
    $('#game-current-word').textContent = room.currentWord || '—';
    const lastLetter = stripAccents(room.currentWord || '').slice(-1).toUpperCase();
    $('#game-next-letter').textContent = lastLetter || '?';

    const currentPlayer = room.players.find((p) => p.id === room.currentPlayerId);
    const isMyTurn = room.currentPlayerId === state.playerId;
    $('#game-turn-indicator').textContent = currentPlayer
      ? `Turno de: ${currentPlayer.name}${isMyTurn ? ' (¡Tú!)' : ''}`
      : 'Esperando...';

    $('#game-word-input').disabled = !isMyTurn;
    $('#game-submit-btn').disabled = !isMyTurn;

    // Scoreboard en vivo, ordenado por puntaje. Muestra equipos si están activados.
    const list = $('#game-scoreboard-list');
    list.innerHTML = '';
    if (room.settings.teamsEnabled && room.teams.length) {
      [...room.teams]
        .sort((a, b) => b.score - a.score)
        .forEach((team) => {
          const li = document.createElement('li');
          li.className = 'player-item';
          li.innerHTML = `<span class="name">👥 ${escapeHtml(team.name)}</span><span class="score">${team.score}</span>`;
          list.appendChild(li);
        });
    } else {
      [...room.players]
        .sort((a, b) => b.score - a.score)
        .forEach((p) => list.appendChild(playerListItem(p)));
    }

    // Host revisa respuestas
    $('#host-review-box').classList.add('hidden');
  }

  $('#game-submit-btn').addEventListener('click', submitWord);
  $('#game-word-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitWord();
  });

  function submitWord() {
    const input = $('#game-word-input');
    const word = input.value.trim();
    if (!word) return;
    socket.emit('game:submitWord', { word }, (resp) => {
      const fb = $('#game-feedback');
      if (!resp) return;
      if (resp.pendingReview) {
        fb.textContent = 'Respuesta enviada, esperando revisión del host...';
        fb.className = 'feedback';
        input.value = '';
        return;
      }
      if (resp.ok) {
        fb.textContent = '¡Correcto! ✅';
        fb.className = 'feedback ok';
        input.value = '';
      } else {
        const reasons = {
          chain: `Debe empezar con "${(resp.expectedLetter || '').toUpperCase()}"`,
          repeated: 'Esa palabra ya se usó',
          not_in_dictionary: 'Palabra no encontrada en el diccionario',
          empty: 'Escribe una palabra',
        };
        fb.textContent = `Incorrecto ❌ ${reasons[resp.reason] || ''}`;
        fb.className = 'feedback err';
      }
    });
  }

  socket.on('game:reviewRequest', ({ playerId, playerName, word }) => {
    $('#host-review-box').classList.remove('hidden');
    $('#review-player-name').textContent = playerName;
    $('#review-word').textContent = word;
    $('#host-review-box').dataset.playerId = playerId;
  });

  $('#review-approve').addEventListener('click', () => {
    socket.emit('game:reviewDecision', { approve: true }, () => {});
    $('#host-review-box').classList.add('hidden');
  });
  $('#review-reject').addEventListener('click', () => {
    socket.emit('game:reviewDecision', { approve: false }, () => {});
    $('#host-review-box').classList.add('hidden');
  });

  socket.on('game:wordAccepted', ({ playerId, word }) => {
    if (playerId !== state.playerId) {
      const fb = $('#game-feedback');
      fb.textContent = `✅ Palabra aceptada: "${word}"`;
      fb.className = 'feedback ok';
    }
  });
  socket.on('game:wordRejected', ({ playerId, word, reason }) => {
    if (playerId !== state.playerId) {
      const fb = $('#game-feedback');
      fb.textContent = `❌ Palabra rechazada: "${word}"`;
      fb.className = 'feedback err';
    }
  });
  socket.on('game:timeout', ({ playerId }) => {
    const fb = $('#game-feedback');
    const p = state.room?.players.find((pl) => pl.id === playerId);
    fb.textContent = `⏰ ¡Tiempo agotado para ${p ? p.name : 'jugador'}!`;
    fb.className = 'feedback err';
  });

  socket.on('game:started', (room) => {
    state.room = room;
    showScreen('screen-game');
    renderGameState(room);
    startTimerDisplay(room.settings.turnTimeLimitSec);
  });

  socket.on('game:finished', (room) => {
    stopTimerDisplay();
    state.room = room;
    renderEndScreen(room);
    showScreen('screen-end');
  });

  socket.on('room:update', (room) => {
    renderRoom(room);
    if (room.state === 'playing') {
      restartTimerIfNeeded();
    }
  });

  // ---------- TIMER VISUAL ----------
  function startTimerDisplay(seconds) {
    stopTimerDisplay();
    let remaining = seconds;
    $('#game-timer-num').textContent = remaining;
    state.timerInterval = setInterval(() => {
      remaining -= 1;
      if (remaining < 0) remaining = 0;
      $('#game-timer-num').textContent = remaining;
      if (remaining <= 0) stopTimerDisplay();
    }, 1000);
  }
  function restartTimerIfNeeded() {
    // Reinicia visualmente el cronómetro cada vez que cambia el turno (nueva palabra aceptada/rechazada).
    if (state.room && state.room.settings) {
      startTimerDisplay(state.room.settings.turnTimeLimitSec);
    }
  }
  function stopTimerDisplay() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  // ---------- PANTALLA FINAL ----------
  function renderEndScreen(room) {
    const box = $('#end-results');
    box.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉'];
    if (room.settings.teamsEnabled && room.teams.length) {
      [...room.teams]
        .sort((a, b) => b.score - a.score)
        .forEach((team, idx) => {
          const div = document.createElement('div');
          div.className = 'end-rank';
          div.innerHTML = `<span class="place">${medals[idx] || `#${idx + 1}`}</span> 👥 ${escapeHtml(
            team.name
          )} — ${team.score} pts`;
          box.appendChild(div);
        });
    } else {
      [...room.players]
        .sort((a, b) => b.score - a.score)
        .forEach((p, idx) => {
          const div = document.createElement('div');
          div.className = 'end-rank';
          div.innerHTML = `<span class="place">${medals[idx] || `#${idx + 1}`}</span> ${escapeHtml(
            p.name
          )} — ${p.score} pts`;
          box.appendChild(div);
        });
    }
    $('#end-next-round-btn').classList.toggle('hidden', !state.isHost);
  }

  $('#end-next-round-btn').addEventListener('click', () => {
    socket.emit('game:nextRound', (resp) => {
      if (!resp || !resp.ok) alert('No se pudo iniciar la siguiente ronda.');
    });
  });

  // ---------- Init ----------
  loadAvatars();
  loadCategories('en', '#practice-categories-list', state.selectedCategoriesPractice);
})();
