/**
 * @file offlineOrganizerBackground.ts
 * @description 115 离线任务的持久化监控与完成后整理
 * @module features/drive115
 */
import { STORAGE_KEYS } from '../../utils/config';
import { getSettings, getValue, setValue } from '../../utils/storage';
import { getDrive115V2Service } from './v2';
import { uploadRemoteImageTo115 } from './v2/backgroundProxy';
import {
  buildDrive115OrganizedVideoNames,
  findDrive115OfflineTask,
  isDrive115TaskJunkFileName,
  isDrive115VideoFileName,
  type Drive115NewFileLike,
} from './offlineOrganizerModel';

export const DRIVE115_OFFLINE_ORGANIZER_ALARM = 'drive115-offline-organizer';
const POLL_INTERVAL_MS = 60_000;
const JOB_TTL_MS = 48 * 60 * 60 * 1000;
const JOB_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCAN_DEPTH = 3;

type JobStatus = 'pending' | 'completed' | 'failed' | 'partial';

type OfflineOrganizerJob = {
  id: string;
  videoId: string;
  folderId: string;
  taskHash?: string;
  magnetName: string;
  coverUrl?: string;
  previewUrls: string[];
  beforeFileIds: string[];
  beforeRootFileNames: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  status: JobStatus;
  tabId?: number;
  autoMarkWatched?: boolean;
  autoMarkWatchedStars?: number;
  lastError?: string;
  result?: {
    videoCount: number;
    imagesUploaded: number;
    imageFailures: number;
    moved: number;
    renamed: number;
    deleted: number;
    failedOperations: number;
  };
};

type SendResponse = (response: unknown) => void;

type ListedEntry = Drive115NewFileLike & { isFolder: boolean };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function getItemId(item: Record<string, any>): string {
  return String(item.file_id ?? item.fid ?? item.cid ?? '').trim();
}

function getItemName(item: Record<string, any>): string {
  return String(item.file_name ?? item.fn ?? item.name ?? '').trim();
}

function isFolder(item: Record<string, any>): boolean {
  return String(item.fc ?? item.file_category ?? '') === '0'
    || item.is_dir === true
    || item.is_directory === true;
}

async function loadJobs(): Promise<OfflineOrganizerJob[]> {
  const raw = await getValue<unknown>(STORAGE_KEYS.DRIVE115_OFFLINE_ORGANIZER_JOBS, []);
  return Array.isArray(raw)
    ? raw.filter((item): item is OfflineOrganizerJob => !!item && typeof item === 'object')
    : [];
}

async function saveJobs(jobs: OfflineOrganizerJob[]): Promise<void> {
  const now = Date.now();
  // 待处理任务不能因为历史记录太多而被 slice(-100) 丢弃。
  const pending = jobs.filter((job) => job.status === 'pending');
  const history = jobs.filter((job) => (
    job.status !== 'pending' && now - job.updatedAt <= JOB_HISTORY_TTL_MS
  )).slice(-100);
  await setValue(STORAGE_KEYS.DRIVE115_OFFLINE_ORGANIZER_JOBS, [...pending, ...history]);
}

function scheduleNextPoll(): void {
  try {
    chrome.alarms.create(DRIVE115_OFFLINE_ORGANIZER_ALARM, { when: Date.now() + POLL_INTERVAL_MS });
  } catch (error) {
    console.warn('[115OfflineOrganizer] schedule alarm failed', error);
  }
}

async function syncAlarm(jobs: readonly OfflineOrganizerJob[]): Promise<void> {
  const pending = jobs.some((job) => job.status === 'pending');
  try {
    if (pending) scheduleNextPoll();
    else await chrome.alarms.clear(DRIVE115_OFFLINE_ORGANIZER_ALARM);
  } catch {
    // Service worker startup will re-create the alarm from persisted jobs.
  }
}

