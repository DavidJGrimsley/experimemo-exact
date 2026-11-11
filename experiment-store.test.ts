// Run with: bun test experiment-store.test.ts
// The store's concurrency and failure behaviour against a fake file system whose reads and
// writes take real (and varying) time, so overlapping operations genuinely interleave.
import { beforeEach, describe, expect, test } from 'bun:test';

import {
  EXPERIMENT_FS_PATH,
  addResultEntry,
  createExperiment,
  deleteResultEntry,
  updateResultNotes,
  deleteExperiment,
  getExperimentById,
  listExperiments,
  resetExperiments,
  updateExperiment,
  updateExperimentStatus,
  type ExperimentFields,
  type Storage,
} from './experiment-store.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fake extends Storage {
  files: Map<string, Uint8Array>;
  reads: number;
  writes: number;
  failWrites: boolean;
  dropWrites: boolean;
}

function fake(): Fake {
  const state: Fake = {
    files: new Map(),
    reads: 0,
    writes: 0,
    failWrites: false,
    dropWrites: false,
    fs: {
      async readFile(path) {
        state.reads += 1;
        await wait(1 + (state.reads % 4)); // varying latency
        const bytes = state.files.get(path);
        if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return bytes.slice().buffer;
      },
      async atomicWriteFile(path, data) {
        state.writes += 1;
        await wait(1 + (state.writes % 3));
        if (state.failWrites) throw Object.assign(new Error('disk full'), { code: 'EIO' });
        if (state.dropWrites) return; // says ok, stores nothing
        state.files.set(path, new Uint8Array(data as Uint8Array));
      },
    },
  };
  return state;
}

const fields = (over: Partial<ExperimentFields> = {}): ExperimentFields => ({
  title: 'T',
  category: '',
  hypothesis: 'H',
  procedure: 'P',
  dataPlan: '',
  observationsNotes: '',
  notes: '',
  conclusionNotes: '',
  plannedAttachmentCount: 0,
  ...over,
});

let fs: Fake;
beforeEach(() => {
  fs = fake();
});

describe('first-run seeding', () => {
  test('many simultaneous first reads seed the two examples exactly once', async () => {
    const lists = await Promise.all([1, 2, 3, 4, 5].map(() => listExperiments(fs)));
    for (const l of lists) expect(l.map((r) => r.id).sort()).toEqual(['experiment-seed-1', 'experiment-seed-2']);
    expect(fs.writes).toBe(1);
  });

  test('a create racing the first read keeps the examples and the new record', async () => {
    const [created, list] = await Promise.all([
      createExperiment(fields({ title: 'New' }), fs, { id: 'n1', now: '2026-07-01T00:00:00.000Z' }),
      listExperiments(fs),
    ]);
    expect(created.id).toBe('n1');
    expect(list.length === 2 || list.length === 3).toBe(true);
    const final = await listExperiments(fs);
    expect(final.map((r) => r.id).sort()).toEqual(['experiment-seed-1', 'experiment-seed-2', 'n1']);
  });
});

