'use strict';

jest.mock('../src/muadi-client', () => ({
  MuadiApiClient: jest.fn(),
}));

const { MuadiApiClient } = require('../src/muadi-client');
const { clearLowestFareCache, handleLowestFareRequest } = require('../src/routes/lowest-fare');

describe('lowest-fare route handler', () => {
  const searchLowestFare = jest.fn();

  beforeEach(() => {
    clearLowestFareCache();
    searchLowestFare.mockReset();
    MuadiApiClient.mockImplementation(() => ({ searchLowestFare }));
  });

  it('returns route, depart and cachedAt for valid origin/destination', async () => {
    searchLowestFare.mockResolvedValue({
      success: true,
      data: {
        depart: {
          '4-2026': [
            { day: 26, month: 4, year: 2026, fareAmount: 1790000, fareDisplay: '1.790.000 ₫' },
          ],
        },
        return: {},
      },
    });

    const result = await handleLowestFareRequest({ origin: 'HAN', destination: 'SGN' });

    expect(result.statusCode).toBe(200);
    expect(result.payload.route).toEqual({ origin: 'HAN', destination: 'SGN' });
    expect(result.payload.depart['4-2026'][0].fareAmount).toBe(1790000);
    expect(result.payload.cachedAt).toEqual(expect.any(String));
    expect(result.headers['Cache-Control']).toBe('private, max-age=60');
  });

  it('normalizes Muadi direct bucket payload into depart and return buckets', async () => {
    searchLowestFare.mockResolvedValue({
      success: true,
      data: {
        '5-2026': [
          { day: 20, month: 5, year: 2026, fareAmount: 1610000, fareDisplay: '1,610K', route: 'HANSGN' },
          { day: 21, month: 5, year: 2026, fareAmount: 1610000, fareDisplay: '1,610K', route: 'HANSGN' },
        ],
      },
      message: 'success',
    });

    const result = await handleLowestFareRequest({ origin: 'HAN', destination: 'SGN' });

    expect(result.statusCode).toBe(200);
    expect(result.payload.depart['5-2026'][0].fareAmount).toBe(1610000);
    expect(result.payload.return['5-2026'][1].day).toBe(21);
  });

  it('uses in-memory cache for repeated route within ttl', async () => {
    searchLowestFare.mockResolvedValue({
      data: { depart: { '4-2026': [{ day: 26, month: 4, year: 2026, fareAmount: 1790000 }] } },
    });

    const first = await handleLowestFareRequest({ origin: 'han', destination: 'sgn' });
    const second = await handleLowestFareRequest({ origin: 'HAN', destination: 'SGN' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(searchLowestFare).toHaveBeenCalledTimes(1);
    expect(second.payload).toEqual(first.payload);
  });

  it.each([
    ['HA', 'SGN'],
    ['HANN', 'SGN'],
    ['H@N', 'SGN'],
    ['HAN', 'SG'],
    ['HAN', 'SGNN'],
    ['HAN', 'S*N'],
  ])('rejects invalid IATA values origin=%s destination=%s', async (origin, destination) => {
    const result = await handleLowestFareRequest({ origin, destination });

    expect(result.statusCode).toBe(400);
    expect(result.payload).toEqual({ error: 'INVALID_IATA' });
    expect(searchLowestFare).not.toHaveBeenCalled();
  });

  it('maps Muadi errors to UPSTREAM_ERROR', async () => {
    searchLowestFare.mockRejectedValue(new Error('Muadi unavailable'));

    const result = await handleLowestFareRequest({ origin: 'HAN', destination: 'SGN' });

    expect(result.statusCode).toBe(502);
    expect(result.payload.error).toBe('UPSTREAM_ERROR');
    expect(result.payload.detail).toContain('Muadi unavailable');
  });
});
