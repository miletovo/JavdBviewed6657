/**
 * @file offlineOrganizerModel.ts
 * @description 115 离线任务整理的纯数据规则
 * @module features/drive115
 */

export type Drive115OfflineTaskLike = {
  info_hash?: unknown;
  hash?: unknown;
  name?: unknown;
  wp_path_id?: unknown;
  status?: unknown;
  [key: string]: unknown;
};

export type Drive115NewFileLike = {
  id: string;
  name: string;
  parentId: string;
};

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeHash(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

/** 优先按 info_hash 精确匹配；任务列表缺少 hash 时回退到目录 + 名称。 */
export function findDrive115OfflineTask(
  tasks: readonly Drive115OfflineTaskLike[],
  params: { taskHash?: string; folderId: string; videoId: string; magnetName: string },
): Drive115OfflineTaskLike | undefined {
  const taskHash = normalizeHash(params.taskHash);
  if (taskHash) {
    const exact = tasks.find((task) => (
      normalizeHash(task.info_hash || task.hash) === taskHash
    ));
    if (exact) return exact;
  }

  const folderId = normalizeText(params.folderId);
  const videoId = normalizeText(params.videoId).toLowerCase();
  const magnetName = normalizeText(params.magnetName).toLowerCase();
  return tasks.find((task) => {
    const taskFolderId = normalizeText(task.wp_path_id);
    if (taskFolderId && taskFolderId !== folderId) return false;
    const name = normalizeText(task.name).toLowerCase();
    return Boolean(name && (
      (videoId && name.includes(videoId))
      || (magnetName && name.includes(magnetName))
    ));
  });
}

export function isDrive115VideoFileName(name: string): boolean {
  return /\.(mp4|mkv|avi|mov|wmv|flv|ts|m4v|iso|webm)$/i.test(String(name || '').trim());
}

/**
 * 只识别明确属于种子/系统杂项的文件。
 * NFO、字幕、图片、TXT 说明文件和未知格式一律保留，避免误删用户资料。
 */
export function isDrive115TaskJunkFileName(name: string): boolean {
  const value = String(name || '').trim();
  if (!value) return false;
  return /(?:^|\\/)(?:thumbs\.db|desktop\.ini|\.ds_store)$/i.test(value)
    || /^__padding_file_/i.test(value)
    || /\.(?:pad|torrent|url|html?|sfv|md5|sha1|log)$/i.test(value);
}

/**
 * 为本次任务新增的视频生成无冲突的规范文件名。
 * 多视频按文件名排序后使用 -01、-02；单视频优先使用番号本名。
 */
export function buildDrive115OrganizedVideoNames(
  videoId: string,
  files: readonly Drive115NewFileLike[],
  reservedNames: readonly string[] = [],
): Array<Drive115NewFileLike & { nextName: string }> {
  const safeCode = String(videoId || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!safeCode || !files.length) return [];

  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const reserved = new Set(reservedNames.map((name) => String(name || '').trim().toLowerCase()).filter(Boolean));
  const output: Array<Drive115NewFileLike & { nextName: string }> = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const file = sorted[index];
    const extension = file.name.match(/\.[^.]+$/)?.[0] || '';
    let nextName = sorted.length === 1 ? safeCode + extension : safeCode + '-' + String(index + 1).padStart(2, '0') + extension;
    if (reserved.has(nextName.toLowerCase())) {
      let suffix = 0;
      do {
        suffix += 1;
        nextName = safeCode + '-' + String(suffix).padStart(2, '0') + extension;
      } while (reserved.has(nextName.toLowerCase()));
    }
    reserved.add(nextName.toLowerCase());
    output.push({ ...file, nextName });
  }
  return output;
}
