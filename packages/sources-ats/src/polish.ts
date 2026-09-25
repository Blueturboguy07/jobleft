// The last step every adapter of this lane passes through (the eight families, the crawler's three included):
//   * titles, company, place and department are one line of plain text with no control characters
//   * the description is plain text: every layer of escaping removed, all named entities decoded, no tags left
//     (whatever mix of live and escaped HTML the posting used), no terminal control characters
//   * pay written in European number style in the text is read here, because the crawler's reader would take
//     "45.000" for 45 and invent an hourly rate. An API pay is never replaced.

import type { HttpGetter, RawJob, Source } from '@jobleft/crawler';
import { cleanDescription, descriptionText, textField } from './util.ts';
import { parseEuropeanPay } from './pay-text.ts';

export function polishRaw(r: RawJob): RawJob {
  if (r.unreadable) return r;
  const text = descriptionText(r.descriptionHtml);
  const out: RawJob = {
    ...r,
    title: textField(r.title),
    company: textField(r.company),
    location: r.location.includes('; ') ? r.location.split('; ').map(textField).filter(Boolean).join('; ') : textField(r.location),
    department: textField(r.department),
    descriptionHtml: cleanDescription(r.descriptionHtml),
  };
  if (!out.pay) {
    const p = parseEuropeanPay(text);
    if (p) out.pay = p;
  }
  return out;
}

/** The same source, with every job it returns passed through `polishRaw`. */
export function polishSource(source: Source): Source {
  return {
    ...source,
    async fetchBoard(board, http: HttpGetter): Promise<RawJob[]> {
      return (await source.fetchBoard(board, http)).map(polishRaw);
    },
  };
}
