import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database as BunSqlite } from 'bun:sqlite';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  seedExperiments,
  ensureLocalDataReady,
  listExperiments,
  getExperimentById,
  createExperiment,
  updateExperiment,
  updateExperimentStatus,
  deleteExperiments,
  deleteExperiment,
  resetExperiments,
  resetMemoryStore,
  setDefaultStorage,
  ExperimentStore,
  EXPERIMENT_GRANTS,
  type ExperimentInput,
  type ExperimentPhotoAsset,
  type ExperimentRecord,
  type ExperimentResultEntry,
  type Storage,
  type Database as ExactDb,
  type SQLite as ExactSqlite,
  type FileSystem as ExactFs,
  type SQLRows,
  type SQLExecution,
  type SQLValue,
} from './experiment-data';

// ---------------------------------------------------------------------------
// Test Storage Adapters (Real disk-backed SQLite and FileSystem for tests)
// ---------------------------------------------------------------------------

function createRealSqliteStorage(dbFilePath: string): Storage {
  const bunDb = new BunSqlite(dbFilePath);

  const sqlite: ExactSqlite = {
    async open(_path: string): Promise<ExactDb> {
      return {
        async execute(sql: string, params?: SQLValue[]): Promise<SQLExecution> {
          const stmt = bunDb.prepare(sql);
          // bun:sqlite stmt.run takes parameters as an array or object
          const info = params ? stmt.run(...(params as unknown[])) : stmt.run();
          return {
            changes: info.changes,
            lastInsertRowid: BigInt(info.lastInsertRowid),
          };
        },

        async query(sql: string, params?: SQLValue[]): Promise<SQLRows> {
          const stmt = bunDb.prepare(sql);
          const rawRows = params ? stmt.values(...(params as unknown[])) : stmt.values();
          // Extract column names from columnNames property of Statement
          const columns = stmt.columnNames;
          return {
            columns,
            rows: rawRows as SQLValue[][],
          };
        },

        async close(): Promise<void> {
          // Keep underlying connection managed by test suite lifecycle
        },
      };
    },
  };

  return { sqlite };
}

