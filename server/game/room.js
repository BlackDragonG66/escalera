// Lógica principal de una Sala (Room) de Next Tap Puzzle.
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
      assistMode: !!options.assistMode, // modo asistido: elegir de opciones en vez de escribir
      learnMode: !!options.learnMode, // modo aprendizaje: da pistas al fallar (solo practica, solo inglés)
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
    this.chainHistory = []; // lista creciente de palabras jugadas, para mostrar la cadena completa
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
    this.chainHistory = [{ word: start, playerId: null, translation: dictionaries.getTranslation(start, this.settings.language) }];
  }

  // Genera variantes "casi correctas" de una palabra: letras trocadas de posición
  // o una letra de más, para usar como distractores realistas (ej: night -> nigth).
  static makeTypoVariants(word, howMany = 3) {
    const variants = new Set();
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    let attempts = 0;
    while (variants.size < howMany && attempts < 30) {
      attempts++;
      const type = Math.floor(Math.random() * 3);
      let variant = word;
      if (type === 0 && word.length >= 3) {
        // Intercambia dos letras adyacentes (ej: night -> nigth).
        const i = 1 + Math.floor(Math.random() * (word.length - 2));
        const chars = word.split('');
        [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
        variant = chars.join('');
      } else if (type === 1) {
        // Inserta una letra de más en una posición aleatoria (no al inicio, para conservar la letra requerida).
        const i = 1 + Math.floor(Math.random() * word.length);
        const extra = letters[Math.floor(Math.random() * letters.length)];
        variant = word.slice(0, i) + extra + word.slice(i);
      } else if (word.length >= 3) {
        // Cambia una letra interna por otra (mal ubicada/mal escrita).
        const i = 1 + Math.floor(Math.random() * (word.length - 2));
        const wrong = letters[Math.floor(Math.random() * letters.length)];
        variant = word.slice(0, i) + wrong + word.slice(i + 1);
      }
      if (variant !== word && !variants.has(variant)) variants.add(variant);
    }
    return [...variants];
  }

  // Modo asistido: genera opciones (múltiple opción) para el jugador actual, en vez de escribir.
  // Incluye 1 palabra válida (real) + distractores que son variantes "casi correctas" con error
  // (letra de más o mal ubicada), para que parezcan opciones plausibles y no obviamente distintas.
  generateOptions(count = 4) {
    const dict = [...this.dictionary];
    if (!dict.length) return [];
    const expectedLetter = this.currentWord ? dictionaries.lastLetter(this.currentWord) : null;

    const valid = dict.filter((w) => {
      const stripped = dictionaries.stripAccents(w);
      const startsOk = !expectedLetter || dictionaries.firstLetter(w) === expectedLetter;
      const notUsed = !this.settings.noRepeatAcrossRounds || !this.usedWords.has(stripped);
      return startsOk && notUsed;
    });

    if (!valid.length) return [];
    const correctWord = valid[Math.floor(Math.random() * valid.length)];
    const options = new Set([correctWord]);

    // Distractores tipo "typo" derivados de la palabra correcta (2-3 opciones erróneas plausibles).
    const dictSet = new Set(dict.map((w) => w.toLowerCase()));
    const typoVariants = Room.makeTypoVariants(correctWord, count + 2)
      .filter((v) => !dictSet.has(v.toLowerCase()));
    for (const v of typoVariants) {
      if (options.size >= count) break;
      options.add(v);
    }

    // Si aún faltan opciones, rellena con otras palabras válidas distintas (variedad) o cualquiera del diccionario.
    const shuffledValid = [...valid].filter((w) => w !== correctWord).sort(() => Math.random() - 0.5);
    for (const w of shuffledValid) {
      if (options.size >= count) break;
      const variant = Room.makeTypoVariants(w, 1)[0];
      if (variant && !dictSet.has(variant.toLowerCase())) options.add(variant);
    }
    const shuffledAll = [...dict].sort(() => Math.random() - 0.5);
    for (const w of shuffledAll) {
      if (options.size >= count) break;
      options.add(w);
    }
    return [...options].slice(0, count).sort(() => Math.random() - 0.5);
  }

  // Modo aprendizaje: al fallar, entrega sugerencias de palabras válidas para continuar
  // (y, en inglés con verbos, la forma pasado/participio relacionada).
  getHintsOnFail() {
    const dict = [...this.dictionary];
    const expectedLetter = this.currentWord ? dictionaries.lastLetter(this.currentWord) : null;
    const candidates = dict.filter((w) => {
      const stripped = dictionaries.stripAccents(w);
      const startsOk = !expectedLetter || dictionaries.firstLetter(w) === expectedLetter;
      const notUsed = !this.settings.noRepeatAcrossRounds || !this.usedWords.has(stripped);
      return startsOk && notUsed;
    });
    const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, 5);

    const hints = { words: shuffled, verbForms: null };

    // Si la categoría incluye verbos en inglés (pasado/participio), añade la forma relacionada
    // de la palabra actual como pista extra de aprendizaje.
    if (this.settings.language === 'en') {
      const entry = dictionaries.findIrregularEntry(this.currentWord);
      if (entry) hints.verbForms = entry;
    }
    return hints;
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
    this.chainHistory.push({ word: norm, playerId, translation: dictionaries.getTranslation(norm, this.settings.language) });

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
      currentWordTranslation: this.currentWordRaw
        ? dictionaries.getTranslation(this.currentWordRaw, this.settings.language)
        : null,
      currentPlayerId: this.currentPlayerId(),
      chainHistory: this.chainHistory,
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
