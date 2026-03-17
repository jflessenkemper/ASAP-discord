// Fuel pricing service — uses NSW FuelCheck API or fallback
// NSW FuelCheck: https://api.onegov.nsw.gov.au/FuelCheckApp/v2/fuel/prices

const FUEL_API_BASE = 'https://api.onegov.nsw.gov.au/FuelCheckApp/v2';
const AVG_CONSUMPTION_L_PER_100KM = parseFloat(process.env.FUEL_CONSUMPTION_L_PER_100KM || '10');
const FALLBACK_PRICE_PER_LITRE = 2.30; // AUD, reasonable Supreme 98 fallback

interface FuelPrice {
  pricePerLitre: number;
  stationName: string;
  stationAddress: string;
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