function createRealFsStorage(tempDir: string): { storage: Storage; getFilePath: (rel: string) => string } {
  const resolveFsPath = (exactPath: string) => {
    const filename = exactPath.replace(/^app:\/data\//, '');
    return path.join(tempDir, filename);
  };

  const fileSystem: ExactFs = {
    async readFile(exactPath: string): Promise<ArrayBuffer> {
      const realPath = resolveFsPath(exactPath);
      const buffer = await fs.readFile(realPath);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },

    async atomicWriteFile(exactPath: string, data: ArrayBuffer | Uint8Array): Promise<void> {
      const realPath = resolveFsPath(exactPath);
      await fs.mkdir(path.dirname(realPath), { recursive: true });
      const tempPath = `${realPath}.tmp-${Date.now()}-${Math.random()}`;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await fs.writeFile(tempPath, bytes);
      await fs.rename(tempPath, realPath);
    },

    async writeFile(exactPath: string, data: ArrayBuffer | Uint8Array): Promise<void> {
      const realPath = resolveFsPath(exactPath);
      await fs.mkdir(path.dirname(realPath), { recursive: true });
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await fs.writeFile(realPath, bytes);
    },

    async rm(exactPath: string): Promise<void> {
      const realPath = resolveFsPath(exactPath);
      try {
        await fs.unlink(realPath);
      } catch {
        // Safe no-op
      }
    },
  };

  return {
    storage: { fs: fileSystem },
    getFilePath: resolveFsPath,
  };
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe('Experiment Data & Persistence Foundation', () => {
  let tempDir: string;

  beforeEach(async () => {
    resetMemoryStore();
    setDefaultStorage(null);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'experimemo-test-'));
  });

  afterEach(async () => {
    resetMemoryStore();
    setDefaultStorage(null);
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // =========================================================================
  // 1. Reference Seed Records Validation
  // =========================================================================
  describe('Seed Records Parity', () => {
    it('contains exactly two original seed experiments matching reference', () => {
      expect(seedExperiments.length).toBe(2);

      const [seed1, seed2] = seedExperiments;

      // Seed 1: Bean sprouts
      expect(seed1.id).toBe('experiment-seed-1');
      expect(seed1.title).toBe('Bean sprouts under different light conditions (Example)');
      expect(seed1.category).toBe('Botany');
      expect(seed1.hypothesis).toBe(
        'Bean sprouts exposed to indirect daylight will grow taller than sprouts kept under a desk lamp for the same duration.'
      );
      expect(seed1.procedure).toContain('Plant matching bean seeds in two trays');
      expect(seed1.dataPlan).toContain('Record height, color changes');
      expect(seed1.observationsNotes).toContain('Window tray currently shows slightly faster growth');
      expect(seed1.resultEntries.length).toBe(1);
      expect(seed1.resultEntries[0].id).toBe('result-seed-1');
      expect(seed1.resultEntries[0].recordedAt).toBe('2026-06-16T17:10:00.000Z');
      expect(seed1.plannedAttachmentCount).toBe(2);
      expect(seed1.photoAssets).toEqual([]);
      expect(seed1.status).toBe('active');
      expect(seed1.createdAt).toBe('2026-06-14T09:30:00.000Z');
      expect(seed1.updatedAt).toBe('2026-06-16T17:10:00.000Z');

      // Seed 2: Cooling rate
      expect(seed2.id).toBe('experiment-seed-2');
      expect(seed2.title).toBe('Cooling rate of metal versus glass containers (Example)');
      expect(seed2.category).toBe('Physics');
      expect(seed2.hypothesis).toBe(
        'Water stored in a metal container will lose heat faster than water stored in a glass container of the same size.'
      );
      expect(seed2.procedure).toContain('Fill matched containers with hot water');
      expect(seed2.dataPlan).toContain('Track time, temperature, room conditions');
      expect(seed2.observationsNotes).toBe('Draft setup ready; first timed run has not been started yet.');
      expect(seed2.resultEntries).toEqual([]);
      expect(seed2.plannedAttachmentCount).toBe(0);
      expect(seed2.photoAssets).toEqual([]);
      expect(seed2.status).toBe('active');
      expect(seed2.createdAt).toBe('2026-06-15T13:00:00.000Z');
      expect(seed2.updatedAt).toBe('2026-06-15T13:00:00.000Z');
    });

    it('exports EXPERIMENT_GRANTS containing SQLite and FileSystem paths', () => {
      expect(EXPERIMENT_GRANTS).toContain('sqlite.open app:/data/experiments.db');
      expect(EXPERIMENT_GRANTS).toContain('fs.read app:/data/experiments.json');
      expect(EXPERIMENT_GRANTS).toContain('fs.write app:/data/experiments.json');
    });
  });

  // =========================================================================
  // 2. In-Memory Store Driver Tests
  // =========================================================================
  describe('In-Memory Store Operations', () => {
    it('bootstraps seed experiments once on first list', async () => {
      const records = await listExperiments();
      expect(records.length).toBe(2);
      // Descending updated_at order: seed 1 (updated 2026-06-16) is newer than seed 2 (updated 2026-06-15)
      expect(records[0].id).toBe('experiment-seed-1');
      expect(records[1].id).toBe('experiment-seed-2');
    });

    it('getExperimentById returns matching record or null', async () => {
      const found = await getExperimentById('experiment-seed-1');
      expect(found).not.toBeNull();
      expect(found?.title).toContain('Bean sprouts');

      const missing = await getExperimentById('non-existent-id');
      expect(missing).toBeNull();
    });

    it('creates a new experiment with trimmed fields, default category, and deterministic options', async () => {
      const input: ExperimentInput = {
        title: '  Magnetic shielding test  ',
        category: '  ', // empty -> should default to General
        hypothesis: '  Mu-metal reduces field strength  ',
        procedure: '  Place sensor inside cylinder  ',
        dataPlan: '  Record Gauss readings  ',
        observationsNotes: '  Low ambient noise  ',
        resultEntries: [],
        notes: '  Calibrate sensor  ',
        conclusionNotes: '  ',
        plannedAttachmentCount: 3,
        photoAssets: [],
      };

      const created = await createExperiment(input, {
        id: 'exp-det-1',
        now: '2026-11-11T12:00:00.000Z',
      });

      expect(created.id).toBe('exp-det-1');
      expect(created.title).toBe('Magnetic shielding test');
      expect(created.category).toBe('General');
      expect(created.hypothesis).toBe('Mu-metal reduces field strength');
      expect(created.procedure).toBe('Place sensor inside cylinder');
      expect(created.dataPlan).toBe('Record Gauss readings');
      expect(created.observationsNotes).toBe('Low ambient noise');
      expect(created.notes).toBe('Calibrate sensor');
      expect(created.conclusionNotes).toBe('');
      expect(created.plannedAttachmentCount).toBe(3);
      expect(created.status).toBe('active');
      expect(created.createdAt).toBe('2026-11-11T12:00:00.000Z');
      expect(created.updatedAt).toBe('2026-11-11T12:00:00.000Z');

      // Verify it appears first in listExperiments due to newer timestamp
      const all = await listExperiments();
      expect(all.length).toBe(3);
      expect(all[0].id).toBe('exp-det-1');
    });

    it('updates an experiment preserving id, createdAt, and status while updating updatedAt', async () => {
      const updated = await updateExperiment(
        'experiment-seed-1',
        {
          title: 'Bean sprouts under light (Revised)',
          category: 'Botany & Photobiology',
          hypothesis: 'Sprouts need blue spectrum daylight.',
          procedure: 'Updated procedure steps.',
          dataPlan: 'Updated data collection plan.',
          observationsNotes: 'Updated observations.',
          resultEntries: [
            {
              id: 'res-new-1',
              recordedAt: '2026-11-11T13:00:00.000Z',
              notes: 'Day 1 results',
              photoAssets: [],
            },
          ],
          notes: 'New notes',
          conclusionNotes: 'Light is essential',
          plannedAttachmentCount: 4,
          photoAssets: [],
        },
        { now: '2026-11-11T14:00:00.000Z' }
      );

      expect(updated).not.toBeNull();
      expect(updated?.id).toBe('experiment-seed-1');
      expect(updated?.createdAt).toBe('2026-06-14T09:30:00.000Z'); // Preserved!
      expect(updated?.updatedAt).toBe('2026-11-11T14:00:00.000Z'); // Updated!
      expect(updated?.title).toBe('Bean sprouts under light (Revised)');
      expect(updated?.category).toBe('Botany & Photobiology');
      expect(updated?.status).toBe('active');
      expect(updated?.conclusionNotes).toBe('Light is essential');
      expect(updated?.resultEntries.length).toBe(1);

      // Updating a non-existent record returns null
      const failed = await updateExperiment('does-not-exist', {
        title: 'X',
        category: 'Y',
        hypothesis: 'Z',
        procedure: 'P',
        dataPlan: 'D',
        observationsNotes: 'O',
        resultEntries: [],
        notes: 'N',
        conclusionNotes: '',
        plannedAttachmentCount: 0,
        photoAssets: [],
      });
      expect(failed).toBeNull();
    });

    it('toggles status to complete and back with deterministic time', async () => {
      const completed = await updateExperimentStatus(
        'experiment-seed-1',
        'complete',
        { now: '2026-11-11T15:00:00.000Z' }
      );
      expect(completed?.status).toBe('complete');
      expect(completed?.updatedAt).toBe('2026-11-11T15:00:00.000Z');

      const reloaded = await getExperimentById('experiment-seed-1');
      expect(reloaded?.status).toBe('complete');

      const reactivated = await updateExperimentStatus(
        'experiment-seed-1',
        'active',
        { now: '2026-11-11T16:00:00.000Z' }
      );
      expect(reactivated?.status).toBe('active');
      expect(reactivated?.updatedAt).toBe('2026-11-11T16:00:00.000Z');
    });

    it('deletes experiments by ID array or single ID', async () => {
      await deleteExperiment('experiment-seed-2');
      const listAfterSingle = await listExperiments();
      expect(listAfterSingle.length).toBe(1);
      expect(listAfterSingle[0].id).toBe('experiment-seed-1');

      await deleteExperiments(['experiment-seed-1']);
      const listAfterArray = await listExperiments();
      expect(listAfterArray.length).toBe(0);
    });

    it('resets experiments without re-seeding starter records', async () => {
      await ensureLocalDataReady();
      expect((await listExperiments()).length).toBe(2);

      await resetExperiments();
      expect((await listExperiments()).length).toBe(0);

      // Re-running ensureLocalDataReady or listing must NOT recreate the seeds!
      await ensureLocalDataReady();
      const list = await listExperiments();
      expect(list.length).toBe(0);
    });
  });

  // =========================================================================
  // 3. Separate Experiment Photos vs Result Photos Parity
  // =========================================================================
  describe('Photo Isolation Parity', () => {
    it('preserves experiment-level photos and result-level photos separately without mixing', async () => {
      const expPhoto1: ExperimentPhotoAsset = {
        id: 'exp-photo-1',
        uri: 'file:///data/photos/tray-setup.jpg',
        fileName: 'tray-setup.jpg',
        mimeType: 'image/jpeg',
        width: 1920,
        height: 1080,
      };

      const resultPhoto1: ExperimentPhotoAsset = {
        id: 'res-photo-1',
        uri: 'file:///data/photos/day3-height.jpg',
        fileName: 'day3-height.jpg',
        mimeType: 'image/jpeg',
        width: 1280,
        height: 720,
      };

      const resultEntry: ExperimentResultEntry = {
        id: 'result-entry-1',
        recordedAt: '2026-11-11T10:00:00.000Z',
        notes: 'Sprouts reached 4cm height',
        photoAssets: [resultPhoto1],
      };

      const input: ExperimentInput = {
        title: 'Photo separation test',
        category: 'Botany',
        hypothesis: 'Separation of photos',
        procedure: 'Take setup photo and result photo',
        dataPlan: 'Compare asset lists',
        observationsNotes: 'Photos attached',
        resultEntries: [resultEntry],
        notes: 'Attached 1 exp photo and 1 result photo',
        conclusionNotes: '',
        plannedAttachmentCount: 2,
        photoAssets: [expPhoto1],
      };

      const created = await createExperiment(input, { id: 'photo-test-exp' });

      expect(created.photoAssets.length).toBe(1);
      expect(created.photoAssets[0].id).toBe('exp-photo-1');
      expect(created.photoAssets[0].uri).toBe('file:///data/photos/tray-setup.jpg');

      expect(created.resultEntries.length).toBe(1);
      expect(created.resultEntries[0].photoAssets.length).toBe(1);
      expect(created.resultEntries[0].photoAssets[0].id).toBe('res-photo-1');
      expect(created.resultEntries[0].photoAssets[0].uri).toBe('file:///data/photos/day3-height.jpg');

      // Add another result with its own photos and update experiment
      const resultPhoto2: ExperimentPhotoAsset = {
        id: 'res-photo-2',
        uri: 'file:///data/photos/day7-final.jpg',
        fileName: 'day7-final.jpg',
        mimeType: 'image/jpeg',
        width: 1920,
        height: 1080,
      };

      const updated = await updateExperiment('photo-test-exp', {
        ...input,
        resultEntries: [
          resultEntry,
          {
            id: 'result-entry-2',
            recordedAt: '2026-11-11T14:00:00.000Z',
            notes: 'Final day harvest',
            photoAssets: [resultPhoto2],
          },
        ],
      });

      expect(updated?.photoAssets.length).toBe(1);
      expect(updated?.photoAssets[0].id).toBe('exp-photo-1');
      expect(updated?.resultEntries.length).toBe(2);
      expect(updated?.resultEntries[0].photoAssets[0].id).toBe('res-photo-1');
      expect(updated?.resultEntries[1].photoAssets[0].id).toBe('res-photo-2');
    });
  });

  // =========================================================================
  // 4. Actual Disk-Backed SQLite Storage Tests
  // =========================================================================
  describe('Actual Disk-Backed SQLite Storage Operations', () => {
    let sqliteStorage: Storage;
    let dbPath: string;

    beforeEach(() => {
      dbPath = path.join(tempDir, 'test-experiments.db');
      sqliteStorage = createRealSqliteStorage(dbPath);
    });

    it('bootstraps seed records into actual SQLite database file', async () => {
      const store = new ExperimentStore(sqliteStorage, { backend: 'sqlite' });
      await store.ensureReady();

      const list = await store.listExperiments();
      expect(list.length).toBe(2);
      expect(list[0].id).toBe('experiment-seed-1');
      expect(list[1].id).toBe('experiment-seed-2');

      // Verify file was physically written to disk
      const stats = await fs.stat(dbPath);
      expect(stats.size).toBeGreaterThan(0);
    });

    it('performs CRUD operations and status updates on SQLite database', async () => {
      const store = new ExperimentStore(sqliteStorage, { backend: 'sqlite' });

      // Create
      const created = await store.createExperiment(
        {
          title: 'SQLite Thermal Conductivity',
          category: 'Physics',
          hypothesis: 'Copper conducts faster than aluminum.',
          procedure: 'Apply heat source and measure temperature.',
          dataPlan: 'Thermocouple every 10s.',
          observationsNotes: 'Rapid heat transfer observed.',
          resultEntries: [
            {
              id: 'sql-res-1',
              recordedAt: '2026-11-11T11:00:00.000Z',
              notes: 'Copper reached 80C at 30s',
              photoAssets: [
                {
                  id: 'p-sql-1',
                  uri: 'file:///photo/cu.png',
                  fileName: 'cu.png',
                  mimeType: 'image/png',
                  width: 800,
                  height: 600,
                },
              ],
            },
          ],
          notes: 'Wear protective visor',
          conclusionNotes: 'Copper confirmed faster',
          plannedAttachmentCount: 1,
          photoAssets: [],
        },
        { id: 'exp-sql-1', now: '2026-11-11T11:00:00.000Z' }
      );

      expect(created.id).toBe('exp-sql-1');

      // Read by ID
      const fetched = await store.getExperimentById('exp-sql-1');
      expect(fetched?.title).toBe('SQLite Thermal Conductivity');
      expect(fetched?.conclusionNotes).toBe('Copper confirmed faster');
      expect(fetched?.resultEntries.length).toBe(1);
      expect(fetched?.resultEntries[0].photoAssets[0].id).toBe('p-sql-1');

      // Update
      const updated = await store.updateExperiment(
        'exp-sql-1',
        {
          title: 'SQLite Thermal Conductivity (Finalized)',
          category: 'Materials Science',
          hypothesis: 'Copper conducts faster than aluminum.',
          procedure: 'Apply heat source and measure temperature.',
          dataPlan: 'Thermocouple every 10s.',
          observationsNotes: 'Completed test run.',
          resultEntries: fetched!.resultEntries,
          notes: 'Test completed safely',
          conclusionNotes: 'Conductivity difference statistically significant',
          plannedAttachmentCount: 2,
          photoAssets: [],
        },
        { now: '2026-11-11T12:00:00.000Z' }
      );

      expect(updated?.title).toBe('SQLite Thermal Conductivity (Finalized)');
      expect(updated?.category).toBe('Materials Science');
      expect(updated?.updatedAt).toBe('2026-11-11T12:00:00.000Z');

      // Status
      const completed = await store.updateExperimentStatus('exp-sql-1', 'complete', {
        now: '2026-11-11T12:30:00.000Z',
      });
      expect(completed?.status).toBe('complete');

      // Delete
      await store.deleteExperiments(['exp-sql-1']);
      const afterDelete = await store.getExperimentById('exp-sql-1');
      expect(afterDelete).toBeNull();
    });

    it('reset on SQLite clears table and preserves bootstrap sentinel', async () => {
      const store = new ExperimentStore(sqliteStorage, { backend: 'sqlite' });
      await store.ensureReady();
      expect((await store.listExperiments()).length).toBe(2);

      await store.resetExperiments();
      expect((await store.listExperiments()).length).toBe(0);

      // Subsequent store instance on same DB stays empty (no reseeding)
      const freshStoreInstance = new ExperimentStore(sqliteStorage, { backend: 'sqlite' });
      await freshStoreInstance.ensureReady();
      expect((await freshStoreInstance.listExperiments()).length).toBe(0);
    });

    it('handles high concurrency operations without locking failure via serialized queue', async () => {
      const store = new ExperimentStore(sqliteStorage, { backend: 'sqlite' });
      await store.ensureReady();

      // Launch 15 concurrent creations and updates simultaneously
      const promises = Array.from({ length: 15 }, (_, i) =>
        store.createExperiment(
          {
            title: `Concurrent Exp ${i}`,
            category: 'Concurrency',
            hypothesis: `Test lock handling ${i}`,
            procedure: 'Simultaneous writes',
            dataPlan: 'Check completion',
            observationsNotes: '',
            resultEntries: [],
            notes: '',
            conclusionNotes: '',
            plannedAttachmentCount: 0,
            photoAssets: [],
          },
          { id: `concurrent-exp-${i}`, now: `2026-11-11T12:${String(i).padStart(2, '0')}:00.000Z` }
        )
      );

      const results = await Promise.all(promises);
      expect(results.length).toBe(15);

      const all = await store.listExperiments();
      expect(all.length).toBe(17); // 2 seed + 15 created
    });
  });

  // =========================================================================
  // 5. Actual Disk-Backed FileSystem Storage Tests
  // =========================================================================
  describe('Actual Disk-Backed FileSystem Storage Operations', () => {
    let fsStorage: Storage;
    let getFilePath: (rel: string) => string;

    beforeEach(() => {
      const helper = createRealFsStorage(tempDir);
      fsStorage = helper.storage;
      getFilePath = helper.getFilePath;
    });

    it('bootstraps seed records into actual JSON file on disk via atomicWriteFile', async () => {
      const store = new ExperimentStore(fsStorage, { backend: 'fs' });
      await store.ensureReady();

      const list = await store.listExperiments();
      expect(list.length).toBe(2);

      // Verify the json file exists and contains valid JSON
      const targetFile = getFilePath('app:/data/experiments.json');
      const content = await fs.readFile(targetFile, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.bootstrapped).toBe(true);
      expect(parsed.experiments.length).toBe(2);
      expect(parsed.experiments[0].id).toBe('experiment-seed-1');
    });

    it('survives reloads and keeps state persistent across new store instances', async () => {
      const store1 = new ExperimentStore(fsStorage, { backend: 'fs' });
      await store1.createExperiment(
        {
          title: 'FileSystem Persisted Record',
          category: 'Storage',
          hypothesis: 'Data survives process restart',
          procedure: 'Write then instantiate new store',
          dataPlan: 'Check length and content',
          observationsNotes: '',
          resultEntries: [],
          notes: '',
          conclusionNotes: '',
          plannedAttachmentCount: 0,
          photoAssets: [],
        },
        { id: 'fs-persisted-1', now: '2026-11-11T13:00:00.000Z' }
      );

      // Create a completely new store instance pointing to same fs
      const store2 = new ExperimentStore(fsStorage, { backend: 'fs' });
      const record = await store2.getExperimentById('fs-persisted-1');
      expect(record).not.toBeNull();
      expect(record?.title).toBe('FileSystem Persisted Record');

      const all = await store2.listExperiments();
      expect(all.length).toBe(3);
    });

    it('reset on FileSystem empties JSON experiments array and preserves bootstrapped flag', async () => {
      const store = new ExperimentStore(fsStorage, { backend: 'fs' });
      await store.ensureReady();
      await store.resetExperiments();

      const list = await store.listExperiments();
      expect(list.length).toBe(0);

      // Check file content directly
      const targetFile = getFilePath('app:/data/experiments.json');
      const content = await fs.readFile(targetFile, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.bootstrapped).toBe(true);
      expect(parsed.experiments).toEqual([]);

      // New store instance doesn't re-seed
      const freshStore = new ExperimentStore(fsStorage, { backend: 'fs' });
      expect((await freshStore.listExperiments()).length).toBe(0);
    });
  });

  // =========================================================================
  // 6. Resilient Fallback & Error Handling Tests
  // =========================================================================
  describe('Resilience and Safe Fallback', () => {
    it('gracefully falls back to in-memory store if storage throws bake error', async () => {
      const failingStorage: Storage = {
        sqlite: {
          async open() {
            const err = new Error('storage is unavailable during bake');
            (err as unknown as { code: string }).code = 'bake';
            throw err;
          },
        },
      };

      const store = new ExperimentStore(failingStorage, { backend: 'sqlite' });
      // Should not throw!
      const list = await store.listExperiments();
      expect(list.length).toBe(2);
      expect(list[0].id).toBe('experiment-seed-1');
    });

    it('gracefully falls back to in-memory store if storage throws denied error', async () => {
      const failingStorage: Storage = {
        fs: {
          async readFile() {
            const err = new Error('outside app grants (fs.read)');
            (err as unknown as { code: string }).code = 'denied';
            throw err;
          },
          async atomicWriteFile() {
            const err = new Error('outside app grants (fs.write)');
            (err as unknown as { code: string }).code = 'denied';
            throw err;
          },
        },
      };

      const store = new ExperimentStore(failingStorage, { backend: 'fs' });
      const list = await store.listExperiments();
      expect(list.length).toBe(2);
    });
  });
});
