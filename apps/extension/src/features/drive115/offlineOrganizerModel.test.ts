import { describe, expect, it } from 'vitest';
import {
  buildDrive115OrganizedVideoNames,
  findDrive115OfflineTask,
  isDrive115TaskJunkFileName,
  isDrive115VideoFileName,
} from './offlineOrganizerModel';

describe('offlineOrganizerModel', () => {
  it('matches by hash first and falls back to directory/name when task lists omit hashes', () => {
    const tasks = [
      { info_hash: 'another-hash', wp_path_id: 'folder-1', name: 'SSIS-001.torrent', status: 1 },
      { wp_path_id: 'folder-2', name: 'SSIS-001 magnet task', status: 2 },
    ];
    expect(findDrive115OfflineTask(tasks, {
      taskHash: 'ANOTHER-HASH',
      folderId: 'folder-1',
      videoId: 'SSIS-001',
      magnetName: 'SSIS-001',
    })).toBe(tasks[0]);
    expect(findDrive115OfflineTask(tasks, {
      taskHash: 'not-in-list',
      folderId: 'folder-2',
      videoId: 'SSIS-001',
      magnetName: 'SSIS-001',
    })).toBe(tasks[1]);
  });

  it('does not match a same-name task in another target folder', () => {
    const tasks = [{ wp_path_id: 'other-folder', name: 'SSIS-001.torrent' }];
    expect(findDrive115OfflineTask(tasks, {
      folderId: 'target-folder',
      videoId: 'SSIS-001',
      magnetName: 'SSIS-001',
    })).toBeUndefined();
  });

  it('normalizes one and multiple video names without overwriting existing files', () => {
    const one = buildDrive115OrganizedVideoNames('SSIS-001', [
      { id: 'a', name: 'source.mp4', parentId: 'folder' },
    ]);
    expect(one[0].nextName).toBe('SSIS-001.mp4');

    const multiple = buildDrive115OrganizedVideoNames('SSIS-001', [
      { id: 'b', name: 'part-b.mkv', parentId: 'folder' },
      { id: 'a', name: 'part-a.mp4', parentId: 'folder' },
    ]);
    expect(multiple.map((file) => file.nextName)).toEqual(['SSIS-001-01.mp4', 'SSIS-001-02.mkv']);

    const collision = buildDrive115OrganizedVideoNames('SSIS-001', [
      { id: 'c', name: 'new.mp4', parentId: 'folder' },
    ], ['SSIS-001.mp4']);
    expect(collision[0].nextName).toBe('SSIS-001-01.mp4');
  });

  it('recognizes video files but only deletes a narrow set of torrent/system artifacts', () => {
    expect(isDrive115VideoFileName('movie.MKV')).toBe(true);
    expect(isDrive115VideoFileName('poster.jpg')).toBe(false);
    expect(isDrive115TaskJunkFileName('metadata.torrent')).toBe(true);
    expect(isDrive115TaskJunkFileName('__padding_file_1.pad')).toBe(true);
    expect(isDrive115TaskJunkFileName('movie.nfo')).toBe(false);
    expect(isDrive115TaskJunkFileName('subtitle.srt')).toBe(false);
    expect(isDrive115TaskJunkFileName('readme.txt')).toBe(false);
  });
});
