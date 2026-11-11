import type { Answer, Result, Sources, Storage } from './app.contract.d.ts';
import {
  EXPERIMENT_FS_PATH,
  createExperiment,
  getExperimentById,
  listExperiments,
  updateExperiment,
  updateExperimentStatus,
  type ExperimentRecord,
  type ExperimentInput,
} from './experiment-store.ts';

// Records live in one file through experiment-store.ts. Every answer is also checked against
// the file itself: a read or write the file does not confirm is an error the screen shows, never
// a success.
const FILE = 'app:/data/experiments.json'; // experiment-store.ts's EXPERIMENT_FS_PATH
export const grants = [`fs.read ${FILE}`, `fs.write ${FILE}`].join('\n');



// Dates are pinned to en-US and UTC so the text is the same on every host.
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  });
const isoAt = (ms: number) => new Date(ms).toISOString();

async function onDisk(storage: Storage): Promise<ExperimentRecord[]> {
  const bytes = await storage.fs.readFile(EXPERIMENT_FS_PATH);
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || !Array.isArray(parsed.experiments)) throw new Error('The experiment file is unreadable.');
  return parsed.experiments as ExperimentRecord[];
}

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
    plannedLabel: `Planned photos: ${r.plannedAttachmentCount}`,
    conclusionLabel: `Conclusion: ${r.conclusionNotes ? 'Ready' : 'Open'}`,
  };
}

function inputOf(
  existing: ExperimentRecord | null,
  [title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned]: [
    string, string, string, string, string, string, string, string, number,
  ],
): ExperimentInput {
  return {
    title,
    category,
    hypothesis,
    procedure,
    dataPlan,
    observationsNotes: observations,
    notes,
    conclusionNotes: conclusion,
    plannedAttachmentCount: planned,
    // Results and photos are not edited here: keep what the record holds.
    resultEntries: existing?.resultEntries ?? [],
    photoAssets: existing?.photoAssets ?? [],
  };
}

const failure = (e: unknown): Result<'createExperimentRecord'> => ({
  ok: false,
  id: '',
  error: `Could not reach storage: ${e instanceof Error ? e.message : String(e)}`,
});

const unconfirmed = (id: string): Result<'createExperimentRecord'> => ({
  ok: false,
  id,
  error: 'The change could not be confirmed in storage, so it was not saved.',
});

const sources: Sources = {
  experiments: async (_args, _store, storage): Promise<Result<'experiments'>> => {
    const records = await listExperiments(storage);
    try {
      const stored = await onDisk(storage);
      const ids = new Set(stored.map((s) => s.id));
      // The module answers from memory when storage fails: refuse what the file does not hold.
      if (records.some((r) => !ids.has(r.id))) throw new Error('Experiments could not be read from storage.');
    } catch (e) {
      if ((e as { code?: string })?.code !== 'bake') throw e; // the build has no storage: let it through
    }
    return records.map(view);
  },

  createExperimentRecord: async (
    [id, ms, title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned],
    _store,
    storage,
  ): Promise<Result<'createExperimentRecord'>> => {
    if (title.trim() === '' || hypothesis.trim() === '' || procedure.trim() === '') {
      return { ok: false, id: '', error: 'Title, hypothesis and procedure are required.' };
    }
    try {
      const at = isoAt(ms);
      const input = inputOf(null, [title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned]);
      await createExperiment(input, storage, { id, now: at });
      const stored = (await onDisk(storage)).find((r) => r.id === id);
      return stored && stored.title === title.trim() && stored.updatedAt === at
        ? { ok: true, id, error: '' }
        : unconfirmed(id);
    } catch (e) {
      return failure(e);
    }
  },

  saveExperimentRecord: async (
    [id, ms, title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned],
    _store,
    storage,
  ): Promise<Result<'saveExperimentRecord'>> => {
    if (title.trim() === '' || hypothesis.trim() === '') {
      return { ok: false, id, error: 'Title and hypothesis are required to save changes.' };
    }
    try {
      const existing = await getExperimentById(id, storage);
      if (!existing) return { ok: false, id, error: 'This experiment no longer exists.' };
      const at = isoAt(ms);
      const input = inputOf(existing, [title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned]);
      await updateExperiment(id, input, storage, { now: at });
      const stored = (await onDisk(storage)).find((r) => r.id === id);
      return stored && stored.title === title.trim() && stored.updatedAt === at
        ? { ok: true, id, error: '' }
        : unconfirmed(id);
    } catch (e) {
      return failure(e);
    }
  },

  setExperimentStatus: async ([id, ms, status], _store, storage): Promise<Result<'setExperimentStatus'>> => {
    try {
      const next = status === 'complete' ? 'complete' : 'active';
      const at = isoAt(ms);
      const updated = await updateExperimentStatus(id, next, storage, { now: at });
      if (!updated) return { ok: false, id, error: 'This experiment no longer exists.' };
      const stored = (await onDisk(storage)).find((r) => r.id === id);
      return stored && stored.status === next && stored.updatedAt === at
        ? { ok: true, id, error: '' }
        : unconfirmed(id);
    } catch (e) {
      return failure(e);
    }
  },
};
export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
