// Compact storage of job records. Each record is JSON, compressed with zstd (built into Node) and a small raw
// dictionary of words that job postings repeat. The first byte names the format so old rows always stay readable.
//   0x00 = plain UTF-8 JSON   0x01 = zstd   0x02 = zstd with DICT_V1
// DICT_V1 must never change once rows use it. A better dictionary gets a new format byte.

import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';

const DICT_V1 = Buffer.from([
  '{"id":"","status":"open","closedAt":null,"closedReason":null,"title":"","company":"","companyKey":"","ats":"greenhouse",',
  '"board":"","externalId":"","url":"https://","applyUrl":null,"canonicalUrl":"https://","places":[{"text":"","city":"",',
  '"region":"","country":"US","placeId":null}],"isUs":true,"workModel":"hybrid","remoteScope":null,"employmentType":"full_time",',
  '"level":"senior","levels":["senior"],"yearsRequired":{"min":3,"max":null},"pay":{"min":0,"max":0,"currency":"USD",',
  '"period":"year","source":"board_field","ranges":1,"annualMin":0,"annualMax":0},"postedAt":"2026-","firstSeenAt":"2026-",',
  '"lastSeenAt":"2026-","updatedAt":"2026-","department":null,"statements":{"sponsorship":null,"clearanceRequired":null,',
  '"usCitizenOnly":null},"skills":[],"evidence":{},"sources":[{"sourceId":"ats:greenhouse","name":" careers (Greenhouse)",',
  '"url":"https://boards.greenhouse.io/","credit":null,"firstSeenAt":"","lastSeenAt":""}],"duplicateOf":null,"contentHash":"",',
  '"description":"',
  'About the role. About us. What you will do. What you\'ll do: Responsibilities include: Requirements: Qualifications: ',
  'Preferred qualifications: Minimum qualifications: Basic qualifications: Nice to have: Who you are: ',
  'We are looking for a motivated and detail-oriented team member to join our growing team. ',
  'You will work closely with cross-functional teams, stakeholders and leadership to deliver high quality results. ',
  'Bachelor\'s degree in a related field or equivalent practical experience. years of experience in a similar role. ',
  'Strong written and verbal communication skills. Excellent problem-solving and analytical skills. ',
  'Ability to work independently and as part of a team in a fast-paced environment. ',
  'Benefits: competitive salary, medical, dental and vision insurance, 401(k) with company match, paid time off, ',
  'parental leave, flexible work arrangements, professional development, equity, wellness stipend. ',
  'The base salary range for this position is $ per year. The hourly pay range is $ per hour. ',
  'Compensation may vary based on location, skills and experience. This role is eligible for a bonus. ',
  'We are an equal opportunity employer and value diversity. All qualified applicants will receive consideration for ',
  'employment without regard to race, color, religion, sex, sexual orientation, gender identity, national origin, ',
  'disability, protected veteran status, or any other characteristic protected by law. ',
  'We provide reasonable accommodations to individuals with disabilities. This position is remote in the United States. ',
  'This is a hybrid role based in our office. Visa sponsorship is not available for this position. ',
  'Must be authorized to work in the United States. Security clearance required. Manage, develop, design, build, ',
  'support, analyze, coordinate, lead, own, drive, improve, maintain, ensure, collaborate, customer, product, ',
  'engineering, operations, sales, marketing, finance, data, software, systems, process, project, quality, ',
].join(''), 'utf8');

const LEVEL = 1;

/** Encodes a record as compact bytes. */
export function encodeRecord(value: unknown): Uint8Array {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  const packed = zstdCompressSync(json, {
    dictionary: DICT_V1,
    params: { [constants.ZSTD_c_compressionLevel]: LEVEL, [constants.ZSTD_c_checksumFlag]: 1 },
  } as Parameters<typeof zstdCompressSync>[1]);
  if (packed.byteLength + 1 >= json.byteLength + 1) {
    const out = new Uint8Array(json.byteLength + 1);
    out[0] = 0x00;
    out.set(json, 1);
    return out;
  }
  const out = new Uint8Array(packed.byteLength + 1);
  out[0] = 0x02;
  out.set(packed, 1);
  return out;
}

/** Decodes bytes written by encodeRecord. Throws on damaged bytes (zstd checks its own checksum). */
export function decodeRecord<T>(bytes: Uint8Array): T {
  const kind = bytes[0];
  const body = Buffer.from(bytes.buffer, bytes.byteOffset + 1, bytes.byteLength - 1);
  let json: Buffer;
  if (kind === 0x00) json = body;
  else if (kind === 0x01) json = zstdDecompressSync(body);
  else if (kind === 0x02) json = zstdDecompressSync(body, { dictionary: DICT_V1 } as Parameters<typeof zstdDecompressSync>[1]);
  else throw new Error(`unknown record format ${kind}`);
  return JSON.parse(json.toString('utf8')) as T;
}
