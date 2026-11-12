import type { Answer, Result, Sources, Storage } from './app.contract.d.ts';
import {
  PhotoRefused,
  addResultEntry,
  attachPhotos,
  createExperiment,
  discardStagedPhoto,
  removePhoto,
  stagePhotos,
  deleteResultEntry,
  updateResultNotes,
  deleteExperiment,
  listExperiments,
  resetExperiments,
  updateExperiment,
  updateExperimentStatus,
  ResultError,
  type ExperimentFields,
  type ExperimentPhotoAsset,
  type ExperimentRecord,
  type Storage as StoreStorage,
} from './experiment-store.ts';
import { PhotoError, persistPickedPhotos } from './experiment-photos.ts';

// Records live in one file through experiment-store.ts, which runs every operation one at a
// time and reads each write back: a reply says ok only when the file holds the change.
const FILE = 'app:/data/experiments.json'; // experiment-store.ts's EXPERIMENT_FS_PATH
// Picked files arrive under app:/tmp; they are copied into app:/data/photos and referenced from there.
export const grants = [
  `fs.read ${FILE}`,
  `fs.write ${FILE}`,
  'fs.read app:/tmp',
  'fs.write app:/tmp',
  'device.camera purpose.camera',
  'fs.read app:/data/photos',
  'fs.write app:/data/photos',
].join('\n');

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

type PhotoView = Result<'attachPhotoRecord'>['photos'][number];

const photoView = (p: ExperimentPhotoAsset): PhotoView => ({
  id: p.id,
  uri: p.uri,
  name: p.fileName ?? '',
  mime: p.mimeType ?? '',
  width: p.width,
  height: p.height,
});
const photoAsset = (p: PhotoView): ExperimentPhotoAsset => ({
  id: p.id,
  uri: p.uri,
  fileName: p.name === '' ? null : p.name,
  mimeType: p.mime === '' ? null : p.mime,
  width: p.width,
  height: p.height,
});

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
      photoItems: e.photoAssets.map(photoView),
    })),
    photoList: r.photoAssets.map(photoView),
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

const photoReply = (ok: boolean, id: string, error: string, photos: PhotoView[] = []): Result<'attachPhotoRecord'> => ({
  ok,
  id,
  error,
  photos,
});

// What a person reads when a photo could not be taken in; never a code alone.
function photoFailure(e: unknown): string {
  if (e instanceof PhotoRefused || e instanceof ResultError) return e.message;
  if (e instanceof PhotoError) {
    if (e.code === 'FILE_NOT_FOUND') return 'The chosen photo could not be read. Choose it again.';
    if (e.code === 'CORRUPT_MEDIA') return 'The chosen photo is empty or damaged, so it was not added.';
    return `The photo could not be saved: ${e.message}`;
  }
  return `Could not save to storage: ${e instanceof Error ? e.message : String(e)}`;
}

const cameraPicked = (path: string, type: string, size: number, width: number, height: number) => ({
  path, name: path.split('/').pop() ?? '', type, size, width, height, duration: null,
});

// Camera shots are written here by takePhoto; nothing else under it is the app's to remove.
const CAMERA_TMP = 'app:/tmp/camera/';
const isCameraTemp = (path: string) => path.startsWith(CAMERA_TMP) && !path.slice(CAMERA_TMP.length).split('/').includes('..');

// The temporary shot is no longer needed once the durable copy (or the failure) is settled. It never
// throws, so a cleanup that fails cannot hide the error that ended the save; app:/tmp is pruned by the host.
async function dropCameraTemp(storage: Storage, path: string): Promise<void> {
  if (!isCameraTemp(path)) return;
  try {
    await (files(storage) as unknown as { fs: { rm(p: string): Promise<void> } }).fs.rm(path);
  } catch {
    // Already gone, or the host refused: either way nothing refers to it.
  }
}

