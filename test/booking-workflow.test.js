'use strict';

jest.mock('../src/config', () => ({
  paths: { sessionFile: './test/fixtures/sample-session.json' },
  browser: {},
  ddddocr: { apiUrl: 'http://localhost:8001', timeout: 10000 },
}));

const mockClient = {
  session: {
    localStorage: { diff: '0', i18nextLng: 'vi' },
    userInfo: { email: 'test@example.com', dienThoai: '0901234567' },
    agentInfo: {},
  },
  accessToken: 'fake-token',
  createSession: jest.fn(),
  searchFlightByAirline: jest.fn(),
  createBooking: jest.fn(),
  getTicketInfoBySessionId: jest.fn(),
};

jest.mock('../src/muadi-client', () => {
  const actual = jest.requireActual('../src/muadi-client');
  return {
    ...actual,
    MuadiApiClient: jest.fn().mockImplementation(() => mockClient),
  };
});

const sampleFlight = require('./fixtures/sample-flight.json');
const sampleMultiSegment = require('./fixtures/sample-flight-multi-segment.json');
const sampleHoldResponse = require('./fixtures/sample-hold-response.json');
const { MuadiApiError } = require('../src/muadi-client');

const {
  normalizeAirport,
  normalizeDate,
  normalizeTime,
  parsePassengerName,
  buildSearchRequest,
  cheapestFare,
  selectFlight,
  selectFlightPair,
  buildAncillariesRequest,
  buildBookRequest,
  clearSessionListCache,
  refreshBookRequestLuggage,
  summarizeHoldResult,
  segmentsOf,
  formatMoney,
  flightNumberOf,
  departTimeOf,
  routeSummaryOf,
  summarizeFlightFare,
  fullFareForAdult,
  flightsFromSearchResponseRT,
  searchJourney,
  pollTicketInfo,
  holdFlight,
} = require('../src/booking-workflow');

// --- normalizeDate ---
describe('normalizeDate', () => {
  it('parses DD-MM-YYYY', () => {
    expect(normalizeDate('25-04-2026')).toBe('25-04-2026');
  });

  it('parses YYYY-MM-DD', () => {
    expect(normalizeDate('2026-04-25')).toBe('25-04-2026');
  });

  it('pads single-digit day and month', () => {
    expect(normalizeDate('5-4-2026')).toBe('05-04-2026');
    expect(normalizeDate('2026-4-5')).toBe('05-04-2026');
  });

  it('accepts slash separator', () => {
    expect(normalizeDate('25/04/2026')).toBe('25-04-2026');
    expect(normalizeDate('2026/04/25')).toBe('25-04-2026');
  });

  it('throws on invalid format', () => {
    expect(() => normalizeDate('not-a-date')).toThrow(/invalid date/i);
    expect(() => normalizeDate('')).toThrow(/invalid date/i);
    expect(() => normalizeDate('25-04')).toThrow(/invalid date/i);
  });
});

// --- normalizeTime ---
describe('normalizeTime', () => {
  it('returns null for falsy input', () => {
    expect(normalizeTime(null)).toBeNull();
    expect(normalizeTime('')).toBeNull();
    expect(normalizeTime(undefined)).toBeNull();
  });

  it('parses HH:mm format', () => {
    expect(normalizeTime('05:00')).toBe('05:00');
    expect(normalizeTime('14:30')).toBe('14:30');
  });

  it('pads single-digit hour', () => {
    expect(normalizeTime('5:00')).toBe('05:00');
    expect(normalizeTime('9:15')).toBe('09:15');
  });

  it('parses HHmm format', () => {
    expect(normalizeTime('0500')).toBe('05:00');
    expect(normalizeTime('1430')).toBe('14:30');
  });

  it('throws for invalid time values', () => {
    expect(() => normalizeTime('25:00')).toThrow(/invalid time/i);
    expect(() => normalizeTime('12:60')).toThrow(/invalid time/i);
    expect(() => normalizeTime('abc')).toThrow(/invalid time/i);
  });
});

