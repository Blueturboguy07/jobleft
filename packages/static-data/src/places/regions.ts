// US states and territories, Canadian provinces and territories, and common country names and codes.
// These are plain facts (USPS and Canada Post codes, ISO 3166-1 alpha-2 codes).

export const US_STATES: ReadonlyArray<readonly [code: string, name: string]> = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
  ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'],
  ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'],
  ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'], ['PR', 'Puerto Rico'], ['GU', 'Guam'],
  ['VI', 'U.S. Virgin Islands'], ['AS', 'American Samoa'], ['MP', 'Northern Mariana Islands'],
];

/** Old-style abbreviations people still write ("Calif.", "Mass.", "Penn."). */
export const US_STATE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  ala: 'AL', ariz: 'AZ', ark: 'AR', calif: 'CA', cal: 'CA', colo: 'CO', conn: 'CT', del: 'DE', fla: 'FL',
  ill: 'IL', ind: 'IN', kan: 'KS', kans: 'KS', ky: 'KY', mass: 'MA', mich: 'MI', minn: 'MN', miss: 'MS',
  mo: 'MO', mont: 'MT', neb: 'NE', nebr: 'NE', nev: 'NV', okla: 'OK', ore: 'OR', oreg: 'OR', penn: 'PA', penna: 'PA',
  tenn: 'TN', tex: 'TX', vt: 'VT', wash: 'WA', wis: 'WI', wisc: 'WI', wyo: 'WY', 'd c': 'DC', 'washington dc': 'DC',
};

export const CA_PROVINCES: ReadonlyArray<readonly [code: string, name: string]> = [
  ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
  ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'], ['NU', 'Nunavut'],
  ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'], ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
];

/** Extra country names and codes people write, beyond the names in the place data. Keys are normalized text. */
export const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  us: 'US', usa: 'US', 'u s': 'US', 'u s a': 'US', 'united states': 'US', 'united states of america': 'US', america: 'US',
  uk: 'GB', 'u k': 'GB', 'united kingdom': 'GB', 'great britain': 'GB', britain: 'GB', gb: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  uae: 'AE', 'united arab emirates': 'AE', 'south korea': 'KR', korea: 'KR', 'republic of korea': 'KR',
  'north korea': 'KP', czechia: 'CZ', 'czech republic': 'CZ', holland: 'NL', netherlands: 'NL', 'the netherlands': 'NL',
  russia: 'RU', 'russian federation': 'RU', vietnam: 'VN', 'viet nam': 'VN', taiwan: 'TW', 'hong kong': 'HK',
  macau: 'MO', macao: 'MO', turkey: 'TR', turkiye: 'TR', 'ivory coast': 'CI', "cote d'ivoire": 'CI', 'cote divoire': 'CI',
  'bosnia': 'BA', 'bosnia and herzegovina': 'BA', 'north macedonia': 'MK', macedonia: 'MK', 'dr congo': 'CD',
  'democratic republic of the congo': 'CD', 'republic of the congo': 'CG', 'eswatini': 'SZ', swaziland: 'SZ',
  'myanmar': 'MM', burma: 'MM', 'cape verde': 'CV', 'cabo verde': 'CV', 'east timor': 'TL', 'timor leste': 'TL',
  'vatican city': 'VA', 'palestine': 'PS', 'laos': 'LA', 'moldova': 'MD', 'iran': 'IR', 'syria': 'SY', 'brunei': 'BN',
  'tanzania': 'TZ', 'bolivia': 'BO', 'venezuela': 'VE', 'the bahamas': 'BS', bahamas: 'BS', 'the gambia': 'GM', gambia: 'GM',
  canada: 'CA', mexico: 'MX', india: 'IN', germany: 'DE', deutschland: 'DE', france: 'FR', spain: 'ES', espana: 'ES',
  italy: 'IT', ireland: 'IE', poland: 'PL', portugal: 'PT', brazil: 'BR', brasil: 'BR', argentina: 'AR', chile: 'CL',
  colombia: 'CO', peru: 'PE', japan: 'JP', china: 'CN', singapore: 'SG', australia: 'AU', 'new zealand': 'NZ',
  israel: 'IL', switzerland: 'CH', austria: 'AT', belgium: 'BE', sweden: 'SE', norway: 'NO', denmark: 'DK',
  finland: 'FI', estonia: 'EE', latvia: 'LV', lithuania: 'LT', ukraine: 'UA', romania: 'RO', bulgaria: 'BG',
  greece: 'GR', hungary: 'HU', serbia: 'RS', croatia: 'HR', slovakia: 'SK', slovenia: 'SI', philippines: 'PH',
  indonesia: 'ID', malaysia: 'MY', thailand: 'TH', pakistan: 'PK', bangladesh: 'BD', 'sri lanka': 'LK', nepal: 'NP',
  egypt: 'EG', nigeria: 'NG', kenya: 'KE', 'south africa': 'ZA', morocco: 'MA', ghana: 'GH', ethiopia: 'ET',
  'saudi arabia': 'SA', qatar: 'QA', kuwait: 'KW', bahrain: 'BH', oman: 'OM', jordan: 'JO', lebanon: 'LB',
  armenia: 'AM', azerbaijan: 'AZ', kazakhstan: 'KZ', uzbekistan: 'UZ', georgia: 'GE', 'costa rica': 'CR',
  'puerto rico': 'PR', uruguay: 'UY', paraguay: 'PY', ecuador: 'EC', guatemala: 'GT', panama: 'PA', luxembourg: 'LU',
  iceland: 'IS', malta: 'MT', cyprus: 'CY', 'dominican republic': 'DO', jamaica: 'JM', 'trinidad and tobago': 'TT',
};

/** Names that are a US state AND a country: they need the rest of the text to decide. */
export const STATE_COUNTRY_CLASHES: ReadonlySet<string> = new Set(['georgia']);
