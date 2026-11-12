/**
 * @file experiment-photos.test.ts
 *
 * Comprehensive test suite for the Exact photo selection and durable file handling foundation.
 * Validates:
 * 1. Reference parity with `photo-picker.ts` (uniqueByUri, appendPickedAssets, cancellation, mapping).
 * 2. Deterministic ID and clock requirements (no ambient Date or Math.random).
 * 3. Durable FileSystem storage operations (ephemeral tmp to persistent data copy, mkdir, stat, delete).
 * 4. Separate experiment and result photo metadata isolation.
 * 5. Camera capabilities, permission enforcement, and explicit platform limitations.
 * 6. Build bake write refusal handling.
 * 7. End-to-end integration with experiment-data foundation.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  uniquePhotoAssets,
  appendPhotoAssets,
  removePhotoAssetById,
  removePhotoAssetByUri,
  validatePhotoAsset,
  assertValidPhotoAsset,
  handlePhotoPickerCancellation,
  extractExtension,
  resolvePhotoExtension,
  sanitizeFileName,
  ensurePhotosDirectory,
  persistPickedPhoto,
  persistPickedPhotos,
  persistCameraPhoto,
  deleteDurablePhotoFile,
  deleteDurablePhotoFiles,
  readDurablePhotoFile,
  attachExperimentPhotos,
  removeExperimentPhoto,
  attachResultPhotos,
  removeResultPhoto,
  attachPhotosToExperimentInput,
  removePhotoFromExperimentInput,
  extractAllExperimentPhotos,
  addPickedPhotosToExperiment,
  addPickedPhotosToResultEntry,
  checkCameraPlatformSupport,
  assertCameraReady,
  DEFAULT_PHOTOS_DIR,
  EXPERIMENT_PHOTO_GRANTS,
  PhotoError,
  PhotoPermissionError,
  PhotoPlatformLimitationError,
  PhotoStorageError,
  PhotoValidationError,
  type ExactPickedPhoto,
  type ExactCameraPhoto,
  type CameraStatusInfo,
  type PhotoStorage,
  type ExactPhotoFileSystem,
} from './experiment-photos';

import {
  createExperiment,
  getExperimentById,
  type ExperimentInput,
  type ExperimentPhotoAsset,
  type ExperimentRecord,
  type ExperimentResultEntry,
  type Storage as DataStorage,
} from './experiment-store.ts';

// ---------------------------------------------------------------------------
// Test Storage Harness (Disk-Backed FileSystem Simulation)
// ---------------------------------------------------------------------------

interface TestFsContext {
  storage: PhotoStorage & DataStorage;
  tempDir: string;
  createSourceFile: (subPath: string, content?: string | Uint8Array) => Promise<string>;
  readDurableFile: (destUri: string) => Promise<string>;
  fileExists: (exactPath: string) => Promise<boolean>;
}

async function createTestFsContext(): Promise<TestFsContext> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'experimemo-photos-test-'));

  const resolvePath = (exactPath: string): string => {
    // Map app:/data/... and app:/tmp/... to local isolated directories
    const clean = exactPath.replace(/^app:\//, '');
    return path.join(tempDir, clean);
  };

  const fileSystem: ExactPhotoFileSystem = {
    async readFile(exactPath: string): Promise<ArrayBuffer> {
      const p = resolvePath(exactPath);
      const buf = await fs.readFile(p);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },

    async writeFile(exactPath: string, data: ArrayBuffer | Uint8Array): Promise<void> {
      const p = resolvePath(exactPath);
      await fs.mkdir(path.dirname(p), { recursive: true });
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await fs.writeFile(p, bytes);
    },

    async atomicWriteFile(exactPath: string, data: ArrayBuffer | Uint8Array): Promise<void> {
      const p = resolvePath(exactPath);
      await fs.mkdir(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${Math.round(Math.random() * 1000000)}`;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, p);
    },

    async copyFile(from: string, to: string): Promise<void> {
      const src = resolvePath(from);
      const dst = resolvePath(to);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    },

    async stat(exactPath: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean }> {
      const p = resolvePath(exactPath);
      const s = await fs.stat(p);
      return {
        size: s.size,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
      };
    },

    async mkdir(exactPath: string): Promise<void> {
      const p = resolvePath(exactPath);
      await fs.mkdir(p, { recursive: true });
    },

    async rm(exactPath: string): Promise<void> {
      const p = resolvePath(exactPath);
      try {
        await fs.unlink(p);
      } catch {
        // ignore ENOENT
      }
    },

    async readdir(exactPath: string): Promise<string[]> {
      const p = resolvePath(exactPath);
      try {
        return await fs.readdir(p);
      } catch {
        return [];
      }
    },
  };

  const storage: PhotoStorage & DataStorage = {
    fs: fileSystem as any,
  };

  const createSourceFile = async (subPath: string, content = 'fake-image-binary-data'): Promise<string> => {
    const exactPath = `app:/tmp/${subPath}`;
    const fullPath = resolvePath(exactPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
    return exactPath;
  };

  const readDurableFile = async (destUri: string): Promise<string> => {
    const fullPath = resolvePath(destUri);
    return fs.readFile(fullPath, 'utf8');
  };

  const fileExists = async (exactPath: string): Promise<boolean> => {
    try {
      const fullPath = resolvePath(exactPath);
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  };

  return {
    storage,
    tempDir,
    createSourceFile,
    readDurableFile,
    fileExists,
  };
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe('Exact Photo Selection & Durable File Handling Foundation', () => {
  let ctx: TestFsContext;

  beforeEach(async () => {
    ctx = await createTestFsContext();
  });

  afterEach(async () => {
    try {
      await fs.rm(ctx.tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // =========================================================================
  // 1. Reference Parity with photo-picker.ts
  // =========================================================================
  describe('Reference Parity with photo-picker.ts', () => {
    it('uniquePhotoAssets deduplicates photo assets strictly by uri', () => {
      const assets: ExperimentPhotoAsset[] = [
        {
          id: 'p-1',
          uri: 'app:/data/photos/1.jpg',
          fileName: '1.jpg',
          mimeType: 'image/jpeg',
          width: 800,
          height: 600,
        },
        {
          id: 'p-2',
          uri: 'app:/data/photos/2.jpg',
          fileName: '2.jpg',
          mimeType: 'image/jpeg',
          width: 1024,
          height: 768,
        },
        {
          id: 'p-3',
          uri: 'app:/data/photos/1.jpg', // duplicate URI with different ID
          fileName: 'duplicate.jpg',
          mimeType: 'image/jpeg',
          width: 800,
          height: 600,
        },
      ];

      const result = uniquePhotoAssets(assets);
      expect(result.length).toBe(2);
      expect(result[0].id).toBe('p-1');
      expect(result[1].id).toBe('p-2');
    });

    it('appendPhotoAssets appends new assets and eliminates duplicate URIs', () => {
      const current: ExperimentPhotoAsset[] = [
        {
          id: 'p-1',
          uri: 'app:/data/photos/1.jpg',
          fileName: '1.jpg',
          mimeType: 'image/jpeg',
          width: 800,
          height: 600,
        },
      ];

      const incoming: ExperimentPhotoAsset[] = [
        {
          id: 'p-1-dup',
          uri: 'app:/data/photos/1.jpg',
          fileName: 'dup.jpg',
          mimeType: 'image/jpeg',
          width: 800,
          height: 600,
        },
        {
          id: 'p-2',
          uri: 'app:/data/photos/2.jpg',
          fileName: '2.jpg',
          mimeType: 'image/jpeg',
          width: 1200,
          height: 900,
        },
      ];

      const merged = appendPhotoAssets(current, incoming);
      expect(merged.length).toBe(2);
      expect(merged.map((p) => p.uri)).toEqual(['app:/data/photos/1.jpg', 'app:/data/photos/2.jpg']);
    });

    it('handlePhotoPickerCancellation preserves current photos unmodified', () => {
      const current: ExperimentPhotoAsset[] = [
        {
          id: 'p-1',
          uri: 'app:/data/photos/1.jpg',
          fileName: '1.jpg',
          mimeType: 'image/jpeg',
          width: 800,
          height: 600,
        },
      ];

      const afterCancel = handlePhotoPickerCancellation(current);
      expect(afterCancel).toEqual(current);
      expect(afterCancel).not.toBe(current); // fresh array reference
    });

    it('removes photos cleanly by id and by uri', () => {
      const photos: ExperimentPhotoAsset[] = [
        {
          id: 'p-1',
          uri: 'app:/data/photos/1.jpg',
          fileName: '1.jpg',
          mimeType: 'image/jpeg',
          width: 800,
          height: 600,
        },
        {
          id: 'p-2',
          uri: 'app:/data/photos/2.jpg',
          fileName: '2.jpg',
          mimeType: 'image/jpeg',
          width: 800,
          height: 600,
        },
      ];

      const byId = removePhotoAssetById(photos, 'p-1');
      expect(byId.length).toBe(1);
      expect(byId[0].id).toBe('p-2');

      const byUri = removePhotoAssetByUri(photos, 'app:/data/photos/2.jpg');
      expect(byUri.length).toBe(1);
      expect(byUri[0].id).toBe('p-1');
    });

    it('validates photo asset runtime schema strictly', () => {
      expect(
        validatePhotoAsset({
          id: 'p-1',
          uri: 'app:/data/photos/1.jpg',
          fileName: '1.jpg',
          mimeType: 'image/jpeg',
          width: 100,
          height: 100,
        })
      ).toBe(true);

      // missing id
      expect(validatePhotoAsset({ uri: 'x', fileName: null, mimeType: null, width: 0, height: 0 })).toBe(false);
      // missing uri
      expect(validatePhotoAsset({ id: '1', fileName: null, mimeType: null, width: 0, height: 0 })).toBe(false);
      // NaN dimension
      expect(validatePhotoAsset({ id: '1', uri: 'x', fileName: null, mimeType: null, width: NaN, height: 0 })).toBe(false);

      expect(() => assertValidPhotoAsset({ id: '' })).toThrow(PhotoValidationError);
    });
  });

  // =========================================================================
  // 2. Deterministic ID and Clock Enforcements
  // =========================================================================
  describe('Deterministic ID & Clock Requirements', () => {
    it('requires caller-supplied now timestamp for persistPickedPhotos', async () => {
      const picked: ExactPickedPhoto = {
        path: 'app:/tmp/picked/img.jpg',
        name: 'img.jpg',
      };

      await expect(
        persistPickedPhotos([picked], ctx.storage, {
          now: '',
          scope: 'experiment',
        })
      ).rejects.toThrow(PhotoValidationError);
    });

    it('requires caller-supplied now timestamp for persistCameraPhoto', async () => {
      const photo: ExactCameraPhoto = {
        path: 'app:/tmp/camera/shot.jpg',
      };

      await expect(
        persistCameraPhoto(photo, ctx.storage, {
          now: '',
          scope: 'experiment',
        })
      ).rejects.toThrow(PhotoValidationError);
    });

    it('generates fully deterministic asset IDs and filenames from now and scope', async () => {
      const src1 = await ctx.createSourceFile('picked/photo-a.jpg', 'img-a-content');
      const src2 = await ctx.createSourceFile('picked/photo-b.png', 'img-b-content');

      const picked: ExactPickedPhoto[] = [
        { path: src1, name: 'photo-a.jpg', width: 400, height: 300 },
        { path: src2, name: 'photo-b.png', width: 800, height: 600 },
      ];

      const now = '2026-11-11T12:00:00.000Z';
      const assets = await persistPickedPhotos(picked, ctx.storage, {
        now,
        scope: 'experiment',
        experimentId: 'exp-42',
      });

      expect(assets.length).toBe(2);
      expect(assets[0].id).toBe('photo-exp-exp-42-2026-11-11T12-00-00-000Z-0');
      expect(assets[0].uri).toBe('app:/data/photos/photo-exp-exp-42-2026-11-11T12-00-00-000Z-0.jpg');
      expect(assets[1].id).toBe('photo-exp-exp-42-2026-11-11T12-00-00-000Z-1');
      expect(assets[1].uri).toBe('app:/data/photos/photo-exp-exp-42-2026-11-11T12-00-00-000Z-1.png');
    });

    it('supports custom deterministic ID generator function', async () => {
      const src = await ctx.createSourceFile('picked/photo.jpg', 'content');
      const picked: ExactPickedPhoto = { path: src, name: 'photo.jpg' };

      const assets = await persistPickedPhotos([picked], ctx.storage, {
        now: '2026-11-11T12:00:00.000Z',
        scope: 'result',
        generateId: (index, scope) => `custom-${scope}-${index}`,
      });

      expect(assets[0].id).toBe('custom-result-0');
      expect(assets[0].uri).toBe('app:/data/photos/custom-result-0.jpg');
    });
  });

  // =========================================================================
  // 3. Durable File Storage & Copying Operations
  // =========================================================================
  describe('Durable File Storage Operations', () => {
    it('copies ephemeral picked file into durable persistent app:/data/photos path', async () => {
      const content = 'actual-jpeg-bytes-data';
      const srcPath = await ctx.createSourceFile('picked/sample.jpg', content);

      const picked: ExactPickedPhoto = {
        path: srcPath,
        name: 'sample.jpg',
        mime: 'image/jpeg',
        width: 1920,
        height: 1080,
      };

      const now = '2026-11-11T14:00:00.000Z';
      const asset = await persistPickedPhoto(picked, ctx.storage, {
        now,
        id: 'durable-test-1',
      });

      expect(asset.id).toBe('durable-test-1');
      expect(asset.uri).toBe('app:/data/photos/durable-test-1.jpg');
      expect(asset.fileName).toBe('sample.jpg');
      expect(asset.mimeType).toBe('image/jpeg');
      expect(asset.width).toBe(1920);
      expect(asset.height).toBe(1080);

      // Verify the durable copy was physically written to disk
      const persistedContent = await ctx.readDurableFile(asset.uri);
      expect(persistedContent).toBe(content);
    });

    it('falls back to atomic write when copyFile is not available', async () => {
      const content = 'atomic-write-fallback-data';
      const srcPath = await ctx.createSourceFile('picked/fallback.png', content);

      // Create storage without copyFile
      const noCopyStorage: PhotoStorage = {
        fs: {
          readFile: ctx.storage.fs!.readFile.bind(ctx.storage.fs),
          atomicWriteFile: ctx.storage.fs!.atomicWriteFile!.bind(ctx.storage.fs),
          stat: ctx.storage.fs!.stat!.bind(ctx.storage.fs),
          mkdir: ctx.storage.fs!.mkdir!.bind(ctx.storage.fs),
        },
      };

      const asset = await persistPickedPhoto(
        { path: srcPath, name: 'fallback.png', mime: 'image/png' },
        noCopyStorage,
        { now: '2026-11-11T14:00:00.000Z', id: 'fallback-1' }
      );

      expect(asset.uri).toBe('app:/data/photos/fallback-1.png');
      const persisted = await ctx.readDurableFile(asset.uri);
      expect(persisted).toBe(content);
    });

    it('throws FILE_NOT_FOUND when source file does not exist', async () => {
      const picked: ExactPickedPhoto = {
        path: 'app:/tmp/picked/non-existent.jpg',
        name: 'non-existent.jpg',
      };

      await expect(
        persistPickedPhoto(picked, ctx.storage, {
          now: '2026-11-11T14:00:00.000Z',
          id: 'missing-test',
        })
      ).rejects.toThrow(PhotoStorageError);
    });

    it('throws CORRUPT_MEDIA when source file is empty (0 bytes)', async () => {
      const emptySrc = await ctx.createSourceFile('picked/empty.jpg', '');

      const picked: ExactPickedPhoto = {
        path: emptySrc,
        name: 'empty.jpg',
      };

      await expect(
        persistPickedPhoto(picked, ctx.storage, {
          now: '2026-11-11T14:00:00.000Z',
          id: 'empty-test',
        })
      ).rejects.toThrow(PhotoValidationError);
    });

    it('persists camera capture into durable storage', async () => {
      const cameraBytes = 'camera-capture-raw-jpeg-stream';
      const camSrc = await ctx.createSourceFile('camera/shutter-001.jpg', cameraBytes);

      const cameraPhoto: ExactCameraPhoto = {
        path: camSrc,
        type: 'image/jpeg',
        width: 4032,
        height: 3024,
      };

      const asset = await persistCameraPhoto(cameraPhoto, ctx.storage, {
        now: '2026-11-11T14:30:00.000Z',
        scope: 'experiment',
        experimentId: 'exp-camera-1',
      });

      expect(asset.uri).toContain('app:/data/photos/');
      expect(asset.width).toBe(4032);
      expect(asset.height).toBe(3024);

      const persisted = await ctx.readDurableFile(asset.uri);
      expect(persisted).toBe(cameraBytes);

      const readback = await readDurablePhotoFile(ctx.storage, asset.uri);
      expect(readback.byteLength).toBe(cameraBytes.length);
    });

    it('deletes durable photo files from disk cleanly', async () => {
      const src = await ctx.createSourceFile('picked/delete-me.jpg', 'to-be-deleted');
      const asset = await persistPickedPhoto(
        { path: src, name: 'delete-me.jpg' },
        ctx.storage,
        { now: '2026-11-11T14:00:00.000Z', id: 'del-1' }
      );

      expect(await ctx.fileExists(asset.uri)).toBe(true);

      const deleted = await deleteDurablePhotoFile(ctx.storage, asset.uri);
      expect(deleted).toBe(true);
      expect(await ctx.fileExists(asset.uri)).toBe(false);

      // Multiple deletion helper
      const src2 = await ctx.createSourceFile('picked/delete-me-2.jpg', 'to-be-deleted-2');
      const asset2 = await persistPickedPhoto(
        { path: src2, name: 'delete-me-2.jpg' },
        ctx.storage,
        { now: '2026-11-11T14:00:00.000Z', id: 'del-2' }
      );
      expect(await ctx.fileExists(asset2.uri)).toBe(true);

      const count = await deleteDurablePhotoFiles(ctx.storage, [asset, asset2]);
      expect(count).toBe(1); // asset was already deleted, asset2 was deleted now
      expect(await ctx.fileExists(asset2.uri)).toBe(false);
    });
  });

  // =========================================================================
  // 4. Separate Experiment and Result Photo Metadata
  // =========================================================================
  describe('Separate Experiment & Result Photo Metadata', () => {
    it('attaches and removes experiment-level photos without cross-contaminating result entries', () => {
      const expPhoto1: ExperimentPhotoAsset = {
        id: 'exp-p1',
        uri: 'app:/data/photos/exp1.jpg',
        fileName: 'exp1.jpg',
        mimeType: 'image/jpeg',
        width: 100,
        height: 100,
      };

      const resPhoto1: ExperimentPhotoAsset = {
        id: 'res-p1',
        uri: 'app:/data/photos/res1.jpg',
        fileName: 'res1.jpg',
        mimeType: 'image/jpeg',
        width: 200,
        height: 200,
      };

      const input: ExperimentInput = {
        title: 'Light Condition Test',
        category: 'Botany',
        hypothesis: 'Hypothesis',
        procedure: 'Procedure',
        dataPlan: 'Data Plan',
        observationsNotes: '',
        resultEntries: [
          {
            id: 'result-1',
            recordedAt: '2026-11-11T12:00:00.000Z',
            notes: 'First sprout observed',
            photoAssets: [resPhoto1],
          },
        ],
        notes: '',
        conclusionNotes: '',
        plannedAttachmentCount: 1,
        photoAssets: [expPhoto1],
      };

      // 1. Add experiment photo
      const expPhoto2: ExperimentPhotoAsset = {
        id: 'exp-p2',
        uri: 'app:/data/photos/exp2.jpg',
        fileName: 'exp2.jpg',
        mimeType: 'image/jpeg',
        width: 300,
        height: 300,
      };
      const updatedInput = attachPhotosToExperimentInput(input, [expPhoto2]);
      expect(updatedInput.photoAssets.length).toBe(2);
      // Result entry photoAssets remain isolated and untouched
      expect(updatedInput.resultEntries[0].photoAssets.length).toBe(1);
      expect(updatedInput.resultEntries[0].photoAssets[0].id).toBe('res-p1');

      // 2. Remove experiment photo
      const removedInput = removePhotoFromExperimentInput(updatedInput, 'exp-p1');
      expect(removedInput.photoAssets.length).toBe(1);
      expect(removedInput.photoAssets[0].id).toBe('exp-p2');
      expect(removedInput.resultEntries[0].photoAssets[0].id).toBe('res-p1');
    });

    it('attaches and removes result-level photos on specific result entries', () => {
      const entry: ExperimentResultEntry = {
        id: 'res-entry-1',
        recordedAt: '2026-11-11T13:00:00.000Z',
        notes: 'Initial day 1 notes',
        photoAssets: [],
      };

      const photoA: ExperimentPhotoAsset = {
        id: 'p-a',
        uri: 'app:/data/photos/a.jpg',
        fileName: 'a.jpg',
        mimeType: 'image/jpeg',
        width: 500,
        height: 500,
      };
      const photoB: ExperimentPhotoAsset = {
        id: 'p-b',
        uri: 'app:/data/photos/b.jpg',
        fileName: 'b.jpg',
        mimeType: 'image/jpeg',
        width: 600,
        height: 600,
      };

      const withPhotos = attachResultPhotos(entry, [photoA, photoB]);
      expect(withPhotos.photoAssets.length).toBe(2);
      expect(withPhotos.photoAssets[0].id).toBe('p-a');
      expect(withPhotos.photoAssets[1].id).toBe('p-b');

      const afterRemove = removeResultPhoto(withPhotos, 'p-a');
      expect(afterRemove.photoAssets.length).toBe(1);
      expect(afterRemove.photoAssets[0].id).toBe('p-b');
    });

    it('extractAllExperimentPhotos separates experiment-level and result-level photos accurately', () => {
      const expPhoto: ExperimentPhotoAsset = {
        id: 'exp-1',
        uri: 'app:/data/photos/exp-1.jpg',
        fileName: 'exp-1.jpg',
        mimeType: 'image/jpeg',
        width: 100,
        height: 100,
      };
      const resPhoto1: ExperimentPhotoAsset = {
        id: 'res-1',
        uri: 'app:/data/photos/res-1.jpg',
        fileName: 'res-1.jpg',
        mimeType: 'image/jpeg',
        width: 200,
        height: 200,
      };
      const resPhoto2: ExperimentPhotoAsset = {
        id: 'res-2',
        uri: 'app:/data/photos/res-2.jpg',
        fileName: 'res-2.jpg',
        mimeType: 'image/jpeg',
        width: 300,
        height: 300,
      };

      const experiment: ExperimentRecord = {
        id: 'exp-test',
        title: 'Title',
        category: 'Physics',
        hypothesis: 'Hypothesis',
        procedure: 'Procedure',
        dataPlan: 'DataPlan',
        observationsNotes: '',
        resultEntries: [
          {
            id: 'entry-1',
            recordedAt: '2026-11-11T10:00:00.000Z',
            notes: 'n1',
            photoAssets: [resPhoto1],
          },
          {
            id: 'entry-2',
            recordedAt: '2026-11-11T11:00:00.000Z',
            notes: 'n2',
            photoAssets: [resPhoto2],
          },
        ],
        notes: '',
        conclusionNotes: '',
        plannedAttachmentCount: 0,
        photoAssets: [expPhoto],
        status: 'active',
        createdAt: '2026-11-11T09:00:00.000Z',
        updatedAt: '2026-11-11T11:00:00.000Z',
      };

      const extracted = extractAllExperimentPhotos(experiment);
      expect(extracted.experimentPhotos.length).toBe(1);
      expect(extracted.experimentPhotos[0].id).toBe('exp-1');

      expect(extracted.resultPhotos.length).toBe(2);
      expect(extracted.resultPhotos.map((p) => p.id)).toEqual(['res-1', 'res-2']);

      expect(extracted.all.length).toBe(3);
    });
  });

  // =========================================================================
  // 5. Camera & Permissions Verification & Platform Limitations
  // =========================================================================
  describe('Camera Verification & Platform Limitations', () => {
    it('accurately identifies supported and unsupported platforms according to Exact APIs', () => {
      expect(checkCameraPlatformSupport('apple').supported).toBe(true);
      expect(checkCameraPlatformSupport('ios').supported).toBe(true);
      expect(checkCameraPlatformSupport('macos').supported).toBe(true);
      expect(checkCameraPlatformSupport('android').supported).toBe(true);
      expect(checkCameraPlatformSupport('web').supported).toBe(true);

      const linux = checkCameraPlatformSupport('linux');
      expect(linux.supported).toBe(false);
      expect(linux.reason).toContain('Exact2 (@exact/camera has no linux target)');

      const windows = checkCameraPlatformSupport('windows');
      expect(windows.supported).toBe(false);
      expect(windows.reason).toContain('Exact2 (@exact/camera has no windows target)');
    });

    it('assertCameraReady throws PhotoPlatformLimitationError on unsupported platform', () => {
      const status: CameraStatusInfo = { available: true, state: 'granted' };
      expect(() => assertCameraReady(status, 'linux')).toThrow(PhotoPlatformLimitationError);
      expect(() => assertCameraReady(status, 'windows')).toThrow(PhotoPlatformLimitationError);
    });

    it('assertCameraReady throws PhotoPermissionError when permission is denied', () => {
      const status: CameraStatusInfo = { available: true, state: 'denied' };
      expect(() => assertCameraReady(status, 'web')).toThrow(PhotoPermissionError);
      expect(() => assertCameraReady(status, 'ios')).toThrow(PhotoPermissionError);
    });

    it('assertCameraReady throws PhotoPlatformLimitationError when camera is not available on device', () => {
      const status: CameraStatusInfo = { available: false, state: 'granted' };
      expect(() => assertCameraReady(status, 'web')).toThrow(PhotoPlatformLimitationError);
    });

    it('assertCameraReady succeeds when camera is available and granted on supported platform', () => {
      const status: CameraStatusInfo = { available: true, state: 'granted' };
      expect(() => assertCameraReady(status, 'web')).not.toThrow();
      expect(() => assertCameraReady(status, 'ios')).not.toThrow();
    });

    it('exports EXPERIMENT_PHOTO_GRANTS containing filesystem grants', () => {
      expect(EXPERIMENT_PHOTO_GRANTS).toContain('fs.read app:/tmp');
      expect(EXPERIMENT_PHOTO_GRANTS).toContain('fs.read app:/data/photos');
      expect(EXPERIMENT_PHOTO_GRANTS).toContain('fs.write app:/data/photos');
      expect(EXPERIMENT_PHOTO_GRANTS).not.toContain('device.camera');
    });
  });

  // =========================================================================
  // 6. Build Bake Handling
  // =========================================================================
  describe('Build Bake Safety', () => {
    it('refuses durable photo writes during build bake', async () => {
      const src = await ctx.createSourceFile('picked/bake.jpg', 'data');
      const bakeStorage: PhotoStorage = {
        fs: {
          readFile: async () => new ArrayBuffer(10),
          mkdir: async () => {
            const err = new Error('Build bake read-only');
            (err as any).code = 'bake';
            throw err;
          },
          copyFile: async () => {
            const err = new Error('Build bake read-only');
            (err as any).code = 'bake';
            throw err;
          },
        },
      };

      await expect(
        persistPickedPhoto({ path: src, name: 'bake.jpg' }, bakeStorage, {
          now: '2026-11-11T12:00:00.000Z',
          id: 'bake-test',
        })
      ).rejects.toThrow(PhotoStorageError);
    });
  });

  // =========================================================================
  // 7. High-Level Orchestration & Integration with Experiment Store
  // =========================================================================
  describe('High-Level Orchestration with Experiment Data', () => {
    it('addPickedPhotosToExperiment imports picked photos and returns deduplicated array', async () => {
      const src1 = await ctx.createSourceFile('picked/step1.jpg', 'img1-data');
      const src2 = await ctx.createSourceFile('picked/step2.png', 'img2-data');

      const existing: ExperimentPhotoAsset[] = [];
      const picked: ExactPickedPhoto[] = [
        { path: src1, name: 'step1.jpg', width: 640, height: 480 },
        { path: src2, name: 'step2.png', width: 800, height: 600 },
      ];

      const now = '2026-11-11T15:00:00.000Z';
      const result = await addPickedPhotosToExperiment(existing, picked, ctx.storage, {
        now,
        experimentId: 'exp-99',
      });

      expect(result.length).toBe(2);
      expect(result[0].fileName).toBe('step1.jpg');
      expect(result[1].fileName).toBe('step2.png');
      expect(await ctx.fileExists(result[0].uri)).toBe(true);
      expect(await ctx.fileExists(result[1].uri)).toBe(true);
    });

    it('addPickedPhotosToResultEntry imports photos and updates the entry safely', async () => {
      const src = await ctx.createSourceFile('picked/result-specimen.jpg', 'specimen-data');
      const entry: ExperimentResultEntry = {
        id: 'result-entry-55',
        recordedAt: '2026-11-11T15:30:00.000Z',
        notes: 'Specimen under magnification',
        photoAssets: [],
      };

      const now = '2026-11-11T15:35:00.000Z';
      const updatedEntry = await addPickedPhotosToResultEntry(
        entry,
        [{ path: src, name: 'result-specimen.jpg', width: 1200, height: 900 }],
        ctx.storage,
        { now, experimentId: 'exp-99' }
      );

      expect(updatedEntry.photoAssets.length).toBe(1);
      expect(updatedEntry.photoAssets[0].id).toContain('photo-res-result-entry-55');
      expect(await ctx.fileExists(updatedEntry.photoAssets[0].uri)).toBe(true);
    });

    it('integrates seamlessly with createExperiment from the experiment store', async () => {
      const src = await ctx.createSourceFile('picked/setup.jpg', 'setup-bytes');

      const now = '2026-11-11T16:00:00.000Z';
      const importedPhotos = await persistPickedPhotos(
        [{ path: src, name: 'setup.jpg', width: 1024, height: 768 }],
        ctx.storage,
        { now, scope: 'experiment', experimentId: 'flow-test' }
      );

      const input: ExperimentInput = {
        title: 'Thermal Dissipation in Copper',
        category: 'Physics',
        hypothesis: 'Copper will dissipate heat 2x faster than iron.',
        procedure: 'Heat both rods to 80C and measure cooling curve.',
        dataPlan: 'Infrared thermometer every 30s.',
        observationsNotes: '',
        resultEntries: [],
        notes: 'Initial test setup photographed.',
        conclusionNotes: '',
        plannedAttachmentCount: 1,
        photoAssets: importedPhotos,
      };

      // The working store takes the editor's fields; photos ride in the options.
      const created = await createExperiment(input, ctx.storage, {
        id: 'exp-flow-1',
        now,
        photoAssets: input.photoAssets,
      });

      expect(created.id).toBe('exp-flow-1');
      expect(created.photoAssets.length).toBe(1);
      expect(created.photoAssets[0].uri).toBe(importedPhotos[0].uri);

      // Verify retrieval
      const fetched = await getExperimentById('exp-flow-1', ctx.storage);
      expect(fetched).not.toBeNull();
      expect(fetched!.photoAssets.length).toBe(1);
      expect(fetched!.photoAssets[0].fileName).toBe('setup.jpg');
    });
  });
});