// --- parsePassengerName ---
describe('parsePassengerName', () => {
  it('parses "MR Vu Duc Anh" → title MR, lastName VU, firstName DUC ANH', () => {
    const p = parsePassengerName('MR Vu Duc Anh');
    expect(p.title).toBe('MR');
    expect(p.lastName).toBe('VU');
    expect(p.firstName).toBe('DUC ANH');
    expect(p.type).toBe('ADT');
  });

  it('parses Vietnamese diacritic name "Vũ Đức Anh"', () => {
    const p = parsePassengerName('Vũ Đức Anh');
    expect(p.title).toBe('MR');
    expect(p.lastName).toBe('VU');
    expect(p.firstName).toBe('DUC ANH');
  });

  it('parses MRS title', () => {
    const p = parsePassengerName('MRS Nguyen Thi B');
    expect(p.title).toBe('MRS');
    expect(p.lastName).toBe('NGUYEN');
    expect(p.firstName).toBe('THI B');
  });

  it('parses MS title', () => {
    const p = parsePassengerName('MS Tran C');
    expect(p.title).toBe('MS');
    expect(p.lastName).toBe('TRAN');
    expect(p.firstName).toBe('C');
  });

  it('defaults to MR when no title prefix', () => {
    const p = parsePassengerName('Vu Duc Anh');
    expect(p.title).toBe('MR');
  });

  it('uses options override for lastName/firstName', () => {
    const p = parsePassengerName('', { lastName: 'VU', firstName: 'DUC ANH', title: 'MR' });
    expect(p.title).toBe('MR');
    expect(p.lastName).toBe('VU');
    expect(p.firstName).toBe('DUC ANH');
  });

  it('options override strips diacritics', () => {
    const p = parsePassengerName('', { lastName: 'Vũ', firstName: 'Đức Anh', title: 'MR' });
    expect(p.lastName).toBe('VU');
    expect(p.firstName).toBe('DUC ANH');
  });

  it('throws for single-word name', () => {
    expect(() => parsePassengerName('Vu')).toThrow(/last name.*first name|must include/i);
  });

  it('throws for empty string', () => {
    expect(() => parsePassengerName('')).toThrow();
  });
});

// --- buildSearchRequest ---
describe('buildSearchRequest', () => {
  it('builds oneway request', () => {
    const req = buildSearchRequest({ from: 'HAN', to: 'SGN', date: '25-04-2026' });
    expect(req.originCode).toBe('HAN');
    expect(req.destinationCode).toBe('SGN');
    expect(req.departureDateTime).toBe('25-04-2026');
    expect(req.journeyType).toBe('OW');
    expect(req.returnDateTime).toBeUndefined();
  });

  it('builds roundtrip request', () => {
    const req = buildSearchRequest({ from: 'HAN', to: 'SGN', date: '25-04-2026', returnDate: '30-04-2026' });
    expect(req.journeyType).toBe('RT');
    expect(req.returnDateTime).toBe('30-04-2026');
  });

  it('includes airline when specified', () => {
    const req = buildSearchRequest({ from: 'HAN', to: 'SGN', date: '25-04-2026', airline: 'vn' });
    expect(req.airlines).toEqual(['VN']);
  });

  it('normalizes from/to to uppercase', () => {
    const req = buildSearchRequest({ from: 'han', to: 'sgn', date: '25-04-2026' });
    expect(req.originCode).toBe('HAN');
    expect(req.destinationCode).toBe('SGN');
  });

  it('defaults to 1 adult, 0 children, 0 infants', () => {
    const req = buildSearchRequest({ from: 'HAN', to: 'SGN', date: '25-04-2026' });
    expect(req.numberOfAdult).toBe(1);
    expect(req.numberOfChildren).toBe(0);
    expect(req.numberOfInfant).toBe(0);
  });
});

// --- cheapestFare ---
describe('cheapestFare', () => {
  it('picks the cheapest non-soldOut fare', () => {
    const result = cheapestFare(sampleFlight);
    expect(result.fare.class).toBe('E');
    expect(result.total).toBe(1500000 + 280000 + 120000);
  });

  it('throws when all fares are soldOut', () => {
    const flight = {
      ...sampleFlight,
      priceInfo: [{ ...sampleFlight.priceInfo[0], soldOut: true }],
    };
    expect(() => cheapestFare(flight)).toThrow(/no fare/i);
  });

  it('throws for empty priceInfo', () => {
    const flight = { ...sampleFlight, priceInfo: [] };
    expect(() => cheapestFare(flight)).toThrow(/no fare/i);
  });

  it('includes issueFeeADT in total when present', () => {
    const flight = {
      ...sampleFlight,
      priceInfo: [{
        ...sampleFlight.priceInfo[0],
        fareADT: 1000000,
        taxADT: 100000,
        vatADT: 0,
        issueFeeADT: 50000,
        soldOut: false,
      }],
    };
    const result = cheapestFare(flight);
    expect(result.total).toBe(1150000);
    expect(result.issueFeeADT).toBe(50000);
  });
});

