import type { Answer, Result, Sources, Storage } from './app.contract.d.ts';
import {
  addResultEntry,
  createExperiment,
  deleteResultEntry,
  updateResultNotes,
  deleteExperiment,
  listExperiments,
  resetExperiments,
  updateExperiment,
  updateExperimentStatus,
  ResultError,
  type ExperimentFields,
  type ExperimentRecord,
  type Storage as StoreStorage,
} from './experiment-store.ts';

// Records live in one file through experiment-store.ts, which runs every operation one at a
// time and reads each write back: a reply says ok only when the file holds the change.
const FILE = 'app:/data/experiments.json'; // experiment-store.ts's EXPERIMENT_FS_PATH
export const grants = [`fs.read ${FILE}`, `fs.write ${FILE}`].join('\n');

const files = (storage: Storage) => storage as unknown as StoreStorage;

// Dates are pinned to en-US and UTC so the text is the same on every host.
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  });
const resultStamp = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  });
const isoAt = (ms: number) => new Date(ms).toISOString();

function view(r: ExperimentRecord): Result<'experiments'>[number] {
  const latest = r.resultEntries[0];
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    hypothesis: r.hypothesis,
    procedure: r.procedure,
    dataPlan: r.dataPlan,
    observationsText: r.observationsNotes,
    notes: r.notes,
    conclusion: r.conclusionNotes,
    planned: r.plannedAttachmentCount,
    status: r.status,
    complete: r.status === 'complete',
    meta: `${r.category} - Updated ${day(r.updatedAt)}`,
    badge: r.status.toUpperCase(),
    observations: r.observationsNotes || 'No observations recorded yet.',
    results: latest
      ? `${r.resultEntries.length} ${r.resultEntries.length === 1 ? 'entry' : 'entries'} - Latest ${stamp(latest.recordedAt)}: ${latest.notes || 'Photos only'}`
      : 'No result entries yet.',
    entryCount: r.resultEntries.length === 1 ? '1 timestamped entry' : `${r.resultEntries.length} timestamped entries`,
    entries: r.resultEntries.map((e) => ({
      id: e.id,
      stamp: resultStamp(e.recordedAt),
      notes: e.notes,
      photos: e.photoAssets.length,
    })),
    plannedLabel: `Planned photos: ${r.plannedAttachmentCount}`,
    conclusionLabel: `Conclusion: ${r.conclusionNotes ? 'Ready' : 'Open'}`,
  };
}

type Fields = [string, string, string, string, string, string, string, string, number];

const fieldsOf = ([title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned]: Fields): ExperimentFields => ({
  title,
  category,
  hypothesis,
  procedure,
  dataPlan,
  observationsNotes: observations,
  notes,
  conclusionNotes: conclusion,
  plannedAttachmentCount: planned,
});

const ok = (id: string): Result<'createExperimentRecord'> => ({ ok: true, id, error: '' });
const refused = (id: string, error: string): Result<'createExperimentRecord'> => ({ ok: false, id, error });
const failure = (id: string, e: unknown): Result<'createExperimentRecord'> =>
  refused(id, `Could not save to storage: ${e instanceof Error ? e.message : String(e)}`);

const gone = 'This experiment no longer exists.';

const sources: Sources = {
  experiments: async (_args, _store, storage): Promise<Result<'experiments'>> =>
    (await listExperiments(files(storage))).map(view),

  createExperimentRecord: async (
    [id, ms, title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned],
    _store,
    storage,
  ): Promise<Result<'createExperimentRecord'>> => {
    if (title.trim() === '' || hypothesis.trim() === '' || procedure.trim() === '') {
      return refused('', 'Title, hypothesis and procedure are required.');
    }
    try {
      const fields = fieldsOf([title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned]);
      await createExperiment(fields, files(storage), { id, now: isoAt(ms) });
      return ok(id);
    } catch (e) {
      return failure('', e);
    }
  },

  saveExperimentRecord: async (
    [id, ms, title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned],
    _store,
    storage,
  ): Promise<Result<'saveExperimentRecord'>> => {
    if (title.trim() === '' || hypothesis.trim() === '') {
      return refused(id, 'Title and hypothesis are required to save changes.');
    }
    try {
      const fields = fieldsOf([title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned]);
      const saved = await updateExperiment(id, fields, files(storage), { now: isoAt(ms) });
      return saved ? ok(id) : refused(id, gone);
    } catch (e) {
      return failure(id, e);
    }
  },

  setExperimentStatus: async ([id, ms, status], _store, storage): Promise<Result<'setExperimentStatus'>> => {
    try {
      const saved = await updateExperimentStatus(id, status === 'complete' ? 'complete' : 'active', files(storage), { now: isoAt(ms) });
      return saved ? ok(id) : refused(id, gone);
    } catch (e) {
      return failure(id, e);
    }
  },

  addResultRecord: async ([id, resultId, ms, notes], _store, storage): Promise<Result<'addResultRecord'>> => {
    if (notes.trim() === '') return refused(resultId, 'Write some result notes before saving.');
    try {
      const saved = await addResultEntry(id, { id: resultId, recordedAt: isoAt(ms), notes }, files(storage), { now: isoAt(ms) });
      return saved ? ok(resultId) : refused(resultId, gone);
    } catch (e) {
      return e instanceof ResultError ? refused(resultId, e.message) : failure(resultId, e);
    }
  },

  editResultRecord: async ([id, resultId, ms, notes], _store, storage): Promise<Result<'editResultRecord'>> => {
    try {
      const saved = await updateResultNotes(id, resultId, notes, files(storage), { now: isoAt(ms) });
      return saved ? ok(resultId) : refused(resultId, gone);
    } catch (e) {
      return e instanceof ResultError ? refused(resultId, e.message) : failure(resultId, e);
    }
  },

  removeResultRecord: async ([id, resultId, ms], _store, storage): Promise<Result<'removeResultRecord'>> => {
    try {
      const saved = await deleteResultEntry(id, resultId, files(storage), { now: isoAt(ms) });
      return saved ? ok(resultId) : refused(resultId, gone);
    } catch (e) {
      return e instanceof ResultError ? refused(resultId, e.message) : failure(resultId, e);
    }
  },

  deleteExperimentRecord: async ([id], _store, storage): Promise<Result<'deleteExperimentRecord'>> => {
    try {
      await deleteExperiment(id, files(storage));
      return ok(id);
    } catch (e) {
      return failure(id, e);
    }
  },

  resetExperimentRecords: async (_args, _store, storage): Promise<Result<'resetExperimentRecords'>> => {
    try {
      await resetExperiments(files(storage));
      return ok('');
    } catch (e) {
      return failure('', e);
    }
  },
};
export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
