// Country, US state and Canadian province names, for strict option matching.
// "Strict" means the same place under another spelling ("TX" = "Texas", "US" = "United States of America"),
// never a near place ("United States Minor Outlying Islands", "Austin, MN").

import { norm } from './text.ts';

/** Other names a country goes by on forms. Keys are ISO 3166-1 alpha-2 codes. */
const COUNTRY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  US: ['united states', 'united states of america', 'usa', 'us'],
  GB: ['united kingdom', 'uk', 'great britain', 'united kingdom of great britain and northern ireland'],
  KR: ['south korea', 'korea, republic of', 'republic of korea', 'korea (south)', 'korea, south'],
  KP: ['north korea', "korea, democratic people's republic of", 'korea (north)'],
  RU: ['russia', 'russian federation'],
  VN: ['vietnam', 'viet nam'],
  IR: ['iran', 'iran, islamic republic of'],
  SY: ['syria', 'syrian arab republic'],
  LA: ['laos', "lao people's democratic republic"],
  BO: ['bolivia', 'bolivia, plurinational state of'],
  VE: ['venezuela', 'venezuela, bolivarian republic of'],
  TZ: ['tanzania', 'tanzania, united republic of'],
  MD: ['moldova', 'moldova, republic of'],
  CZ: ['czechia', 'czech republic'],
  TR: ['turkey', 'turkiye', 'türkiye'],
  CI: ["cote d'ivoire", 'ivory coast'],
  CD: ['congo, democratic republic of the', 'democratic republic of the congo', 'congo (kinshasa)', 'dr congo'],
  CG: ['congo', 'republic of the congo', 'congo (brazzaville)'],
  MK: ['north macedonia', 'macedonia'],
  SZ: ['eswatini', 'swaziland'],
  MM: ['myanmar', 'burma', 'myanmar (burma)'],
  TW: ['taiwan'],
  HK: ['hong kong', 'hong kong sar china', 'hong kong sar'],
  MO: ['macao', 'macau', 'macao sar china'],
  PS: ['palestine', 'palestinian territories', 'palestine, state of'],
  AE: ['united arab emirates', 'uae'],
  NL: ['netherlands', 'the netherlands', 'holland'],
  BS: ['bahamas', 'the bahamas'],
  GM: ['gambia', 'the gambia'],
  VA: ['vatican city', 'holy see'],
  FM: ['micronesia', 'micronesia, federated states of'],
  CV: ['cape verde', 'cabo verde'],
  TL: ['timor-leste', 'east timor'],
};

/**
 * Place comparison form: norm() without dots, brackets or a trailing dial code, so "U.S.A." = "usa" and
 * "United States (+1)" = "united states".
 */
export function pn(s: string | null | undefined): string {
  return norm(s)
    .replace(/^[^a-z0-9]+/, '')
    .replace(/\(\s*\+?\d[\d\s-]*\)\s*$/, '')
    .replace(/\s\+\d[\d\s-]*$/, '')
    .replace(/\./g, '')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let displayNames: Intl.DisplayNames | null = null;
function regionName(code: string): string | null {
  try {
    displayNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    const n = displayNames.of(code);
    return n && n !== code ? n : null;
  } catch {
    return null;
  }
}

/** Every accepted normalized name of a country code (empty for an unknown code). */
export function countryNames(code: string): Set<string> {
  const c = code.toUpperCase();
  const out = new Set<string>();
  if (!/^[A-Z]{2}$/.test(c)) return out;
  const canonical = regionName(c);
  if (!canonical) return out;
  out.add(pn(canonical));
  for (const a of COUNTRY_ALIASES[c] ?? []) out.add(pn(a));
  out.add(c.toLowerCase());
  return out;
}

/** The English name to type into a free-text country box. */
export function countryDisplayName(code: string): string | null {
  const c = code.toUpperCase();
  if (c === 'US') return 'United States';
  if (c === 'GB') return 'United Kingdom';
  return regionName(c);
}

/** A country code from a name or code the person typed, or null. */
export function countryCodeOf(text: string): string | null {
  const t = pn(text);
  if (!t) return null;
  if (/^[a-z]{2}$/.test(t) && regionName(t.toUpperCase())) return t.toUpperCase();
  for (const [code, names] of Object.entries(COUNTRY_ALIASES)) if (names.some((n) => pn(n) === t)) return code;
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const n = regionName(code);
      if (n && pn(n) === t) return code;
    }
  }
  return null;
}

const US_STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};

const CA_PROVINCES: Readonly<Record<string, string>> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};

function regionTable(country: string | null): Readonly<Record<string, string>> | null {
  if (country === 'US') return US_STATES;
  if (country === 'CA') return CA_PROVINCES;
  return null;
}

/**
 * Every accepted normalized name of a region (state or province). With a known country, "TX" and "Texas" are the
 * same region. Without one, only the text itself is accepted.
 */
export function regionNames(region: string, country: string | null): Set<string> {
  const out = new Set<string>();
  const r = pn(region);
  if (!r) return out;
  out.add(r);
  const table = regionTable(country ? country.toUpperCase() : null);
  if (table) {
    for (const [code, name] of Object.entries(table)) {
      if (pn(code) === r || pn(name) === r) {
        out.add(pn(code));
        out.add(pn(name));
      }
    }
  }
  return out;
}

/** The full region name ("Texas" for "TX" in the US), or the text itself. */
export function regionDisplayName(region: string, country: string | null): string {
  const table = regionTable(country ? country.toUpperCase() : null);
  if (table) {
    const hit = Object.entries(table).find(([code, name]) => pn(code) === pn(region) || pn(name) === pn(region));
    if (hit) return hit[1];
  }
  return region;
}
