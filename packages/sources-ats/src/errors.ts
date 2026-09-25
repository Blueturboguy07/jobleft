// Errors with one plain sentence each. The crawler records `${name}: ${message}` for a failed board, so the
// message is what a person reads in the crawl report.

/** The board answered, but not with the feed we asked for (HTML page, renamed list field, cut-off XML...). */
export class FeedFormatError extends Error {
  readonly url: string;
  constructor(url: string, message: string) {
    super(message);
    this.name = 'FeedFormatError';
    this.url = url;
  }
}

/** A paged feed did not end properly (the next page repeats, or the page cap was reached). */
export class PagingError extends Error {
  readonly url: string;
  constructor(url: string, message: string) {
    super(message);
    this.name = 'PagingError';
    this.url = url;
  }
}

/** The board token is not a plain slug. Nothing was sent: a token like "evil.com/x?" could point a request elsewhere. */
export class BoardTokenError extends Error {
  constructor(ats: string, board: string) {
    super(`"${board}" is not a valid ${ats} board name (letters, digits and dashes only); nothing was sent`);
    this.name = 'BoardTokenError';
  }
}

/** The vendor refused the request in a way that needs a person (for example a new token rule). */
export class SourceChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceChangedError';
  }
}
