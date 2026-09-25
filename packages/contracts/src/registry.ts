// Every top-level contract schema by name. scripts/gen-schemas.ts writes each one to schemas/<name>.schema.json,
// and test/schemas.test.ts checks that the files on disk match (so non-TypeScript readers see the same contract).

import {
  ActionProposalSchema, AiSettingsSchema, AiSettingsUpdateSchema, ChatMessageSchema, ChatRequestSchema, ChatStreamEventSchema,
  ChatThreadSchema, PracticeItemSchema, PracticeSessionSchema, ProviderCheckSchema,
} from './ai.ts';
import { ApiErrorSchema, AppSettingsSchema, HealthSchema, JobDetailSchema, TrackerListSchema } from './api.ts';
import { CompanySchema, H1bSummarySchema } from './company.ts';
import {
  DraftOfferSchema, DraftRequestSchema, DraftResponseSchema, ExtensionStatusSchema, FieldNoteSchema, FillRequestSchema,
  FillResponseSchema, FormFieldSchema, PageInfoRequestSchema, PageInfoSchema, PairingCodeSchema, PairingInfoSchema,
  PairRequestSchema, PairResponseSchema, ReviewResponseSchema, ReviewResultSchema,
} from './extension.ts';
import { JobFilterSchema, JobListItemSchema, JobSearchRequestSchema, JobSearchResponseSchema, SavedFilterSchema } from './filter.ts';
import { JobSchema, JobSummarySchema, PaySchema, PlaceSchema, SourceAttributionSchema } from './job.ts';
import {
  DealBreakerCheckSchema, ExperienceDetailSchema, JobFactViewSchema, MatchResultSchema, MatchSummarySchema, MustHaveSchema, SkillCheckSchema,
} from './match.ts';
import {
  CoffeeChatPlanEntrySchema, CompanyCoverageSchema, CompanyMatchExplanationSchema, ContactRankSchema, DraftPreviewSchema,
  NetworkCompanyGroupSchema, NetworkContactSchema, NetworkImportSummarySchema, OutreachDraftSchema,
} from './network.ts';
import { ProfileInputSchema, ProfileSchema } from './profile.ts';
import {
  AtsReportSchema, CoverLetterSchema, KeywordGapReportSchema, ResumeDocumentSchema, ResumeSchema, TailorProposalSchema,
} from './resume.ts';
import type { JsonSchema } from './schema.ts';
import {
  BoardEntrySchema, BoardResolveResponseSchema, CrawlBoardReportSchema, CrawlProgressSchema, DatasetInfoSchema,
  ExternalJobRequestSchema, FitIndexStatusSchema, H1bLookupSchema, NotificationSchema, PlaceLookupSchema, SourceInfoSchema,
  StorageInfoSchema,
} from './sources.ts';
import { TrackerEntrySchema, TrackerPatchSchema } from './tracker.ts';
import { PublikConnectionSchema, PublikWalletSchema } from './wallet.ts';

export const SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  // core records
  Job: JobSchema, JobSummary: JobSummarySchema, Pay: PaySchema, Place: PlaceSchema, SourceAttribution: SourceAttributionSchema,
  Company: CompanySchema, H1bSummary: H1bSummarySchema,
  Profile: ProfileSchema, ProfileInput: ProfileInputSchema,
  Resume: ResumeSchema, ResumeDocument: ResumeDocumentSchema, AtsReport: AtsReportSchema, KeywordGapReport: KeywordGapReportSchema,
  TailorProposal: TailorProposalSchema, CoverLetter: CoverLetterSchema,
  MatchResult: MatchResultSchema, MatchSummary: MatchSummarySchema,
  MustHave: MustHaveSchema, DealBreakerCheck: DealBreakerCheckSchema, JobFactView: JobFactViewSchema, SkillCheck: SkillCheckSchema,
  ExperienceDetail: ExperienceDetailSchema,
  TrackerEntry: TrackerEntrySchema, TrackerPatch: TrackerPatchSchema,
  NetworkContact: NetworkContactSchema, NetworkImportSummary: NetworkImportSummarySchema, ContactRank: ContactRankSchema,
  CompanyCoverage: CompanyCoverageSchema, OutreachDraft: OutreachDraftSchema, NetworkCompanyGroup: NetworkCompanyGroupSchema,
  CompanyMatchExplanation: CompanyMatchExplanationSchema, CoffeeChatPlanEntry: CoffeeChatPlanEntrySchema,
  DraftPreview: DraftPreviewSchema,
  PublikWallet: PublikWalletSchema, PublikConnection: PublikConnectionSchema,
  // search
  JobFilter: JobFilterSchema, JobSearchRequest: JobSearchRequestSchema, JobSearchResponse: JobSearchResponseSchema,
  JobListItem: JobListItemSchema, SavedFilter: SavedFilterSchema,
  // boards, sources, crawl, data
  BoardEntry: BoardEntrySchema, BoardResolveResponse: BoardResolveResponseSchema, SourceInfo: SourceInfoSchema,
  CrawlProgress: CrawlProgressSchema, CrawlBoardReport: CrawlBoardReportSchema, FitIndexStatus: FitIndexStatusSchema,
  DatasetInfo: DatasetInfoSchema, H1bLookup: H1bLookupSchema, PlaceLookup: PlaceLookupSchema, StorageInfo: StorageInfoSchema,
  ExternalJobRequest: ExternalJobRequestSchema, Notification: NotificationSchema,
  // AI
  AiSettings: AiSettingsSchema, AiSettingsUpdate: AiSettingsUpdateSchema, ProviderCheck: ProviderCheckSchema,
  ChatMessage: ChatMessageSchema, ChatRequest: ChatRequestSchema, ChatStreamEvent: ChatStreamEventSchema,
  ActionProposal: ActionProposalSchema, ChatThread: ChatThreadSchema, PracticeSession: PracticeSessionSchema,
  PracticeItem: PracticeItemSchema,
  // local API
  ApiError: ApiErrorSchema, Health: HealthSchema, JobDetail: JobDetailSchema, TrackerList: TrackerListSchema,
  AppSettings: AppSettingsSchema,
  // extension protocol
  PairingCode: PairingCodeSchema, PairingInfo: PairingInfoSchema, PairRequest: PairRequestSchema, PairResponse: PairResponseSchema,
  ExtensionStatus: ExtensionStatusSchema, FormField: FormFieldSchema, FillRequest: FillRequestSchema,
  FillResponse: FillResponseSchema, ReviewResult: ReviewResultSchema, ReviewResponse: ReviewResponseSchema,
  FieldNote: FieldNoteSchema, DraftOffer: DraftOfferSchema, PageInfoRequest: PageInfoRequestSchema, PageInfo: PageInfoSchema,
  DraftRequest: DraftRequestSchema, DraftResponse: DraftResponseSchema,
};

/** The JSON Schema file content for one schema: the draft, an id and the schema itself. */
export function schemaDocument(name: string): JsonSchema {
  const s = SCHEMAS[name];
  if (!s) throw new Error(`unknown schema: ${name}`);
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `urn:jobleft:contracts:${name}`, title: s.title ?? name, description: s.description, ...s };
}
