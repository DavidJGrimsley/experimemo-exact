// Run with: bun test experiment-store-photos.test.ts
// Photo metadata goes through the same serialized, verified store as every other write, and a
// photo file is removed only when nothing refers to it any more.
import { describe, expect, test } from 'bun:test';

import {
  PHOTOS_DIR,
  PhotoRefused,
  attachPhotos,
  createExperiment,
  deleteExperiment,
  deleteResultEntry,
  discardStagedPhoto,
  addResultEntry,
  listExperiments,
  removePhoto,
  resetExperiments,
  stagePhotos,
  updateExperiment,
  type ExperimentFields,
  type ExperimentPhotoAsset,
  type Storage,
} from './experiment-store.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = '2026-11-11T12:00:00.000Z';

function fake() {
  const files = new Map<string, Uint8Array>();
  const s = {
    files,
    failWrites: false,
    fs: {
      async readFile(path: string) {
        await wait(1);
        const b = files.get(path);
        if (!b) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return b.slice().buffer;
      },
      async atomicWriteFile(path: string, data: ArrayBuffer | Uint8Array) {
        await wait(1);
        if (s.failWrites && path.endsWith('experiments.json')) throw Object.assign(new Error('disk full'), { code: 'EIO' });
        files.set(path, new Uint8Array(data as Uint8Array));
      },
      async rm(path: string) {
        if (!files.delete(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      async readdir(path: string) {
        return [...files.keys()].filter((k) => k.startsWith(`${path}/`)).map((k) => k.slice(path.length + 1));
      },
    },
  };
  return s;
}
type Fake = ReturnType<typeof fake>;
const st = (f: Fake) => f as unknown as Storage;
const fields: ExperimentFields = {
  title: 'T', category: '', hypothesis: 'H', procedure: 'P', dataPlan: '', observationsNotes: '', notes: '', conclusionNotes: '', plannedAttachmentCount: 0,
};
const asset = (id: string): ExperimentPhotoAsset => ({ id, uri: `${PHOTOS_DIR}/${id}.png`, fileName: `${id}.png`, mimeType: 'image/png', width: 1, height: 1 });
const put = (f: Fake, id: string) => f.files.set(`${PHOTOS_DIR}/${id}.png`, new Uint8Array([1, 2, 3]));
const has = (f: Fake, id: string) => f.files.has(`${PHOTOS_DIR}/${id}.png`);
const produce = (f: Fake, ...ids: string[]) => async () => {
  ids.forEach((i) => put(f, i));
  return ids.map(asset);
};

async function withRecord(f: Fake, id = 'e1') {
  await createExperiment(fields, st(f), { id, now: NOW });
}

describe('attach and remove', () => {
  test('attached photos are stored with the record, separately for the experiment and a result', async () => {
    const f = fake();
    await withRecord(f);
    await addResultEntry('e1', { id: 'r1', recordedAt: NOW, notes: 'n' }, st(f), { now: NOW });
    await attachPhotos({ experimentId: 'e1', resultId: '' }, produce(f, 'pe'), st(f), { now: NOW });
    await attachPhotos({ experimentId: 'e1', resultId: 'r1' }, produce(f, 'pr'), st(f), { now: NOW });
    const rec = (await listExperiments(st(f))).find((e) => e.id === 'e1')!;
    expect(rec.photoAssets.map((p) => p.id)).toEqual(['pe']);
    expect(rec.resultEntries[0].photoAssets.map((p) => p.id)).toEqual(['pr']);
  });

  test('a record that no longer exists copies nothing', async () => {
    const f = fake();
    await withRecord(f);
    let copied = false;
    const r = await attachPhotos({ experimentId: 'gone', resultId: '' }, async () => { copied = true; return []; }, st(f), { now: NOW });
    expect(r).toBeNull();
    expect(copied).toBe(false);
  });

  test('a failed metadata write removes the copies it made and keeps the record as it was', async () => {
    const f = fake();
    await withRecord(f);
    f.failWrites = true;
    await expect(attachPhotos({ experimentId: 'e1', resultId: '' }, produce(f, 'p1'), st(f), { now: NOW })).rejects.toThrow('disk full');
    f.failWrites = false;
    expect(has(f, 'p1')).toBe(false);
    expect((await listExperiments(st(f)))[0].photoAssets).toEqual([]);
  });

  test('a transient read-back failure does not delete an attached photo', async () => {
    const f = fake();
    await withRecord(f);
    const originalWrite = f.fs.atomicWriteFile;
    const originalRead = f.fs.readFile;
    let failConfirmation = false;
    f.fs.atomicWriteFile = async (path, data) => {
      await originalWrite(path, data);
      if (path.endsWith('experiments.json')) failConfirmation = true;
    };
    f.fs.readFile = async (path) => {
      if (failConfirmation && path.endsWith('experiments.json')) {
        failConfirmation = false;
        throw Object.assign(new Error('temporary read failure'), { code: 'EIO' });
      }
      return originalRead(path);
    };
    await expect(attachPhotos({ experimentId: 'e1', resultId: '' }, produce(f, 'p1'), st(f), { now: NOW })).rejects.toThrow('temporary read failure');
    expect(has(f, 'p1')).toBe(true);
    expect((await listExperiments(st(f)))[0].photoAssets.map((p) => p.id)).toEqual(['p1']);
  });

  test('removing a photo deletes its file, and an unknown photo is refused', async () => {
    const f = fake();
    await withRecord(f);
    await attachPhotos({ experimentId: 'e1', resultId: '' }, produce(f, 'p1'), st(f), { now: NOW });
    await expect(removePhoto({ experimentId: 'e1', resultId: '' }, 'nope', st(f), { now: NOW })).rejects.toBeInstanceOf(PhotoRefused);
    expect(has(f, 'p1')).toBe(true);
    await removePhoto({ experimentId: 'e1', resultId: '' }, 'p1', st(f), { now: NOW });
    expect(has(f, 'p1')).toBe(false);
    expect((await listExperiments(st(f)))[0].photoAssets).toEqual([]);
  });

  test('a file another record still refers to is not deleted', async () => {
    const f = fake();
    await withRecord(f, 'e1');
    await withRecord(f, 'e2');
    const shared = produce(f, 'shared');
    await attachPhotos({ experimentId: 'e1', resultId: '' }, shared, st(f), { now: NOW });
    await attachPhotos({ experimentId: 'e2', resultId: '' }, async () => [asset('shared2')].map((a) => ({ ...a, uri: `${PHOTOS_DIR}/shared.png` })), st(f), { now: NOW });
    await removePhoto({ experimentId: 'e1', resultId: '' }, 'shared', st(f), { now: NOW });
    expect(has(f, 'shared')).toBe(true);
    await removePhoto({ experimentId: 'e2', resultId: '' }, 'shared2', st(f), { now: NOW });
    expect(has(f, 'shared')).toBe(false);
  });

  test('a result cannot lose its last photo while it has no notes, but can with notes', async () => {
    const f = fake();
    await withRecord(f);
    await addResultEntry('e1', { id: 'r1', recordedAt: NOW, notes: '', photoAssets: [asset('p1')] }, st(f), { now: NOW });
    put(f, 'p1');
    await expect(removePhoto({ experimentId: 'e1', resultId: 'r1' }, 'p1', st(f), { now: NOW })).rejects.toThrow('A result needs notes or photos.');
    expect(has(f, 'p1')).toBe(true);
    await addResultEntry('e1', { id: 'r2', recordedAt: NOW, notes: 'has notes', photoAssets: [asset('p2')] }, st(f), { now: NOW });
    put(f, 'p2');
    await removePhoto({ experimentId: 'e1', resultId: 'r2' }, 'p2', st(f), { now: NOW });
    expect(has(f, 'p2')).toBe(false);
  });

  test('an empty result with neither notes nor photos is refused', async () => {
    const f = fake();
    await withRecord(f);
    await expect(addResultEntry('e1', { id: 'r1', recordedAt: NOW, notes: '  ' }, st(f), { now: NOW })).rejects.toThrow();
  });
});

describe('cleanup follows the last reference', () => {
  test('deleting a result or an experiment removes only the files nothing else uses', async () => {
    const f = fake();
    await withRecord(f);
    await attachPhotos({ experimentId: 'e1', resultId: '' }, produce(f, 'exp'), st(f), { now: NOW });
    await addResultEntry('e1', { id: 'r1', recordedAt: NOW, notes: 'n', photoAssets: [asset('res')] }, st(f), { now: NOW });
    put(f, 'res');
    await deleteResultEntry('e1', 'r1', st(f), { now: NOW });
    expect(has(f, 'res')).toBe(false);
    expect(has(f, 'exp')).toBe(true);
    await deleteExperiment('e1', st(f));
    expect(has(f, 'exp')).toBe(false);
  });

  test('a field edit keeps every photo and file', async () => {
    const f = fake();
    await withRecord(f);
    await attachPhotos({ experimentId: 'e1', resultId: '' }, produce(f, 'p1'), st(f), { now: NOW });
    await updateExperiment('e1', { ...fields, title: 'Changed' }, st(f), { now: NOW });
    expect(has(f, 'p1')).toBe(true);
    expect((await listExperiments(st(f)))[0].photoAssets.map((p) => p.id)).toEqual(['p1']);
  });

  test('reset removes every photo file', async () => {
    const f = fake();
    await withRecord(f);
    await attachPhotos({ experimentId: 'e1', resultId: '' }, produce(f, 'p1'), st(f), { now: NOW });
    await resetExperiments(st(f));
    expect(has(f, 'p1')).toBe(false);
  });

  test('a staged photo can be discarded, but not once a record has taken it', async () => {
    const f = fake();
    await withRecord(f);
    const [a] = await stagePhotos(produce(f, 'staged'), st(f));
    await discardStagedPhoto(a.uri, st(f));
    expect(has(f, 'staged')).toBe(false);
    const [b] = await stagePhotos(produce(f, 'taken'), st(f));
    await createExperiment(fields, st(f), { id: 'e2', now: NOW, photoAssets: [b] });
    await discardStagedPhoto(b.uri, st(f));
    expect(has(f, 'taken')).toBe(true);
  });

  test('the first operation of a run removes strays left by an abandoned draft, and keeps referenced files', async () => {
    const f = fake();
    await withRecord(f);
    await attachPhotos({ experimentId: 'e1', resultId: '' }, produce(f, 'kept'), st(f), { now: NOW });
    put(f, 'stray');
    // a new run: a fresh file system object over the same files
    const next = { files: f.files, fs: { ...f.fs } } as unknown as Fake;
    await listExperiments(st(next));
    expect(has(f, 'stray')).toBe(false);
    expect(has(f, 'kept')).toBe(true);
  });

  test('a damaged record file removes no photo', async () => {
    const f = fake();
    await withRecord(f);
    await attachPhotos({ experimentId: 'e1', resultId: '' }, produce(f, 'kept'), st(f), { now: NOW });
    f.files.set('app:/data/experiments.json', new TextEncoder().encode('{broken'));
    const next = { files: f.files, fs: { ...f.fs } } as unknown as Fake;
    await expect(listExperiments(st(next))).rejects.toThrow();
    expect(has(f, 'kept')).toBe(true);
  });
});
