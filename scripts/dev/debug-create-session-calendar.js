#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { MuadiApiClient } = require('../../src/muadi-client');

const ROUTE = {
  from: process.env.DEBUG_FROM || 'HAN',
  to: process.env.DEBUG_TO || 'SGN',
  date: process.env.DEBUG_DATE || '26-04-2026',
  returnDate: process.env.DEBUG_RETURN_DATE || '',
  adults: Number.parseInt(process.env.DEBUG_ADULTS || '1', 10) || 1,
  children: Number.parseInt(process.env.DEBUG_CHILDREN || '0', 10) || 0,
  infants: Number.parseInt(process.env.DEBUG_INFANTS || '0', 10) || 0,
};

function normalizeDate(value) {
  const text = String(value || '').trim();
  const ymd = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymd) {
    const [, year, month, day] = ymd;
    return `${day.padStart(2, '0')}-${month.padStart(2, '0')}-${year}`;
  }

  const dmy = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    const [, day, month, year] = dmy;
    return `${day.padStart(2, '0')}-${month.padStart(2, '0')}-${year}`;
  }

  throw new Error(`Invalid DEBUG_DATE: ${value}. Use DD-MM-YYYY or YYYY-MM-DD.`);
}

function buildCreateSessionPayload(route) {
  return {
    sessionID: 0,
    originCode: String(route.from).trim().toUpperCase(),
    destinationCode: String(route.to).trim().toUpperCase(),
    departureDateTime: normalizeDate(route.date),
    returnDateTime: route.returnDate ? normalizeDate(route.returnDate) : undefined,
    journeyType: route.returnDate ? 'RT' : 'OW',
    numberOfAdult: route.adults,
    numberOfChildren: route.children,
    numberOfInfant: route.infants,
    currencyCode: 'VND',
    searchType: 'BP',
    promotionCodes: [],
    airlines: [],
    systems: [],
  };
}

function compactPreview(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: value.slice(0, 3).map(compactPreview),
    };
  }

  const entries = Object.entries(value).slice(0, 12);
  return Object.fromEntries(entries.map(([key, item]) => [key, compactPreview(item)]));
}

function looksCalendarRelated(key, value) {
  const keyText = String(key || '');
  if (/(calendar|fare|price|amount|lowest|min|date|day|week|month|next|prev|near|flight|journey|sign|session)/i.test(keyText)) {
    return true;
  }

  if (Array.isArray(value) && value.some((item) => item && typeof item === 'object')) {
    const keys = value.slice(0, 5).flatMap((item) => Object.keys(item || {}));
    return keys.some((itemKey) => /(calendar|fare|price|amount|date|day|min|lowest)/i.test(itemKey));
  }

  return false;
}

function collectCandidates(value, pathName = '$', out = []) {
  if (!value || typeof value !== 'object') return out;

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${pathName}.${key}`;
    if (looksCalendarRelated(key, child)) {
      out.push({
        path: childPath,
        preview: compactPreview(child),
      });
    }

    if (child && typeof child === 'object') {
      collectCandidates(child, childPath, out);
    }
  }

  return out;
}

function safeFilePart(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function main() {
  const request = buildCreateSessionPayload(ROUTE);
  const client = new MuadiApiClient();
  const startedAt = Date.now();

  console.log('[debug-create-session] Calling booking/create-session...');
  console.log('[debug-create-session] Request:', JSON.stringify(request, null, 2));

  const response = await client.createSession(request);
  const data = response && response.data !== undefined ? response.data : response;
  const candidates = collectCandidates(data);

  const output = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    route: ROUTE,
    request,
    response,
    dataKeys: data && typeof data === 'object' ? Object.keys(data) : [],
    calendarCandidateCount: candidates.length,
    calendarCandidates: candidates,
  };

  const debugDir = path.join(process.cwd(), 'debug');
  fs.mkdirSync(debugDir, { recursive: true });

  const fileName = [
    'create-session',
    safeFilePart(request.originCode),
    safeFilePart(request.destinationCode),
    safeFilePart(request.departureDateTime),
    request.journeyType,
  ].join('_') + '.json';
  const outputPath = path.join(debugDir, fileName);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');

  console.log(`[debug-create-session] Saved: ${outputPath}`);
  console.log(`[debug-create-session] data keys: ${output.dataKeys.join(', ') || '(none)'}`);
  console.log(`[debug-create-session] candidate paths: ${candidates.map((item) => item.path).join(', ') || '(none)'}`);
}

main().catch((error) => {
  console.error('[debug-create-session] Failed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
