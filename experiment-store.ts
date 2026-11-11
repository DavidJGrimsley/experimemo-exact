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
// Every failure throws: nothing here falls back to memory, so a caller never
// reports a save the file does not hold. Time and ids are arguments (a data
// source has no clock or random of its own).
// ---------------------------------------------------------------------------

export const EXPERIMENT_FS_PATH = 'app:/data/experiments.json';

export interface FileSystem {
  readFile(path: string): Promise<ArrayBuffer>;
  atomicWriteFile(path: string, data: ArrayBuffer | Uint8Array): Promise<void>;
}
export interface Storage {
  readonly fs: FileSystem;
}

interface FileState {
  bootstrapped: boolean;
  experiments: ExperimentRecord[];
}

const clone = (r: ExperimentRecord): ExperimentRecord => JSON.parse(JSON.stringify(r));
const byUpdated = (xs: ExperimentRecord[]) => [...xs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

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

async function write(storage: Storage, state: FileState): Promise<void> {
  await storage.fs.atomicWriteFile(EXPERIMENT_FS_PATH, new TextEncoder().encode(JSON.stringify(state)));
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

export async function listExperiments(storage: Storage): Promise<ExperimentRecord[]> {
  return byUpdated((await ready(storage)).experiments.map(clone));
}

export async function getExperimentById(id: string, storage: Storage): Promise<ExperimentRecord | null> {
  const found = (await ready(storage)).experiments.find((e) => e.id === id);
  return found ? clone(found) : null;
}

function fromInput(input: ExperimentInput) {
  return {
    title: input.title.trim(),
    category: input.category.trim() || 'General',
    hypothesis: input.hypothesis.trim(),
    procedure: input.procedure.trim(),
    dataPlan: input.dataPlan.trim(),
    observationsNotes: input.observationsNotes.trim(),
    resultEntries: input.resultEntries,
    notes: input.notes.trim(),
    conclusionNotes: input.conclusionNotes.trim(),
    plannedAttachmentCount: Math.max(0, Number(input.plannedAttachmentCount) || 0),
    photoAssets: input.photoAssets,
  };
}

export async function createExperiment(
  input: ExperimentInput,
  storage: Storage,
  options: { id: string; now: string },
): Promise<ExperimentRecord> {
  const state = await ready(storage);
  const record: ExperimentRecord = {
    id: options.id,
    ...fromInput(input),
    status: 'active',
    createdAt: options.now,
    updatedAt: options.now,
  };
  await write(storage, { ...state, experiments: [record, ...state.experiments] });
  return clone(record);
}

export async function updateExperiment(
  id: string,
  input: ExperimentInput,
  storage: Storage,
  options: { now: string },
): Promise<ExperimentRecord | null> {
  const state = await ready(storage);
  const existing = state.experiments.find((e) => e.id === id);
  if (!existing) return null;
  const record: ExperimentRecord = { ...existing, ...fromInput(input), updatedAt: options.now };
  await write(storage, { ...state, experiments: state.experiments.map((e) => (e.id === id ? record : e)) });
  return clone(record);
}

export async function updateExperimentStatus(
  id: string,
  status: ExperimentStatus,
  storage: Storage,
  options: { now: string },
): Promise<ExperimentRecord | null> {
  const state = await ready(storage);
  const existing = state.experiments.find((e) => e.id === id);
  if (!existing) return null;
  const record: ExperimentRecord = { ...existing, status, updatedAt: options.now };
  await write(storage, { ...state, experiments: state.experiments.map((e) => (e.id === id ? record : e)) });
  return clone(record);
}

export async function deleteExperiment(id: string, storage: Storage): Promise<void> {
  const state = await ready(storage);
  await write(storage, { ...state, experiments: state.experiments.filter((e) => e.id !== id) });
}

/** Empties the file and marks it seeded, so the examples are never put back. */
export async function resetExperiments(storage: Storage): Promise<void> {
  await write(storage, { bootstrapped: true, experiments: [] });
}
