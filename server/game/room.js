// Lógica principal de una Sala (Room) de Escalera.
const { nanoid } = require('nanoid');
const dictionaries = require('./dictionaries');

function makeRoomCode() {
  // Código corto, fácil de leer/escribir (sin caracteres ambiguos).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

class Player {
  constructor(id, name, socketId, avatar = null) {
    this.id = id;
    this.name = name;
    this.socketId = socketId;
    this.avatar = avatar;
    this.teamId = null;
    this.score = 0;
    this.alive = true; // false = descalificado
    this.connected = true;
    this.isHost = false;
  }
}

class Team {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.score = 0;
  }
}

class Room {
  constructor(hostSocketId, options = {}) {
    this.code = makeRoomCode();
    this.hostSocketId = hostSocketId;
    this.createdAt = Date.now();

    this.settings = {
      mode: options.mode || 'party', // 'practice' | 'pvp' | 'party'
      language: options.language || 'en', // 'en' | 'es'
      categories: options.categories || [], // vacío = todas
      startWord: options.startWord || null, // palabra inicial elegida por el host, o null = aleatoria
      noRepeatAcrossRounds: options.noRepeatAcrossRounds !== false, // no repetir palabras ya usadas
      disqualifyOnFail: options.disqualifyOnFail !== false, // descalificación por fallo/ronda
      hostReviewsAnswers: !!options.hostReviewsAnswers, // "todo vale", el host aprueba/rechaza
      turnTimeLimitSec: options.turnTimeLimitSec || 20,
      teamsEnabled: !!options.teamsEnabled,
      maxRounds: options.maxRounds || 0, // 0 = ilimitado
      hostPlays: !!options.hostPlays, // por defecto el host NO juega, solo modera
    };

    this.players = new Map(); // id -> Player
    this.teams = new Map(); // id -> Team
    this.usedWords = new Set(); // normalizadas, sin acentos
    this.usedWordsByRound = new Set();

    this.state = 'lobby'; // lobby | playing | finished
    this.round = 1;
    this.turnOrder = []; // array de player ids
    this.turnIndex = 0;
    this.currentWord = null;
    this.currentWordRaw = null;
    this.turnDeadline = null;
    this.pendingReview = null; // { playerId, word, resolve }
    this.turnTimer = null;
  }

  addPlayer(name, socketId, isHost = false, avatar = null) {
    const id = nanoid(8);
    const player = new Player(id, name, socketId, avatar);
    player.isHost = isHost;
    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  findPlayerBySocket(socketId) {
    for (const p of this.players.values()) {
      if (p.socketId === socketId) return p;
    }
    return null;
  }

  createTeam(name) {
    const id = nanoid(6);
    const team = new Team(id, name);
    this.teams.set(id, team);
    return team;
  }

  assignTeam(playerId, teamId) {
    const player = this.players.get(playerId);
    if (player) player.teamId = teamId;
  }

  alivePlayers() {
    return [...this.players.values()].filter(
      (p) => p.alive && p.connected && !(p.isHost && !this.settings.hostPlays)
    );
  }

  get dictionary() {
    return dictionaries.getWordSet(this.settings.language, this.settings.categories);
  }

  pickRandomWord() {
    const dict = this.dictionary;
    const arr = [...dict];
    if (!arr.length) return 'start';
    return arr[Math.floor(Math.random() * arr.length)];
  }

  start() {
    this.state = 'playing';
    this.round = 1;
    this.usedWords.clear();
    this.usedWordsByRound.clear();
    this.turnOrder = this.alivePlayers().map((p) => p.id);
    this.turnIndex = 0;
    const start = this.settings.startWord
      ? dictionaries.normalizeWord(this.settings.startWord)
      : this.pickRandomWord();
    this.currentWordRaw = start;
    this.currentWord = start;
    this.usedWords.add(dictionaries.stripAccents(start));
  }

  currentPlayerId() {
    if (!this.turnOrder.length) return null;
    return this.turnOrder[this.turnIndex % this.turnOrder.length];
  }

  advanceTurn() {
    if (!this.turnOrder.length) return;
    let attempts = 0;
    do {
      this.turnIndex = (this.turnIndex + 1) % this.turnOrder.length;
      attempts++;
    } while (
      attempts <= this.turnOrder.length &&
      !this.players.get(this.turnOrder[this.turnIndex])?.alive
    );
  }

  // Valida estructura de cadena (letra) y, si aplica, pertenencia al diccionario / no repetido.
  validateWord(word) {
    const norm = dictionaries.normalizeWord(word);
    const stripped = dictionaries.stripAccents(norm);
    if (!norm) return { ok: false, reason: 'empty' };

    if (this.currentWord && !dictionaries.isValidChain(this.currentWord, norm)) {
      return { ok: false, reason: 'chain', expectedLetter: dictionaries.lastLetter(this.currentWord) };
    }

    if (this.settings.noRepeatAcrossRounds && this.usedWords.has(stripped)) {
      return { ok: false, reason: 'repeated' };
    }

    if (!this.settings.hostReviewsAnswers) {
      const dict = this.dictionary;
      if (dict.size && !dict.has(stripped) && !dict.has(norm)) {
        return { ok: false, reason: 'not_in_dictionary' };
      }
    }

    return { ok: true, norm, stripped };
  }

  acceptWord(playerId, word) {
    const norm = dictionaries.normalizeWord(word);
    const stripped = dictionaries.stripAccents(norm);
    this.currentWord = norm;
    this.currentWordRaw = word;
    this.usedWords.add(stripped);

    const player = this.players.get(playerId);
    if (player) {
      player.score += 10;
      if (player.teamId && this.teams.has(player.teamId)) {
        this.teams.get(player.teamId).score += 10;
      }
    }
    this.advanceTurn();
  }

  // Descalifica jugador (por fallo o timeout), según settings.
  failTurn(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (this.settings.disqualifyOnFail) {
      player.alive = false;
    }
    this.advanceTurn();
    this.checkRoundEnd();
  }

  checkRoundEnd() {
    const alive = this.alivePlayers();
    if (this.settings.mode === 'pvp' && alive.length <= 1) {
      this.state = 'finished';
      return true;
    }
    if (alive.length === 0) {
      this.state = 'finished';
      return true;
    }
    return false;
  }

  nextRound() {
    this.round += 1;
    // revive a todos para la siguiente ronda si se desea reiniciar descalificaciones
    for (const p of this.players.values()) p.alive = true;
    this.turnOrder = this.alivePlayers().map((p) => p.id);
    this.turnIndex = 0;
  }

  toPublicState() {
    return {
      code: this.code,
      state: this.state,
      round: this.round,
      settings: this.settings,
      currentWord: this.currentWordRaw,
      currentPlayerId: this.currentPlayerId(),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        score: p.score,
        alive: p.alive,
        connected: p.connected,
        teamId: p.teamId,
        isHost: p.isHost,
      })),
      teams: [...this.teams.values()],
    };
  }
}

module.exports = { Room, makeRoomCode };