// --- selectFlight ---
describe('selectFlight', () => {
  const flights = [sampleFlight, sampleMultiSegment];

  it('selects by airline', () => {
    const result = selectFlight(flights, { airline: 'VN', from: 'HAN', to: 'SGN' });
    expect(result.airline).toBe('VN');
  });

  it('selects by time', () => {
    const result = selectFlight(flights, { time: '05:00', from: 'HAN', to: 'SGN' });
    expect(result.id).toBe('flight-vn205');
  });

  it('selects by flightNumber', () => {
    const result = selectFlight(flights, { flightNumber: 'VN205' });
    expect(result.id).toBe('flight-vn205');
  });

  it('matches multi-segment flight from HAN to SGN', () => {
    const result = selectFlight(flights, { from: 'HAN', to: 'SGN', airline: 'VJ' });
    expect(result.id).toBe('flight-vj851');
  });

  it('throws when no match found', () => {
    expect(() => selectFlight(flights, { airline: 'QH' })).toThrow(/no matching flight/i);
  });

  it('filters out multi-segment when directOnly=true', () => {
    const result = selectFlight(flights, { from: 'HAN', to: 'SGN', airline: 'VN', directOnly: true });
    expect(result.id).toBe('flight-vn205');
  });

  it('throws when directOnly=true filters all matches', () => {
    expect(() => selectFlight(flights, { airline: 'VJ', directOnly: true })).toThrow(/no matching flight/i);
  });
});

// --- buildBookRequest ---
describe('buildBookRequest', () => {
  const passenger = {
    id: 'ADT-1',
    type: 'ADT',
    title: 'MR',
    lastName: 'VU',
    firstName: 'DUC ANH',
    loyalty: [],
    goldCard: '',
    listLuggage: [],
    ancillaryServices: [],
  };
  const request = {
    sessionID: 99,
    originCode: 'HAN',
    destinationCode: 'SGN',
    departureDateTime: '25-04-2026',
    numberOfAdult: 1,
    numberOfChildren: 0,
    numberOfInfant: 0,
    currencyCode: 'VND',
  };
  const fare = sampleFlight.priceInfo[0];

  it('builds correct single-segment booking request', () => {
    const req = buildBookRequest({ request, flight: sampleFlight, fare, passenger });
    expect(req.sessionID).toBe(99);
    expect(req.listRoutes).toHaveLength(1);
    expect(req.listRoutes[0].listRoute).toHaveLength(1);
    expect(req.listRoutes[0].listRoute[0].from).toBe('HAN');
    expect(req.listRoutes[0].listRoute[0].to).toBe('SGN');
    expect(req.listPax).toHaveLength(1);
    expect(req.adt).toBe(1);
  });

  it('đảo Họ/Tên khi gửi Muadi: listPax.firstName = Họ, lastName = Tên', () => {
    const req = buildBookRequest({ request, flight: sampleFlight, fare, passenger });
    // Nội bộ lưu chuẩn quốc tế: lastName='VU' (Họ), firstName='DUC ANH' (Tên).
    // Muadi đọc firstName như HỌ → phải đảo, nếu không vé in ngược "DUC ANH/VU".
    expect(req.listPax[0].firstName).toBe('VU');
    expect(req.listPax[0].lastName).toBe('DUC ANH');
    expect(req.listPax[0].name).toBe('VU DUC ANH');
    expect(req.listPax[0].fullName).toBe('VU DUC ANH');
  });

  it('builds correct multi-segment booking request', () => {
    const req = buildBookRequest({ request, flight: sampleMultiSegment, fare: sampleMultiSegment.priceInfo[0], passenger });
    expect(req.listRoutes[0].listRoute).toHaveLength(2);
    expect(req.listRoutes[0].listRoute[0].from).toBe('HAN');
    expect(req.listRoutes[0].listRoute[0].to).toBe('DAD');
    expect(req.listRoutes[0].listRoute[1].from).toBe('DAD');
    expect(req.listRoutes[0].listRoute[1].to).toBe('SGN');
  });

  it('isExportNow defaults to false', () => {
    const req = buildBookRequest({ request, flight: sampleFlight, fare, passenger });
    expect(req.isExportNow).toBe(false);
  });

  it('supports multiple passengers in listPax', () => {
    const passengers = [
      { ...passenger, id: 'ADT1' },
      { ...passenger, id: 'ADT2', firstName: 'ANH', lastName: 'NGUYEN' },
    ];
    const req = buildBookRequest({ request, flight: sampleFlight, fare, passengers });
    expect(req.listPax).toHaveLength(2);
    expect(req.listPax[0].id).toBe('ADT1');
    expect(req.listPax[1].id).toBe('ADT2');
  });

  it('copies baggage from listLuggage to ancillaryServices for create-booking compatibility', () => {
    const passengers = [{
      ...passenger,
      id: 'ADT1',
      listLuggage: [{
        route: 'HANSGN',
        segmentId: 1,
        airline: 'VN',
        serviceType: 'BAG',
        code: 'BG23',
        key: 'bg-23',
        description: 'Hanh ly ky gui 23kg',
        unit: '23KG',
        price: 324000,
      }],
      ancillaryServices: [],
    }];

    const req = buildBookRequest({ request, flight: sampleFlight, fare, passengers });
    expect(req.listPax[0].listLuggage).toHaveLength(1);
    expect(req.listPax[0].ancillaryServices).toHaveLength(1);
    expect(req.listPax[0].ancillaryServices[0]).toMatchObject({
      route: 'HANSGN',
      code: 'BG23',
      key: 'bg-23',
      serviceType: 'BAG',
    });
  });

  it('restores listLuggage from ancillaryServices when baggage was provided there', () => {
    const passengers = [{
      ...passenger,
      id: 'ADT1',
      listLuggage: [],
      ancillaryServices: [{
        route: 'DADHAN',
        segmentId: 1,
        airline: 'QH',
        serviceType: 'BAG',
        code: 'BG10',
        key: 'bg-10',
        description: 'Hanh ly ky gui 10kg',
        unit: '10KG',
        price: 130000,
      }],
    }];

    const req = buildBookRequest({ request, flight: sampleFlight, fare, passengers });
    expect(req.listPax[0].listLuggage).toHaveLength(1);
    expect(req.listPax[0].listLuggage[0]).toMatchObject({
      route: 'DADHAN',
      code: 'BG10',
      key: 'bg-10',
      serviceType: 'BAG',
    });
  });
});

