// @jobleft/store: the one SQLite database of the app ($JOBLEFT_HOME/data/jobleft.db, node:sqlite, WAL, 16 KB pages).
//   * opens the file safely (mode 0600, WAL) and runs the store's migrations
//   * keeps its own copy of every posting (store_jobs) with dedupe keys, a contentless FTS5 word index and float16
//     fit vectors; upsert, close and complete-listing refresh APIs for the crawler and importers
//   * job search: words + every filter + three sorts, true totals, stable cursors (spike S2 method)
//   * fit indexing: bge-small-en-v1.5 fp32 on ONNX Runtime (CPU), embed queue, never re-embeds unchanged text
//   * the person's records: tracker, saved filters, profile, chats, notifications, app settings
// Interface: docs/INTERFACES.md, section "@jobleft/store". Commands: packages/store/README.md.

export const PACKAGE_NAME = '@jobleft/store';

export { openDatabase, migrate, tx, StoreError, STORE_SCHEMA_VERSION, storeVersion, type OpenOptions } from './db.ts';
export { JobStore, crawlRowToInput, type SearchContext, type ImportResult } from './jobstore.ts';
export { FitIndex, profileTextOf, priorityFilterOf, type FitIndexOptions, type ModelInfo } from './fit.ts';
export {
  TrackerStore, FilterStore, ProfileStore, ChatStore, NotificationStore, SettingsStore, DEFAULT_SETTINGS, emptyProfileInput,
  canonicalJobId,
} from './userdata.ts';
export { type CompanyInput, type UpsertStats } from './writer.ts';
export { normalizeInput, companyKeyOf, embedTextOf, EMBED_RECIPE } from './record.ts';
export { parseQuery, rewriteSpecialTokens, localCompanyKey } from './text.ts';
export { SynthGenerator, type SynthCompany } from './synth.ts';
export {
  MODEL_ID, MODEL_DIMS, MODEL_REVISION, MODEL_FILES, MODEL_TOTAL_BYTES, DEFAULT_MODEL_BASE_URL, MODEL_FOLDER,
  checkModel, ensureModel, defaultModelSource, modelDirIn, type ModelFile, type ModelSource,
} from './embed/model.ts';
export { createBgeEmbedder, type LocalEmbedder } from './embed/onnx.ts';

/** The contract job id of a crawled posting: "<ats>:<board>:<externalId>", lower-case ATS and board. */
export function makeJobId(ats: string, board: string, externalId: string): string {
  return `${ats.toLowerCase()}:${board.toLowerCase()}:${externalId}`;
}