/** 注册/更新一条持久化整理任务。任务快照只保存文件 ID 和名称，不保存授权凭据。 */
export async function scheduleDrive115OfflineOrganizerJob(
  input: {
    videoId: string;
    folderId: string;
    taskHash?: string;
    magnetName: string;
    coverUrl?: string;
    previewUrls?: string[];
    beforeFileIds: string[];
    beforeRootFileNames: string[];
    autoMarkWatched?: boolean;
    autoMarkWatchedStars?: number;
  },
  tabId?: number,
): Promise<{ success: boolean; jobId?: string; message?: string }> {
  const videoId = String(input.videoId || '').trim();
  const folderId = String(input.folderId || '').trim();
  if (!videoId || !folderId) return { success: false, message: '缺少番号或目标文件夹 ID' };

  const now = Date.now();
  const jobs = await loadJobs();
  const taskHash = String(input.taskHash || '').trim().toLowerCase();
  const existing = jobs.find((job) => (
    job.status === 'pending'
    && job.folderId === folderId
    && ((taskHash && job.taskHash?.toLowerCase() === taskHash)
      || (!taskHash && job.videoId === videoId && job.magnetName === input.magnetName))
  ));
  if (existing) {
    existing.tabId = tabId ?? existing.tabId;
    existing.updatedAt = now;
    await saveJobs(jobs);
    await syncAlarm(jobs);
    return { success: true, jobId: existing.id };
  }

  const id = [folderId, taskHash || videoId, now].join(':');
  jobs.push({
    id,
    videoId,
    folderId,
    taskHash: taskHash || undefined,
    magnetName: String(input.magnetName || '').trim(),
    coverUrl: String(input.coverUrl || '').trim() || undefined,
    previewUrls: Array.from(new Set((input.previewUrls || []).map((url) => String(url || '').trim()).filter(Boolean))).slice(0, 8),
    beforeFileIds: Array.from(new Set((input.beforeFileIds || []).map(String).filter(Boolean))),
    beforeRootFileNames: Array.from(new Set((input.beforeRootFileNames || []).map(String).filter(Boolean))),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + JOB_TTL_MS,
    status: 'pending',
    tabId,
    autoMarkWatched: Boolean(input.autoMarkWatched),
    autoMarkWatchedStars: Math.max(1, Math.min(5, Number(input.autoMarkWatchedStars) || 4)),
  });
  await saveJobs(jobs);
  await syncAlarm(jobs);
  return { success: true, jobId: id };
}

