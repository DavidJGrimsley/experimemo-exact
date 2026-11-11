# Data Foundation Task Record — Experimemo Exact Parity

**Owner:** Jam Session Data Manager (Codex)  
**Branch:** `codex/experimemo-data`  
**Workspace:** `F:\SoftwareDev\mrdj-dev-suite-i2Workspace\test-apps\experimemo-exact-i2Workspace\experimemo-exact-data`  
**Date:** 2026-11-11  

---

## 1. Objectives & Scope
Implement the data and persistence foundation for Experimemo in Exact, achieving full parity with the original reference (`F:/ReactNativeApps/experimemo/src/features/experiments/experiment-models.ts` and `src/services/local-data.native.ts`):
- Full experiment, result, and photo data shapes.
- Exact two original example seed records (`experiment-seed-1`, `experiment-seed-2`).
- Reusable data module `experiment-data.ts` callable cleanly from `app.ts`.
- Durable local storage operations via supported Exact storage APIs:
  - Bootstrap once with sentinel
  - List sorted by `updatedAt` descending
  - Get by ID
  - Create with default category 'General', status 'active', trimmed fields, deterministic ID/time support
  - Update with preserved status, updated timestamp, deterministic time support
  - Status toggle/update with updated timestamp, deterministic time support
  - Delete by IDs / single ID
  - Reset all experiments without re-seeding
- Safe error handling, zero accidental data loss, atomic writes / transactions, serialized concurrency.
- Preservation of distinct experiment-level and result-level photo assets.
- Separate owned test suites testing all operations against actual storage implementations.
- No modifications to `app.contract`, `app.ts`, `app.json`, or shared project memory (`project/todo.md`).

---

## 2. Requirements Checklist
- [x] Task record created in checkout (`task-record.md`)
- [x] Reference models inspected and verified (`experiment-models.ts`, `local-data.native.ts`)
- [x] Types defined:
  - `ExperimentStatus` ('active' | 'complete')
  - `ExperimentPhotoAsset` ({ id, uri, fileName, mimeType, width, height })
  - `ExperimentResultEntry` ({ id, recordedAt, notes, photoAssets })
  - `ExperimentRecord` (all 14 reference fields)
  - `ExperimentInput` (all 11 reference fields)
  - Options (`CreateExperimentOptions`, `UpdateExperimentOptions`, `StorageOptions`)
- [x] Exact two original seed records matched byte-for-byte:
  - `experiment-seed-1`: Bean sprouts under different light conditions (Example), Botany
  - `experiment-seed-2`: Cooling rate of metal versus glass containers (Example), Physics
- [x] Exact storage drivers:
  - SQLite driver (`app:/data/experiments.db` with `app_state` and `experiments` tables, migrations, serialized queue)
  - FileSystem driver (`app:/data/experiments.json` with atomic writes via `atomicWriteFile`)
  - In-memory fallback (when storage is unavailable or during build `bake`)
- [x] Core operations implemented:
  - `ensureLocalDataReady` / bootstrap once with sentinel
  - `listExperiments` (ordered by `updatedAt` DESC)
  - `getExperimentById`
  - `createExperiment`
  - `updateExperiment`
  - `updateExperimentStatus`
  - `deleteExperiments` / `deleteExperiment`
  - `resetExperiments` (no re-seeding)
- [x] Deterministic ID and timestamp support for testability
- [x] Distinct experiment photos vs result photos preserved
- [x] Clean integration exports and grant definitions (`EXPERIMENT_GRANTS`)
- [x] Comprehensive test suite in owned test file (`experiment-data.test.ts`)
- [x] Verification with `bun test` and storage tests:
  - 19 passed, 0 failed, 119 expect assertions across in-memory, real disk SQLite, real disk FileSystem, concurrency, and photo separation.
  - Exact `test web` passed (2 passed, 0 failed).
- [x] Clean git commit on `codex/experimemo-data`

---

## 3. Integration Guide for `app.ts`

### Grants Declaration
```ts
import { EXPERIMENT_GRANTS } from './experiment-data';

export const grants = EXPERIMENT_GRANTS;
```

### Sources Wiring
```ts
import {
  ensureLocalDataReady,
  listExperiments,
  getExperimentById,
  createExperiment,
  updateExperiment,
  updateExperimentStatus,
  deleteExperiments,
  resetExperiments,
  type ExperimentInput,
  type ExperimentStatus,
} from './experiment-data';

const sources: Sources = {
  loadExperiments: async (_args, _store, storage) => {
    return listExperiments(storage);
  },
  getExperiment: async ([id], _store, storage) => {
    return getExperimentById(id, storage);
  },
  addExperiment: async ([input], _store, storage) => {
    const created = await createExperiment(input, storage);
    return { ok: true, id: created.id };
  },
  saveExperiment: async ([id, input], _store, storage) => {
    const updated = await updateExperiment(id, input, storage);
    return { ok: Boolean(updated) };
  },
  toggleStatus: async ([id, status], _store, storage) => {
    const updated = await updateExperimentStatus(id, status as ExperimentStatus, storage);
    return { ok: Boolean(updated) };
  },
  removeExperiments: async ([ids], _store, storage) => {
    await deleteExperiments(ids, storage);
    return { ok: true };
  },
  resetAll: async (_args, _store, storage) => {
    await resetExperiments(storage);
    return { ok: true };
  },
};
```
