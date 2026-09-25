// Location helpers. Text heuristics only, as in the audit ("state code, United States, USA").
// The result is a share estimate, not a geocode. Plain "Remote" is unknown (null), never US.

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR',
]);

const US_STATE_NAME_RE = new RegExp(
  '\\b(' + [
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida',
    'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
    'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
    'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma',
    'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah',
    'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
  ].join('|') + ')\\b',
  'i',
);

// Places that are clearly not the US even when a token looks like a state code ("Toronto, ON, CA").
const NON_US = new RegExp(
  '\\b(canada|united kingdom|uk|england|scotland|ireland|germany|france|spain|italy|netherlands|india|australia|' +
  'new zealand|singapore|brazil|mexico|japan|china|israel|poland|portugal|sweden|norway|denmark|finland|' +
  'switzerland|austria|belgium|romania|ukraine|philippines|argentina|colombia|chile|uae|dubai|nigeria|kenya|' +
  'south africa|egypt|turkey|hong kong|taiwan|korea|indonesia|vietnam|thailand|malaysia|pakistan|bangladesh|' +
  'london|toronto|vancouver|montreal|ottawa|calgary|berlin|paris|dublin|sydney|melbourne|bengaluru|bangalore|' +
  'tel aviv|amsterdam|lisbon|madrid|barcelona|warsaw|krakow|emea|apac|latam)\\b',
  'i',
);

const US_WORD = /\b(united states( of america)?|u\.s\.a?\.?|usa)\b/i;
// A standalone upper-case "US" token: "Remote, US", "US-Remote", "(US)".
const US_TOKEN = /(?:^|[,\s(\-/|])US(?=$|[,\s)\-/|;])/;
// A state code after a comma (", TX", ", MA (Hybrid)"), in parentheses ("(TX)"), or before a ZIP ("TX 78701").
const STATE_CODE = /(?:,\s*|\()([A-Z]{2})\b|\b([A-Z]{2})\s+\d{5}\b/g;

export function isRemoteText(location: string): boolean {
  return /remote/i.test(location);
}

/** true = US, false = clearly elsewhere, null = cannot tell (e.g. "Remote", empty). */
export function isUsLocation(location: string, countries: string[] = []): boolean | null {
  if (countries.length > 0) return countries.some((c) => c.toUpperCase() === 'US');
  const loc = (location ?? '').trim();
  if (!loc) return null;
  if (US_WORD.test(loc) || US_TOKEN.test(loc)) return true;
  const nonUs = NON_US.test(loc);
  if (US_STATE_NAME_RE.test(loc)) return !nonUs;
  STATE_CODE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATE_CODE.exec(loc)) !== null) {
    if (US_STATES.has(m[1] ?? m[2])) return !nonUs; // "CA" also means Canada, so a named non-US place vetoes it
  }
  if (nonUs) return false;
  return null;
}
