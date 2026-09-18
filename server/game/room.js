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

    // PvP 1v1 (y modos con jugadores avanzando en paralelo): cada jugador tiene su propia
    // cadena independiente, así ambos pueden responder al mismo tiempo sin esperar turno.
    // id -> { currentWord, currentWordRaw, usedWords: Set, chainHistory: [], wordStartedAt, wordsCompleted }
    this.playerChains = new Map();
  }

  // ¿Existe alguna palabra del diccionario que continúe la cadena (misma letra inicial) y
  // que no esté ya usada? Si no, la cadena está "agotada" y hay que reiniciarla con otra palabra
  // en vez de dejar al jugador sin ninguna opción válida (el bug de quedarse "atascado").
  hasContinuation(word, usedWordsSet) {
    const dict = [...this.dictionary];
    if (!dict.length) return false;
    const expectedLetter = word ? dictionaries.lastLetter(word) : null;
    return dict.some((w) => {
      const stripped = dictionaries.stripAccents(w);
      const startsOk = !expectedLetter || dictionaries.firstLetter(w) === expectedLetter;
      const notUsed = !this.settings.noRepeatAcrossRounds || !usedWordsSet.has(stripped);
      return startsOk && notUsed;
    });
  }

  // Si la cadena actual ya no tiene continuación posible, elige una palabra nueva al azar
  // (no usada, si es posible, y que además tenga su propia continuación) para reiniciar la
  // cadena desde ahí, en vez de quedar sin salida otra vez enseguida.
  // Si el diccionario completo ya se usó, limpia el set de usadas para permitir un nuevo ciclo
  // (en vez de comparar contra un set que ya contiene "todo", lo que dejaría 0 opciones siempre).
  // `excludeWord` evita relanzar la misma palabra sin salida que provocó el atasco.
  // Devuelve la nueva palabra si reinició, o null si no hay ninguna palabra en el diccionario.
  rescueChain(usedWordsSet, excludeWord = null) {
    const dict = [...this.dictionary];
    if (!dict.length) return null;
    const excludeStripped = excludeWord ? dictionaries.stripAccents(dictionaries.normalizeWord(excludeWord)) : null;
    let free = dict.filter((w) => {
      const stripped = dictionaries.stripAccents(w);
      if (excludeStripped && stripped === excludeStripped) return false;
      return !this.settings.noRepeatAcrossRounds || !usedWordsSet.has(stripped);
    });
    if (!free.length) {
      // Diccionario agotado: iniciamos un nuevo ciclo de repetición en vez de quedar sin salida.
      usedWordsSet.clear();
      free = dict.filter((w) => dictionaries.stripAccents(w) !== excludeStripped);
    }
    if (!free.length) free = dict; // último recurso: si solo hay 1 palabra en todo el diccionario
    // Preferimos una palabra que en sí misma tenga continuación, para no volver a atascarnos.
    const withContinuation = free.filter((w) => this.hasContinuation(w, usedWordsSet));
    const finalPool = withContinuation.length ? withContinuation : free;
    return finalPool[Math.floor(Math.random() * finalPool.length)];
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
    // Preferimos una palabra inicial que sí tenga continuación posible en el diccionario,
    // para no arrancar una cadena que se atasque de inmediato.
    const withContinuation = arr.filter((w) => this.hasContinuation(w, new Set()));
    const pool = withContinuation.length ? withContinuation : arr;
    return pool[Math.floor(Math.random() * pool.length)];
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

    // PvP 1v1: cada jugador avanza a su propio ritmo, en paralelo, sobre la misma palabra
    // inicial. Quien conteste más rápido gana más puntos (ver acceptWordFor).
    this.playerChains = new Map();
    if (this.isPvpSimultaneous()) {
      const now = Date.now();
      for (const id of this.turnOrder) {
        this.playerChains.set(id, {
          currentWord: start,
          currentWordRaw: start,
          usedWords: new Set([dictionaries.stripAccents(start)]),
          chainHistory: [{ word: start, playerId: null, translation: dictionaries.getTranslation(start, this.settings.language) }],
          wordStartedAt: now,
          wordsCompleted: 0,
        });
      }
    }
  }

  isPvpSimultaneous() {
    return this.settings.mode === 'pvp';
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
  // `word`/`usedWordsSet` permiten generar opciones para la cadena propia de un jugador en PvP.
  generateOptions(count = 4, word = this.currentWord, usedWordsSet = this.usedWords) {
    const dict = [...this.dictionary];
    if (!dict.length) return [];
    const expectedLetter = word ? dictionaries.lastLetter(word) : null;

    let valid = dict.filter((w) => {
      const stripped = dictionaries.stripAccents(w);
      const startsOk = !expectedLetter || dictionaries.firstLetter(w) === expectedLetter;
      const notUsed = !this.settings.noRepeatAcrossRounds || !usedWordsSet.has(stripped);
      return startsOk && notUsed;
    });

    // Si ya no queda ninguna palabra válida (diccionario agotado para esta letra), no dejamos
    // al jugador sin opciones: se permite reutilizar palabras ya usadas para poder seguir jugando.
    if (!valid.length) {
      valid = dict.filter((w) => !expectedLetter || dictionaries.firstLetter(w) === expectedLetter);
    }
    // Si la letra requerida es un callejón sin salida real (ninguna palabra del diccionario
    // empieza con ella), no hay opción válida posible para continuar la cadena tal cual: en vez
    // de dejar al jugador sin ninguna opción (bug de atasco), ofrecemos un "reinicio" con una
    // palabra nueva al azar como si fuera la respuesta correcta.
    if (!valid.length) {
      const rescueWord = this.rescueChain(usedWordsSet, word);
      if (rescueWord) valid = [rescueWord];
    }
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
  getHintsOnFail(word = this.currentWord, usedWordsSet = this.usedWords) {
    const dict = [...this.dictionary];
    const expectedLetter = word ? dictionaries.lastLetter(word) : null;
    let candidates = dict.filter((w) => {
      const stripped = dictionaries.stripAccents(w);
      const startsOk = !expectedLetter || dictionaries.firstLetter(w) === expectedLetter;
      const notUsed = !this.settings.noRepeatAcrossRounds || !usedWordsSet.has(stripped);
      return startsOk && notUsed;
    });
    if (!candidates.length) {
      // Diccionario agotado para esta letra: mostramos igual palabras posibles aunque repitan.
      candidates = dict.filter((w) => !expectedLetter || dictionaries.firstLetter(w) === expectedLetter);
    }
    const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, 5);

    const hints = { words: shuffled, verbForms: null };

    // Si la categoría incluye verbos en inglés (pasado/participio), añade la forma relacionada
    // de la palabra actual como pista extra de aprendizaje.
    if (this.settings.language === 'en') {
      const entry = dictionaries.findIrregularEntry(word);
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

  // ¿Ya se usaron TODAS las palabras del diccionario que empiezan con esta letra? Si es así,
  // permitimos repetir (no hay alternativa real) en vez de dejar al jugador sin ninguna
  // respuesta válida posible: esto evita el bug de quedar "atascado" cuando el modo asistido
  // ofrece opciones ya usadas como única alternativa (generateOptions cae a reusar en ese caso).
  letterPoolExhausted(letter, usedWordsSet) {
    if (!letter) return false;
    const dict = [...this.dictionary];
    const candidates = dict.filter((w) => dictionaries.firstLetter(w) === letter);
    // Si no existe NINGUNA palabra que empiece con esta letra en el diccionario, la cadena
    // está en un callejón sin salida real: se considera "agotada" para permitir el rescate/repetición.
    if (!candidates.length) return true;
    return candidates.every((w) => usedWordsSet.has(dictionaries.stripAccents(w)));
  }

  // Valida estructura de cadena (letra) y, si aplica, pertenencia al diccionario / no repetido.
  validateWord(word) {
    const norm = dictionaries.normalizeWord(word);
    const stripped = dictionaries.stripAccents(norm);
    if (!norm) return { ok: false, reason: 'empty' };

    const expectedLetter = this.currentWord ? dictionaries.lastLetter(this.currentWord) : null;
    const deadEnd = expectedLetter ? this.letterPoolExhausted(expectedLetter, this.usedWords) : false;

    if (this.currentWord && !deadEnd && !dictionaries.isValidChain(this.currentWord, norm)) {
      return { ok: false, reason: 'chain', expectedLetter };
    }

    if (this.settings.noRepeatAcrossRounds && this.usedWords.has(stripped) && !deadEnd) {
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

    // Si la cadena ya no tiene continuación posible (diccionario agotado para esta letra),
    // reiniciamos automáticamente con una nueva palabra al azar en vez de dejar el juego atascado.
    if (!this.hasContinuation(this.currentWord, this.usedWords)) {
      const rescueWord = this.rescueChain(this.usedWords, this.currentWord);
      if (rescueWord) {
        this.currentWord = rescueWord;
        this.currentWordRaw = rescueWord;
        this.usedWords.add(dictionaries.stripAccents(rescueWord));
        this.chainHistory.push({
          word: rescueWord,
          playerId: null,
          restart: true,
          translation: dictionaries.getTranslation(rescueWord, this.settings.language),
        });
      }
    }

    this.advanceTurn();
  }

  // --- PvP 1v1 simultáneo: cada jugador tiene su propia cadena independiente ---
  // Ambos ven la misma palabra inicial y pueden responder en cualquier momento, sin
  // esperar turno. Se otorgan más puntos entre más rápido se responda correctamente.

  getPlayerChain(playerId) {
    return this.playerChains.get(playerId) || null;
  }

  validateWordFor(playerId, word) {
    const chain = this.getPlayerChain(playerId);
    if (!chain) return { ok: false, reason: 'no_chain' };
    const norm = dictionaries.normalizeWord(word);
    const stripped = dictionaries.stripAccents(norm);
    if (!norm) return { ok: false, reason: 'empty' };

    const expectedLetter = chain.currentWord ? dictionaries.lastLetter(chain.currentWord) : null;
    const deadEnd = expectedLetter ? this.letterPoolExhausted(expectedLetter, chain.usedWords) : false;

    if (chain.currentWord && !deadEnd && !dictionaries.isValidChain(chain.currentWord, norm)) {
      return { ok: false, reason: 'chain', expectedLetter };
    }
    if (this.settings.noRepeatAcrossRounds && chain.usedWords.has(stripped) && !deadEnd) {
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

  // Puntaje por velocidad: base 10 pts + bonus lineal según lo rápido que respondió,
  // hasta +15 pts extra si contesta casi al instante, decayendo a 0 al llegar al límite de tiempo.
  speedBonus(elapsedMs) {
    const limitMs = (this.settings.turnTimeLimitSec || 20) * 1000;
    const ratio = Math.max(0, Math.min(1, 1 - elapsedMs / limitMs));
    return Math.round(ratio * 15);
  }

  acceptWordFor(playerId, word) {
    const chain = this.getPlayerChain(playerId);
    if (!chain) return;
    const norm = dictionaries.normalizeWord(word);
    const stripped = dictionaries.stripAccents(norm);
    const elapsed = Date.now() - (chain.wordStartedAt || Date.now());
    const bonus = this.speedBonus(elapsed);

    chain.currentWord = norm;
    chain.currentWordRaw = word;
    chain.usedWords.add(stripped);
    chain.wordsCompleted += 1;
    chain.chainHistory.push({ word: norm, playerId, translation: dictionaries.getTranslation(norm, this.settings.language) });

    // Si la cadena personal se queda sin continuación posible, se reinicia con una palabra nueva.
    if (!this.hasContinuation(chain.currentWord, chain.usedWords)) {
      const rescueWord = this.rescueChain(chain.usedWords, chain.currentWord);
      if (rescueWord) {
        chain.currentWord = rescueWord;
        chain.currentWordRaw = rescueWord;
        chain.usedWords.add(dictionaries.stripAccents(rescueWord));
        chain.chainHistory.push({
          word: rescueWord,
          playerId: null,
          restart: true,
          translation: dictionaries.getTranslation(rescueWord, this.settings.language),
        });
      }
    }
    chain.wordStartedAt = Date.now();

    const points = 10 + bonus;
    const player = this.players.get(playerId);
    if (player) {
      player.score += points;
      if (player.teamId && this.teams.has(player.teamId)) {
        this.teams.get(player.teamId).score += points;
      }
    }
    return points;
  }

  failWordFor(playerId) {
    const chain = this.getPlayerChain(playerId);
    // En PvP simultáneo el juego es una carrera de puntos, no de eliminación: un fallo no
    // descalifica, solo reinicia su temporizador para que pueda intentar de nuevo.
    if (chain) chain.wordStartedAt = Date.now();
    this.checkRoundEnd();
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
    if (this.settings.mode === 'pvp') {
      // Si se definió una meta de palabras (maxRounds usado como "palabras a completar"),
      // termina en cuanto algún jugador la alcanza. Sin descalificación: es una carrera de puntos.
      if (this.settings.maxRounds > 0) {
        for (const chain of this.playerChains.values()) {
          if (chain.wordsCompleted >= this.settings.maxRounds) {
            this.state = 'finished';
            return true;
          }
        }
      }
      return false;
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
    const playerChainsPublic = {};
    if (this.isPvpSimultaneous()) {
      for (const [id, chain] of this.playerChains.entries()) {
        playerChainsPublic[id] = {
          currentWord: chain.currentWordRaw,
          currentWordTranslation: dictionaries.getTranslation(chain.currentWordRaw, this.settings.language),
          nextLetter: chain.currentWord ? dictionaries.lastLetter(chain.currentWord) : null,
          wordsCompleted: chain.wordsCompleted,
          chainHistory: chain.chainHistory,
        };
      }
    }
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
      playerChains: playerChainsPublic,
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
