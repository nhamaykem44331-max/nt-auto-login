'use strict';

const { cacheSearch, searchCache } = require('../src/server');

describe('cacheSearch fare ids', () => {
  afterEach(() => {
    searchCache.clear();
  });

  it('keeps fare options unique when Muadi returns the same fare id for multiple classes', () => {
    const fares = [
      {
        id: 'HANSGN-1_Y',
        class: 'M',
        fareInfo: [{ fareBasis: 'MMEPD0VF', cabinClass: 'Economy' }],
        fareADT: 1959000,
        taxADT: 595000,
        vatADT: 157000,
        issueFeeADT: 0,
        currencyCode: 'VND',
        seatAvailable: 9,
      },
      {
        id: 'HANSGN-1_Y',
        class: 'J',
        fareInfo: [{ fareBasis: 'JMBFD1VF', cabinClass: 'Business' }],
        fareADT: 5999000,
        taxADT: 595000,
        vatADT: 480000,
        issueFeeADT: 0,
        currencyCode: 'VND',
        seatAvailable: 8,
      },
    ];

    const result = cacheSearch({
      request: {
        sessionID: 123,
        originCode: 'HAN',
        destinationCode: 'SGN',
        departureDateTime: '30-04-2026',
        currencyCode: 'VND',
      },
      sessionData: {},
      flights: [{
        id: 'HANSGN-1',
        airline: '9G',
        source: '9G',
        routeInfo: [{
          carrierCode: '9G',
          flightNumber: '855',
          from: 'HAN',
          to: 'SGN',
          departDate: '30-04-2026 15:30',
          arrivalDate: '30-04-2026 17:40',
          flightTime: '02:10',
          airCraft: '321',
        }],
        priceInfo: fares,
      }],
    });

    const publicFlight = result.publicFlights[0];
    const fareIds = publicFlight.fareOptions.map((fare) => fare.id);
    const cachedEntry = searchCache.get(result.searchId).entries.get(publicFlight.id);

    expect(new Set(fareIds).size).toBe(fareIds.length);
    expect(publicFlight.price.amount).toBe(2711000);
    expect(cachedEntry.fareById.get(publicFlight.fareId)).toBe(fares[0]);
  });
});