describe('buildAncillariesRequest', () => {
  it('maps booking request to ancillaries payload format', () => {
    const payload = buildAncillariesRequest({
      sessionID: 123,
      listRoutes: [{ id: 'r1' }],
      adt: 2,
      chd: 1,
      inf: 0,
    });
    expect(payload).toEqual({
      sessionID: 123,
      Routes: [{ id: 'r1' }],
      ADT: 2,
      CHD: 1,
      INF: 0,
    });
  });
});

describe('refreshBookRequestLuggage', () => {
  it('updates baggage key in both listLuggage and ancillaryServices', async () => {
    const client = {
      getAncillaries: jest.fn().mockResolvedValue({
        data: {
          airline: 'VN',
          paxData: [{ paxId: 'ADT1', paxType: 'ADT' }],
          segments: [{
            route: 'HANDAD',
            segmentId: 1,
            airline: 'VN',
            paxServices: [{
              paxId: 'ADT1',
              services: [{
                serviceType: 'BAG',
                code: 'BG23',
                key: 'new-key-23',
                description: 'Hanh ly ky gui 23kg',
                unit: '23KG',
                price: 324000,
              }],
            }],
          }],
        },
      }),
    };

    const bookRequest = {
      sessionID: 999,
      listRoutes: [{ route: 'HANDAD' }],
      adt: 1,
      chd: 0,
      inf: 0,
      listPax: [{
        id: 'ADT1',
        type: 'ADT',
        listLuggage: [{
          route: 'HANDAD',
          segmentId: 1,
          airline: 'VN',
          serviceType: 'BAG',
          code: 'BG23',
          key: 'old-key-23',
          description: 'Hanh ly ky gui 23kg',
          unit: '23KG',
          price: 324000,
        }],
        ancillaryServices: [{
          route: 'HANDAD',
          segmentId: 1,
          airline: 'VN',
          serviceType: 'BAG',
          code: 'BG23',
          key: 'old-key-23',
          description: 'Hanh ly ky gui 23kg',
          unit: '23KG',
          price: 324000,
        }],
      }],
    };

    const updated = await refreshBookRequestLuggage(client, bookRequest);
    expect(client.getAncillaries).toHaveBeenCalledTimes(1);
    expect(updated.listPax[0].listLuggage[0].key).toBe('new-key-23');
    const bagAncillary = updated.listPax[0].ancillaryServices.find((item) => item.serviceType === 'BAG');
    expect(bagAncillary).toBeDefined();
    expect(bagAncillary.key).toBe('new-key-23');
  });
});

