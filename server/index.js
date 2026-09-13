const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { RoomManager } = require('./game/roomManager');
const dictionaries = require('./game/dictionaries');
const { AVATARS } = require('./game/avatars');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;
const manager = new RoomManager();

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

// Info de categorías disponibles por idioma (para el formulario de creación de sala).
app.get('/api/categories/:lang', (req, res) => {
  const lang = req.params.lang === 'es' ? 'es' : 'en';
  res.json({ language: lang, categories: dictionaries.listCategories(lang) });
});

// Avatares disponibles para elegir.
app.get('/api/avatars', (req, res) => {
  res.json({ avatars: AVATARS });
});

// Visualizar el contenido completo del diccionario (una o varias categorías).
app.get('/api/dictionary/:lang', (req, res) => {
  const lang = req.params.lang === 'es' ? 'es' : 'en';
  const categories = req.query.categories ? String(req.query.categories).split(',').filter(Boolean) : [];
  const words = dictionaries.getWordsArray(lang, categories);
  res.json({ language: lang, categories, words, total: words.length });
});

// Genera un QR apuntando a la URL de "unirse" con el código de sala precargado.
app.get('/api/qr/:code', async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const base = `${req.protocol}://${req.get('host')}`;
  const joinUrl = `${base}/?join=${code}`;
  try {
    const dataUrl = await QRCode.toDataURL(joinUrl, { width: 320, margin: 1 });
    res.json({ url: joinUrl, qr: dataUrl });
  } catch (e) {
    res.status(500).json({ error: 'qr_failed' });
  }
});

function roomUpdate(room) {
  io.to(room.code).emit('room:update', room.toPublicState());
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function scheduleTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.settings.turnTimeLimitSec) return;
  const ms = room.settings.turnTimeLimitSec * 1000;
  room.turnDeadline = Date.now() + ms;
  room.turnTimer = setTimeout(() => {
    const playerId = room.currentPlayerId();
    if (!playerId) return;
    const hints = room.settings.learnMode ? room.getHintsOnFail() : null;
    room.failTurn(playerId);
    io.to(room.code).emit('game:timeout', { playerId, hints });
    if (room.state === 'finished') {
      io.to(room.code).emit('game:finished', room.toPublicState());
    } else {
      scheduleTurnTimer(room);
    }
    roomUpdate(room);
  }, ms);
}

