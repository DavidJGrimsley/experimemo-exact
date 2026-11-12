// Run with: bun test experiment-store-corruption.test.ts
// A file that is there but damaged is never seeded over, never rewritten and never silently
// emptied; only a missing file bootstraps, and an explicit reset is the way out.
import { describe, expect, test } from 'bun:test';

import {
  EXPERIMENT_FS_PATH,
  StoreCorruptError,
  addResultEntry,
  createExperiment,
  deleteExperiment,
  listExperiments,
  resetExperiments,
  seedExperiments,
  updateExperiment,
  type ExperimentFields,
  type Storage,
} from './experiment-store.ts';

function fake(initial?: string | Uint8Array) {
  const files = new Map<string, Uint8Array>();
  if (initial !== undefined) {
    files.set(EXPERIMENT_FS_PATH, typeof initial === 'string' ? new TextEncoder().encode(initial) : initial);
  }
  const s = {
    files,
    writes: 0,
    fs: {
      async readFile(path: string) {
        const b = files.get(path);
        if (!b) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return b.slice().buffer;
      },
      async atomicWriteFile(path: string, data: ArrayBuffer | Uint8Array) {
        s.writes += 1;
        files.set(path, new Uint8Array(data as Uint8Array));
      },
    },
  };
  return s;
}
const asStorage = (s: ReturnType<typeof fake>) => s as unknown as Storage;
const text = (s: ReturnType<typeof fake>) => new TextDecoder().decode(s.files.get(EXPERIMENT_FS_PATH)!);
const NOW = '2026-01-01T00:00:00.000Z';
const fields: ExperimentFields = {
  title: 'T',
  category: '',
  hypothesis: 'H',
  procedure: 'P',
  dataPlan: '',
  observationsNotes: '',
  notes: '',
  conclusionNotes: '',
  plannedAttachmentCount: 0,
};
const good = () => JSON.parse(JSON.stringify({ bootstrapped: true, experiments: seedExperiments }));
const withRecord = (over: Record<string, unknown>) => {
  const g = good();
  g.experiments[0] = { ...g.experiments[0], ...over };
  return JSON.stringify(g);
};
const withEntry = (over: Record<string, unknown>) => {
  const g = good();
  g.experiments[0].resultEntries[0] = { ...g.experiments[0].resultEntries[0], ...over };
  return JSON.stringify(g);
};

const bad: [string, string | Uint8Array][] = [
  ['empty file', ''],
  ['truncated JSON', '{"bootstrapped":true,"experiments":[{"id":"a"'],
  ['not JSON', 'hello'],
  ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
  ['null', 'null'],
  ['an array', '[]'],
  ['a number', '7'],
  ['no experiments key', '{"bootstrapped":true}'],
  ['experiments not an array', '{"bootstrapped":true,"experiments":{}}'],
  ['bootstrapped missing', JSON.stringify({ experiments: seedExperiments })],
  ['bootstrapped false with records', JSON.stringify({ bootstrapped: false, experiments: seedExperiments })],
  ['bootstrapped false and empty', '{"bootstrapped":false,"experiments":[]}'],
  ['bootstrapped a string', '{"bootstrapped":"true","experiments":[]}'],
  ['a record that is null', '{"bootstrapped":true,"experiments":[null]}'],
  ['a record that is a string', '{"bootstrapped":true,"experiments":["x"]}'],
  ['a record without an id', withRecord({ id: undefined })],
  ['a record with an empty id', withRecord({ id: '' })],
  ['a numeric title', withRecord({ title: 5 })],
  ['a missing hypothesis', withRecord({ hypothesis: undefined })],
  ['a bad status', withRecord({ status: 'done' })],
  ['a bad planned count', withRecord({ plannedAttachmentCount: 'two' })],
  ['a negative planned count', withRecord({ plannedAttachmentCount: -1 })],
  ['a bad updatedAt', withRecord({ updatedAt: 'yesterday' })],
  ['a missing createdAt', withRecord({ createdAt: undefined })],
  ['resultEntries not a list', withRecord({ resultEntries: null })],
  ['photoAssets not a list', withRecord({ photoAssets: 'none' })],
  ['a malformed photo', withRecord({ photoAssets: [{ id: 'p' }] })],
  ['a result that is a string', withRecord({ resultEntries: ['x'] })],
  ['a result without notes', withEntry({ notes: undefined })],
  ['a result with a bad date', withEntry({ recordedAt: 'later' })],
  ['a result without photoAssets', withEntry({ photoAssets: undefined })],
  [
    'a duplicate result id',
    withRecord({ resultEntries: [good().experiments[0].resultEntries[0], good().experiments[0].resultEntries[0]] }),
  ],
  ['a duplicate experiment id', JSON.stringify({ bootstrapped: true, experiments: [seedExperiments[0], seedExperiments[0]] })],
];