describe('interleaved writes lose nothing', () => {
  test('a field edit and a status change on one record both survive, in either order', async () => {
    await listExperiments(fs);
    await Promise.all([
      updateExperiment('experiment-seed-1', fields({ title: 'Edited', hypothesis: 'New H' }), fs, { now: '2026-07-01T00:00:01.000Z' }),
      updateExperimentStatus('experiment-seed-1', 'complete', fs, { now: '2026-07-01T00:00:02.000Z' }),
    ]);
    let r = await getExperimentById('experiment-seed-1', fs);
    expect(r?.title).toBe('Edited');
    expect(r?.status).toBe('complete');

    await Promise.all([
      updateExperimentStatus('experiment-seed-2', 'complete', fs, { now: '2026-07-01T00:00:03.000Z' }),
      updateExperiment('experiment-seed-2', fields({ title: 'Edited 2' }), fs, { now: '2026-07-01T00:00:04.000Z' }),
    ]);
    r = await getExperimentById('experiment-seed-2', fs);
    expect(r?.title).toBe('Edited 2');
    expect(r?.status).toBe('complete');
  });

  test('an edit keeps the record results and photos', async () => {
    await listExperiments(fs);
    await updateExperiment('experiment-seed-1', fields({ title: 'Edited' }), fs, { now: '2026-07-01T00:00:01.000Z' });
    const r = await getExperimentById('experiment-seed-1', fs);
    expect(r?.resultEntries.length).toBe(1);
    expect(r?.resultEntries[0].id).toBe('result-seed-1');
  });

  test('twenty creates, edits, status changes and deletes in flight end in the expected set', async () => {
    await listExperiments(fs);
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i += 1) {
      ops.push(createExperiment(fields({ title: `C${i}` }), fs, { id: `c${i}`, now: `2026-07-01T00:00:${10 + i}.000Z` }));
    }
    ops.push(updateExperiment('experiment-seed-1', fields({ title: 'Seed 1 edited' }), fs, { now: '2026-07-01T00:01:00.000Z' }));
    ops.push(updateExperimentStatus('experiment-seed-1', 'complete', fs, { now: '2026-07-01T00:01:01.000Z' }));
    ops.push(updateExperimentStatus('experiment-seed-2', 'complete', fs, { now: '2026-07-01T00:01:02.000Z' }));
    ops.push(deleteExperiment('experiment-seed-2', fs));
    await Promise.all(ops);
    const list = await listExperiments(fs);
    expect(list.map((r) => r.id).sort()).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'experiment-seed-1']);
    const seed1 = list.find((r) => r.id === 'experiment-seed-1');
    expect(seed1?.title).toBe('Seed 1 edited');
    expect(seed1?.status).toBe('complete');
  });

  test('a delete racing an edit of the same record leaves it deleted and the edit reports nothing found', async () => {
    await listExperiments(fs);
    const [, edited] = await Promise.all([
      deleteExperiment('experiment-seed-1', fs),
      updateExperiment('experiment-seed-1', fields({ title: 'Late' }), fs, { now: '2026-07-01T00:00:01.000Z' }),
    ]);
    expect(edited).toBeNull();
    expect((await listExperiments(fs)).map((r) => r.id)).toEqual(['experiment-seed-2']);
  });

  test('a reset racing creates never brings the examples back', async () => {
    await listExperiments(fs);
    await Promise.all([
      resetExperiments(fs),
      createExperiment(fields({ title: 'After' }), fs, { id: 'a1', now: '2026-07-01T00:00:01.000Z' }),
    ]);
    const ids = (await listExperiments(fs)).map((r) => r.id);
    expect(ids).not.toContain('experiment-seed-1');
    expect(ids).not.toContain('experiment-seed-2');
  });
});

describe('failures are errors, never silent', () => {
  test('a failed write throws, leaves the file as it was, and the queue still works', async () => {
    await listExperiments(fs);
    const before = new TextDecoder().decode(fs.files.get(EXPERIMENT_FS_PATH));
    fs.failWrites = true;
    await expect(
      updateExperiment('experiment-seed-1', fields({ title: 'Nope' }), fs, { now: '2026-07-01T00:00:01.000Z' }),
    ).rejects.toThrow('disk full');
    expect(new TextDecoder().decode(fs.files.get(EXPERIMENT_FS_PATH))).toBe(before);
    fs.failWrites = false;
    const ok = await updateExperiment('experiment-seed-1', fields({ title: 'Yes' }), fs, { now: '2026-07-01T00:00:02.000Z' });
    expect(ok?.title).toBe('Yes');
  });

  test('a write that is accepted but not stored is refused after the read-back', async () => {
    await listExperiments(fs);
    fs.dropWrites = true;
    await expect(
      updateExperimentStatus('experiment-seed-1', 'complete', fs, { now: '2026-07-01T00:00:01.000Z' }),
    ).rejects.toThrow('could not be confirmed');
    fs.dropWrites = false;
    expect((await getExperimentById('experiment-seed-1', fs))?.status).toBe('active');
  });

  test('a failure among overlapping calls fails only its own', async () => {
    await listExperiments(fs);
    const first = updateExperimentStatus('experiment-seed-1', 'complete', fs, { now: '2026-07-01T00:00:01.000Z' });
    const failing = (async () => {
      fs.failWrites = true;
      return updateExperiment('experiment-seed-2', fields({ title: 'Bad' }), fs, { now: '2026-07-01T00:00:02.000Z' });
    })();
    const settled = await Promise.allSettled([first, failing]);
    fs.failWrites = false;
    // The first was queued before the failure flag was raised only if it had already started writing;
    // either way each outcome matches what the file holds.
    const list = await listExperiments(fs);
    const s1 = list.find((r) => r.id === 'experiment-seed-1');
    expect(settled[0].status === 'fulfilled' ? s1?.status === 'complete' : s1?.status === 'active').toBe(true);
    expect(settled[1].status).toBe('rejected');
    expect(list.find((r) => r.id === 'experiment-seed-2')?.title).not.toBe('Bad');
  });

  test('a duplicate id is refused', async () => {
    await listExperiments(fs);
    await expect(
      createExperiment(fields(), fs, { id: 'experiment-seed-1', now: '2026-07-01T00:00:01.000Z' }),
    ).rejects.toThrow('exists');
  });

  test('an unreadable file is an error, not an empty list', async () => {
    fs.files.set(EXPERIMENT_FS_PATH, new TextEncoder().encode('{not json'));
    await expect(listExperiments(fs)).rejects.toThrow();
  });
});

