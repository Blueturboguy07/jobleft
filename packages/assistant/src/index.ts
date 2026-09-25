// @jobleft/assistant: the assistant (chat with tools over the person's own data), interview practice, the company facts
// panel, and the metered page fetch and web search client. Docs: docs/INTERFACES.md, section "@jobleft/assistant";
// how to run it: packages/assistant/README.md.

export const PACKAGE_NAME = '@jobleft/assistant';

export { Assistant, ApiFailure, MAX_ROUNDS, MAX_TOOL_CALLS, type AssistantOptions } from './assistant.ts';
export { createAssistantHandlers, ASSISTANT_ROUTES, type AssistantHandlers, type AssistantRouteName, type RouteInput } from './routes.ts';
export { openAssistantDb, migrateAssistant, ASSISTANT_OWNER, ASSISTANT_SCHEMA_VERSION } from './db.ts';
export { ChatStore } from './chats.ts';
export { UsageLedger, type UsageLine } from './usage.ts';
export { PracticeStore, planQuestions, rulesFeedback, verifySample, stripEmployerClaims, PRACTICE_LABEL } from './practice.ts';
export { Grounder, jobsNamedIn } from './grounding.ts';
export { ProposalBook, buildAction, type StoredAction } from './proposals.ts';
export { createToolbox, toolsFor, READ_TOOLS, WRITE_TOOL, PAID_TOOL, CHANGE_INTENT, WEB_INTENT, type TurnState, type ToolDeps } from './tools.ts';
export { createMeteredClient, MeteredError, METERED_PRICES, checkQuery, priceText, quote, type MeteredClient, type MeteredDeps } from './metered.ts';
export { createFreeReader, robotsAllows, htmlToText, hostMapFromEnv, USER_AGENT, type FreeReader } from './fetchfree.ts';
export { checkUrl, isPrivateAddress, blockedReason, looksLikeIp, type UrlCheck } from './urlsafe.ts';
export { buildCompanyPanel, runEnrichment, type CompanyPanel, type CompanyEnricher, type EnrichedFact, type PanelFact } from './company.ts';
export { Data, plainError, type DataApi } from './data.ts';
export { profileForModel } from './profileview.ts';
export { PRESETS, systemPrompt, type Preset } from './prompts.ts';
