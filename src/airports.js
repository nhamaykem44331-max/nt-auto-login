const path = require('path');

const airports = require(path.join(__dirname, '../data/airports.json'));

const airportMap = new Map(airports.map((a) => [a.code, a]));

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function suggestAirport(code) {
  let best = null;
  let bestDist = Infinity;
  for (const airport of airports) {
    const dist = levenshtein(code, airport.code);
    if (dist < bestDist) {
      bestDist = dist;
      best = airport;
    }
  }
  return bestDist <= 2 ? best : null;
}

function isValidAirport(code) {
  if (!code || typeof code !== 'string') return false;
  return airportMap.has(code.trim().toUpperCase());
}

function validateAirport(code, fieldName = 'airport') {
  const upper = String(code || '').trim().toUpperCase();
  if (airportMap.has(upper)) return upper;
  const suggestion = suggestAirport(upper);
  const hint = suggestion
    ? ` Did you mean ${suggestion.code} (${suggestion.city} - ${suggestion.name})?`
    : '';
  throw new Error(`Unknown airport: "${code}".${hint}`);
}

function normalizeQuery(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

function searchAirport(query) {
  const q = normalizeQuery(query);
  return airports.filter((airport) => {
    if (airport.code.toLowerCase() === q.toUpperCase().toLowerCase()) return true;
    return (
      normalizeQuery(airport.code).includes(q) ||
      normalizeQuery(airport.city).includes(q) ||
      normalizeQuery(airport.name).includes(q)
    );
  });
}

function isDomesticRoute(from, to) {
  const a = airportMap.get(String(from || '').toUpperCase());
  const b = airportMap.get(String(to || '').toUpperCase());
  if (!a || !b) return false;
  return a.domestic === true && b.domestic === true;
}

function getAirportInfo(code) {
  return airportMap.get(String(code || '').trim().toUpperCase()) || null;
}

function getAirportsList() {
  return airports.slice();
}

module.exports = {
  isValidAirport,
  validateAirport,
  searchAirport,
  isDomesticRoute,
  getAirportInfo,
  getAirportsList,
  suggestAirport,
};