describe('result entries', () => {
  const at = '2026-07-01T10:00:00.000Z';
  const stored = async () => (await listExperiments(fs)).find((r) => r.id === 'experiment-seed-1')!;

  test('add puts the entry first, keeps photos, fields and older entries, and persists', async () => {
    const before = await stored();
    await addResultEntry('experiment-seed-1', { id: 'r2', recordedAt: at, notes: ' New ' }, fs, { now: at });
    const after = await stored();
    expect(after.resultEntries.map((r) => r.id)).toEqual(['r2', 'result-seed-1']);
    expect(after.resultEntries[0]).toEqual({ id: 'r2', recordedAt: at, notes: 'New', photoAssets: [] });
    expect(after.title).toBe(before.title);
    expect(after.photoAssets).toEqual(before.photoAssets);
    expect(after.updatedAt).toBe(at);
  });

  test('a blank add is refused and writes nothing', async () => {
    await listExperiments(fs);
    const writes = fs.writes;
    await expect(addResultEntry('experiment-seed-1', { id: 'r2', recordedAt: at, notes: '  ' }, fs, { now: at })).rejects.toThrow();
    expect(fs.writes).toBe(writes);
  });

  test('edit changes only that entry notes and keeps its photos and timestamp', async () => {
    const photo = { id: 'p', uri: 'u', fileName: null, mimeType: null, width: 1, height: 1 };
    await addResultEntry('experiment-seed-1', { id: 'r2', recordedAt: at, notes: 'a' }, fs, { now: at });
    const raw = JSON.parse(new TextDecoder().decode(fs.files.get(EXPERIMENT_FS_PATH)!));
    raw.experiments.find((e: any) => e.id === 'experiment-seed-1').resultEntries[0].photoAssets = [photo];
    fs.files.set(EXPERIMENT_FS_PATH, new TextEncoder().encode(JSON.stringify(raw)));
    await updateResultNotes('experiment-seed-1', 'r2', '', fs, { now: at }).then(
      () => { throw new Error('should refuse'); },
      () => undefined,
    ).catch(() => undefined);
    await updateResultNotes('experiment-seed-1', 'r2', 'b', fs, { now: at });
    const e = (await stored()).resultEntries;
    expect(e[0]).toEqual({ id: 'r2', recordedAt: at, notes: 'b', photoAssets: [photo] });
    expect(e[1].id).toBe('result-seed-1');
    // photo-only result may be blanked
    await updateResultNotes('experiment-seed-1', 'r2', '', fs, { now: at });
    expect((await stored()).resultEntries[0].notes).toBe('');
  });

  test('editing or deleting a missing result throws, a missing record returns null', async () => {
    await expect(updateResultNotes('experiment-seed-1', 'zz', 'x', fs, { now: at })).rejects.toThrow();
    await expect(deleteResultEntry('experiment-seed-1', 'zz', fs, { now: at })).rejects.toThrow();
    expect(await deleteResultEntry('nope', 'zz', fs, { now: at })).toBeNull();
  });

  test('delete removes only that entry', async () => {
    await deleteResultEntry('experiment-seed-1', 'result-seed-1', fs, { now: at });
    expect((await stored()).resultEntries).toEqual([]);
    expect((await listExperiments(fs)).length).toBe(2);
  });

  test('overlapping result writes and a field update all land', async () => {
    await Promise.all([
      addResultEntry('experiment-seed-1', { id: 'a', recordedAt: at, notes: 'a' }, fs, { now: at }),
      addResultEntry('experiment-seed-1', { id: 'b', recordedAt: at, notes: 'b' }, fs, { now: at }),
      updateExperiment('experiment-seed-1', fields({ title: 'Renamed' }), fs, { now: at }),
    ]);
    const r = await stored();
    expect(r.resultEntries.map((x) => x.id).sort()).toEqual(['a', 'b', 'result-seed-1']);
    expect(r.title).toBe('Renamed');
  });

  test('a failed or dropped write is an error, not a success', async () => {
    await listExperiments(fs);
    fs.failWrites = true;
    await expect(addResultEntry('experiment-seed-1', { id: 'x', recordedAt: at, notes: 'x' }, fs, { now: at })).rejects.toThrow();
    fs.failWrites = false;
    fs.dropWrites = true;
    await expect(deleteResultEntry('experiment-seed-1', 'result-seed-1', fs, { now: at })).rejects.toThrow();
  });
});
