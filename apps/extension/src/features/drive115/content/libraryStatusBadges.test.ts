// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isDrive115LibraryStatusEnabled, matchesDrive115LibraryCode } from './libraryStatusBadges';
import { STORAGE_KEYS } from '../../../utils/config';

/**
 * 媒体库假数据 + 加载 mock：
 * - loadDrive115LibraryState 用 mock 计数（验证"每页只读一次"）
 * - lookupByCode 复用 store 里的真实实现，避免测试自己的副本
 */
const { fakeLibrary, loadDrive115LibraryStateMock } = vi.hoisted(() => {
  const makeEntry = (code: string) => ({
    key: `${code}:file`,
    code,
    title: code,
    folderCid: `f-${code}`,
    folderName: code,
    rootCid: 'root',
    videoFileId: `v-${code}`,
    pickCode: `p-${code}`,
    fileName: `${code}.mp4`,
    fileSize: 1,
    updatedAt: 1,
  });

  const state = {
    version: 1 as const,
    updatedAt: 1,
    entries: [makeEntry('SSIS-001')],
    stats: { roots: 1, foldersSeen: 1, indexed: 1, skipped: 0, unrecognized: 0, apiCalls: 1, truncatedFolders: 0 },
  };

  return {
    fakeLibrary: {
      state,
      setEntries(entries: unknown[]) {
        state.entries = entries;
      },
    },
    loadDrive115LibraryStateMock: vi.fn(async () => state),
  };
});

vi.mock('../mediaLibrary', async () => {
  const store = await import('../mediaLibrary/store');
  return {
    lookupByCode: store.lookupByCode,
    loadDrive115LibraryState: loadDrive115LibraryStateMock,
  };
});

type StorageChangeHandler = (
  changes: Record<string, { newValue?: unknown } | undefined>,
  areaName: string,
) => void;

let changeListeners: StorageChangeHandler[] = [];

function installFakeChrome(): void {
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      onChanged: {
        addListener: (listener: StorageChangeHandler) => {
          changeListeners.push(listener);
        },
        removeListener: (listener: StorageChangeHandler) => {
          changeListeners = changeListeners.filter((item) => item !== listener);
        },
      },
    },
  };
}

function emitLibraryStateChange(): void {
  const change = { [STORAGE_KEYS.DRIVE115_LIBRARY_STATE]: { newValue: fakeLibrary.state } };
  for (const listener of [...changeListeners]) listener(change, 'local');
}

/** 等微任务 + 定时器冲刷完毕，确保异步刷新落地 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 每个渲染测试都拿一份全新的模块实例，避免模块级缓存跨用例串扰 */
async function loadFreshBadgesModule(): Promise<typeof import('./libraryStatusBadges')> {
  vi.resetModules();
  return import('./libraryStatusBadges');
}

function attachContainer(videoId: string): HTMLDivElement {
  const container = document.createElement('div');
  container.dataset.videoId = videoId;
  document.body.appendChild(container);
  return container;
}


function attachCardContainer(videoId: string): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'item';
  card.innerHTML = '<div class="box"><div class="cover"><img alt=""></div></div>';
  const container = document.createElement('div');
  container.dataset.videoId = videoId;
  card.appendChild(container);
  document.body.appendChild(card);
  return container;
}

const enabledSettings: Record<string, unknown> = {
  libraryMatchStatus: { enabled: true, sources: { drive115: true } },
};

