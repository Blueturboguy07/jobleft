// The assistant reads and changes the person's records ONLY through the documented local API routes (docs/INTERFACES.md
// section 6.4). `DataApi` is the same `call(name, input)` shape as `createLocalApiClient()` in @jobleft/contracts, so
// the app server can pass an in-process client, the dev tools can pass an HTTP client for a running server, and the
// stand-in (standin/) can pass an in-memory one. Nothing here caches: every answer reads the record again.

import { LocalApiError, type JobDetail, type LocalApiClient, type MatchResult, type Profile, type RouteName } from '@jobleft/contracts';

export type DataApi = Pick<LocalApiClient, 'call'>;

/** A failure of a data call in plain words, for the tool result (never a stack trace). */
export function plainError(e: unknown): string {
  if (e instanceof LocalApiError) return e.body?.error.message ?? `The app answered HTTP ${e.status}.`;
  return 'The app could not read that record.';
}

export function statusOf(e: unknown): number | null {
  return e instanceof LocalApiError ? e.status : null;
}

export class Data {
  readonly api: DataApi;
  constructor(api: DataApi) { this.api = api; }

  /** null = no such job. */
  async job(jobId: string): Promise<JobDetail | null> {
    try { return await this.api.call('getJob', { params: { jobId } }); } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  /** null = no such job; 'needs_profile' = the person has no profile yet. */
  async match(jobId: string): Promise<MatchResult | null | 'needs_profile'> {
    try { return await this.api.call('getMatch', { params: { jobId } }); } catch (e) {
      if (statusOf(e) === 404) return null;
      if (statusOf(e) === 409) return 'needs_profile';
      throw e;
    }
  }

  async profile(): Promise<Profile | null> {
    try { return await this.api.call('getProfile'); } catch (e) {
      if (statusOf(e) === 404 || statusOf(e) === 409) return null;
      throw e;
    }
  }

  async call<K extends RouteName>(name: K, input?: Parameters<DataApi['call']>[1]): Promise<Awaited<ReturnType<DataApi['call']>>> {
    return this.api.call(name, input as never);
  }
}