const sources: Sources = {
  experiments: async (_args, _store, storage): Promise<Result<'experiments'>> =>
    (await listExperiments(files(storage))).map(view),

  createExperimentRecord: async (
    [id, ms, title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned, photos],
    _store,
    storage,
  ): Promise<Result<'createExperimentRecord'>> => {
    if (title.trim() === '' || hypothesis.trim() === '' || procedure.trim() === '') {
      return refused('', 'Title, hypothesis and procedure are required.');
    }
    try {
      const fields = fieldsOf([title, category, hypothesis, procedure, dataPlan, observations, notes, conclusion, planned]);
      await createExperiment(fields, files(storage), { id, now: isoAt(ms), photoAssets: photos.map(photoAsset) });
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

  addResultRecord: async ([id, resultId, ms, notes, photos], _store, storage): Promise<Result<'addResultRecord'>> => {
    if (notes.trim() === '' && photos.length === 0) return refused(resultId, 'Write some result notes or add a photo before saving.');
    try {
      const saved = await addResultEntry(
        id,
        { id: resultId, recordedAt: isoAt(ms), notes, photoAssets: photos.map(photoAsset) },
        files(storage),
        { now: isoAt(ms) },
      );
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

  // Picked files become durable copies. Staged ones (New, a result draft) wait, unreferenced, for Save.
  stagePhotoFiles: async ([idBase, ms, picked], _store, storage): Promise<Result<'stagePhotoFiles'>> => {
    try {
      const assets = await stagePhotos(
        () => persistPickedPhotos(picked, storage, { now: isoAt(ms), scope: 'experiment', generateId: (i) => `${idBase}-${i}` }),
        files(storage),
      );
      return photoReply(true, idBase, '', assets.map(photoView));
    } catch (e) {
      return photoReply(false, idBase, photoFailure(e));
    }
  },

  attachPhotoRecord: async ([expId, resultId, idBase, ms, picked], _store, storage): Promise<Result<'attachPhotoRecord'>> => {
    try {
      const saved = await attachPhotos(
        { experimentId: expId, resultId },
        () => persistPickedPhotos(picked, storage, { now: isoAt(ms), scope: resultId === '' ? 'experiment' : 'result', generateId: (i) => `${idBase}-${i}` }),
        files(storage),
        { now: isoAt(ms) },
      );
      return saved ? photoReply(true, idBase, '') : photoReply(false, idBase, gone);
    } catch (e) {
      return photoReply(false, idBase, photoFailure(e));
    }
  },

  // A camera photo waits under app:/tmp/camera; it becomes a durable copy exactly like a picked file. The
  // temporary file goes whether or not that worked: a failed save leaves nothing to retry from it.
  stageCameraPhoto: async ([idBase, ms, path, type, size, width, height], _store, storage): Promise<Result<'stageCameraPhoto'>> => {
    try {
      const picked = [cameraPicked(path, type, size, width, height)];
      const assets = await stagePhotos(
        () => persistPickedPhotos(picked, storage, { now: isoAt(ms), scope: 'experiment', generateId: (i) => `${idBase}-${i}` }),
        files(storage),
      );
      return photoReply(true, idBase, '', assets.map(photoView));
    } catch (e) {
      return photoReply(false, idBase, photoFailure(e));
    } finally {
      await dropCameraTemp(storage, path);
    }
  },

  attachCameraPhoto: async ([expId, resultId, idBase, ms, path, type, size, width, height], _store, storage): Promise<Result<'attachCameraPhoto'>> => {
    try {
      const picked = [cameraPicked(path, type, size, width, height)];
      const saved = await attachPhotos(
        { experimentId: expId, resultId },
        () => persistPickedPhotos(picked, storage, { now: isoAt(ms), scope: resultId === '' ? 'experiment' : 'result', generateId: (i) => `${idBase}-${i}` }),
        files(storage),
        { now: isoAt(ms) },
      );
      return saved ? photoReply(true, idBase, '') : photoReply(false, idBase, gone);
    } catch (e) {
      return photoReply(false, idBase, photoFailure(e));
    } finally {
      await dropCameraTemp(storage, path);
    }
  },

  // A shot that landed after its camera sheet closed: its temporary file goes and nothing refers to it.
  discardCameraShot: async ([path], _store, storage): Promise<Result<'discardCameraShot'>> => {
    if (!isCameraTemp(path)) return photoReply(false, path, 'Only a camera shot can be discarded.');
    await dropCameraTemp(storage, path);
    return photoReply(true, path, '');
  },

  removePhotoRecord: async ([expId, resultId, photoId, ms], _store, storage): Promise<Result<'removePhotoRecord'>> => {
    try {
      const saved = await removePhoto({ experimentId: expId, resultId }, photoId, files(storage), { now: isoAt(ms) });
      return saved ? photoReply(true, photoId, '') : photoReply(false, photoId, gone);
    } catch (e) {
      return photoReply(false, photoId, photoFailure(e));
    }
  },

  discardPhotoFile: async ([uri], _store, storage): Promise<Result<'discardPhotoFile'>> => {
    try {
      await discardStagedPhoto(uri, files(storage));
      return photoReply(true, uri, '');
    } catch (e) {
      return photoReply(false, uri, photoFailure(e));
    }
  },

  // A draft's staged photos nobody wants any more (its record was deleted or reset, or the staging landed
  // too late): each file goes unless a record has meanwhile taken it. One failure does not stop the rest.
  discardPhotoFiles: async ([uris], _store, storage): Promise<Result<'discardPhotoFiles'>> => {
    const errors: string[] = [];
    for (const uri of uris) {
      try {
        await discardStagedPhoto(uri, files(storage));
      } catch (e) {
        errors.push(photoFailure(e));
      }
    }
    return photoReply(errors.length === 0, '', errors.join(' '));
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