// --- summarizeHoldResult ---
describe('summarizeHoldResult', () => {
  it('summarizes a successful hold result', () => {
    const result = {
      request: { sessionID: 12345 },
      passenger: { title: 'MR', lastName: 'VU', firstName: 'DUC ANH' },
      summary: { flightNumber: 'VN205', from: 'HAN', to: 'SGN', total: 1900000, currencyCode: 'VND', class: 'E', cabinClass: 'Economy' },
      ticketInfo: sampleHoldResponse,
    };
    const summary = summarizeHoldResult(result);
    expect(summary.sessionID).toBe(12345);
    expect(summary.pnrs).toHaveLength(1);
    expect(summary.pnrs[0].pnr).toBe('ABC123');
    expect(summary.pnrs[0].status).toBe('OK');
    expect(summary.pnrs[0].airline).toBe('VN');
  });

  it('handles WAIT status in listPNR', () => {
    const result = {
      request: { sessionID: 1 },
      passenger: { title: 'MR', lastName: 'A', firstName: 'B' },
      summary: {},
      ticketInfo: {
        data: {
          listPNR: [{ airline: 'VN', pnr: '', status: 'WAIT', dep: 'HAN', ret: 'SGN', timelimit: '', message: 'Processing' }],
        },
      },
    };
    const summary = summarizeHoldResult(result);
    expect(summary.pnrs[0].status).toBe('WAIT');
  });

  it('handles missing ticketInfo gracefully', () => {
    const result = {
      request: { sessionID: 1 },
      passenger: { title: 'MR', lastName: 'A', firstName: 'B' },
      summary: {},
      ticketInfo: null,
    };
    const summary = summarizeHoldResult(result);
    expect(summary.pnrs).toEqual([]);
  });

  it('handles multiple PNRs (roundtrip)', () => {
    const result = {
      request: { sessionID: 1 },
      passenger: { title: 'MR', lastName: 'A', firstName: 'B' },
      summary: {},
      ticketInfo: {
        data: {
          listPNR: [
            { airline: 'VN', pnr: 'DEP001', status: 'OK', dep: 'HAN', ret: 'SGN', timelimit: '' },
            { airline: 'VN', pnr: 'RET001', status: 'OK', dep: 'SGN', ret: 'HAN', timelimit: '' },
          ],
        },
      },
    };
    const summary = summarizeHoldResult(result);
    expect(summary.pnrs).toHaveLength(2);
    expect(summary.pnrs[0].pnr).toBe('DEP001');
    expect(summary.pnrs[1].pnr).toBe('RET001');
  });
});

// --- segmentsOf ---
describe('segmentsOf', () => {
  it('returns single segment for single-segment flight', () => {
    expect(segmentsOf(sampleFlight)).toHaveLength(1);
  });

  it('returns multiple segments for multi-segment flight', () => {
    expect(segmentsOf(sampleMultiSegment)).toHaveLength(2);
  });
});

// --- normalizeAirport ---
describe('normalizeAirport', () => {
  it('normalizes lowercase to uppercase for known airports', () => {
    expect(normalizeAirport('han')).toBe('HAN');
    expect(normalizeAirport(' sgn ')).toBe('SGN');
  });

  it('throws for codes that fail 3-letter regex', () => {
    expect(() => normalizeAirport('HA')).toThrow(/invalid.*airport/i);
    expect(() => normalizeAirport('HANO')).toThrow(/invalid.*airport/i);
    expect(() => normalizeAirport('12')).toThrow(/invalid.*airport/i);
  });

  it('throws for unknown airport codes with suggestion', () => {
    expect(() => normalizeAirport('XXX')).toThrow(/unknown airport/i);
  });

  it('error message includes suggestion for near-miss (HNI → Did you mean)', () => {
    let msg = '';
    try { normalizeAirport('HNI'); } catch (e) { msg = e.message; }
    expect(msg).toMatch(/Did you mean/i);
  });
});

// --- formatMoney ---
describe('formatMoney', () => {
  it('formats number with VND by default', () => {
    expect(formatMoney(1900000)).toMatch(/1\.900\.000|1,900,000/);
    expect(formatMoney(1900000)).toContain('VND');
  });

  it('uses specified currency', () => {
    expect(formatMoney(100, 'USD')).toContain('USD');
  });

  it('handles zero', () => {
    expect(formatMoney(0)).toContain('0');
  });
});

// --- flightNumberOf ---
describe('flightNumberOf', () => {
  it('returns carrier + flightNumber for single-segment', () => {
    expect(flightNumberOf(sampleFlight)).toBe('VN205');
  });

  it('returns carrier + flightNumber from first segment for multi-segment', () => {
    expect(flightNumberOf(sampleMultiSegment)).toBe('VJ851');
  });
});

// --- departTimeOf ---
describe('departTimeOf', () => {
  it('extracts depart time from first segment', () => {
    expect(departTimeOf(sampleFlight)).toBe('05:00');
  });

  it('returns empty string for flight with no time', () => {
    expect(departTimeOf({ routeInfo: [{ departDate: '' }] })).toBe('');
  });
});

// --- routeSummaryOf ---
describe('routeSummaryOf', () => {
  it('returns from-to for single-segment', () => {
    expect(routeSummaryOf(sampleFlight)).toBe('HAN-SGN');
  });

  it('returns full path for multi-segment', () => {
    expect(routeSummaryOf(sampleMultiSegment)).toBe('HAN-DAD-SGN');
  });
});

// --- fullFareForAdult ---
describe('fullFareForAdult', () => {
  it('sums fare + tax + vat + issueFee', () => {
    const fare = { fareADT: 1000, taxADT: 200, vatADT: 100, issueFeeADT: 50 };
    expect(fullFareForAdult(fare, {})).toBe(1350);
  });

  it('handles missing fields as 0', () => {
    expect(fullFareForAdult({}, {})).toBe(0);
  });
});

