const crypto = require('crypto');
const { MuadiApiClient, MuadiApiError } = require('./muadi-client');

const DEFAULT_AIRLINES = ['VN', 'VJ', 'QH', 'VU', '9G'];
const sessionListCache = new Map();
const SESSION_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const TITLE_SET = new Set(['MR', 'MRS', 'MS', 'MISS', 'MSTR']);
const PENDING_PNR_STATUSES = new Set(['WAIT', 'LOADING']);

function sessionListCacheKey(request = {}) {
  return [
    String(request.originCode || request.from || '').trim().toUpperCase(),
    String(request.destinationCode || request.to || '').trim().toUpperCase(),
    String(request.journeyType || (request.returnDateTime ? 'RT' : 'OW')).trim().toUpperCase(),
  ].join(':');
}

function getCachedSessionList(key) {
  const cached = sessionListCache.get(key);
  if (!cached) return [];
  if (cached.expiresAt <= Date.now()) {
    sessionListCache.delete(key);
    return [];
  }
  return [...cached.listSignIn];
}

function rememberSessionList(key, list) {
  const normalized = normalizeAirlineList(list);
  if (!normalized.length) return normalized;
  sessionListCache.set(key, {
    listSignIn: normalized,
    expiresAt: Date.now() + SESSION_LIST_CACHE_TTL_MS,
  });
  return normalized;
}

function clearSessionListCache() {
  sessionListCache.clear();
}

function debugTiming(label, startedAt) {
  if (String(process.env.LOG_LEVEL || '').toLowerCase() === 'debug') {
    console.error(`[DEBUG] ${label}: ${Date.now() - startedAt}ms`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pnrListFromResponse(response) {
  return (response && response.data && Array.isArray(response.data.listPNR))
    ? response.data.listPNR
    : [];
}

function isPendingPnr(item) {
  return PENDING_PNR_STATUSES.has(String(item && item.status || '').toUpperCase());
}

function hasCompletePnrResponse(response) {
  const pnrs = pnrListFromResponse(response);
  return pnrs.length > 0 && !pnrs.some(isPendingPnr);
}

function hasAnyPnrResponse(response) {
  return pnrListFromResponse(response).some((item) => item && (item.pnr || item.message));
}

function parseMoneyAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').trim();
  if (!text) return NaN;
  const normalized = text.replace(/[^\d.-]/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : NaN;
}

function hasFastPnrTicketInfo(response) {
  const pnrs = pnrListFromResponse(response);
  if (!pnrs.length) return false;
  const data = response && response.data ? response.data : {};
  const totalAmount = parseMoneyAmount(data.total ?? data.totalAmount ?? data.totalPrice);
  return Number.isFinite(totalAmount) && totalAmount >= 0;
}

function normalizeAirlineList(list) {
  return (list || [])
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item) return '';
      return item.airline || item.airlineCode || item.code || item.value || '';
    })
    .map((item) => String(item).trim().toUpperCase())
    .filter(Boolean);
}

function normalizeAirport(value, fieldName = 'airport') {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(`Invalid ${fieldName}: "${value}" is not a valid IATA code (must be 3 uppercase letters)`);
  }
  const { validateAirport } = require('./airports');
  return validateAirport(code, fieldName);
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  let day;
  let month;
  let year;

  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    year = match[1];
    month = match[2];
    day = match[3];
  } else {
    match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (!match) {
      throw new Error(`Invalid date: ${value}. Use DD-MM-YYYY or YYYY-MM-DD.`);
    }
    day = match[1];
    month = match[2];
    year = match[3];
  }

  return `${day.padStart(2, '0')}-${month.padStart(2, '0')}-${year}`;
}

