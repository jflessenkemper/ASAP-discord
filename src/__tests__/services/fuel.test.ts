import { haversineKm } from '../../services/fuel';

describe('Fuel Service — haversineKm', () => {
  it('returns 0 for same point', () => {
    expect(haversineKm(-33.8688, 151.2093, -33.8688, 151.2093)).toBe(0);
  });

  it('calculates Sydney to Melbourne correctly (~713 km)', () => {
    // Sydney: -33.8688, 151.2093 — Melbourne: -37.8136, 144.9631
    const dist = haversineKm(-33.8688, 151.2093, -37.8136, 144.9631);
    expect(dist).toBeGreaterThan(700);
    expect(dist).toBeLessThan(730);
  });

  it('calculates short distance correctly (Sydney CBD to Bondi ~7 km)', () => {
    const dist = haversineKm(-33.8688, 151.2093, -33.8915, 151.2767);
    expect(dist).toBeGreaterThan(5);
    expect(dist).toBeLessThan(10);
  });

  it('is symmetric (A→B = B→A)', () => {
    const a = haversineKm(-33.8688, 151.2093, -37.8136, 144.9631);
    const b = haversineKm(-37.8136, 144.9631, -33.8688, 151.2093);
    expect(a).toBeCloseTo(b, 10);
  });

  it('handles crossing the date line', () => {
    // Fiji (178°E) to Tonga (175°W = -175)
    const dist = haversineKm(-18, 178, -21, -175);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeLessThan(1000);
  });

  it('handles equator crossing', () => {
    const dist = haversineKm(1, 100, -1, 100);
    expect(dist).toBeGreaterThan(200);
    expect(dist).toBeLessThan(230);
  });
});

describe('Fuel Service — getNearestSupreme98Price', () => {
  // Reset modules for each test since we need to control env vars  
  beforeEach(() => {
    jest.resetModules();
  });

  it('returns fallback price when FUEL_API_KEY is not set', async () => {
    delete process.env.FUEL_API_KEY;
    const { getNearestSupreme98Price } = await import('../../services/fuel');
    const result = await getNearestSupreme98Price(-33.87, 151.21);
    expect(result.pricePerLitre).toBe(2.30);
    expect(result.stationName).toBe('Default estimate');
  });

  it('returns fallback price when API call fails', async () => {
    process.env.FUEL_API_KEY = 'test-key';
    // Mock global fetch to simulate failure
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    const { getNearestSupreme98Price } = await import('../../services/fuel');
    const result = await getNearestSupreme98Price(-33.87, 151.21);
    expect(result.pricePerLitre).toBe(2.30);
    expect(result.stationName).toBe('API unavailable');

    global.fetch = originalFetch;
  });
});

describe('Fuel Service — calculateFuelCost', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.FUEL_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  it('calculates fuel cost using haversine and fallback price', async () => {
    const { calculateFuelCost } = await import('../../services/fuel');
    // Sydney to Wollongong ~82km
    const result = await calculateFuelCost(-33.8688, 151.2093, -34.4278, 150.8931);

    expect(result.distanceKm).toBeGreaterThan(60);
    expect(result.distanceKm).toBeLessThan(100);
    expect(result.pricePerLitre).toBe(2.30); // fallback
    expect(result.fuelCost).toBeGreaterThan(0);
    // Fuel cost = (distKm / 100) * 10 * 2.30  ≈ ~16-19 AUD
    expect(result.fuelCost).toBeGreaterThan(10);
    expect(result.fuelCost).toBeLessThan(25);
  });
});
