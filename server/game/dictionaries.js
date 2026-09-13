// Carga y gestiona los diccionarios (categorías) en varios idiomas.
const fs = require('fs');
const path = require('path');

const DICT_ROOT = path.join(__dirname, '..', 'data', 'dictionaries');

// Estructura: { en: { verbs: [...], animals: [...], cities: [...] }, es: {...} }
const cache = {};

function loadLanguage(lang) {
  if (cache[lang]) return cache[lang];
  const dir = path.join(DICT_ROOT, lang);
  const result = {};
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.json')) {
        const key = path.basename(file, '.json');
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          result[key] = raw.map(normalizeWord);
        } catch (e) {
          console.error('Error cargando diccionario', file, e.message);
        }
      }
    }
  }
  cache[lang] = result;
  return result;
}

function listCategories(lang) {
  return Object.keys(loadLanguage(lang));
}

function getWordSet(lang, categories) {
  const dict = loadLanguage(lang);
  const set = new Set();
  const cats = categories && categories.length ? categories : Object.keys(dict);
  for (const cat of cats) {
    if (dict[cat]) dict[cat].forEach((w) => set.add(w));
  }
  return set;
}

// Devuelve las palabras como array ordenado, para poder "visualizar el diccionario" en el cliente.
function getWordsArray(lang, categories) {
  return [...getWordSet(lang, categories)].sort();
}

// Verbos irregulares en inglés (base/past/participle), usados en el modo "Aprender" asistido.
let irregularVerbsCache = null;
function loadIrregularVerbs() {
  if (irregularVerbsCache) return irregularVerbsCache;
  const file = path.join(__dirname, '..', 'data', 'irregular_verbs.json');
  try {
    irregularVerbsCache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    irregularVerbsCache = [];
  }
  return irregularVerbsCache;
}

// Dada una palabra (pasado o participio), busca su entrada completa para mostrar pistas.
function findIrregularEntry(word) {
  const norm = normalizeWord(word);
  return loadIrregularVerbs().find(
    (e) => e.base === norm || e.past === norm || e.participle === norm
  );
}

// Normaliza: minúsculas, sin espacios extra, sin acentos para comparar letras de cadena,
// pero conserva ñ como letra válida en español.
function normalizeWord(word) {
  return String(word || '')
    .trim()
    .toLowerCase();
}

function stripAccents(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/g, 'n');
}

function lastLetter(word) {
  const n = normalizeWord(word);
  const stripped = stripAccents(n);
  return stripped.charAt(stripped.length - 1);
}

function firstLetter(word) {
  const n = normalizeWord(word);
  const stripped = stripAccents(n);
  return stripped.charAt(0);
}

function isValidChain(prevWord, nextWord) {
  if (!prevWord) return true;
  return lastLetter(prevWord) === firstLetter(nextWord);
}

module.exports = {
  loadLanguage,
  listCategories,
  getWordSet,
  getWordsArray,
  loadIrregularVerbs,
  findIrregularEntry,
  normalizeWord,
  stripAccents,
  lastLetter,
  firstLetter,
  isValidChain,
};
