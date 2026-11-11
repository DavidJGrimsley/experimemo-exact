/**
 * Experiment records for the Experimemo Exact app: the reference models, the two original example
 * records, and a file store whose every failure throws.
 *
 * This stands in for experiment-data.ts, which Exact refuses to build today (it names
 * Date.now() and new Date() in data-source code) and which falls back to memory on a storage
 * failure. app.ts imports only through this file; when experiment-data.ts is fixed, the swap
 * is this one import. Same shapes and seed values as experiment-data.ts (7334426).
 */

export type ExperimentStatus = 'active' | 'complete';

export interface ExperimentPhotoAsset {
  id: string;
  uri: string;
  fileName: string | null;
  mimeType: string | null;
  width: number;
  height: number;
}

export interface ExperimentResultEntry {
  id: string;
  recordedAt: string;
  notes: string;
  photoAssets: ExperimentPhotoAsset[];
}

export interface ExperimentRecord {
  id: string;
  title: string;
  category: string;
  hypothesis: string;
  procedure: string;
  dataPlan: string;
  observationsNotes: string;
  resultEntries: ExperimentResultEntry[];
  notes: string;
  conclusionNotes: string;
  plannedAttachmentCount: number;
  photoAssets: ExperimentPhotoAsset[];
  status: ExperimentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentInput {
  title: string;
  category: string;
  hypothesis: string;
  procedure: string;
  dataPlan: string;
  observationsNotes: string;
  resultEntries: ExperimentResultEntry[];
  notes: string;
  conclusionNotes: string;
  plannedAttachmentCount: number;
  photoAssets: ExperimentPhotoAsset[];
}

export const seedExperiments: ExperimentRecord[] = [
  {
    id: 'experiment-seed-1',
    title: 'Bean sprouts under different light conditions (Example)',
    category: 'Botany',
    hypothesis:
      'Bean sprouts exposed to indirect daylight will grow taller than sprouts kept under a desk lamp for the same duration.',
    procedure:
      'Plant matching bean seeds in two trays, water them equally, place one tray near a window and the other under a desk lamp, then measure height every 24 hours.',
    dataPlan: 'Record height, color changes, and moisture level once per day for seven days.',
    observationsNotes:
      'Window tray currently shows slightly faster growth after the first 48 hours.',
    resultEntries: [
      {
        id: 'result-seed-1',
        recordedAt: '2026-06-16T17:10:00.000Z',
        notes:
          'Window tray stems are taller and greener than the desk lamp tray after the first measurement cycle.',
        photoAssets: [],
      },
    ],
    notes: 'Need clearer labels for tray photos before the next measurement cycle.',
    conclusionNotes: '',
    plannedAttachmentCount: 2,
    photoAssets: [],
    status: 'active',
    createdAt: '2026-06-14T09:30:00.000Z',
    updatedAt: '2026-06-16T17:10:00.000Z',
  },
  {
    id: 'experiment-seed-2',
    title: 'Cooling rate of metal versus glass containers (Example)',
    category: 'Physics',
    hypothesis:
      'Water stored in a metal container will lose heat faster than water stored in a glass container of the same size.',
    procedure:
      'Fill matched containers with hot water, measure initial temperature, then log temperature every five minutes for thirty minutes.',
    dataPlan: 'Track time, temperature, room conditions, and any handling disturbances.',
    observationsNotes: 'Draft setup ready; first timed run has not been started yet.',
    resultEntries: [],
    notes: 'Bring insulated gloves and set up tripod before running measurements.',
    conclusionNotes: '',
    plannedAttachmentCount: 0,
    photoAssets: [],
    status: 'active',
    createdAt: '2026-06-15T13:00:00.000Z',
    updatedAt: '2026-06-15T13:00:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// Helpers & Normalization
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// The file store. One JSON file, read and written whole, through storage.fs.
//
// - Every exported operation, the first-run seeding included, runs one at a time through a
//   single queue, so two overlapping calls (an autosave and a status change, a create and
//   a delete) each read what the one before wrote: no write is lost to a stale read.
// - Every write is read back and compared before the operation returns, inside the same
//   turn of the queue; a file that does not hold what was written is an error.
// - Every failure throws. Nothing falls back to memory, so a caller never reports a save
//   the file does not hold. Time and ids are arguments (a data source has no clock or random).
//
// The queue is this module's: it serialises calls made in one JavaScript realm, which is
// how Exact runs a data module's sources. A second process writing the same file is not covered.
// ---------------------------------------------------------------------------

export const EXPERIMENT_FS_PATH = 'app:/data/experiments.json';

export interface FileSystem {
  readFile(path: string): Promise<ArrayBuffer>;
  atomicWriteFile(path: string, data: ArrayBuffer | Uint8Array): Promise<void>;
}
export interface Storage {
  readonly fs: FileSystem;
}

/** The fields an editor owns; results and photos are kept as the record holds them. */
export type ExperimentFields = Omit<ExperimentInput, 'resultEntries' | 'photoAssets'>;

interface FileState {
  bootstrapped: boolean;
  experiments: ExperimentRecord[];
}

const clone = (r: ExperimentRecord): ExperimentRecord => JSON.parse(JSON.stringify(r));
const byUpdated = (xs: ExperimentRecord[]) => [...xs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

let tail: Promise<unknown> = Promise.resolve();

/** Runs `work` after every earlier operation has finished, whether it succeeded or failed. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.catch(() => undefined);
  return run;
}

async function read(storage: Storage): Promise<FileState> {
  let bytes: ArrayBuffer;
  try {
    bytes = await storage.fs.readFile(EXPERIMENT_FS_PATH);
  } catch (e) {
    if ((e as { code?: string })?.code === 'ENOENT') return { bootstrapped: false, experiments: [] };
    throw e;
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || !Array.isArray(parsed.experiments)) throw new Error('The experiment file is unreadable.');
  return { bootstrapped: Boolean(parsed.bootstrapped), experiments: parsed.experiments as ExperimentRecord[] };
}

/** Writes the state and reads the file back; anything but the same state is an error. */
async function write(storage: Storage, state: FileState): Promise<void> {
  const text = JSON.stringify(state);
  await storage.fs.atomicWriteFile(EXPERIMENT_FS_PATH, new TextEncoder().encode(text));
  const back = new TextDecoder().decode(await storage.fs.readFile(EXPERIMENT_FS_PATH));
  if (back !== text) throw new Error('The change could not be confirmed in storage, so it was not saved.');
}

/** The state with the two examples seeded once; a file that already says so is left as it is. */
async function ready(storage: Storage): Promise<FileState> {
  const state = await read(storage);
  if (state.bootstrapped) return state;
  const next: FileState = {
    bootstrapped: true,
    experiments: state.experiments.length > 0 ? state.experiments : seedExperiments.map(clone),
  };
  await write(storage, next);
  return next;
}

function fromFields(f: ExperimentFields) {
  return {
    title: f.title.trim(),
    category: f.category.trim() || 'General',
    hypothesis: f.hypothesis.trim(),
    procedure: f.procedure.trim(),
    dataPlan: f.dataPlan.trim(),
    observationsNotes: f.observationsNotes.trim(),
    notes: f.notes.trim(),
    conclusionNotes: f.conclusionNotes.trim(),
    plannedAttachmentCount: Math.max(0, Number(f.plannedAttachmentCount) || 0),
  };
}

export function listExperiments(storage: Storage): Promise<ExperimentRecord[]> {
  return serial(async () => byUpdated((await ready(storage)).experiments.map(clone)));
}

export function getExperimentById(id: string, storage: Storage): Promise<ExperimentRecord | null> {
  return serial(async () => {
    const found = (await ready(storage)).experiments.find((e) => e.id === id);
    return found ? clone(found) : null;
  });
}

export function createExperiment(
  fields: ExperimentFields,
  storage: Storage,
  options: { id: string; now: string },
): Promise<ExperimentRecord> {
  return serial(async () => {
    const state = await ready(storage);
    if (state.experiments.some((e) => e.id === options.id)) throw new Error('An experiment with this id exists.');
    const record: ExperimentRecord = {
      id: options.id,
      ...fromFields(fields),
      resultEntries: [],
      photoAssets: [],
      status: 'active',
      createdAt: options.now,
      updatedAt: options.now,
    };
    await write(storage, { ...state, experiments: [record, ...state.experiments] });
    return clone(record);
  });
}

/** Changes the editor's fields, keeping the stored status, results and photos. Null: no such record. */
export function updateExperiment(
  id: string,
  fields: ExperimentFields,
  storage: Storage,
  options: { now: string },
): Promise<ExperimentRecord | null> {
  return serial(async () => {
    const state = await ready(storage);
    const existing = state.experiments.find((e) => e.id === id);
    if (!existing) return null;
    const record: ExperimentRecord = { ...existing, ...fromFields(fields), updatedAt: options.now };
    await write(storage, { ...state, experiments: state.experiments.map((e) => (e.id === id ? record : e)) });
    return clone(record);
  });
}

/** Changes the status, keeping every field. Null: no such record. */
export function updateExperimentStatus(
  id: string,
  status: ExperimentStatus,
  storage: Storage,
  options: { now: string },
): Promise<ExperimentRecord | null> {
  return serial(async () => {
    const state = await ready(storage);
    const existing = state.experiments.find((e) => e.id === id);
    if (!existing) return null;
    const record: ExperimentRecord = { ...existing, status, updatedAt: options.now };
    await write(storage, { ...state, experiments: state.experiments.map((e) => (e.id === id ? record : e)) });
    return clone(record);
  });
}

export function deleteExperiment(id: string, storage: Storage): Promise<void> {
  return serial(async () => {
    const state = await ready(storage);
    await write(storage, { ...state, experiments: state.experiments.filter((e) => e.id !== id) });
  });
}

/** Empties the file and marks it seeded, so the examples are never put back. */
export function resetExperiments(storage: Storage): Promise<void> {
  return serial(() => write(storage, { bootstrapped: true, experiments: [] }));
}

// ---------------------------------------------------------------------------
// Result entries. Each runs through the same queue and read-back as every other write, changes
// only the one entry, and keeps the record's fields, status, photos and the entries' own photos.
// A result needs notes or photos; recordedAt is set once, when the entry is added.
// ---------------------------------------------------------------------------

export class ResultError extends Error {}

const withResults = (
  id: string,
  storage: Storage,
  now: string,
  change: (existing: ExperimentRecord) => ExperimentResultEntry[],
): Promise<ExperimentRecord | null> =>
  serial(async () => {
    const state = await ready(storage);
    const existing = state.experiments.find((e) => e.id === id);
    if (!existing) return null;
    const record: ExperimentRecord = { ...existing, resultEntries: change(existing), updatedAt: now };
    await write(storage, { ...state, experiments: state.experiments.map((e) => (e.id === id ? record : e)) });
    return clone(record);
  });

/** Puts a new entry first. Null: no such record. */
export function addResultEntry(
  experimentId: string,
  entry: { id: string; recordedAt: string; notes: string },
  storage: Storage,
  options: { now: string },
): Promise<ExperimentRecord | null> {
  const notes = entry.notes.trim();
  if (notes === '') return Promise.reject(new ResultError('Write some result notes before saving.'));
  return withResults(experimentId, storage, options.now, (existing) => {
    if (existing.resultEntries.some((r) => r.id === entry.id)) throw new ResultError('A result with this id exists.');
    return [{ id: entry.id, recordedAt: entry.recordedAt, notes, photoAssets: [] }, ...existing.resultEntries];
  });
}

/** Changes one entry's notes only. Null: no such record. */
export function updateResultNotes(
  experimentId: string,
  resultId: string,
  notes: string,
  storage: Storage,
  options: { now: string },
): Promise<ExperimentRecord | null> {
  const text = notes.trim();
  return withResults(experimentId, storage, options.now, (existing) => {
    const entry = existing.resultEntries.find((r) => r.id === resultId);
    if (!entry) throw new ResultError('This result no longer exists.');
    if (text === '' && entry.photoAssets.length === 0) throw new ResultError('A result needs notes or photos.');
    return existing.resultEntries.map((r) => (r.id === resultId ? { ...r, notes: text } : r));
  });
}

/** Removes one entry. Null: no such record. */
export function deleteResultEntry(
  experimentId: string,
  resultId: string,
  storage: Storage,
  options: { now: string },
): Promise<ExperimentRecord | null> {
  return withResults(experimentId, storage, options.now, (existing) => {
    if (!existing.resultEntries.some((r) => r.id === resultId)) throw new ResultError('This result no longer exists.');
    return existing.resultEntries.filter((r) => r.id !== resultId);
  });
}