function normalizeTime(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    throw new Error(`Invalid time: ${value}. Use HH:mm.`);
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2] || '00', 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time: ${value}. Use HH:mm.`);
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function stripVietnamese(value) {
  return String(value || '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s/-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePassengerType(value, fallback = 'ADT') {
  const type = String(value || fallback).trim().toUpperCase();
  if (type === 'CHD' || type === 'INF' || type === 'ADT') return type;
  return fallback;
}

function normalizeBirthday(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    return `${day}-${month}-${year}`;
  }
  match = text.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    return `${day}-${month}-${year}`;
  }
  return text;
}

function normalizeLoyalty(options = {}) {
  if (Array.isArray(options.loyalty) && options.loyalty.length > 0) {
    return options.loyalty;
  }
  const airline = String(options.loyaltyAirline || options.airline || '').trim().toUpperCase();
  const number = String(options.loyaltyNumber || options.number || '').trim();
  if (!airline || !number) return [];
  return [{ airline, cardNumber: number }];
}

function normalizeAncillaryList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      return {
        route: item.route || '',
        segmentId: item.segmentId,
        airline: item.airline || '',
        serviceType: item.serviceType || '',
        code: item.code || '',
        key: item.key || '',
        description: item.description || '',
        unit: item.unit || '',
        price: Number(item.price || 0),
      };
    })
    .filter((item) => item && item.code && item.key);
}

function isBaggageService(item) {
  return String(item && item.serviceType || '').toUpperCase() === 'BAG';
}

function normalizeBaggageList(value) {
  return normalizeAncillaryList(value)
    .filter(isBaggageService)
    .map((item) => ({ ...item, serviceType: 'BAG' }));
}

function ancillaryIdentity(item) {
  return [
    cleanRouteCode(item && item.route || ''),
    Number.parseInt(item && item.segmentId || '0', 10) || 0,
    String(item && item.serviceType || '').toUpperCase(),
    String(item && item.code || ''),
    String(item && item.key || ''),
  ].join('|');
}

function dedupeAncillaryList(items = []) {
  const map = new Map();
  items.forEach((item) => {
    if (!item || !item.code || !item.key) return;
    const identity = ancillaryIdentity(item);
    if (!map.has(identity)) map.set(identity, item);
  });
  return [...map.values()];
}

function mergePassengerAncillaries(passenger = {}) {
  const luggage = normalizeAncillaryList(passenger.listLuggage);
  const ancillaryServices = normalizeAncillaryList(passenger.ancillaryServices);
  const nonBaggageAncillary = ancillaryServices.filter((item) => !isBaggageService(item));
  const baggageFromAncillary = normalizeBaggageList(ancillaryServices);
  const baggage = dedupeAncillaryList(
    (luggage.length > 0 ? luggage : baggageFromAncillary).map((item) => ({
      ...item,
      serviceType: 'BAG',
    }))
  );

  return {
    ...passenger,
    listLuggage: baggage,
    ancillaryServices: dedupeAncillaryList([...nonBaggageAncillary, ...baggage]),
  };
}

function normalizePassport(value) {
  if (!value || typeof value !== 'object') return undefined;
  const passport = {
    number: String(value.number || '').trim(),
    nationality: String(value.nationality || '').trim(),
    issuingCountry: String(value.issuingCountry || '').trim(),
    issueDate: normalizeBirthday(value.issueDate || ''),
    expiryDate: normalizeBirthday(value.expiryDate || ''),
  };
  if (!passport.number && !passport.nationality && !passport.issuingCountry && !passport.issueDate && !passport.expiryDate) {
    return undefined;
  }
  return passport;
}

function parsePassengerName(input, options = {}) {
  const raw = stripVietnamese(input || '').toUpperCase();
  let tokens = raw.split(/\s+/).filter(Boolean);
  let title = (options.title || '').toUpperCase();
  const type = normalizePassengerType(options.type, 'ADT');
  const passengerId = String(options.id || `${type}-1`);

  if (!title && TITLE_SET.has(tokens[0])) {
    title = tokens.shift();
  }
  if (!title) title = type === 'ADT' ? 'MR' : 'MSTR';

  const birthday = normalizeBirthday(options.birthday || options.dateOfBirth || '');
  const loyalty = normalizeLoyalty(options);
  const listLuggage = normalizeAncillaryList(options.listLuggage);
  const ancillaryServices = normalizeAncillaryList(options.ancillaryServices);
  const passport = normalizePassport(options.passport);
  const goldCard = String(options.goldCard || '').trim();

  const directLastName = stripVietnamese(options.lastName || '').toUpperCase();
  const directFirstName = stripVietnamese(options.firstName || '').toUpperCase();
  if (directLastName && directFirstName) {
    return {
      id: passengerId,
      type,
      title,
      firstName: directFirstName,
      lastName: directLastName,
      ...(birthday ? { birthday } : {}),
      loyalty,
      goldCard,
      listLuggage,
      ancillaryServices,
      ...(passport ? { passport } : {}),
    };
  }

  if (tokens.length < 2) {
    throw new Error('Passenger name must include last name and first name, for example: "MR Vu Duc Anh".');
  }

  return {
    id: passengerId,
    type,
    title,
    lastName: tokens[0],
    firstName: tokens.slice(1).join(' '),
    ...(birthday ? { birthday } : {}),
    loyalty,
    goldCard,
    listLuggage,
    ancillaryServices,
    ...(passport ? { passport } : {}),
  };
}

function money(value) {
  return Number(value || 0);
}

function fullFareForAdult(price, flight) {
  const issueFee = getIssueFeeADT(price, flight);
  return money(price.fareADT) + money(price.taxADT) + money(price.vatADT) + issueFee;
}

function getIssueFeeADT(price, flight) {
  if (price && price.issueFeeADT !== undefined) return money(price.issueFeeADT);
  if (flight && flight.issueFeeADT !== undefined) return money(flight.issueFeeADT);
  if (flight && Array.isArray(flight.bookingFee)) {
    const fee = flight.bookingFee.find((item) => item && item.issueFeeADT !== undefined);
    if (fee) return money(fee.issueFeeADT);
  }
  return 0;
}

function formatMoney(value, currency = 'VND') {
  return `${money(value).toLocaleString('vi-VN')} ${currency}`;
}

function routeOf(flight) {
  return (flight && flight.routeInfo && flight.routeInfo[0]) || {};
}

function segmentsOf(flight) {
  if (flight && Array.isArray(flight.routeInfo) && flight.routeInfo.length > 0) {
    return flight.routeInfo;
  }
  return [routeOf(flight)];
}

function routeEndOf(flight) {
  const segments = segmentsOf(flight);
  return segments[segments.length - 1] || {};
}

function routeSummaryOf(flight) {
  const segments = segmentsOf(flight).filter((segment) => segment && (segment.from || segment.to));
  if (!segments.length) return `${flight.from || ''}-${flight.to || ''}`;
  const points = [segments[0].from, ...segments.map((segment) => segment.to)].filter(Boolean);
  return points.join('-');
}

function flightNumberOf(flight) {
  const route = routeOf(flight);
  const carrier = route.carrierCode || flight.airline || '';
  const number = route.flightNumber || '';
  return `${carrier}${number}`.toUpperCase();
}

function departTimeOf(flight) {
  const route = routeOf(flight);
  const depart = route.departDate || flight.departDateTime || '';
  const match = String(depart).match(/\b(\d{1,2}:\d{2})\b/);
  if (!match) return '';
  const [hour, minute] = match[1].split(':');
  return `${hour.padStart(2, '0')}:${minute}`;
}

function buildSearchRequest(params = {}) {
  const airline = params.airline ? String(params.airline).trim().toUpperCase() : null;
  return {
    sessionID: params.sessionID || 0,
    originCode: normalizeAirport(params.from, 'from'),
    destinationCode: normalizeAirport(params.to, 'to'),
    departureDateTime: normalizeDate(params.date),
    returnDateTime: params.returnDate ? normalizeDate(params.returnDate) : undefined,
    journeyType: params.returnDate ? 'RT' : 'OW',
    numberOfAdult: Number.parseInt(params.adt || '1', 10),
    numberOfChildren: Number.parseInt(params.chd || '0', 10),
    numberOfInfant: Number.parseInt(params.inf || '0', 10),
    currencyCode: params.currencyCode || 'VND',
    searchType: params.searchType || 'BP',
    promotionCodes: params.promotionCodes || [],
    airlines: airline ? [airline] : [],
    systems: params.systems || [],
  };
}

function flightsFromSearchResponse(response) {
  const data = response && response.data ? response.data : response;
  const flights = [];
  if (Array.isArray(data && data.departureFlight)) flights.push(...data.departureFlight);
  if (Array.isArray(data && data.gdsFlight && data.gdsFlight.departureFlight)) {
    flights.push(...data.gdsFlight.departureFlight);
  }
  return flights;
}

function flightsFromSearchResponseRT(response) {
  const data = response && response.data ? response.data : response;
  const departureFlights = [];
  const returnFlights = [];
  if (Array.isArray(data && data.departureFlight)) departureFlights.push(...data.departureFlight);
  if (Array.isArray(data && data.returnFlight)) returnFlights.push(...data.returnFlight);
  if (data && data.gdsFlight) {
    if (Array.isArray(data.gdsFlight.departureFlight)) departureFlights.push(...data.gdsFlight.departureFlight);
    if (Array.isArray(data.gdsFlight.returnFlight)) returnFlights.push(...data.gdsFlight.returnFlight);
  }
  return { departureFlights, returnFlights };
}

function selectFlightPair(departureFlights, returnFlights, criteria = {}) {
  const departureCriteria = {
    airline: criteria.airline,
    time: criteria.time,
    flightNumber: criteria.flightNumber,
    from: criteria.from,
    to: criteria.to,
    directOnly: criteria.directOnly,
  };
  const returnCriteria = {
    airline: criteria.returnAirline || criteria.airline,
    time: criteria.returnTime,
    flightNumber: criteria.returnFlightNumber,
    from: criteria.to,
    to: criteria.from,
    directOnly: criteria.directOnly,
  };
  const departureFlight = selectFlight(departureFlights, departureCriteria);
  const returnFlight = selectFlight(returnFlights, returnCriteria);
  const { fare: departureFare } = cheapestFare(departureFlight);
  const { fare: returnFare } = cheapestFare(returnFlight);
  return { departureFlight, returnFlight, departureFare, returnFare };
}

async function searchJourney(params = {}, options = {}) {
  const client = options.client || new MuadiApiClient(options);
  const request = buildSearchRequest(params);
  const sessionStartedAt = Date.now();
  const requestedAirline = params.airline ? String(params.airline).trim().toUpperCase() : null;
  const listCacheKey = sessionListCacheKey(request);
  const cachedSignIns = requestedAirline ? [] : getCachedSessionList(listCacheKey);
  if (!requestedAirline && cachedSignIns.length && (!Array.isArray(request.airlines) || !request.airlines.length)) {
    request.airlines = [...cachedSignIns];
  }

  const createSession = await client.createSession(request);
  debugTiming('createSession', sessionStartedAt);
  const sessionData = createSession.data || {};
  request.sessionID = sessionData.sessionID;

  const normalizedSignIns = !requestedAirline
    ? rememberSessionList(listCacheKey, sessionData.listSignIn)
    : normalizeAirlineList(sessionData.listSignIn);
  const signIns = normalizedSignIns.length
    ? normalizedSignIns
    : (cachedSignIns.length ? cachedSignIns : (requestedAirline ? [requestedAirline] : DEFAULT_AIRLINES));

  const airlines = requestedAirline ? [requestedAirline] : signIns;
  const byAirline = {};
  const errorsByAirline = {};
  const flights = [];
  const returnFlights = [];

  const searchStartedAt = Date.now();
  const results = await Promise.all(
    airlines.map((airline) =>
      client
        .searchFlightByAirline(airline, request)
        .then((response) => ({ airline, response }))
        .catch((error) => ({ airline, error }))
    )
  );
  debugTiming(`parallel search ${airlines.length} airlines`, searchStartedAt);

  let successCount = 0;
  for (const { airline, response, error } of results) {
    if (error) {
      byAirline[airline] = [];
      errorsByAirline[airline] = error && error.message ? error.message : String(error);
      continue;
    }

    successCount += 1;
    if (request.journeyType === 'RT') {
      const { departureFlights, returnFlights: rf } = flightsFromSearchResponseRT(response);
      byAirline[airline] = departureFlights;
      flights.push(...departureFlights);
      returnFlights.push(...rf);
    } else {
      const found = flightsFromSearchResponse(response);
      byAirline[airline] = found;
      flights.push(...found);
    }
  }

  if (airlines.length && successCount === 0) {
    const details = Object.entries(errorsByAirline)
      .map(([airline, message]) => `${airline}: ${message}`)
      .join('; ');
    const airlineErrors = results.map(({ error }) => error).filter(Boolean);
    const error = new Error(`All airline searches failed${details ? ` (${details})` : ''}.`);
    error.safeToRetry = airlineErrors.length > 0 && airlineErrors.every((item) => item.safeToRetry === true);
    error.errorsByAirline = errorsByAirline;
    throw error;
  }

  return {
    client,
    request,
    createSession,
    sessionData,
    signIns,
    byAirline,
    errorsByAirline,
    flights,
    returnFlights,
  };
}

function selectFlight(flights, criteria = {}) {
  const airline = criteria.airline ? String(criteria.airline).toUpperCase() : null;
  const flightNumber = criteria.flightNumber ? String(criteria.flightNumber).replace(/\s+/g, '').toUpperCase() : null;
  const time = normalizeTime(criteria.time);
  const from = criteria.from ? normalizeAirport(criteria.from, 'from') : null;
  const to = criteria.to ? normalizeAirport(criteria.to, 'to') : null;

  const matches = flights.filter((flight) => {
    const firstRoute = routeOf(flight);
    const lastRoute = routeEndOf(flight);
    if (criteria.directOnly && segmentsOf(flight).length > 1) return false;
    if (airline && String(flight.airline || '').toUpperCase() !== airline) return false;
    if (from && String(firstRoute.from || flight.from || '').toUpperCase() !== from) return false;
    if (to && String(lastRoute.to || flight.to || '').toUpperCase() !== to) return false;
    if (flightNumber && flightNumberOf(flight) !== flightNumber) return false;
    if (time && departTimeOf(flight) !== time) return false;
    return true;
  });

  if (matches.length) return matches[0];

  const alternatives = flights
    .filter((flight) => !airline || String(flight.airline || '').toUpperCase() === airline)
    .slice(0, 8)
    .map((flight) => `${flightNumberOf(flight)} ${routeSummaryOf(flight)} ${departTimeOf(flight)} total-from ${formatMoney(cheapestFare(flight).total)}`);

  throw new Error(
    `No matching flight found. Criteria: route=${from || '-'}-${to || '-'}, airline=${airline || '-'}, flight=${flightNumber || '-'}, time=${time || '-'}. ` +
    `Alternatives: ${alternatives.join('; ') || 'none'}`
  );
}

function cheapestFare(flight) {
  const fares = (flight.priceInfo || []).filter((fare) => fare && !fare.soldOut);
  if (!fares.length) {
    throw new Error(`No fare found for ${flightNumberOf(flight)}.`);
  }

  const fare = fares
    .slice()
    .sort((a, b) => fullFareForAdult(a, flight) - fullFareForAdult(b, flight))[0];

  return {
    fare,
    total: fullFareForAdult(fare, flight),
    issueFeeADT: getIssueFeeADT(fare, flight),
  };
}

function summarizeFlightFare(flight, fare) {
  const route = routeOf(flight);
  const routeEnd = routeEndOf(flight);
  const segments = segmentsOf(flight);
  const fareInfo = (fare.fareInfo && fare.fareInfo[0]) || {};
  const issueFeeADT = getIssueFeeADT(fare, flight);
  const total = fullFareForAdult(fare, flight);

  return {
    id: flight.id,
    airline: flight.airline,
    systemName: flight.systemName,
    source: flight.source,
    flightNumber: flightNumberOf(flight),
    from: route.from || flight.from,
    to: routeEnd.to || flight.to,
    route: routeSummaryOf(flight),
    departDate: route.departDate || flight.departDateTime,
    arrivalDate: routeEnd.arrivalDate || flight.arrivalDateTime,
    segments: segments.map((segment) => ({
      carrierCode: segment.carrierCode || flight.airline,
      flightNumber: segment.flightNumber || '',
      from: segment.from,
      to: segment.to,
      departDate: segment.departDate,
      arrivalDate: segment.arrivalDate,
      airCraft: segment.airCraft || segment.aircraft || '',
    })),
    class: fare.class,
    cabinClass: fareInfo.cabinClass || 'Economy',
    fareBasis: fareInfo.fareBasis || '',
    seatAvailable: fare.seatAvailable,
    currencyCode: fare.currencyCode || 'VND',
    fareADT: money(fare.fareADT),
    taxADT: money(fare.taxADT),
    vatADT: money(fare.vatADT),
    issueFeeADT,
    total,
  };
}

function contactFromSession(client, passenger, options = {}) {
  const user = (client && client.session && client.session.userInfo) || {};
  const agent = (client && client.session && client.session.agentInfo) || {};
  const firstName = String(passenger && passenger.firstName || '').trim();
  const lastName = String(passenger && passenger.lastName || '').trim();
  return {
    email: options.email || user.email || agent.agentEmail || '',
    fullName: options.contactName || `${firstName} ${lastName}`.trim(),
    phoneNumber: options.phone || user.dienThoai || agent.telephone || '',
    address: options.address || '',
    extraInfo: options.extraInfo || '',
  };
}

function buildRouteEntry({ flight, fare, request, fromCode, toCode, departDate }) {
  const segments = segmentsOf(flight);
  const currencyCode = fare.currencyCode || request.currencyCode || 'VND';
  const routeId = fare.id || flight.id;
  const listRoute = segments.map((route) => {
    const market = `${route.from || ''}${route.to || ''}`;
    const fareInfo = (fare.fareInfo || []).find((item) => item.market === market) ||
      (fare.fareInfo && fare.fareInfo[0]) ||
      {};
    return {
      from: route.from || fromCode,
      to: route.to || toCode,
      departDate: route.departDate || flight.departDateTime,
      arrivalDate: route.arrivalDate || flight.arrivalDateTime,
      airCraft: route.airCraft || route.aircraft || '',
      flightNumber: route.flightNumber || '',
      carrierCode: route.carrierCode || flight.airline,
      class: fare.class,
      cabinClass: fareInfo.cabinClass || 'Economy',
      flightTime: route.flightTime,
      jPrice: {
        class: fare.class,
        fareBasis: fareInfo.fareBasis || '',
        seat: fare.seatAvailable,
        price: 0,
        tax: 0,
        vat: 0,
        adminFee: 0,
        fareADT: money(fare.fareADT),
        taxADT: money(fare.taxADT) + money(fare.vatADT),
        fareCHD: money(fare.fareCHD),
        taxCHD: money(fare.taxCHD) + money(fare.vatCHD),
        fareINF: money(fare.fareINF),
        taxINF: money(fare.taxINF) + money(fare.vatINF),
        source: fare.source || flight.source,
        currencyCode,
      },
    };
  });
  return {
    id: routeId,
    typeBook: flight.typeOfBook || fare.typeOfBook || 'NN',
    from: fromCode,
    to: toCode,
    departDate,
    airline: flight.airline,
    source: flight.source || fare.source,
    listRoute,
  };
}

function normalizePassengerList(passengers, passenger) {
  if (Array.isArray(passengers) && passengers.length > 0) return passengers;
  if (passenger && typeof passenger === 'object') return [passenger];
  throw new Error('Missing passenger list.');
}

function buildBookRequest({ client, request, flight, fare, passenger, passengers, contact, isExportNow = false, returnFlight, returnFare }) {
  const currencyCode = fare.currencyCode || request.currencyCode || 'VND';
  const listPax = normalizePassengerList(passengers, passenger).map((item) => mergePassengerAncillaries(item));
  const leadPassenger = listPax[0];

  const outboundEntry = buildRouteEntry({
    flight,
    fare,
    request,
    fromCode: request.originCode,
    toCode: request.destinationCode,
    departDate: request.departureDateTime,
  });

  const listRoutes = [outboundEntry];

  if (returnFlight && returnFare) {
    const retEntry = buildRouteEntry({
      flight: returnFlight,
      fare: returnFare,
      request,
      fromCode: request.destinationCode,
      toCode: request.originCode,
      departDate: request.returnDateTime,
    });
    listRoutes.push(retEntry);
  }

  return {
    sessionID: request.sessionID,
    isExportNow,
    isReBook: false,
    isNDC: !!flight.isNDC,
    extraInfo: '',
    customerInfo: contact || contactFromSession(client, leadPassenger),
    listRoutes,
    listPax,
    adt: request.numberOfAdult,
    chd: request.numberOfChildren,
    inf: request.numberOfInfant,
    currencyCode,
    promotions: [],
    listCAs: [],
    pincode: '',
    isSplitSegment: false,
  };
}

function buildAncillariesRequest(bookRequest = {}) {
  return {
    sessionID: bookRequest.sessionID || 0,
    Routes: Array.isArray(bookRequest.listRoutes) ? bookRequest.listRoutes : [],
    ADT: Number.parseInt(bookRequest.adt || '1', 10) || 1,
    CHD: Number.parseInt(bookRequest.chd || '0', 10) || 0,
    INF: Number.parseInt(bookRequest.inf || '0', 10) || 0,
  };
}

function cleanRouteCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

function normalizeText(value) {
  return stripVietnamese(String(value || '').toUpperCase());
}

function hasSelectedLuggage(listPax = []) {
  return listPax.some((passenger) => {
    if (Array.isArray(passenger && passenger.listLuggage) && passenger.listLuggage.length > 0) return true;
    return normalizeBaggageList(passenger && passenger.ancillaryServices).length > 0;
  });
}

function baggageServicesFromAncillaries(ancillaryResponse) {
  const data = ancillaryResponse && ancillaryResponse.data ? ancillaryResponse.data : {};
  const paxData = Array.isArray(data.paxData) ? data.paxData : [];
  const paxTypeById = new Map(
    paxData.map((item) => [String(item.paxId || ''), normalizePassengerType(item.paxType, 'ADT')])
  );

  const segments = Array.isArray(data.segments) ? data.segments : [];
  const services = [];
  segments.forEach((segment) => {
    const route = cleanRouteCode(segment.route || '');
    const segmentId = Number.parseInt(segment.segmentId || '0', 10) || 0;
    const paxServices = Array.isArray(segment.paxServices) ? segment.paxServices : [];
    paxServices.forEach((entry) => {
      const paxId = String(entry.paxId || '');
      const paxType = paxTypeById.get(paxId) || normalizePassengerType(entry.paxType, 'ADT');
      (Array.isArray(entry.services) ? entry.services : []).forEach((service) => {
        if (String(service.serviceType || '').toUpperCase() !== 'BAG') return;
        if (!service.code || !service.key) return;
        services.push({
          route,
          segmentId,
          paxId,
          paxType,
          airline: data.airline || segment.airline || '',
          serviceType: String(service.serviceType || '').toUpperCase(),
          code: service.code,
          key: service.key,
          description: service.description || '',
          unit: service.unit || '',
          price: Number(service.price || 0),
        });
      });
    });
  });
  return services;
}

function serviceSignature(service) {
  return [
    normalizeText(service.description || ''),
    String(service.unit || '').trim(),
    Number(service.price || 0),
  ].join('|');
}

function matchBaggageSelection(selected, options) {
  if (!options.length) return null;
  const selectedKey = String(selected.key || '');
  const selectedCode = String(selected.code || '');
  const selectedSignature = serviceSignature(selected);

  let found = null;
  if (selectedKey) found = options.find((item) => item.key === selectedKey) || null;
  if (!found && selectedCode) found = options.find((item) => item.code === selectedCode) || null;
  if (!found) found = options.find((item) => serviceSignature(item) === selectedSignature) || null;
  if (!found) {
    const selectedUnit = String(selected.unit || '').trim();
    const selectedPrice = Number(selected.price || 0);
    found = options.find((item) => String(item.unit || '').trim() === selectedUnit && Number(item.price || 0) === selectedPrice) || null;
  }
  return found;
}

function pickServicesForPassenger(allServices, passenger) {
  const passengerId = String(passenger && passenger.id || '');
  const byId = allServices.filter((item) => item.paxId === passengerId);
  if (byId.length) return byId;
  const type = normalizePassengerType(passenger && passenger.type, 'ADT');
  return allServices.filter((item) => item.paxType === type);
}

function reconcilePassengerLuggage(passengers = [], allServices = []) {
  return passengers.map((passenger) => {
    const selectedList = Array.isArray(passenger.listLuggage) && passenger.listLuggage.length > 0
      ? passenger.listLuggage
      : normalizeBaggageList(passenger.ancillaryServices);
    if (!selectedList.length) return passenger;
    const passengerServices = pickServicesForPassenger(allServices, passenger);

    const nextList = selectedList.map((selected) => {
      const route = cleanRouteCode(selected.route || '');
      const segmentId = Number.parseInt(selected.segmentId || '0', 10) || 0;
      const routeOptions = passengerServices.filter((item) => item.route === route && (!segmentId || item.segmentId === segmentId));
      const matched = matchBaggageSelection(selected, routeOptions);
      if (!matched) {
        const detail = `${route || '-'} segment ${segmentId || '-'}`;
        throw new Error(`Luggage selection is no longer valid for passenger ${passenger.id || '-'} (${detail}). Please refresh baggage options and try again.`);
      }
      return {
        route: route || selected.route,
        segmentId: matched.segmentId || selected.segmentId,
        airline: matched.airline || selected.airline,
        serviceType: matched.serviceType || selected.serviceType || 'BAG',
        code: matched.code,
        key: matched.key,
        description: matched.description || selected.description || '',
        unit: matched.unit || selected.unit || '',
        price: Number(matched.price || selected.price || 0),
      };
    });

    const nextBaggage = dedupeAncillaryList(nextList.map((item) => ({
      ...item,
      serviceType: 'BAG',
    })));
    const existingAncillary = normalizeAncillaryList(passenger.ancillaryServices);
    const nonBaggageAncillary = existingAncillary.filter((item) => !isBaggageService(item));

    return {
      ...passenger,
      listLuggage: nextBaggage,
      ancillaryServices: dedupeAncillaryList([...nonBaggageAncillary, ...nextBaggage]),
    };
  });
}

async function refreshBookRequestLuggage(client, bookRequest) {
  if (!hasSelectedLuggage(bookRequest && bookRequest.listPax)) return bookRequest;
  const ancillaryRequest = buildAncillariesRequest(bookRequest);
  const ancillaryResponse = await client.getAncillaries(ancillaryRequest);
  const baggageServices = baggageServicesFromAncillaries(ancillaryResponse);
  const nextPax = reconcilePassengerLuggage(bookRequest.listPax || [], baggageServices);
  return {
    ...bookRequest,
    listPax: nextPax,
  };
}

function usernameFromClient(client) {
  const user = (client && client.session && client.session.userInfo) || {};
  return user.username || user.userName || user.user || user.email || '';
}

function randomOtpCode(length = 3) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += chars[crypto.randomInt(chars.length)];
  }
  return value;
}

function normalizeOtpCode(value) {
  return String(value || randomOtpCode())
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 3)
    .toUpperCase() || randomOtpCode();
}

function isBookingProtectionError(error) {
  if (!(error instanceof MuadiApiError)) return false;
  const code = error.data && String(error.data.code || '');
  return error.status === 403 && code === '120' && !!(error.data && error.data.data);
}

function buildBookingProtectionVerify(client, error, otp) {
  const salt = error && error.data && error.data.data;
  const username = usernameFromClient(client);
  if (!salt) throw new Error('Nam Thanh booking protection did not return a salt.');
  if (!username) {
    throw new Error('Cannot verify Nam Thanh booking protection because username is missing from saved session. Login again.');
  }

  const otpCode = normalizeOtpCode(otp);
  const verify = crypto
    .createHash('md5')
    .update(`${salt}|${otpCode}|${username}`)
    .digest('hex')
    .toUpperCase();

  return {
    otp: otpCode,
    verify,
  };
}

async function verifyBookingProtection(client, error, options = {}) {
  const payload = buildBookingProtectionVerify(client, error, options.otp);
  return client.verifyAgent(payload);
}

async function createBookingWithProtection(client, bookRequest, options = {}) {
  try {
    return {
      bookingResponse: await client.createBooking(bookRequest),
      protectionVerified: false,
    };
  } catch (error) {
    if (!isBookingProtectionError(error)) {
      if (error && typeof error === 'object') error.safeToRetry = false;
      throw error;
    }

    await verifyBookingProtection(client, error, options);
    return {
      bookingResponse: await client.createBooking(bookRequest),
      protectionVerified: true,
    };
  }
}

async function priceFlight(params = {}, options = {}) {
  const result = await searchJourney(params, options);

  if (params.returnDate) {
    const { departureFlight, returnFlight, departureFare, returnFare } = selectFlightPair(
      result.flights,
      result.returnFlights,
      params
    );
    return {
      ...result,
      flight: departureFlight,
      fare: departureFare,
      returnFlight,
      returnFare,
      summary: summarizeFlightFare(departureFlight, departureFare),
      returnSummary: summarizeFlightFare(returnFlight, returnFare),
      total: fullFareForAdult(departureFare, departureFlight) + fullFareForAdult(returnFare, returnFlight),
      isRoundtrip: true,
    };
  }

  const flight = selectFlight(result.flights, params);
  const { fare, total } = cheapestFare(flight);

  return {
    ...result,
    flight,
    fare,
    summary: summarizeFlightFare(flight, fare),
    total,
    isRoundtrip: false,
  };
}

async function pollTicketInfo(client, sessionID, attempts = 10, initialDelayMs = 500) {
  const maxAttempts = Number.parseInt(attempts || '10', 10);
  let delayMs = Number.parseInt(initialDelayMs || '500', 10);
  let lastResponse = null;
  for (let index = 0; index < maxAttempts; index += 1) {
    try {
      lastResponse = await client.getTicketInfoBySessionId(sessionID);
    } catch (error) {
      if (!isBookingProtectionError(error)) throw error;
      try {
        await verifyBookingProtection(client, error);
      } catch (verifyError) {
        if (verifyError && typeof verifyError === 'object') verifyError.safeToRetry = false;
        throw verifyError;
      }
      lastResponse = await client.getTicketInfoBySessionId(sessionID);
    }
    if (hasCompletePnrResponse(lastResponse) || hasFastPnrTicketInfo(lastResponse)) {
      return lastResponse;
    }
    if (index < maxAttempts - 1) {
      await sleep(delayMs);
      delayMs = Math.min(Math.round(delayMs * 1.4), 2000);
    }
  }
  return lastResponse;
}

async function holdFlight(params = {}, options = {}) {
  const client = options.client || new MuadiApiClient(options);
  const fastHold = !!(
    options.fastHold ||
    options.skipPricingSync ||
    params.fastHold ||
    params.skipPricingSync
  );
  const priced = await priceFlight(params, { ...options, client });
  const passengers = Array.isArray(params.passengersObject) && params.passengersObject.length > 0
    ? params.passengersObject
    : [params.passengerObject || parsePassengerName(params.passenger, params)];
  const passenger = passengers[0];
  const contact = contactFromSession(client, passenger, params);
  const bookRequest = buildBookRequest({
    client,
    request: priced.request,
    flight: priced.flight,
    fare: priced.fare,
    passenger,
    passengers,
    contact,
    isExportNow: false,
    returnFlight: priced.returnFlight,
    returnFare: priced.returnFare,
  });
  const finalBookRequest = (options.dryRun || params.dryRun)
    ? bookRequest
    : await refreshBookRequestLuggage(client, bookRequest);

  if (options.dryRun || params.dryRun) {
    return {
      ...priced,
      passenger,
      passengers,
      bookRequest: finalBookRequest,
      dryRun: true,
    };
  }

  const bookingStartedAt = Date.now();
  const protectedBooking = await createBookingWithProtection(client, finalBookRequest, {
    otp: params.otp || options.otp,
  });
  debugTiming('createBookingWithProtection', bookingStartedAt);
  const bookingResponse = protectedBooking.bookingResponse;
  const protectionVerified = protectedBooking.protectionVerified;

  let ticketInfo;
  if (hasCompletePnrResponse(bookingResponse) || (fastHold && hasAnyPnrResponse(bookingResponse))) {
    ticketInfo = bookingResponse;
    debugTiming('pollTicketInfo skipped', Date.now());
  } else {
    const pollStartedAt = Date.now();
    try {
      ticketInfo = await pollTicketInfo(
        client,
        finalBookRequest.sessionID,
        options.pollAttempts ?? (fastHold ? 1 : 20),
        options.pollDelayMs ?? (fastHold ? 0 : 800)
      );
    } catch (error) {
      ticketInfo = bookingResponse;
      console.warn('[hold] ticket-info polling failed after create-booking; returning booking response fallback', {
        sessionID: finalBookRequest.sessionID,
        error: error && error.message ? error.message : String(error),
      });
    }
    debugTiming('pollTicketInfo', pollStartedAt);
  }

  return {
    ...priced,
    passenger,
    passengers,
    bookRequest: finalBookRequest,
    bookingResponse,
    protectionVerified,
    ticketInfo,
    dryRun: false,
  };
}

function summarizeHoldResult(result) {
  const data = result.ticketInfo && result.ticketInfo.data ? result.ticketInfo.data : {};
  const pnrs = data.listPNR || [];
  return {
    sessionID: result.request.sessionID,
    passenger: `${result.passenger.title} ${result.passenger.lastName}/${result.passenger.firstName}`,
    flight: result.summary,
    pnrs: pnrs.map((item) => ({
      airline: item.airline,
      pnr: item.pnr || item.message || '',
      status: item.status,
      from: item.dep || item.from,
      to: item.ret || item.to,
      timelimit: item.timelimit || item.timeLimit || '',
      message: item.message || '',
    })),
  };
}

module.exports = {
  buildAncillariesRequest,
  buildBookRequest,
  buildSearchRequest,
  cheapestFare,
  clearSessionListCache,
  createBookingWithProtection,
  departTimeOf,
  flightNumberOf,
  hasAnyPnrResponse,
  flightsFromSearchResponse,
  flightsFromSearchResponseRT,
  formatMoney,
  fullFareForAdult,
  hasCompletePnrResponse,
  holdFlight,
  isBookingProtectionError,
  normalizeAirport,
  normalizeDate,
  normalizeTime,
  parsePassengerName,
  pollTicketInfo,
  priceFlight,
  refreshBookRequestLuggage,
  routeSummaryOf,
  searchJourney,
  segmentsOf,
  selectFlight,
  selectFlightPair,
  stripVietnamese,
  summarizeFlightFare,
  summarizeHoldResult,
  verifyBookingProtection,
};