/** Content-script message handler. */
export function handleDrive115OfflineOrganizerMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: SendResponse,
): boolean {
  const record = asRecord(message);
  if (record.type !== 'drive115.offline-organizer.schedule') return false;
  void (async () => {
    try {
      const payload = asRecord(record.payload);
      const result = await scheduleDrive115OfflineOrganizerJob({
        videoId: String(payload.videoId || ''),
        folderId: String(payload.folderId || ''),
        taskHash: String(payload.taskHash || ''),
        magnetName: String(payload.magnetName || ''),
        coverUrl: String(payload.coverUrl || ''),
        previewUrls: Array.isArray(payload.previewUrls) ? payload.previewUrls.map(String) : [],
        beforeFileIds: Array.isArray(payload.beforeFileIds) ? payload.beforeFileIds.map(String) : [],
        beforeRootFileNames: Array.isArray(payload.beforeRootFileNames) ? payload.beforeRootFileNames.map(String) : [],
        autoMarkWatched: Boolean(payload.autoMarkWatched),
        autoMarkWatchedStars: Number(payload.autoMarkWatchedStars) || 4,
      }, sender.tab?.id);
      sendResponse(result);
    } catch (error) {
      sendResponse({ success: false, message: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
}

/** 浏览器重启或 Service Worker 冷启动后恢复待处理任务的闹钟。 */
export async function ensureDrive115OfflineOrganizerAlarm(): Promise<void> {
  const jobs = await loadJobs();
  await syncAlarm(jobs);
}

async function listAllFolderItems(
  svc: ReturnType<typeof getDrive115V2Service>,
  accessToken: string,
  folderId: string,
): Promise<Array<Record<string, any>>> {
  const all: Array<Record<string, any>> = [];
  const limit = 1150;
  let offset = 0;
  for (let page = 0; page < 100; page += 1) {
    const listed = await svc.listFiles({
      accessToken,
      cid: folderId,
      limit,
      offset,
      show_dir: 1,
      stdir: 1,
      cur: 1,
    });
    if (!listed.success) throw new Error(listed.message || '读取 115 文件夹失败');
    const data = Array.isArray(listed.data) ? listed.data as Array<Record<string, any>> : [];
    if (!data.length) break;
    all.push(...data);
    offset += data.length;
    const count = Number(listed.count || 0);
    if (data.length < limit || (count > 0 && offset >= count)) break;
  }
  return all;
}

async function collectNewFiles(
  svc: ReturnType<typeof getDrive115V2Service>,
  accessToken: string,
  rootFolderId: string,
  beforeFileIds: ReadonlySet<string>,
): Promise<ListedEntry[]> {
  const collected: ListedEntry[] = [];
  const visited = new Set<string>();
  const visit = async (folderId: string, depth: number): Promise<void> => {
    if (visited.has(folderId)) return;
    visited.add(folderId);
    const items = await listAllFolderItems(svc, accessToken, folderId);
    for (const item of items) {
      const id = getItemId(item);
      if (!id) continue;
      const name = getItemName(item);
      if (isFolder(item)) {
        if (depth < MAX_SCAN_DEPTH) await visit(id, depth + 1);
        continue;
      }
      if (!beforeFileIds.has(id)) collected.push({ id, name, parentId: folderId, isFolder: false });
    }
  };
  await visit(rootFolderId, 0);
  return collected;
}

function imageExtensionFromUrl(sourceUrl: string): string {
  try {
    const ext = new URL(sourceUrl).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    if (ext === 'jpeg') return 'jpg';
    if (ext && ['jpg', 'png', 'webp', 'gif'].includes(ext)) return ext;
  } catch {}
  return 'jpg';
}

async function uploadJavDbImagesTo115(
  job: OfflineOrganizerJob,
  accessToken: string,
): Promise<{ imagesUploaded: number; imageFailures: number }> {
  const assets: Array<{ sourceUrl: string; fileName: string }> = [];
  if (job.coverUrl) {
    assets.push({ sourceUrl: job.coverUrl, fileName: 'cover.' + imageExtensionFromUrl(job.coverUrl) });
  }
  job.previewUrls.slice(0, 8).forEach((sourceUrl, index) => {
    assets.push({
      sourceUrl,
      fileName: 'preview-' + String(index + 1).padStart(2, '0') + '.' + imageExtensionFromUrl(sourceUrl),
    });
  });
  if (!assets.length) return { imagesUploaded: 0, imageFailures: 0 };

  let baseUrl = 'https://proapi.115.com';
  try {
    const settings = await getSettings();
    baseUrl = String((settings as any)?.drive115?.v2ApiBaseUrl || baseUrl).replace(/\/+$/, '');
  } catch {
    // 设置读取失败时使用官方默认 API 域名，不能因此中断已经完成的视频整理。
  }
  let imagesUploaded = 0;
  let imageFailures = 0;
  for (const asset of assets) {
    let result: { success: boolean; message?: string } = { success: false };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await uploadRemoteImageTo115({
          accessToken,
          parentId: job.folderId,
          fileName: asset.fileName,
          sourceUrl: asset.sourceUrl,
          baseUrl,
        });
      } catch (error) {
        result = { success: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (result.success) break;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (result.success) imagesUploaded += 1;
    else imageFailures += 1;
  }
  return { imagesUploaded, imageFailures };
}

async function organizeCompletedJob(
  job: OfflineOrganizerJob,
  accessToken: string,
): Promise<OfflineOrganizerJob['result']> {
  const svc = getDrive115V2Service();
  const collected = await collectNewFiles(
    svc,
    accessToken,
    job.folderId,
    new Set(job.beforeFileIds),
  );
  const videos = collected.filter((file) => isDrive115VideoFileName(file.name));
  if (!videos.length) {
    // 115 的任务状态可能先变成完成、文件列表稍后才可见；保留任务到下一轮闹钟重试。
    throw new Error('115 离线任务已完成，但新增视频尚未出现在目录列表中，稍后将自动重试扫描');
  }

  const arranged = buildDrive115OrganizedVideoNames(
    job.videoId,
    videos,
    job.beforeRootFileNames,
  );
  let moved = 0;
  let renamed = 0;
  let failedOperations = 0;
  for (const file of arranged) {
    if (file.parentId !== job.folderId) {
      try {
        const move = await svc.moveFiles({
          accessToken,
          fileIds: [file.id],
          targetFolderId: job.folderId,
        });
        if (move.success) moved += 1;
        else failedOperations += 1;
      } catch {
        failedOperations += 1;
      }
    }
    if (file.name !== file.nextName) {
      try {
        const rename = await svc.renameFile({
          accessToken,
          fileId: file.id,
          fileName: file.nextName,
        });
        if (rename.success) renamed += 1;
        else failedOperations += 1;
      } catch {
        failedOperations += 1;
      }
    }
  }

  // 仅删除本次新增且明确属于 torrent/系统杂项的文件；NFO、字幕、图片和说明文件保留。
  const junkFiles = collected.filter((file) => (
    !isDrive115VideoFileName(file.name) && isDrive115TaskJunkFileName(file.name)
  ));
  let deleted = 0;
  for (let index = 0; index < junkFiles.length; index += 50) {
    const batch = junkFiles.slice(index, index + 50);
    try {
      const remove = await svc.deleteFiles({ accessToken, fileIds: batch.map((file) => file.id) });
      if (remove.success) deleted += batch.length;
      else failedOperations += batch.length;
    } catch {
      failedOperations += batch.length;
    }
  }

  const imageResult = await uploadJavDbImagesTo115(job, accessToken);
  return {
    videoCount: videos.length,
    imagesUploaded: imageResult.imagesUploaded,
    imageFailures: imageResult.imageFailures,
    moved,
    renamed,
    deleted,
    failedOperations,
  };
}

async function notifyOriginTab(job: OfflineOrganizerJob): Promise<void> {
  if (typeof job.tabId !== 'number') return;
  try {
    await chrome.tabs.sendMessage(job.tabId, {
      type: 'drive115.offline-organizer.completed',
      payload: {
        videoId: job.videoId,
        status: job.status,
        autoMarkWatched: job.autoMarkWatched,
        autoMarkWatchedStars: job.autoMarkWatchedStars,
        result: job.result,
        message: job.lastError,
      },
    });
  } catch {
    // 原 JavDB 标签页可能已经关闭；后台整理结果仍保存在本机。
  }
}

let processingPromise: Promise<void> | null = null;

/** 每次闹钟只处理一轮；失败/进行中的任务保留到下一轮。 */
export async function handleDrive115OfflineOrganizerAlarm(alarmName: string): Promise<boolean> {
  if (alarmName !== DRIVE115_OFFLINE_ORGANIZER_ALARM) return false;
  if (processingPromise) {
    await processingPromise;
    return true;
  }
  processingPromise = (async () => {
    const jobs = await loadJobs();
    const now = Date.now();
    const svc = getDrive115V2Service();
    for (const job of jobs) {
      if (job.status !== 'pending') continue;
      if (now >= job.expiresAt) {
        job.status = 'failed';
        job.lastError = '离线任务监控超过 48 小时，已停止自动整理';
        job.updatedAt = now;
        await notifyOriginTab(job);
        continue;
      }

      const token = await svc.getValidAccessToken({ forceAutoRefresh: true });
      if (!token.success || !token.accessToken) {
        job.lastError = token.message || '115 授权暂不可用';
        job.updatedAt = now;
        continue;
      }
      const firstPage = await svc.getTaskList({ accessToken: token.accessToken, page: 1 });
      if (!firstPage.success) {
        job.lastError = firstPage.message || '读取 115 离线任务失败';
        job.updatedAt = now;
        continue;
      }
      const findTask = (tasks: readonly unknown[]) => findDrive115OfflineTask(
        tasks as Array<{ info_hash?: unknown; hash?: unknown; name?: unknown; wp_path_id?: unknown; status?: unknown }>,
        {
          taskHash: job.taskHash,
          folderId: job.folderId,
          videoId: job.videoId,
          magnetName: job.magnetName,
        },
      );
      let task = findTask(firstPage.data?.tasks || []);
      // 通常最新任务在第一页；若用户任务很多，最多继续检查前 5 页，避免每分钟无限请求。
      const pageCount = Math.min(5, Math.max(1, Number(firstPage.data?.page_count) || 1));
      for (let page = 2; !task && page <= pageCount; page += 1) {
        const nextPage = await svc.getTaskList({ accessToken: token.accessToken, page });
        if (!nextPage.success) {
          job.lastError = nextPage.message || '读取 115 离线任务分页失败';
          break;
        }
        task = findTask(nextPage.data?.tasks || []);
      }
      if (!task) {
        job.updatedAt = now;
        continue;
      }
      const status = Number(task.status);
      if (status === -1) {
        job.status = 'failed';
        job.lastError = '115 离线任务失败，请检查 115 任务列表';
        job.updatedAt = now;
        await notifyOriginTab(job);
        continue;
      }
      if (status !== 2) {
        job.updatedAt = now;
        continue;
      }

      try {
        job.result = await organizeCompletedJob(job, token.accessToken);
        job.status = (job.result.failedOperations || job.result.imageFailures) ? 'partial' : 'completed';
        job.lastError = job.result.failedOperations || job.result.imageFailures
          ? '部分移动、重命名、清理或图片上传操作未成功，请检查 115 文件夹'
          : undefined;
      } catch (error) {
        job.lastError = error instanceof Error ? error.message : String(error);
        job.updatedAt = now;
        continue;
      }
      job.updatedAt = Date.now();
      await notifyOriginTab(job);
    }
    await saveJobs(jobs);
    await syncAlarm(jobs);
  })();
  try {
    await processingPromise;
  } finally {
    processingPromise = null;
  }
  return true;
}
