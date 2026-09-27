// TrackerEntry: the user's own state on one job: liked, hidden ("not interested"), external, the
// application status (Applied, Interviewing, Offer Received, Rejected, Archived), notes and reminders.
// A tracker entry outlives its job posting: a closed job keeps its entry and its details.

import { IdSchema, IsoDateTimeSchema } from './common.ts';
import { arr, bool, enm, named, nullable, obj, str, type Infer } from './schema.ts';

export const TRACKER_STATUSES = ['applied', 'interviewing', 'offer_received', 'rejected', 'archived'] as const;
export const TrackerStatusSchema = enm(TRACKER_STATUSES);
export const TRACKER_STATUS_LABELS = {
  applied: 'Applied', interviewing: 'Interviewing', offer_received: 'Offer Received', rejected: 'Rejected', archived: 'Archived',
} as const;

/**
 * The tabs and views of the tracker. closed = liked or tracked jobs whose posting closed. tracked (added by the
 * tracker fix, additive) = every job that holds something the person did: a like, a status, an applied date, a note
 * or a reminder. The tracker board reads it, so a job never drops out of every view while it holds notes or reminders.
 */
export const TrackerViewSchema = enm(['liked', 'applied', 'external', 'hidden', 'closed', 'tracked']);

export const TrackerNoteSchema = named(obj({
  id: IdSchema, text: str({ maxLength: 20000 }), createdAt: IsoDateTimeSchema, updatedAt: IsoDateTimeSchema,
}), 'TrackerNote');

export const ReminderSchema = named(obj({
  id: IdSchema, at: IsoDateTimeSchema, text: str({ maxLength: 500 }), done: bool(),
}), 'Reminder');

export const TrackerEntrySchema = named(obj({
  jobId: IdSchema,
  liked: bool(),
  /** "Not interested": the job never shows in results until the user undoes it. */
  hidden: bool(),
  /** Added by the user from a URL or pasted text (the External tab). */
  external: bool(),
  /** null = not applied (for example only liked). */
  status: nullable(TrackerStatusSchema),
  statusHistory: arr(obj({ status: nullable(TrackerStatusSchema), at: IsoDateTimeSchema })),
  appliedAt: nullable(IsoDateTimeSchema),
  /** The resume version sent, when known. */
  resumeId: nullable(IdSchema),
  notes: arr(TrackerNoteSchema),
  reminders: arr(ReminderSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}), 'TrackerEntry', "The user's own state on one job");

/** A change to a tracker entry. Absent keys stay as they are. `notes` and `reminders` replace the whole list. */
export const TrackerPatchSchema = named(obj({}, {
  liked: bool(),
  hidden: bool(),
  status: nullable(TrackerStatusSchema),
  resumeId: nullable(IdSchema),
  notes: arr(obj({ text: str({ maxLength: 20000 }) }, { id: IdSchema })),
  reminders: arr(obj({ at: IsoDateTimeSchema, text: str({ maxLength: 500 }), done: bool() }, { id: IdSchema })),
}), 'TrackerPatch');

export type TrackerStatus = Infer<typeof TrackerStatusSchema>;
export type TrackerView = Infer<typeof TrackerViewSchema>;
export type TrackerNote = Infer<typeof TrackerNoteSchema>;
export type Reminder = Infer<typeof ReminderSchema>;
export type TrackerEntry = Infer<typeof TrackerEntrySchema>;
export type TrackerPatch = Infer<typeof TrackerPatchSchema>;
