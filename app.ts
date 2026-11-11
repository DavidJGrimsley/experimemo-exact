import type { Answer, Result, Sources } from './app.contract.d.ts';

export const grants = '';

// The reference app's two labeled example experiments (origin/test 23f39c3,
// src/features/experiments/experiment-models.ts), in the original order. They are
// read-only display data in this visual slice: nothing is stored, edited or deleted.
const seeds = [
  {
    id: 'experiment-seed-1',
    title: 'Bean sprouts under different light conditions (Example)',
    category: 'Botany',
    hypothesis:
      'Bean sprouts exposed to indirect daylight will grow taller than sprouts kept under a desk lamp for the same duration.',
    observations: 'Window tray currently shows slightly faster growth after the first 48 hours.',
    resultCount: 1,
    latestResultAt: '2026-06-16T17:10:00.000Z',
    latestResultNotes:
      'Window tray stems are taller and greener than the desk lamp tray after the first measurement cycle.',
    plannedPhotos: 2,
    conclusion: '',
    status: 'active',
    updatedAt: '2026-06-16T17:10:00.000Z',
  },
  {
    id: 'experiment-seed-2',
    title: 'Cooling rate of metal versus glass containers (Example)',
    category: 'Physics',
    hypothesis:
      'Water stored in a metal container will lose heat faster than water stored in a glass container of the same size.',
    observations: 'Draft setup ready; first timed run has not been started yet.',
    resultCount: 0,
    latestResultAt: '',
    latestResultNotes: '',
    plannedPhotos: 0,
    conclusion: '',
    status: 'active',
    updatedAt: '2026-06-15T13:00:00.000Z',
  },
];

// Dates are pinned to en-US and UTC so the text is the same on every host.
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  });

const sources: Sources = {
  experiments: (): Result<'experiments'> =>
    [...seeds]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({
        id: s.id,
        title: s.title,
        meta: `${s.category} - Updated ${day(s.updatedAt)}`,
        status: s.status === 'complete' ? 'COMPLETE' : 'ACTIVE',
        complete: s.status === 'complete',
        hypothesis: s.hypothesis,
        observations: s.observations || 'No observations recorded yet.',
        results:
          s.resultCount > 0
            ? `${s.resultCount} ${s.resultCount === 1 ? 'entry' : 'entries'} - Latest ${stamp(s.latestResultAt)}: ${s.latestResultNotes || 'Photos only'}`
            : 'No result entries yet.',
        planned: `Planned photos: ${s.plannedPhotos}`,
        conclusion: `Conclusion: ${s.conclusion ? 'Ready' : 'Open'}`,
      })),
};
export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