// --- summarizeFlightFare ---
describe('summarizeFlightFare', () => {
  it('returns a summary object with correct fields', () => {
    const fare = sampleFlight.priceInfo[0];
    const summary = summarizeFlightFare(sampleFlight, fare);
    expect(summary.flightNumber).toBe('VN205');
    expect(summary.from).toBe('HAN');
    expect(summary.to).toBe('SGN');
    expect(summary.fareADT).toBe(1500000);
    expect(summary.total).toBe(1900000);
    expect(summary.segments).toHaveLength(1);
  });

  it('returns multi-segment summary', () => {
    const fare = sampleMultiSegment.priceInfo[0];
    const summary = summarizeFlightFare(sampleMultiSegment, fare);
    expect(summary.route).toBe('HAN-DAD-SGN');
    expect(summary.segments).toHaveLength(2);
  });
});

// --- cheapestFare with bookingFee ---
describe('cheapestFare with bookingFee array', () => {
  it('reads issueFee from bookingFee array when direct issueFeeADT missing', () => {
    const flight = {
      ...sampleFlight,
      priceInfo: [{
        ...sampleFlight.priceInfo[0],
        issueFeeADT: undefined,
        soldOut: false,
        fareADT: 1000000,
        taxADT: 100000,
        vatADT: 0,
      }],
      bookingFee: [{ issueFeeADT: 30000 }],
    };
    const result = cheapestFare(flight);
    expect(result.issueFeeADT).toBe(30000);
    expect(result.total).toBe(1130000);
  });
});

// --- searchJourney ---
describe('searchJourney', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSessionListCache();
    mockClient.createSession.mockResolvedValue({
      data: { sessionID: 42, listSignIn: [{ airline: 'VN' }] },
    });
    mockClient.searchFlightByAirline.mockResolvedValue({
      data: { departureFlight: [sampleFlight] },
    });
  });

  it('returns flights from search', async () => {
    const result = await searchJourney({ from: 'HAN', to: 'SGN', date: '25-04-2026', airline: 'VN' }, { client: mockClient });
    expect(result.flights).toHaveLength(1);
    expect(result.flights[0].id).toBe('flight-vn205');
    expect(result.request.sessionID).toBe(42);
  });

  it('uses DEFAULT_AIRLINES when signIns is empty and no airline param', async () => {
    mockClient.createSession.mockResolvedValue({ data: { sessionID: 1, listSignIn: [] } });
    mockClient.searchFlightByAirline.mockResolvedValue({ data: { departureFlight: [] } });
    const result = await searchJourney({ from: 'HAN', to: 'SGN', date: '25-04-2026' }, { client: mockClient });
    expect(mockClient.searchFlightByAirline).toHaveBeenCalledTimes(5);
    expect(result.flights).toHaveLength(0);
  });

  it('uses cached route sign-ins on repeated searches', async () => {
    mockClient.createSession
      .mockResolvedValueOnce({
        data: { sessionID: 101, listSignIn: [{ airline: 'VN' }, { airline: 'VJ' }] },
      })
      .mockResolvedValueOnce({
        data: { sessionID: 102, listSignIn: [] },
      });
    mockClient.searchFlightByAirline.mockResolvedValue({ data: { departureFlight: [] } });

    await searchJourney({ from: 'HAN', to: 'CAN', date: '25-04-2026' }, { client: mockClient });
    const result = await searchJourney({ from: 'HAN', to: 'CAN', date: '26-04-2026' }, { client: mockClient });

    expect(mockClient.createSession.mock.calls[1][0].airlines).toEqual(['VN', 'VJ']);
    expect(mockClient.searchFlightByAirline).toHaveBeenCalledTimes(4);
    expect(result.signIns).toEqual(['VN', 'VJ']);
  });

  it('starts airline searches in parallel', async () => {
    mockClient.createSession.mockResolvedValue({
      data: {
        sessionID: 77,
        listSignIn: [{ airline: 'VN' }, { airline: 'VJ' }, { airline: 'QH' }],
      },
    });

    const resolvers = {};
    mockClient.searchFlightByAirline.mockImplementation((airline) => new Promise((resolve) => {
      resolvers[airline] = resolve;
    }));

    const pending = searchJourney({ from: 'HAN', to: 'SGN', date: '25-04-2026' }, { client: mockClient });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockClient.searchFlightByAirline).toHaveBeenCalledTimes(3);

    resolvers.VN({ data: { departureFlight: [{ ...sampleFlight, id: 'flight-vn', airline: 'VN' }] } });
    resolvers.VJ({ data: { departureFlight: [{ ...sampleFlight, id: 'flight-vj', airline: 'VJ' }] } });
    resolvers.QH({ data: { departureFlight: [{ ...sampleFlight, id: 'flight-qh', airline: 'QH' }] } });

    const result = await pending;
    expect(result.flights).toHaveLength(3);
  });

  it('keeps successful airline results when one airline search fails', async () => {
    mockClient.createSession.mockResolvedValue({
      data: {
        sessionID: 88,
        listSignIn: [{ airline: 'VN' }, { airline: 'VJ' }, { airline: 'QH' }],
      },
    });
    mockClient.searchFlightByAirline.mockImplementation((airline) => {
      if (airline === 'VJ') return Promise.reject(new Error('VJ temporary error'));
      return Promise.resolve({ data: { departureFlight: [{ ...sampleFlight, id: `flight-${airline}`, airline }] } });
    });

    const result = await searchJourney({ from: 'HAN', to: 'SGN', date: '25-04-2026' }, { client: mockClient });

    expect(result.flights).toHaveLength(2);
    expect(result.byAirline.VJ).toEqual([]);
    expect(result.errorsByAirline.VJ).toMatch(/temporary error/i);
  });

  it('throws a clear error when every airline search fails', async () => {
    mockClient.createSession.mockResolvedValue({
      data: { sessionID: 89, listSignIn: [{ airline: 'VN' }, { airline: 'VJ' }] },
    });
    mockClient.searchFlightByAirline.mockRejectedValue(new Error('gateway down'));

    await expect(searchJourney({ from: 'HAN', to: 'SGN', date: '25-04-2026' }, { client: mockClient }))
      .rejects.toThrow(/all airline searches failed/i);
  });

  it('marks all-airline validation failures as safe to retry', async () => {
    mockClient.createSession.mockResolvedValue({
      data: { sessionID: 90, listSignIn: [{ airline: 'VN' }, { airline: 'VJ' }] },
    });
    mockClient.searchFlightByAirline.mockRejectedValue(
      new MuadiApiError('Validation request failed !!!', { safeToRetry: true })
    );

    await expect(searchJourney({ from: 'HAN', to: 'SGN', date: '25-04-2026' }, { client: mockClient }))
      .rejects.toMatchObject({ safeToRetry: true });
  });
});

