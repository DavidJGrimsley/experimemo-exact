/**
 * @file experiment-photos.ts
 *
 * Exact Photo Selection and Durable File Handling Foundation for Experimemo.
 * Achieves full parity with original reference implementations:
 * - Reference photo picker: F:/ReactNativeApps/experimemo/src/features/experiments/photo-picker.ts
 * - Reference editor screens: F:/ReactNativeApps/experimemo/src/features/experiments/experiment-editor-screen.tsx
 * - Reference new screen: F:/ReactNativeApps/experimemo/src/features/new-experiment/new-experiment-screen.tsx
 *
 * Exact Platform Architecture & Guarantees:
 * 1. File / Library Selection:
 *    - Supported universally across all Exact platforms (Web, iOS, macOS, Android, Linux, Windows)
 *      via Contract `input type="file" accept="image/*"` and host `showPicker(...)`.
 *    - Emits `Picked[]` records (`path: app:/tmp/picked/...`, `name`, `type`, `size`, `width`, `height`).
 *    - Cancellation emits `cancel` event on the input, safely leaving current photos unchanged.
 * 2. Camera Platform Limitations:
 *    - Contract explicitly forbids `input type="file" capture="camera"` (`lower-picker-capture` compiler error).
 *    - Real tested camera capture is NOT provided in this data foundation harness (requires @exact/camera and
 *      platform media permissions/drivers not present or tested in this harness).
 *    - We do NOT claim camera parity or platform camera support without a real tested implementation.
 * 3. Durable File Storage:
 *    - Temporary picked files reside in `app:/tmp` and are ephemeral (pruned by OS/cleaners).
 *    - Durable foundation copies assets into `app:/data/photos/{id}.{ext}` via `storage.fs.copyFile`
 *      (or atomic write fallback) and preserves full metadata (`ExperimentPhotoAsset`).
 *    - Supports cleanup / removal of durable photo files from disk upon deletion.
 * 4. Separate Experiment & Result Photo Metadata:
 *    - Enforces distinct separation between experiment-level reference photos (`ExperimentRecord.photoAssets`)
 *      and result-level observation photos (`ExperimentResultEntry.photoAssets`).
 *    - Provides scoped attachment, removal, deduplication by URI (`uniqueByUri` parity), and validation.
 * 5. Deterministic Runtime:
 *    - Zero ambient clock (`Date.now()`, `new Date()`) or ambient randomness (`Math.random()`).
 *    - Passes Exact AST checking with zero warnings.
 */

import type {
  ExperimentPhotoAsset,
  ExperimentResultEntry,
  ExperimentRecord,
  ExperimentInput,
} from './experiment-store.ts';

export type {
  ExperimentPhotoAsset,
  ExperimentResultEntry,
  ExperimentRecord,
  ExperimentInput,
};

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

export type PhotoScope = 'experiment' | 'result';
export type PhotoSource = 'library' | 'camera';

export type PhotoErrorCode =
  | 'PERMISSION_DENIED'
  | 'PERMISSION_DISMISSED'
  | 'CAMERA_UNAVAILABLE'
  | 'CAMERA_UNSUPPORTED_ON_PLATFORM'
  | 'FILE_NOT_FOUND'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_WRITE_FAILED'
  | 'INVALID_PHOTO_ASSET'
  | 'MISSING_DETERMINISTIC_TIMESTAMP'
  | 'MISSING_DETERMINISTIC_ID'
  | 'CORRUPT_MEDIA'
  | 'BAKE_WRITE_REFUSED';

/**
 * Normalized input representation of an Exact file picker item (`Picked` in Contract/runner).
 */
