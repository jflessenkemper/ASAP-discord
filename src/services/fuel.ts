// Fuel pricing service — uses NSW FuelCheck API or fallback
// NSW FuelCheck: https://api.onegov.nsw.gov.au/FuelCheckApp/v2/fuel/prices

const FUEL_API_BASE = 'https://api.onegov.nsw.gov.au/FuelCheckApp/v2';
const AVG_CONSUMPTION_L_PER_100KM = parseFloat(process.env.FUEL_CONSUMPTION_L_PER_100KM || '10');
const FALLBACK_PRICE_PER_LITRE = 2.30; // AUD, reasonable Supreme 98 fallback

// All NSW FuelCheck fuel type codes
const FUEL_TYPES = ['E10', 'U91', 'P95', 'P98', 'DL', 'PDL'] as const;
type FuelTypeCode = typeof FUEL_TYPES[number];

const FUEL_TYPE_LABELS: Record<FuelTypeCode, string> = {
  E10: 'Ethanol 10',
  U91: 'Unleaded 91',
  P95: 'Premium 95',
  P98: 'Premium 98',
  DL: 'Diesel',
  PDL: 'Premium Diesel',
};

interface FuelPrice {
  pricePerLitre: number;
  stationName: string;
  stationAddress: string;
}

export interface FuelPriceCard {
  fuelType: FuelTypeCode;
  fuelLabel: string;
  pricePerLitre: number;
  stationName: string;
  stationBrand: string;
  stationAddress: string;
  stationLat: number;
  stationLng: number;
  distanceKm: number;
}

interface FuelCostResult {
  distanceKm: number;
  fuelCost: number;
  pricePerLitre: number;
  stationName: string;
}

export async function getNearestSupreme98Price(
  lat: number,
  lng: number
): Promise<FuelPrice> {
  const apiKey = process.env.FUEL_API_KEY;

  if (!apiKey) {
    return {
      pricePerLitre: FALLBACK_PRICE_PER_LITRE,
      stationName: 'Default estimate',
      stationAddress: '',
    };
  }

  try {
    // NSW FuelCheck API — search by location for "P98" (Premium 98)
    const res = await fetch(`${FUEL_API_BASE}/fuel/prices/nearby`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        fueltype: 'P98',
        latitude: lat,
        longitude: lng,
        radius: 10, // km
        sortby: 'distance',
        sortascending: 'true',
      }),
    });

    if (!res.ok) {
      throw new Error(`FuelCheck API error: ${res.status}`);
    }

    const data = await res.json();
    if ((data as any).stations && (data as any).stations.length > 0) {
      // Find the nearest 7-Eleven, or fall back to nearest station
      const sevenEleven = (data as any).stations.find(
        (s: any) => s.brand?.toLowerCase().includes('7-eleven')
      );
      const station = sevenEleven || (data as any).stations[0];
      return {
        pricePerLitre: station.price / 10, // API returns tenths of cents → dollars
        stationName: station.name || station.brand || 'Unknown',
        stationAddress: station.address || '',
      };
    }

    return {
      pricePerLitre: FALLBACK_PRICE_PER_LITRE,
      stationName: 'No nearby stations found',
      stationAddress: '',
    };
  } catch (err) {
    console.error('Fuel API error:', err instanceof Error ? err.message : 'Unknown error');
    return {
      pricePerLitre: FALLBACK_PRICE_PER_LITRE,
      stationName: 'API unavailable',
      stationAddress: '',
    };
  }
}

async function getDrivingDistanceKm(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): Promise<number> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    // Haversine fallback
    return haversineKm(fromLat, fromLng, toLat, toLng);
  }

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    url.searchParams.set('origins', `${fromLat},${fromLng}`);
    url.searchParams.set('destinations', `${toLat},${toLng}`);
    url.searchParams.set('key', apiKey);
    const res = await fetch(url.toString());
    const data = await res.json();
    if ((data as any).rows?.[0]?.elements?.[0]?.distance?.value) {
      return (data as any).rows[0].elements[0].distance.value / 1000; // meters → km
    }
  } catch (err) {
    console.error('Distance Matrix error:', err instanceof Error ? err.message : 'Unknown error');
  }

  return haversineKm(fromLat, fromLng, toLat, toLng);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Get best price for each fuel type within radius ───
export async function getBestPricesByType(
  lat: number,
  lng: number,
  radiusKm: number = 15
): Promise<FuelPriceCard[]> {
  const apiKey = process.env.FUEL_API_KEY;
  if (!apiKey) return [];

  const results: FuelPriceCard[] = [];

  // Query each fuel type in parallel
  const fetches = FUEL_TYPES.map(async (fuelType) => {
    try {
      const res = await fetch(`${FUEL_API_BASE}/fuel/prices/nearby`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          fueltype: fuelType,
          latitude: lat,
          longitude: lng,
          radius: radiusKm,
          sortby: 'price',
          sortascending: 'true',
        }),
      });

      if (!res.ok) return null;

      const data = await res.json();
      const stations = (data as any).stations;
      if (!stations || stations.length === 0) return null;

      // Take the cheapest station
      const s = stations[0];
      const sLat = parseFloat(s.location?.latitude ?? s.latitude ?? lat);
      const sLng = parseFloat(s.location?.longitude ?? s.longitude ?? lng);

      return {
        fuelType,
        fuelLabel: FUEL_TYPE_LABELS[fuelType],
        pricePerLitre: s.price / 10, // API returns tenths of cents → dollars
        stationName: s.name || s.brand || 'Unknown',
        stationBrand: s.brand || '',
        stationAddress: s.address || '',
        stationLat: sLat,
        stationLng: sLng,
        distanceKm: parseFloat(haversineKm(lat, lng, sLat, sLng).toFixed(1)),
      } as FuelPriceCard;
    } catch (err) {
      console.error(`Fuel price error for ${fuelType}:`, err instanceof Error ? err.message : 'Unknown');
      return null;
    }
  });

  const settled = await Promise.all(fetches);
  for (const card of settled) {
    if (card) results.push(card);
  }

  // Sort by price ascending
  results.sort((a, b) => a.pricePerLitre - b.pricePerLitre);
  return results;
}

export async function calculateFuelCost(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): Promise<FuelCostResult> {
  const [distanceKm, fuelPrice] = await Promise.all([
    getDrivingDistanceKm(fromLat, fromLng, toLat, toLng),
    getNearestSupreme98Price(fromLat, fromLng),
  ]);

  const litresNeeded = (distanceKm / 100) * AVG_CONSUMPTION_L_PER_100KM;
  const fuelCost = parseFloat((litresNeeded * fuelPrice.pricePerLitre).toFixed(2));

  return {
    distanceKm: parseFloat(distanceKm.toFixed(1)),
    fuelCost,
    pricePerLitre: fuelPrice.pricePerLitre,
    stationName: fuelPrice.stationName,
  };
}

export { haversineKm };