describe('115 library status badges', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    changeListeners = [];
    installFakeChrome();
    loadDrive115LibraryStateMock.mockReset();
    loadDrive115LibraryStateMock.mockImplementation(async () => fakeLibrary.state);
    fakeLibrary.setEntries([{
      key: 'SSIS-001:file',
      code: 'SSIS-001',
      title: 'SSIS-001',
      folderCid: 'f-SSIS-001',
      folderName: 'SSIS-001',
      rootCid: 'root',
      videoFileId: 'v-SSIS-001',
      pickCode: 'p-SSIS-001',
      fileName: 'SSIS-001.mp4',
      fileSize: 1,
      updatedAt: 1,
    }]);
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it('only treats an exact normalized code match as existing', () => {
    expect(matchesDrive115LibraryCode('ssis-001', ['SSIS-001'])).toBe(true);
    expect(matchesDrive115LibraryCode('ssis-001', ['SSIS-001-C'])).toBe(false);
    expect(matchesDrive115LibraryCode('ssis-001', [])).toBe(false);
  });

  it('uses the top-level local library matching setting while accepting the legacy location', () => {
    expect(isDrive115LibraryStatusEnabled({})).toBe(false);
    expect(isDrive115LibraryStatusEnabled({ libraryMatchStatus: { enabled: true, sources: { drive115: true } } })).toBe(true);
    expect(isDrive115LibraryStatusEnabled({ listEnhancement: { drive115LibraryStatus: { enabled: true } } })).toBe(true);
  });

  it('同页多卡片只触发一次媒体库全量读取（单飞缓存）', async () => {
    const badges = await loadFreshBadgesModule();
    const containers = Array.from({ length: 30 }, (_, index) => attachContainer(index === 0 ? 'SSIS-001' : `CODE-${String(index).padStart(3, '0')}`));

    await Promise.all(containers.map((container) => badges.renderDrive115LibraryStatusBadge(container, container.dataset.videoId as string, enabledSettings)));

    expect(loadDrive115LibraryStateMock).toHaveBeenCalledTimes(1);
    expect(containers[0].querySelector('.drive115-library-status-tag')?.textContent).toBe('115 已有');
    expect(containers[1].querySelector('.drive115-library-status-tag')).toBeNull();
  });


  it('renders a direct 115 play button on the matching poster', async () => {
    const badges = await loadFreshBadgesModule();
    const container = attachCardContainer('SSIS-001');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    await badges.renderDrive115LibraryStatusBadge(container, 'SSIS-001', enabledSettings);

    const button = container.closest('.item')?.querySelector<HTMLButtonElement>('.drive115-library-play-button');
    expect(button).not.toBeNull();
    button?.click();
    expect(open).toHaveBeenCalledWith(
      'https://115vod.com/?pickcode=p-SSIS-001&share_id=0',
      '_blank',
      'noopener,noreferrer',
    );
    expect(container.querySelector('.drive115-library-status-tag')?.textContent).toBe('115 已有');
  });

  it('offers a file picker when one JavDB code matches multiple local videos', async () => {
    const badges = await loadFreshBadgesModule();
    fakeLibrary.setEntries([
      {
        key: 'SSIS-001:a', code: 'SSIS-001', title: 'SSIS-001', folderCid: 'f', folderName: 'SSIS-001',
        rootCid: 'root', videoFileId: 'a', pickCode: 'pick-a', fileName: 'SSIS-001.mp4', fileSize: 900, updatedAt: 1,
      },
      {
        key: 'SSIS-001:b', code: 'SSIS-001', title: 'SSIS-001', folderCid: 'f', folderName: 'SSIS-001',
        rootCid: 'root', videoFileId: 'b', pickCode: 'pick-b', fileName: 'SSIS-001.mkv', fileSize: 700, updatedAt: 1,
      },
    ]);
    const container = attachCardContainer('SSIS-001');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    await badges.renderDrive115LibraryStatusBadge(container, 'SSIS-001', enabledSettings);

    const trigger = container.closest('.item')?.querySelector<HTMLButtonElement>('.drive115-library-play-button');
    trigger?.click();
    const options = container.closest('.item')?.querySelectorAll<HTMLButtonElement>('.drive115-library-play-option');
    expect(options).toHaveLength(2);
    options?.[1]?.click();
    expect(open).toHaveBeenCalledWith(
      'https://115vod.com/?pickcode=pick-b&share_id=0',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('storage 变化后失效缓存并刷新已渲染卡片的角标', async () => {
    const badges = await loadFreshBadgesModule();
    const matched = attachContainer('SSIS-001');
    const incoming = attachContainer('FANZ-999');

    await badges.renderDrive115LibraryStatusBadge(matched, 'SSIS-001', enabledSettings);
    await badges.renderDrive115LibraryStatusBadge(incoming, 'FANZ-999', enabledSettings);
    expect(matched.querySelector('.drive115-library-status-tag')).not.toBeNull();
    expect(incoming.querySelector('.drive115-library-status-tag')).toBeNull();
    expect(loadDrive115LibraryStateMock).toHaveBeenCalledTimes(1);

    // 模拟 115 索引更新：SSIS-001 被移除，FANZ-999 入库
    const entry = (code: string) => ({
      key: `${code}:file`,
      code,
      title: code,
      folderCid: `f-${code}`,
      folderName: code,
      rootCid: 'root',
      videoFileId: `v-${code}`,
      pickCode: `p-${code}`,
      fileName: `${code}.mp4`,
      fileSize: 1,
      updatedAt: 2,
    });
    fakeLibrary.setEntries([entry('FANZ-999')]);
    emitLibraryStateChange();
    await flush();

    expect(loadDrive115LibraryStateMock).toHaveBeenCalledTimes(2);
    expect(matched.querySelector('.drive115-library-status-tag')).toBeNull();
    expect(incoming.querySelector('.drive115-library-status-tag')).not.toBeNull();
  });

  it('重复 storage 变化合并为一次刷新读取', async () => {
    const badges = await loadFreshBadgesModule();
    const container = attachContainer('SSIS-001');
    await badges.renderDrive115LibraryStatusBadge(container, 'SSIS-001', enabledSettings);

    emitLibraryStateChange();
    emitLibraryStateChange();
    emitLibraryStateChange();
    await flush();

    expect(loadDrive115LibraryStateMock).toHaveBeenCalledTimes(2);
  });

  it('设置未开启时不渲染角标也不注册监听', async () => {
    const badges = await loadFreshBadgesModule();
    const container = attachContainer('SSIS-001');

    await badges.renderDrive115LibraryStatusBadge(container, 'SSIS-001', {});

    expect(container.querySelector('.drive115-library-status-tag')).toBeNull();
    expect(loadDrive115LibraryStateMock).not.toHaveBeenCalled();
    expect(changeListeners).toHaveLength(0);
  });

  it('await 期间卡片被移除则不渲染', async () => {
    const badges = await loadFreshBadgesModule();
    let resolveLoad: (() => void) | undefined;
    loadDrive115LibraryStateMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveLoad = () => resolve(fakeLibrary.state);
      }),
    );

    const container = attachContainer('SSIS-001');
    const pending = badges.renderDrive115LibraryStatusBadge(container, 'SSIS-001', enabledSettings);
    container.remove();
    resolveLoad?.();
    await pending;

    expect(container.querySelector('.drive115-library-status-tag')).toBeNull();
  });
});