describe('a damaged file is an error and is never overwritten', () => {
  for (const [name, content] of bad) {
    test(name, async () => {
      const s = fake(content);
      const storage = asStorage(s);
      const before = Array.from(s.files.get(EXPERIMENT_FS_PATH)!);
      await expect(listExperiments(storage)).rejects.toBeInstanceOf(StoreCorruptError);
      await expect(createExperiment(fields, storage, { id: 'n', now: NOW })).rejects.toBeInstanceOf(StoreCorruptError);
      await expect(updateExperiment('experiment-seed-1', fields, storage, { now: NOW })).rejects.toBeInstanceOf(StoreCorruptError);
      await expect(deleteExperiment('experiment-seed-1', storage)).rejects.toBeInstanceOf(StoreCorruptError);
      await expect(
        addResultEntry('experiment-seed-1', { id: 'r', recordedAt: NOW, notes: 'x' }, storage, { now: NOW }),
      ).rejects.toBeInstanceOf(StoreCorruptError);
      expect(s.writes).toBe(0);
      expect(Array.from(s.files.get(EXPERIMENT_FS_PATH)!)).toEqual(before);
    });
  }
});

describe('first run and recovery', () => {
  test('only a missing file bootstraps, once, with the two examples', async () => {
    const s = fake();
    const list = await listExperiments(asStorage(s));
    expect(list.map((r) => r.id).sort()).toEqual(['experiment-seed-1', 'experiment-seed-2']);
    expect(s.writes).toBe(1);
    await listExperiments(asStorage(s));
    expect(s.writes).toBe(1);
  });

  test('a valid file and an empty valid file are both read as they are, without a write', async () => {
    const a = fake(JSON.stringify(good()));
    expect((await listExperiments(asStorage(a))).length).toBe(2);
    expect(a.writes).toBe(0);
    const b = fake('{"bootstrapped":true,"experiments":[]}');
    expect(await listExperiments(asStorage(b))).toEqual([]);
    expect(b.writes).toBe(0);
  });

  test('a read error other than a missing file is thrown and nothing is written', async () => {
    const s = fake(JSON.stringify(good()));
    s.fs.readFile = async () => {
      throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    };
    await expect(listExperiments(asStorage(s))).rejects.toThrow('locked');
    expect(s.writes).toBe(0);
  });

  test('an explicit reset replaces a damaged file with an empty one, and the examples stay gone', async () => {
    const s = fake('{"bootstrapped":tru');
    const storage = asStorage(s);
    await expect(listExperiments(storage)).rejects.toBeInstanceOf(StoreCorruptError);
    await resetExperiments(storage);
    expect(JSON.parse(text(s))).toEqual({ bootstrapped: true, experiments: [] });
    expect(await listExperiments(storage)).toEqual([]);
    const made = await createExperiment(fields, storage, { id: 'n', now: NOW });
    expect((await listExperiments(storage)).map((r) => r.id)).toEqual([made.id]);
  });

  test('failures leave the queue usable: after a reset the same module works again', async () => {
    const s = fake('garbage');
    const storage = asStorage(s);
    await expect(Promise.all([listExperiments(storage), listExperiments(storage)])).rejects.toBeInstanceOf(StoreCorruptError);
    await resetExperiments(storage);
    expect(await listExperiments(storage)).toEqual([]);
  });
});
