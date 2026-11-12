// Run with: bun test camera-cleanup.test.ts
// A camera shot's temporary file under app:/tmp/camera goes once its save is settled, whether the save
// worked or not, and a failed cleanup never hides the error that ended the save. A shot that landed
// after its sheet closed is discarded, and only camera shots can be.
import { describe, expect, test } from 'bun:test';

import { answer } from './app.ts';
import { EXPERIMENT_FS_PATH, PHOTOS_DIR } from './experiment-store.ts';

const MS = Date.UTC(2026, 10, 11, 12);
const SHOT = 'app:/tmp/camera/shot-1-1.jpg';

function fake() {
  const files = new Map<string, Uint8Array>();
  const s = {
    files,
    failPhotoWrites: false,
    failRecordWrites: false,
    failRm: false,
    fs: {
      async readFile(path: string) {
        const b = files.get(path);
        if (!b) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return b.slice().buffer;
      },
      async atomicWriteFile(path: string, data: ArrayBuffer | Uint8Array) {
        if (s.failPhotoWrites && path.startsWith(`${PHOTOS_DIR}/`)) throw Object.assign(new Error('disk full'), { code: 'EIO' });
        if (s.failRecordWrites && path === EXPERIMENT_FS_PATH) throw Object.assign(new Error('disk full'), { code: 'EIO' });
        files.set(path, new Uint8Array(data as Uint8Array));
      },
      async rm(path: string) {
        if (s.failRm) throw Object.assign(new Error('rm refused'), { code: 'EPERM' });
        if (!files.delete(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      async readdir(path: string) {
        return [...files.keys()].filter((k) => k.startsWith(`${path}/`)).map((k) => k.slice(path.length + 1));
      },
      async mkdir() {},
    },
  };
  return s;
}
type Fake = ReturnType<typeof fake>;

const ask = (f: Fake, source: string, args: unknown[]) =>
  (answer as unknown as (s: string, a: unknown[], store: unknown, storage: unknown, native: unknown) => Promise<any>)(source, args, undefined, f, undefined);

// A store seeded with the two examples, plus one shot waiting under app:/tmp/camera.
async function withShot() {
  const f = fake();
  await ask(f, 'experiments', []);
  f.files.set(SHOT, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  return f;
}
const photoFiles = (f: Fake) => [...f.files.keys()].filter((k) => k.startsWith(`${PHOTOS_DIR}/`));
const record = (f: Fake, id: string) =>
  JSON.parse(new TextDecoder().decode(f.files.get(EXPERIMENT_FS_PATH))).experiments.find((e: { id: string }) => e.id === id);
const stageArgs = ['photo-1', MS, SHOT, 'image/jpeg', 4, 2, 2];
const attachArgs = (expId: string, resultId = '') => [expId, resultId, 'photo-1', MS, SHOT, 'image/jpeg', 4, 2, 2];

describe('stageCameraPhoto', () => {
  test('a stored shot keeps its durable copy and the temporary file goes', async () => {
    const f = await withShot();
    const r = await ask(f, 'stageCameraPhoto', stageArgs);
    expect(r.ok).toBe(true);
    expect(r.photos.length).toBe(1);
    expect(f.files.has(SHOT)).toBe(false);
    expect(photoFiles(f)).toEqual([r.photos[0].uri]);
  });

  test('when the durable copy cannot be written, the temporary file still goes and the error is reported', async () => {
    const f = await withShot();
    f.failPhotoWrites = true;
    const r = await ask(f, 'stageCameraPhoto', stageArgs);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('disk full');
    expect(f.files.has(SHOT)).toBe(false);
    expect(photoFiles(f)).toEqual([]);
  });

  test('a cleanup that fails too does not replace the save error', async () => {
    const f = await withShot();
    f.failPhotoWrites = true;
    f.failRm = true;
    const r = await ask(f, 'stageCameraPhoto', stageArgs);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('disk full');
    expect(r.error).not.toContain('rm refused');
  });
});

describe('attachCameraPhoto', () => {
  test('an attached shot is referenced from the record and the temporary file goes', async () => {
    const f = await withShot();
    const r = await ask(f, 'attachCameraPhoto', attachArgs('experiment-seed-1'));
    expect(r.ok).toBe(true);
    expect(f.files.has(SHOT)).toBe(false);
    expect(record(f, 'experiment-seed-1').photoAssets.map((p: { uri: string }) => p.uri)).toEqual(photoFiles(f));
  });

  test('when the durable copy cannot be written, the temporary file goes and the record is unchanged', async () => {
    const f = await withShot();
    const before = record(f, 'experiment-seed-1');
    f.failPhotoWrites = true;
    const r = await ask(f, 'attachCameraPhoto', attachArgs('experiment-seed-1'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('disk full');
    expect(f.files.has(SHOT)).toBe(false);
    expect(photoFiles(f)).toEqual([]);
    expect(record(f, 'experiment-seed-1')).toEqual(before);
  });

  test('when the record cannot be written after the copy, both the copy and the temporary file go', async () => {
    const f = await withShot();
    const before = record(f, 'experiment-seed-1');
    f.failRecordWrites = true;
    const r = await ask(f, 'attachCameraPhoto', attachArgs('experiment-seed-1'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('disk full');
    expect(f.files.has(SHOT)).toBe(false);
    expect(photoFiles(f)).toEqual([]);
    expect(record(f, 'experiment-seed-1')).toEqual(before);
  });

  test('a cleanup that fails too does not replace the save error', async () => {
    const f = await withShot();
    f.failRecordWrites = true;
    f.failRm = true;
    const r = await ask(f, 'attachCameraPhoto', attachArgs('experiment-seed-1'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('disk full');
    expect(r.error).not.toContain('rm refused');
  });

  test('a shot for a record deleted meanwhile is refused and its temporary file goes', async () => {
    const f = await withShot();
    const r = await ask(f, 'attachCameraPhoto', attachArgs('no-such-record'));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('This experiment no longer exists.');
    expect(f.files.has(SHOT)).toBe(false);
    expect(photoFiles(f)).toEqual([]);
  });

  test('a shot for a result deleted meanwhile is refused and its temporary file goes', async () => {
    const f = await withShot();
    const r = await ask(f, 'attachCameraPhoto', attachArgs('experiment-seed-1', 'no-such-result'));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('This result no longer exists.');
    expect(f.files.has(SHOT)).toBe(false);
    expect(photoFiles(f)).toEqual([]);
  });
});

describe('discardCameraShot', () => {
  test('a stale shot is removed and nothing else changes', async () => {
    const f = await withShot();
    const stored = new TextDecoder().decode(f.files.get(EXPERIMENT_FS_PATH));
    const r = await ask(f, 'discardCameraShot', [SHOT]);
    expect(r.ok).toBe(true);
    expect(f.files.has(SHOT)).toBe(false);
    expect(new TextDecoder().decode(f.files.get(EXPERIMENT_FS_PATH))).toBe(stored);
  });

  test('a shot already gone is not an error', async () => {
    const f = fake();
    const r = await ask(f, 'discardCameraShot', [SHOT]);
    expect(r.ok).toBe(true);
  });

  test('only files under app:/tmp/camera can be discarded', async () => {
    const f = await withShot();
    for (const path of [EXPERIMENT_FS_PATH, 'app:/tmp/camera/../../data/experiments.json', 'app:/tmp/picked/x.jpg', '']) {
      const r = await ask(f, 'discardCameraShot', [path]);
      expect(r.ok).toBe(false);
    }
    expect(f.files.has(EXPERIMENT_FS_PATH)).toBe(true);
    expect(f.files.has(SHOT)).toBe(true);
  });
});
