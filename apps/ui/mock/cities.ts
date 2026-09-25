// A small place table for the mock (the real one is @jobleft/static-data, from GeoNames).
// Coordinates are approximate city centres; they are public geographic facts.

export interface City {
  id: string;
  city: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
}

export const CITIES: readonly City[] = [
  { id: 'us-austin-tx', city: 'Austin', region: 'TX', country: 'US', lat: 30.267, lon: -97.743 },
  { id: 'us-round-rock-tx', city: 'Round Rock', region: 'TX', country: 'US', lat: 30.508, lon: -97.679 },
  { id: 'us-dallas-tx', city: 'Dallas', region: 'TX', country: 'US', lat: 32.777, lon: -96.797 },
  { id: 'us-houston-tx', city: 'Houston', region: 'TX', country: 'US', lat: 29.760, lon: -95.370 },
  { id: 'us-new-york-ny', city: 'New York', region: 'NY', country: 'US', lat: 40.713, lon: -74.006 },
  { id: 'us-jersey-city-nj', city: 'Jersey City', region: 'NJ', country: 'US', lat: 40.728, lon: -74.078 },
  { id: 'us-boston-ma', city: 'Boston', region: 'MA', country: 'US', lat: 42.360, lon: -71.059 },
  { id: 'us-cambridge-ma', city: 'Cambridge', region: 'MA', country: 'US', lat: 42.374, lon: -71.106 },
  { id: 'us-san-francisco-ca', city: 'San Francisco', region: 'CA', country: 'US', lat: 37.775, lon: -122.419 },
  { id: 'us-oakland-ca', city: 'Oakland', region: 'CA', country: 'US', lat: 37.804, lon: -122.271 },
  { id: 'us-san-jose-ca', city: 'San Jose', region: 'CA', country: 'US', lat: 37.338, lon: -121.886 },
  { id: 'us-los-angeles-ca', city: 'Los Angeles', region: 'CA', country: 'US', lat: 34.052, lon: -118.244 },
  { id: 'us-san-diego-ca', city: 'San Diego', region: 'CA', country: 'US', lat: 32.716, lon: -117.161 },
  { id: 'us-seattle-wa', city: 'Seattle', region: 'WA', country: 'US', lat: 47.606, lon: -122.332 },
  { id: 'us-bellevue-wa', city: 'Bellevue', region: 'WA', country: 'US', lat: 47.610, lon: -122.201 },
  { id: 'us-portland-or', city: 'Portland', region: 'OR', country: 'US', lat: 45.515, lon: -122.679 },
  { id: 'us-portland-me', city: 'Portland', region: 'ME', country: 'US', lat: 43.661, lon: -70.255 },
  { id: 'us-denver-co', city: 'Denver', region: 'CO', country: 'US', lat: 39.739, lon: -104.990 },
  { id: 'us-chicago-il', city: 'Chicago', region: 'IL', country: 'US', lat: 41.878, lon: -87.630 },
  { id: 'us-atlanta-ga', city: 'Atlanta', region: 'GA', country: 'US', lat: 33.749, lon: -84.388 },
  { id: 'us-miami-fl', city: 'Miami', region: 'FL', country: 'US', lat: 25.762, lon: -80.192 },
  { id: 'us-raleigh-nc', city: 'Raleigh', region: 'NC', country: 'US', lat: 35.780, lon: -78.638 },
  { id: 'us-nashville-tn', city: 'Nashville', region: 'TN', country: 'US', lat: 36.163, lon: -86.781 },
  { id: 'us-phoenix-az', city: 'Phoenix', region: 'AZ', country: 'US', lat: 33.448, lon: -112.074 },
  { id: 'us-salt-lake-city-ut', city: 'Salt Lake City', region: 'UT', country: 'US', lat: 40.761, lon: -111.891 },
  { id: 'us-minneapolis-mn', city: 'Minneapolis', region: 'MN', country: 'US', lat: 44.978, lon: -93.265 },
  { id: 'us-pittsburgh-pa', city: 'Pittsburgh', region: 'PA', country: 'US', lat: 40.441, lon: -79.996 },
  { id: 'us-philadelphia-pa', city: 'Philadelphia', region: 'PA', country: 'US', lat: 39.953, lon: -75.165 },
  { id: 'us-washington-dc', city: 'Washington', region: 'DC', country: 'US', lat: 38.907, lon: -77.037 },
  { id: 'us-arlington-va', city: 'Arlington', region: 'VA', country: 'US', lat: 38.880, lon: -77.107 },
  { id: 'us-columbus-oh', city: 'Columbus', region: 'OH', country: 'US', lat: 39.961, lon: -82.999 },
  { id: 'us-detroit-mi', city: 'Detroit', region: 'MI', country: 'US', lat: 42.331, lon: -83.046 },
  { id: 'ca-toronto-on', city: 'Toronto', region: 'ON', country: 'CA', lat: 43.653, lon: -79.383 },
  { id: 'ca-vancouver-bc', city: 'Vancouver', region: 'BC', country: 'CA', lat: 49.283, lon: -123.121 },
  { id: 'gb-london', city: 'London', region: 'England', country: 'GB', lat: 51.507, lon: -0.128 },
  { id: 'ie-dublin', city: 'Dublin', region: 'Leinster', country: 'IE', lat: 53.350, lon: -6.260 },
  { id: 'de-berlin', city: 'Berlin', region: 'Berlin', country: 'DE', lat: 52.520, lon: 13.405 },
];

export const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  US: 'United States', CA: 'Canada', GB: 'United Kingdom', IE: 'Ireland', DE: 'Germany', AU: 'Australia', NZ: 'New Zealand',
};

export function cityById(id: string): City | undefined {
  return CITIES.find((c) => c.id === id);
}

/** The text of a city as a posting writes it: "Austin, TX" (US and Canada) or "London, United Kingdom". */
export function cityText(c: City): string {
  if (c.country === 'US' || c.country === 'CA') return `${c.city}, ${c.region}`;
  return `${c.city}, ${COUNTRY_NAMES[c.country] ?? c.country}`;
}

const STATE_NAMES: Readonly<Record<string, string>> = {
  TX: 'Texas', NY: 'New York', NJ: 'New Jersey', MA: 'Massachusetts', CA: 'California', WA: 'Washington', OR: 'Oregon',
  ME: 'Maine', CO: 'Colorado', IL: 'Illinois', GA: 'Georgia', FL: 'Florida', NC: 'North Carolina', TN: 'Tennessee',
  AZ: 'Arizona', UT: 'Utah', MN: 'Minnesota', PA: 'Pennsylvania', DC: 'District of Columbia', VA: 'Virginia', OH: 'Ohio',
  MI: 'Michigan', ON: 'Ontario', BC: 'British Columbia',
};

/** Resolves free text ("Austin, TX", "austin", "Portland") to cities. Several answers = ambiguous. */
export function resolveCity(text: string): City[] {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return [];
  const [cityPart, regionPart] = t.split(',').map((x) => x.trim());
  return CITIES.filter((c) => {
    if (c.city.toLowerCase() !== cityPart) return false;
    if (!regionPart) return true;
    const r = regionPart.toLowerCase();
    return c.region.toLowerCase() === r || (STATE_NAMES[c.region] ?? '').toLowerCase() === r
      || (COUNTRY_NAMES[c.country] ?? '').toLowerCase() === r || c.country.toLowerCase() === r;
  });
}

/** Great-circle distance in miles. */
export function distanceMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