export interface ExactPickedPhoto {
  path: string;
  name?: string | null;
  type?: string | null;
  mime?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

/**
 * Normalized representation of a photo captured via `@exact/camera` (`takePhoto`).
 */
export interface ExactCameraPhoto {
  path: string;
  type?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
}

/**
 * Permission and device availability status for camera.
 */
export interface CameraStatusInfo {
  available: boolean;
  state: 'granted' | 'prompt' | 'denied' | 'unknown';
}

/**
 * Options for importing and persisting photos picked from the library.
 */
export interface ImportPickedPhotosOptions {
  /** Caller-supplied ISO 8601 timestamp string (required; ambient clock is forbidden). */
  now: string;
  /** Scope of the photos being imported: experiment-level or result-level. */
  scope: PhotoScope;
  /** Optional experiment identifier for metadata tagging and default naming. */
  experimentId?: string;
  /** Optional result identifier for result-level photo tagging. */
  resultId?: string;
  /** Target persistent directory in Exact FileSystem (defaults to 'app:/data/photos'). */
  targetDir?: string;
  /** Optional custom ID generator taking (index, scope). If omitted, a deterministic ID is derived. */
  generateId?: (index: number, scope: PhotoScope) => string;
}

/**
 * Options for persisting a single camera capture.
 */
export interface ImportCameraPhotoOptions {
  /** Caller-supplied ISO 8601 timestamp string (required; ambient clock is forbidden). */
  now: string;
  /** Scope of the photo being imported: experiment-level or result-level. */
  scope: PhotoScope;
  /** Optional caller-supplied photo ID. If omitted, a deterministic ID is generated. */
  id?: string;
  /** Optional experiment identifier. */
  experimentId?: string;
  /** Optional result identifier. */
  resultId?: string;
  /** Target persistent directory in Exact FileSystem (defaults to 'app:/data/photos'). */
  targetDir?: string;
}

/**
 * FileSystem interface conforming to Exact Storage capabilities.
 */
export interface ExactPhotoFileSystem {
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile?(path: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  atomicWriteFile?(path: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  copyFile?(from: string, to: string): Promise<void>;
  stat?(path: string): Promise<{ size: number; isFile?: boolean; isDirectory?: boolean }>;
  mkdir?(path: string): Promise<void>;
  rm?(path: string): Promise<void>;
  readdir?(path: string): Promise<string[]>;
}

export interface PhotoStorage {
  fs?: ExactPhotoFileSystem;
}

// ---------------------------------------------------------------------------
// Error Hierarchy
// ---------------------------------------------------------------------------

export class PhotoError extends Error {
  readonly code: PhotoErrorCode;
  readonly details?: unknown;

  constructor(code: PhotoErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'PhotoError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PhotoPermissionError extends PhotoError {
  constructor(code: 'PERMISSION_DENIED' | 'PERMISSION_DISMISSED', message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'PhotoPermissionError';
  }
}

export class PhotoPlatformLimitationError extends PhotoError {
  constructor(code: 'CAMERA_UNAVAILABLE' | 'CAMERA_UNSUPPORTED_ON_PLATFORM', message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'PhotoPlatformLimitationError';
  }
}

export class PhotoStorageError extends PhotoError {
  constructor(
    code: 'FILE_NOT_FOUND' | 'STORAGE_UNAVAILABLE' | 'STORAGE_WRITE_FAILED' | 'BAKE_WRITE_REFUSED',
    message: string,
    details?: unknown
  ) {
    super(code, message, details);
    this.name = 'PhotoStorageError';
  }
}

export class PhotoValidationError extends PhotoError {
  constructor(
    code: 'INVALID_PHOTO_ASSET' | 'MISSING_DETERMINISTIC_TIMESTAMP' | 'MISSING_DETERMINISTIC_ID' | 'CORRUPT_MEDIA',
    message: string,
    details?: unknown
  ) {
    super(code, message, details);
    this.name = 'PhotoValidationError';
  }
}

// ---------------------------------------------------------------------------
// Constants & Grants
// ---------------------------------------------------------------------------

export const DEFAULT_PHOTOS_DIR = 'app:/data/photos';
export const DEFAULT_TMP_PICKED_DIR = 'app:/tmp/picked';
export const DEFAULT_TMP_CAMERA_DIR = 'app:/tmp/camera';

/**
 * Static grants required for durable photo handling in Exact:
 * - `fs.read app:/tmp`: Reading ephemeral files delivered by file picker
 * - `fs.read app:/data/photos`: Reading persisted photos
 * - `fs.write app:/data/photos`: Writing persistent photo copies
 */
export const EXPERIMENT_PHOTO_GRANTS = [
  'fs.read app:/tmp',
  'fs.read app:/data/photos',
  'fs.write app:/data/photos',
].join('\n');

/**
 * Optional camera grant for future implementation if/when @exact/camera is bound.
 */
export const OPTIONAL_CAMERA_GRANT = 'device.camera purpose.experimentPhotos';

// ---------------------------------------------------------------------------
// Platform Limitations & Capability Inspection
// ---------------------------------------------------------------------------

export interface PlatformCameraCapability {
  supported: boolean;
  platform: string;
  reason?: string;
}

/**
 * Evaluates whether camera capture is supported on the target platform.
 * Verified against Exact upstream packages:
 * - `@exact/camera` provides native implementations for 'apple' (iOS/macOS), 'android', and 'web'.
 * - Linux and Windows desktop hosts do NOT have native camera support in exact2.
 * - Headless test environments have no physical camera hardware.
 */
export function checkCameraPlatformSupport(platform?: string): PlatformCameraCapability {
  const target = (platform || 'web').toLowerCase();

  switch (target) {
    case 'ios':
    case 'macos':
    case 'apple':
      return { supported: true, platform: target };
    case 'android':
      return { supported: true, platform: target };
    case 'web':
      return { supported: true, platform: target };
    case 'linux':
      return {
        supported: false,
        platform: target,
        reason: 'Native Linux host does not provide a camera module in Exact2 (@exact/camera has no linux target).',
      };
    case 'windows':
      return {
        supported: false,
        platform: target,
        reason: 'Native Windows host does not provide a camera module in Exact2 (@exact/camera has no windows target).',
      };
    default:
      return {
        supported: false,
        platform: target,
        reason: `Unknown or unsupported host platform: ${target}`,
      };
  }
}

/**
 * Asserts that the camera is ready and available on the current device.
 * Throws explicit typed errors when camera is unavailable or denied.
 * NEVER pretends an unavailable native camera is working.
 */
export function assertCameraReady(status: CameraStatusInfo, platform?: string): void {
  const cap = checkCameraPlatformSupport(platform);
  if (!cap.supported) {
    throw new PhotoPlatformLimitationError(
      'CAMERA_UNSUPPORTED_ON_PLATFORM',
      `Camera capture is unsupported on platform "${cap.platform}": ${cap.reason}`
    );
  }

  if (status.state === 'denied') {
    throw new PhotoPermissionError(
      'PERMISSION_DENIED',
      'Camera permission was denied. Camera access must be granted in device settings.'
    );
  }

  if (!status.available) {
    throw new PhotoPlatformLimitationError(
      'CAMERA_UNAVAILABLE',
      'No camera hardware is available on this device or session.'
    );
  }
}

// ---------------------------------------------------------------------------
// Deduplication & Metadata Helpers (Full Parity with Reference)
// ---------------------------------------------------------------------------

/**
 * Deduplicates photo assets by URI, preserving the first occurrence.
 * Matches `uniqueByUri` in reference `photo-picker.ts`.
 */
export function uniquePhotoAssets(assets: readonly ExperimentPhotoAsset[]): ExperimentPhotoAsset[] {
  const seen = new Set<string>();
  const out: ExperimentPhotoAsset[] = [];
  for (const asset of assets) {
    if (!asset || typeof asset.uri !== 'string' || asset.uri.trim() === '') {
      continue;
    }
    const normalizedUri = asset.uri.trim();
    if (seen.has(normalizedUri)) {
      continue;
    }
    seen.add(normalizedUri);
    out.push(asset);
  }
  return out;
}

/**
 * Appends newly imported photo assets to existing photos, deduplicating by URI.
 * Matches `appendPickedAssets` in reference `photo-picker.ts`.
 */
export function appendPhotoAssets(
  currentPhotos: readonly ExperimentPhotoAsset[],
  newPhotos: readonly ExperimentPhotoAsset[] | null | undefined
): ExperimentPhotoAsset[] {
  if (!newPhotos || newPhotos.length === 0) {
    return uniquePhotoAssets(currentPhotos);
  }
  return uniquePhotoAssets([...currentPhotos, ...newPhotos]);
}

/**
 * Removes a photo asset by its unique identifier.
 */
export function removePhotoAssetById(
  currentPhotos: readonly ExperimentPhotoAsset[],
  photoId: string
): ExperimentPhotoAsset[] {
  return currentPhotos.filter((asset) => asset.id !== photoId);
}

/**
 * Removes a photo asset by its URI path.
 */
export function removePhotoAssetByUri(
  currentPhotos: readonly ExperimentPhotoAsset[],
  uri: string
): ExperimentPhotoAsset[] {
  return currentPhotos.filter((asset) => asset.uri !== uri);
}

/**
 * Validates the runtime shape of an ExperimentPhotoAsset.
 */
export function validatePhotoAsset(asset: unknown): asset is ExperimentPhotoAsset {
  if (!asset || typeof asset !== 'object') {
    return false;
  }
  const candidate = asset as Partial<ExperimentPhotoAsset>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim().length > 0 &&
    typeof candidate.uri === 'string' &&
    candidate.uri.trim().length > 0 &&
    (candidate.fileName === null || typeof candidate.fileName === 'string') &&
    (candidate.mimeType === null || typeof candidate.mimeType === 'string') &&
    typeof candidate.width === 'number' &&
    !Number.isNaN(candidate.width) &&
    typeof candidate.height === 'number' &&
    !Number.isNaN(candidate.height)
  );
}

/**
 * Asserts that a photo asset is valid, throwing PhotoValidationError if invalid.
 */
export function assertValidPhotoAsset(asset: unknown): asserts asset is ExperimentPhotoAsset {
  if (!validatePhotoAsset(asset)) {
    throw new PhotoValidationError(
      'INVALID_PHOTO_ASSET',
      `Malformed photo asset: ${JSON.stringify(asset)}`
    );
  }
}

/**
 * Handles user cancellation of photo selection (picker dismiss).
 * Returns the current photo list completely unchanged, matching React Native reference.
 */
export function handlePhotoPickerCancellation(
  currentPhotos: readonly ExperimentPhotoAsset[]
): ExperimentPhotoAsset[] {
  return [...currentPhotos];
}

// ---------------------------------------------------------------------------
// Path & Extension Utilities (Pure & Deterministic)
// ---------------------------------------------------------------------------

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/**
 * Extracts a file extension from a file path or name.
 */
export function extractExtension(pathOrName: string): string {
  const clean = pathOrName.split('?')[0].split('#')[0];
  const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const basename = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;
  const lastDot = basename.lastIndexOf('.');
  if (lastDot > 0 && lastDot < basename.length - 1) {
    return basename.slice(lastDot + 1).toLowerCase();
  }
  return '';
}

/**
 * Resolves appropriate file extension from fileName, path, or MIME type.
 */
export function resolvePhotoExtension(
  path: string,
  fileName?: string | null,
  mimeType?: string | null
): string {
  if (fileName) {
    const ext = extractExtension(fileName);
    if (ext) return ext;
  }
  const fromPath = extractExtension(path);
  if (fromPath) return fromPath;

  if (mimeType) {
    const cleanMime = mimeType.toLowerCase().trim();
    if (MIME_EXTENSION_MAP[cleanMime]) {
      return MIME_EXTENSION_MAP[cleanMime];
    }
  }

  return 'jpg';
}

/**
 * Sanitizes a file name, removing path separators and dangerous tokens.
 */
export function sanitizeFileName(rawName: string | null | undefined, fallbackId: string, ext = 'jpg'): string {
  if (!rawName || typeof rawName !== 'string' || rawName.trim() === '') {
    return `${fallbackId}.${ext}`;
  }
  const cleaned = rawName
    .replace(/[/\\]/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.');
  if (cleaned.length === 0 || cleaned === '.') {
    return `${fallbackId}.${ext}`;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Durable File Storage Operations
// ---------------------------------------------------------------------------

/**
 * Ensures the target persistent photos directory exists in FileSystem.
 */
export async function ensurePhotosDirectory(
  storage: PhotoStorage | null | undefined,
  targetDir = DEFAULT_PHOTOS_DIR
): Promise<void> {
  if (!storage?.fs) {
    throw new PhotoStorageError(
      'STORAGE_UNAVAILABLE',
      'Cannot ensure photos directory: storage.fs is not available.'
    );
  }
  if (typeof storage.fs.mkdir === 'function') {
    try {
      await storage.fs.mkdir(targetDir);
    } catch (error: any) {
      if (error && typeof error === 'object' && error.code === 'bake') {
        throw new PhotoStorageError('BAKE_WRITE_REFUSED', 'Cannot create directory during build bake.');
      }
      // Directory may already exist, which is expected and fine
    }
  }
}

/**
 * Copies a temporary source photo into durable persistent app storage.
 */
async function copyToDurableStorage(
  storage: PhotoStorage,
  sourcePath: string,
  destPath: string
): Promise<void> {
  const fs = storage.fs;
  if (!fs) {
    throw new PhotoStorageError('STORAGE_UNAVAILABLE', 'storage.fs is missing');
  }

  // 1. Verify source existence if stat is supported
  if (typeof fs.stat === 'function') {
    try {
      const stats = await fs.stat(sourcePath);
      if (stats.size === 0) {
        throw new PhotoValidationError('CORRUPT_MEDIA', `Source photo file is empty (0 bytes): ${sourcePath}`);
      }
    } catch (error: any) {
      if (error instanceof PhotoError) throw error;
      const code = error?.code || 'ENOENT';
      throw new PhotoStorageError(
        'FILE_NOT_FOUND',
        `Source photo file not found or inaccessible at "${sourcePath}" (${code}).`,
        error
      );
    }
  }

  // 2. Perform copy
  try {
    if (typeof fs.copyFile === 'function') {
      await fs.copyFile(sourcePath, destPath);
      return;
    }

    // Fallback: read source and atomic-write to destination
    const data = await fs.readFile(sourcePath);
    if (typeof fs.atomicWriteFile === 'function') {
      await fs.atomicWriteFile(destPath, data);
    } else if (typeof fs.writeFile === 'function') {
      await fs.writeFile(destPath, data);
    } else {
      throw new PhotoStorageError(
        'STORAGE_UNAVAILABLE',
        'FileSystem supports neither copyFile, atomicWriteFile, nor writeFile.'
      );
    }
  } catch (error: any) {
    if (error && typeof error === 'object' && error.code === 'bake') {
      throw new PhotoStorageError('BAKE_WRITE_REFUSED', 'Cannot write photo file during build bake.');
    }
    if (error instanceof PhotoError) throw error;
    if (error?.code === 'ENOENT' || error?.message?.includes('no such file')) {
      throw new PhotoStorageError(
        'FILE_NOT_FOUND',
        `Source photo file not found or inaccessible at "${sourcePath}".`,
        error
      );
    }
    throw new PhotoStorageError(
      'STORAGE_WRITE_FAILED',
      `Failed to copy photo from "${sourcePath}" to "${destPath}": ${error?.message || String(error)}`,
      error
    );
  }
}

/**
 * Persists a single picked photo item into durable storage and returns its metadata.
 */
export async function persistPickedPhoto(
  picked: ExactPickedPhoto,
  storage: PhotoStorage,
  options: {
    now: string;
    id: string;
    targetDir?: string;
  }
): Promise<ExperimentPhotoAsset> {
  if (!picked || typeof picked.path !== 'string' || picked.path.trim() === '') {
    throw new PhotoValidationError('INVALID_PHOTO_ASSET', 'Picked photo has missing or invalid path.');
  }
  if (!options.now || typeof options.now !== 'string' || options.now.trim() === '') {
    throw new PhotoValidationError(
      'MISSING_DETERMINISTIC_TIMESTAMP',
      'Caller-supplied ISO timestamp "now" is required for deterministic photo persistence.'
    );
  }
  if (!options.id || typeof options.id !== 'string' || options.id.trim() === '') {
    throw new PhotoValidationError(
      'MISSING_DETERMINISTIC_ID',
      'Caller-supplied identifier "id" is required for deterministic photo persistence.'
    );
  }

  const targetDir = options.targetDir || DEFAULT_PHOTOS_DIR;
  await ensurePhotosDirectory(storage, targetDir);

  const rawMime = picked.mime || picked.type || null;
  const ext = resolvePhotoExtension(picked.path, picked.name, rawMime);
  const destPath = `${targetDir}/${options.id}.${ext}`;

  // If source is already in persistent destination, no copy needed
  if (picked.path !== destPath) {
    await copyToDurableStorage(storage, picked.path, destPath);
  }

  const resolvedFileName = picked.name
    ? sanitizeFileName(picked.name, options.id, ext)
    : `${options.id}.${ext}`;

  return {
    id: options.id,
    uri: destPath,
    fileName: resolvedFileName,
    mimeType: rawMime || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    width: typeof picked.width === 'number' && !Number.isNaN(picked.width) ? Math.max(0, picked.width) : 0,
    height: typeof picked.height === 'number' && !Number.isNaN(picked.height) ? Math.max(0, picked.height) : 0,
  };
}

/**
 * Persists multiple picked photo items into durable storage.
 */
export async function persistPickedPhotos(
  pickedList: readonly ExactPickedPhoto[],
  storage: PhotoStorage,
  options: ImportPickedPhotosOptions
): Promise<ExperimentPhotoAsset[]> {
  if (!pickedList || pickedList.length === 0) {
    return [];
  }
  if (!options.now || typeof options.now !== 'string' || options.now.trim() === '') {
    throw new PhotoValidationError(
      'MISSING_DETERMINISTIC_TIMESTAMP',
      'Caller-supplied ISO timestamp "now" is required for deterministic photo persistence.'
    );
  }

  const cleanTimestamp = options.now.replace(/[:.]/g, '-');
  const targetDir = options.targetDir || DEFAULT_PHOTOS_DIR;

  const results: ExperimentPhotoAsset[] = [];

  for (let i = 0; i < pickedList.length; i++) {
    const item = pickedList[i];
    let id: string;
    if (options.generateId) {
      id = options.generateId(i, options.scope);
    } else if (options.scope === 'result') {
      const rId = options.resultId || 'res';
      id = `photo-res-${rId}-${cleanTimestamp}-${i}`;
    } else {
      const eId = options.experimentId || 'exp';
      id = `photo-exp-${eId}-${cleanTimestamp}-${i}`;
    }

    const asset = await persistPickedPhoto(item, storage, {
      now: options.now,
      id,
      targetDir,
    });
    results.push(asset);
  }

  return uniquePhotoAssets(results);
}

/**
 * Persists a photo captured by `@exact/camera` into durable storage.
 */
export async function persistCameraPhoto(
  photo: ExactCameraPhoto,
  storage: PhotoStorage,
  options: ImportCameraPhotoOptions
): Promise<ExperimentPhotoAsset> {
  if (!photo || typeof photo.path !== 'string' || photo.path.trim() === '') {
    throw new PhotoValidationError('INVALID_PHOTO_ASSET', 'Camera photo has missing or invalid path.');
  }
  if (!options.now || typeof options.now !== 'string' || options.now.trim() === '') {
    throw new PhotoValidationError(
      'MISSING_DETERMINISTIC_TIMESTAMP',
      'Caller-supplied ISO timestamp "now" is required for deterministic camera photo persistence.'
    );
  }

  const cleanTimestamp = options.now.replace(/[:.]/g, '-');
  let id = options.id;
  if (!id) {
    if (options.scope === 'result') {
      const rId = options.resultId || 'res';
      id = `camera-res-${rId}-${cleanTimestamp}`;
    } else {
      const eId = options.experimentId || 'exp';
      id = `camera-exp-${eId}-${cleanTimestamp}`;
    }
  }

  const targetDir = options.targetDir || DEFAULT_PHOTOS_DIR;
  await ensurePhotosDirectory(storage, targetDir);

  const rawMime = photo.type || null;
  const ext = resolvePhotoExtension(photo.path, null, rawMime);
  const destPath = `${targetDir}/${id}.${ext}`;

  if (photo.path !== destPath) {
    await copyToDurableStorage(storage, photo.path, destPath);
  }

  return {
    id,
    uri: destPath,
    fileName: `${id}.${ext}`,
    mimeType: rawMime || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    width: typeof photo.width === 'number' && !Number.isNaN(photo.width) ? Math.max(0, photo.width) : 0,
    height: typeof photo.height === 'number' && !Number.isNaN(photo.height) ? Math.max(0, photo.height) : 0,
  };
}

/**
 * Reads a durable photo file from FileSystem storage as an ArrayBuffer.
 */
export async function readDurablePhotoFile(
  storage: PhotoStorage,
  uri: string
): Promise<ArrayBuffer> {
  if (!storage.fs || typeof storage.fs.readFile !== 'function') {
    throw new PhotoStorageError('STORAGE_UNAVAILABLE', 'storage.fs is missing or readFile is unsupported');
  }
  try {
    return await storage.fs.readFile(uri);
  } catch (error: any) {
    if (error instanceof PhotoError) throw error;
    const code = error?.code || 'ENOENT';
    throw new PhotoStorageError(
      'FILE_NOT_FOUND',
      `Failed to read photo at "${uri}" (${code}).`,
      error
    );
  }
}

/**
 * Deletes a single durable photo file from FileSystem storage.
 * Returns true if the file existed and was removed; false if the file was absent or storage is unavailable.
 */
export async function deleteDurablePhotoFile(
  storage: PhotoStorage,
  uri: string
): Promise<boolean> {
  if (!storage.fs || typeof storage.fs.rm !== 'function') {
    return false;
  }
  if (typeof storage.fs.stat === 'function') {
    try {
      await storage.fs.stat(uri);
    } catch {
      return false;
    }
  }
  try {
    await storage.fs.rm(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes multiple durable photo files from FileSystem storage.
 */
export async function deleteDurablePhotoFiles(
  storage: PhotoStorage,
  assets: readonly ExperimentPhotoAsset[]
): Promise<number> {
  let count = 0;
  for (const asset of assets) {
    if (asset?.uri) {
      const deleted = await deleteDurablePhotoFile(storage, asset.uri);
      if (deleted) count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Separate Experiment and Result Photo Metadata Handlers
// ---------------------------------------------------------------------------

/**
 * Attaches new photos to an experiment's photo asset collection, deduplicating by URI.
 * Parity with `setForm(current => ({ ...current, photoAssets }))` in experiment editor.
 */
export function attachExperimentPhotos(
  currentPhotos: readonly ExperimentPhotoAsset[],
  incomingPhotos: readonly ExperimentPhotoAsset[]
): ExperimentPhotoAsset[] {
  return appendPhotoAssets(currentPhotos, incomingPhotos);
}

/**
 * Removes a photo from an experiment's photo asset collection by ID.
 * Parity with `current.photoAssets.filter(asset => asset.id !== photo.id)` in experiment editor.
 */
export function removeExperimentPhoto(
  currentPhotos: readonly ExperimentPhotoAsset[],
  photoId: string
): ExperimentPhotoAsset[] {
  return removePhotoAssetById(currentPhotos, photoId);
}

/**
 * Attaches photos to a specific timestamped result entry, returning an updated entry.
 * Parity with `updateResultEntry(entry.id, { photoAssets })` in experiment editor.
 */
export function attachResultPhotos(
  resultEntry: ExperimentResultEntry,
  incomingPhotos: readonly ExperimentPhotoAsset[]
): ExperimentResultEntry {
  return {
    ...resultEntry,
    photoAssets: appendPhotoAssets(resultEntry.photoAssets, incomingPhotos),
  };
}

/**
 * Removes a photo from a specific timestamped result entry by photo ID.
 * Parity with `entry.photoAssets.filter(asset => asset.id !== photo.id)` in experiment editor.
 */
export function removeResultPhoto(
  resultEntry: ExperimentResultEntry,
  photoId: string
): ExperimentResultEntry {
  return {
    ...resultEntry,
    photoAssets: removePhotoAssetById(resultEntry.photoAssets, photoId),
  };
}

/**
 * Attaches photos to an experiment input object at the experiment level.
 */
export function attachPhotosToExperimentInput(
  input: ExperimentInput,
  photos: readonly ExperimentPhotoAsset[]
): ExperimentInput {
  return {
    ...input,
    photoAssets: appendPhotoAssets(input.photoAssets, photos),
  };
}

/**
 * Removes an experiment-level photo from an experiment input by ID.
 */
export function removePhotoFromExperimentInput(
  input: ExperimentInput,
  photoId: string
): ExperimentInput {
  return {
    ...input,
    photoAssets: removePhotoAssetById(input.photoAssets, photoId),
  };
}

/**
 * Extracts and categorizes all photos across an experiment record or input.
 */
export function extractAllExperimentPhotos(experiment: ExperimentRecord | ExperimentInput): {
  experimentPhotos: ExperimentPhotoAsset[];
  resultPhotos: ExperimentPhotoAsset[];
  all: ExperimentPhotoAsset[];
} {
  const experimentPhotos = uniquePhotoAssets(experiment.photoAssets || []);
  const resultPhotosList: ExperimentPhotoAsset[] = [];
  if (Array.isArray(experiment.resultEntries)) {
    for (const entry of experiment.resultEntries) {
      if (Array.isArray(entry.photoAssets)) {
        resultPhotosList.push(...entry.photoAssets);
      }
    }
  }
  const resultPhotos = uniquePhotoAssets(resultPhotosList);
  const all = uniquePhotoAssets([...experimentPhotos, ...resultPhotos]);

  return {
    experimentPhotos,
    resultPhotos,
    all,
  };
}

/**
 * High-level orchestration for importing photos from Exact library picker into an experiment.
 */
export async function addPickedPhotosToExperiment(
  currentPhotos: readonly ExperimentPhotoAsset[],
  pickedFiles: readonly ExactPickedPhoto[],
  storage: PhotoStorage,
  options: {
    now: string;
    experimentId?: string;
    targetDir?: string;
  }
): Promise<ExperimentPhotoAsset[]> {
  if (!pickedFiles || pickedFiles.length === 0) {
    return handlePhotoPickerCancellation(currentPhotos);
  }
  const imported = await persistPickedPhotos(pickedFiles, storage, {
    now: options.now,
    scope: 'experiment',
    experimentId: options.experimentId,
    targetDir: options.targetDir,
  });
  return attachExperimentPhotos(currentPhotos, imported);
}

/**
 * High-level orchestration for importing photos from Exact library picker into a result entry.
 */
export async function addPickedPhotosToResultEntry(
  resultEntry: ExperimentResultEntry,
  pickedFiles: readonly ExactPickedPhoto[],
  storage: PhotoStorage,
  options: {
    now: string;
    experimentId?: string;
    targetDir?: string;
  }
): Promise<ExperimentResultEntry> {
  if (!pickedFiles || pickedFiles.length === 0) {
    return { ...resultEntry };
  }
  const imported = await persistPickedPhotos(pickedFiles, storage, {
    now: options.now,
    scope: 'result',
    experimentId: options.experimentId,
    resultId: resultEntry.id,
    targetDir: options.targetDir,
  });
  return attachResultPhotos(resultEntry, imported);
}