// --- pollTicketInfo ---
describe('pollTicketInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses exponential backoff between incomplete ticket-info attempts', async () => {
    const waits = [];
    const timerSpy = jest.spyOn(global, 'setTimeout').mockImplementation((callback, ms) => {
      waits.push(ms);
      callback();
      return 0;
    });
    const client = {
      getTicketInfoBySessionId: jest.fn()
        .mockResolvedValueOnce({ data: { listPNR: [] } })
        .mockResolvedValueOnce({ data: { listPNR: [{ status: 'WAIT' }] } })
        .mockResolvedValueOnce({ data: { listPNR: [] } })
        .mockResolvedValueOnce({ data: { listPNR: [{ status: 'OK', pnr: 'ABC123' }] } }),
    };

    try {
      const result = await pollTicketInfo(client, 123, 4, 800);
      expect(result.data.listPNR[0].pnr).toBe('ABC123');
      expect(waits).toEqual([800, 1200, 1800]);
    } finally {
      timerSpy.mockRestore();
    }
  });

  it('returns immediately when ticket-info already has a complete PNR', async () => {
    const timerSpy = jest.spyOn(global, 'setTimeout');
    const client = {
      getTicketInfoBySessionId: jest.fn().mockResolvedValue({
        data: { listPNR: [{ status: 'OK', pnr: 'ABC123' }] },
      }),
    };

    try {
      const result = await pollTicketInfo(client, 123, 20, 800);
      expect(result.data.listPNR[0].pnr).toBe('ABC123');
      expect(client.getTicketInfoBySessionId).toHaveBeenCalledTimes(1);
      expect(timerSpy).not.toHaveBeenCalled();
    } finally {
      timerSpy.mockRestore();
    }
  });
});

// --- holdFlight (dry-run) ---
describe('holdFlight dryRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.createSession.mockResolvedValue({
      data: { sessionID: 55, listSignIn: [{ airline: 'VN' }] },
    });
    mockClient.searchFlightByAirline.mockResolvedValue({
      data: { departureFlight: [sampleFlight] },
    });
  });

  it('returns dryRun=true without calling createBooking', async () => {
    const result = await holdFlight(
      {
        from: 'HAN',
        to: 'SGN',
        date: '25-04-2026',
        airline: 'VN',
        time: '05:00',
        passenger: 'MR Vu Duc Anh',
        dryRun: true,
      },
      { client: mockClient }
    );
    expect(result.dryRun).toBe(true);
    expect(result.bookRequest).toBeDefined();
    expect(mockClient.createBooking).not.toHaveBeenCalled();
  });
});