io.on('connection', (socket) => {
  let currentRoomCode = null;
  let currentPlayerId = null;

  socket.on('room:create', (payload, cb) => {
    try {
      const room = manager.createRoom(socket.id, payload || {});
      const host = room.addPlayer(payload?.hostName || 'Host', socket.id, true, payload?.avatar || null);
      room.hostPlayerId = host.id;
      currentRoomCode = room.code;
      currentPlayerId = host.id;
      socket.join(room.code);
      cb && cb({ ok: true, code: room.code, playerId: host.id, room: room.toPublicState() });
      roomUpdate(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('room:join', ({ code, name, avatar }, cb) => {
    const room = manager.getRoom(code);
    if (!room) return cb && cb({ ok: false, error: 'not_found' });
    if (room.state === 'playing') {
      // Permitir unirse como espectador tardío en modo party (se integrará en la próxima ronda)
    }
    const player = room.addPlayer(name || `Jugador${room.players.size + 1}`, socket.id, false, avatar || null);
    currentRoomCode = room.code;
    currentPlayerId = player.id;
    socket.join(room.code);
    cb && cb({ ok: true, code: room.code, playerId: player.id, room: room.toPublicState() });
    roomUpdate(room);
  });

  socket.on('room:reconnect', ({ code, playerId }, cb) => {
    const room = manager.getRoom(code);
    if (!room || !room.players.has(playerId)) {
      return cb && cb({ ok: false, error: 'not_found' });
    }
    const player = room.players.get(playerId);
    player.socketId = socket.id;
    player.connected = true;
    currentRoomCode = room.code;
    currentPlayerId = playerId;
    socket.join(room.code);
    cb && cb({ ok: true, room: room.toPublicState() });
    roomUpdate(room);
  });

  socket.on('team:create', ({ name }, cb) => {
    const room = manager.getRoom(currentRoomCode);
    if (!room) return cb && cb({ ok: false });
    const team = room.createTeam(name || `Equipo ${room.teams.size + 1}`);
    cb && cb({ ok: true, team });
    roomUpdate(room);
  });

  socket.on('team:join', ({ teamId }, cb) => {
    const room = manager.getRoom(currentRoomCode);
    if (!room) return cb && cb({ ok: false });
    room.assignTeam(currentPlayerId, teamId);
    cb && cb({ ok: true });
    roomUpdate(room);
  });

  socket.on('room:updateSettings', (settings, cb) => {
    const room = manager.getRoom(currentRoomCode);
    if (!room || room.hostSocketId !== socket.id) return cb && cb({ ok: false, error: 'not_host' });
    Object.assign(room.settings, settings || {});
    cb && cb({ ok: true });
    roomUpdate(room);
  });

  socket.on('game:start', (cb) => {
    const room = manager.getRoom(currentRoomCode);
    if (!room || room.hostSocketId !== socket.id) return cb && cb({ ok: false, error: 'not_host' });
    room.start();
    cb && cb({ ok: true });
    io.to(room.code).emit('game:started', room.toPublicState());
    scheduleTurnTimer(room);
    roomUpdate(room);
  });

  // Modo asistido: entrega opciones (multiple choice) para el jugador en turno, en vez de escribir.
  socket.on('game:getOptions', (cb) => {
    const room = manager.getRoom(currentRoomCode);
    if (!room || room.state !== 'playing') return cb && cb({ ok: false });
    const options = room.generateOptions(4);
    cb && cb({ ok: true, options });
  });

  socket.on('game:submitWord', ({ word }, cb) => {
    const room = manager.getRoom(currentRoomCode);
    if (!room || room.state !== 'playing') return cb && cb({ ok: false, error: 'not_playing' });
    const playerId = currentPlayerId;
    if (room.currentPlayerId() !== playerId) {
      return cb && cb({ ok: false, error: 'not_your_turn' });
    }

    const validation = room.validateWord(word);

    if (room.settings.hostReviewsAnswers && validation.ok) {
      // El host decide si la palabra es válida (modo "todo vale, el host revisa").
      io.to(room.hostSocketId).emit('game:reviewRequest', {
        playerId,
        playerName: room.players.get(playerId)?.name,
        word,
      });
      room.pendingReview = { playerId, word };
      cb && cb({ ok: true, pendingReview: true });
      return;
    }

    if (!validation.ok) {
      room.failTurn(playerId);
      const hints = room.settings.learnMode ? room.getHintsOnFail() : null;
      cb && cb({ ok: false, reason: validation.reason, expectedLetter: validation.expectedLetter, hints });
      io.to(room.code).emit('game:wordRejected', { playerId, word, reason: validation.reason });
      if (room.state === 'finished') {
        io.to(room.code).emit('game:finished', room.toPublicState());
      } else {
        scheduleTurnTimer(room);
      }
      roomUpdate(room);
      return;
    }

    room.acceptWord(playerId, word);
    cb && cb({ ok: true });
    io.to(room.code).emit('game:wordAccepted', { playerId, word });
    scheduleTurnTimer(room);
    roomUpdate(room);
  });

  // Resolución manual del host cuando hostReviewsAnswers está activo.
  socket.on('game:reviewDecision', ({ approve }, cb) => {
    const room = manager.getRoom(currentRoomCode);
    if (!room || room.hostSocketId !== socket.id || !room.pendingReview) {
      return cb && cb({ ok: false });
    }
    const { playerId, word } = room.pendingReview;
    room.pendingReview = null;
    if (approve) {
      room.acceptWord(playerId, word);
      io.to(room.code).emit('game:wordAccepted', { playerId, word });
    } else {
      room.failTurn(playerId);
      io.to(room.code).emit('game:wordRejected', { playerId, word, reason: 'host_rejected' });
    }
    cb && cb({ ok: true });
    if (room.state === 'finished') {
      io.to(room.code).emit('game:finished', room.toPublicState());
    } else {
      scheduleTurnTimer(room);
    }
    roomUpdate(room);
  });

  socket.on('game:nextRound', (cb) => {
    const room = manager.getRoom(currentRoomCode);
    if (!room || room.hostSocketId !== socket.id) return cb && cb({ ok: false, error: 'not_host' });
    room.nextRound();
    room.start();
    cb && cb({ ok: true });
    io.to(room.code).emit('game:started', room.toPublicState());
    scheduleTurnTimer(room);
    roomUpdate(room);
  });

  socket.on('disconnect', () => {
    const room = manager.getRoom(currentRoomCode);
    if (!room) return;
    const player = room.players.get(currentPlayerId);
    if (player) {
      player.connected = false;
      roomUpdate(room);
    }
  });
});

// Limpieza periódica de salas inactivas.
setInterval(() => manager.cleanup(), 1000 * 60 * 30);

server.listen(PORT, () => {
  console.log(`Escalera corriendo en http://localhost:${PORT}`);
});