// --- holdFlight polling ---
describe('holdFlight polling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.createSession.mockResolvedValue({
      data: { sessionID: 56, listSignIn: [{ airline: 'VN' }] },
    });
    mockClient.searchFlightByAirline.mockResolvedValue({
      data: { departureFlight: [sampleFlight] },
    });
  });

  it('skips ticket-info polling when createBooking already returns a complete PNR', async () => {
    mockClient.createBooking.mockResolvedValue({
      data: { listPNR: [{ airline: 'VN', pnr: 'ABC123', status: 'OK' }] },
    });

    const result = await holdFlight(
      {
        from: 'HAN',
        to: 'SGN',
        date: '25-04-2026',
        airline: 'VN',
        time: '05:00',
        passenger: 'MR Vu Duc Anh',
      },
      { client: mockClient }
    );

    expect(mockClient.getTicketInfoBySessionId).not.toHaveBeenCalled();
    expect(result.ticketInfo).toBe(result.bookingResponse);
  });

  it('polls ticket-info when createBooking returns a pending PNR', async () => {
    mockClient.createBooking.mockResolvedValue({
      data: { listPNR: [{ airline: 'VN', pnr: '', status: 'WAIT' }] },
    });
    mockClient.getTicketInfoBySessionId.mockResolvedValue({
      data: { listPNR: [{ airline: 'VN', pnr: 'ABC123', status: 'OK' }] },
    });

    const result = await holdFlight(
      {
        from: 'HAN',
        to: 'SGN',
        date: '25-04-2026',
        airline: 'VN',
        time: '05:00',
        passenger: 'MR Vu Duc Anh',
      },
      { client: mockClient }
    );

    expect(mockClient.getTicketInfoBySessionId).toHaveBeenCalledTimes(1);
    expect(result.ticketInfo.data.listPNR[0].pnr).toBe('ABC123');
  });
});

// --- Roundtrip (Task 1.2) ---
const sampleReturnFlight = {
  ...sampleFlight,
  id: 'flight-vn218',
  routeInfo: [{
    from: 'SGN',
    to: 'HAN',
    carrierCode: 'VN',
    flightNumber: '218',
    departDate: '30-04-2026 14:00',
    arrivalDate: '30-04-2026 16:10',
    airCraft: '321',
    flightTime: 130,
  }],
};

describe('buildSearchRequest roundtrip', () => {
  it('sets journeyType=RT and returnDateTime when returnDate given', () => {
    const req = buildSearchRequest({ from: 'HAN', to: 'SGN', date: '25-04-2026', returnDate: '30-04-2026' });
    expect(req.journeyType).toBe('RT');
    expect(req.returnDateTime).toBe('30-04-2026');
  });
});

describe('buildBookRequest roundtrip', () => {
  const passenger = {
    id: 'ADT-1', type: 'ADT', title: 'MR', lastName: 'VU', firstName: 'DUC ANH',
    loyalty: [], goldCard: '', listLuggage: [], ancillaryServices: [],
  };
  const request = {
    sessionID: 99,
    originCode: 'HAN',
    destinationCode: 'SGN',
    departureDateTime: '25-04-2026',
    returnDateTime: '30-04-2026',
    numberOfAdult: 1,
    numberOfChildren: 0,
    numberOfInfant: 0,
    currencyCode: 'VND',
  };

  it('builds 2 listRoutes for roundtrip', () => {
    const req = buildBookRequest({
      request,
      flight: sampleFlight,
      fare: sampleFlight.priceInfo[0],
      passenger,
      returnFlight: sampleReturnFlight,
      returnFare: sampleReturnFlight.priceInfo[0],
    });
    expect(req.listRoutes).toHaveLength(2);
    expect(req.listRoutes[0].from).toBe('HAN');
    expect(req.listRoutes[0].to).toBe('SGN');
    expect(req.listRoutes[1].from).toBe('SGN');
    expect(req.listRoutes[1].to).toBe('HAN');
  });
});

describe('flightsFromSearchResponseRT', () => {
  it('extracts departure and return flights', () => {
    const response = {
      data: {
        departureFlight: [sampleFlight],
        returnFlight: [sampleReturnFlight],
      },
    };
    const { departureFlights, returnFlights } = flightsFromSearchResponseRT(response);
    expect(departureFlights).toHaveLength(1);
    expect(returnFlights).toHaveLength(1);
    expect(returnFlights[0].id).toBe('flight-vn218');
  });

  it('returns empty returnFlights when not present', () => {
    const response = { data: { departureFlight: [sampleFlight] } };
    const { departureFlights, returnFlights } = flightsFromSearchResponseRT(response);
    expect(departureFlights).toHaveLength(1);
    expect(returnFlights).toHaveLength(0);
  });
});

describe('selectFlightPair', () => {
  it('selects matching departure and return flights', () => {
    const pair = selectFlightPair([sampleFlight], [sampleReturnFlight], {
      from: 'HAN', to: 'SGN', airline: 'VN',
    });
    expect(pair.departureFlight.id).toBe('flight-vn205');
    expect(pair.returnFlight.id).toBe('flight-vn218');
    expect(pair.departureFare).toBeDefined();
    expect(pair.returnFare).toBeDefined();
  });
});
