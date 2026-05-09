const IMG_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic']);
const VID_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']);

const DB_NAME = 'gallery-viewer-db';
const DB_VERSION = 3;
const THUMB_STORE = 'thumbnails';
const HANDLE_STORE = 'handles';

const PREFS_KEY = 'gallery-viewer-prefs-v3';
const SEARCH_DEBOUNCE_MS = 240;
const GALLERY_BATCH_SIZE = 120;
const LOOP_YIELD_EVERY = 160;
const LARGE_FOLDER_THRESHOLD = 1200;
const COLLECT_CHUNK_SIZE = 80;
const GALLERY_SKELETON_COUNT = 12;
const INLINE_SCAN_PROGRESS_THRESHOLD = 40;
const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'out',
  'target',
]);
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const CACHE_WARN_BYTES = 224 * 1024 * 1024;
const CACHE_TRIM_TARGET_BYTES = 192 * 1024 * 1024;
const THUMB_PRESETS = {
  small: 160,
  medium: 220,
  large: 320,
};
const THUMB_LAYOUTS = {
  small: {
    frameHeight: 150,
    gap: 12,
    nameSize: 12,
    metaSize: 10,
    minColWidth: 180,
  },
  medium: {
    frameHeight: 210,
    gap: 16,
    nameSize: 13,
    metaSize: 11,
    minColWidth: 250,
  },
  large: {
    frameHeight: 280,
    gap: 20,
    nameSize: 14,
    metaSize: 12,
    minColWidth: 340,
  },
};
const state = {
  rootHandle: null,
  folderTree: null,
  sidebarMode: 'tree',
  activeFolderPath: '',
  lastActiveFolderPath: '',
  currentFolderPath: '',
  currentFolderName: '',
  collapsedPaths: new Set(),

  allFiles: [],
  currentFiles: [],
  selectedIndex: -1,
  modalIndex: -1,

  sortKey: 'name',
  sortOrder: 'asc',
  thumbPreset: 'medium',
  thumbSize: THUMB_PRESETS.medium,
  searchQuery: '',
  typeFilter: 'all',
  autoRestoreLastFolder: false,
  includeSubfolders: false,
  excludeCommonDirs: true,

  detailPanelOpen: true,
  preloaded: {},
  observer: null,
  openItemPath: '',
  renderToken: 0,
  detailRenderToken: 0,
  detailItemPath: '',

  cacheBytes: 0,
  cacheItems: 0,
  cacheWarningShown: false,
  largeFolderMode: false,
  pendingRestoreHandle: null,
  pendingRestoreName: '',
  activeScanId: 0,
  cancelScanRequested: false,
  loadingCancelable: false,
  scanVisible: false,
  scanPhase: 'idle',
  scanFoundCount: 0,
  scanTotalCount: 0,
  settingsPanelOpen: false,
};

let toastTimer = null;
let loadingTimer = null;
let searchTimer = null;
let cacheAuditTimer = null;
let cacheAuditRunning = false;

let modalScale = 1;
let modalTranslateX = 0;
let modalTranslateY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartTX = 0;
let dragStartTY = 0;
let detailPlayer = null;
let modalPlayer = null;
let detailVideoUrl = '';
let modalVideoUrl = '';

function getExt(name) {
  const idx = name.lastIndexOf('.');
  return idx === -1 ? '' : name.slice(idx + 1).toLowerCase();
}

function isImage(name) {
  return IMG_EXTS.has(getExt(name));
}

function isVideo(name) {
  return VID_EXTS.has(getExt(name));
}

function isMediaFile(name) {
  return isImage(name) || isVideo(name);
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '--';
  return new Date(ts).toLocaleString('zh-CN');
}

function isIgnoredDirectory(name) {
  return IGNORED_DIR_NAMES.has(String(name || '').toLowerCase());
}

function makeTaskAbortError() {
  const error = new Error('Task aborted');
  error.name = 'AbortError';
  error.isTaskAbort = true;
  return error;
}

function ensureScanActive(scanId) {
  if (scanId !== state.activeScanId || state.cancelScanRequested) {
    throw makeTaskAbortError();
  }
}

function revokeDetailVideoUrl() {
  if (!detailVideoUrl) return;
  URL.revokeObjectURL(detailVideoUrl);
  detailVideoUrl = '';
}

function revokeModalVideoUrl() {
  if (!modalVideoUrl) return;
  URL.revokeObjectURL(modalVideoUrl);
  modalVideoUrl = '';
}

function createXgPlayer(host, options = {}) {
  const XgPlayer = window.Player;
  if (!host || typeof XgPlayer !== 'function') return null;
  host.innerHTML = '';
  const player = new XgPlayer({
    el: host,
    url: options.url,
    width: '100%',
    height: '100%',
    autoplay: Boolean(options.autoplay),
    autoplayMuted: Boolean(options.autoplay && options.muted),
    volume: options.muted ? 0 : 0.8,
    loop: false,
    playsinline: true,
    lang: 'zh-cn',
    fluid: false,
    videoInit: true,
    cssFullscreen: false,
    pip: true,
    playbackRate: [0.5, 0.75, 1, 1.25, 1.5, 2],
    videoAttributes: {
      preload: 'metadata',
      crossorigin: 'anonymous',
    },
  });

  const videoEl = host.querySelector('video');
  if (videoEl) {
    videoEl.draggable = false;
    videoEl.defaultMuted = Boolean(options.muted);
    videoEl.muted = Boolean(options.muted);
    videoEl.playsInline = true;
  }
  if (options.muted) {
    player.volume = 0;
  }
  return player;
}

function pauseDetailPlayback() {
  try {
    detailPlayer?.pause?.();
  } catch {}
  const nativeVideo = document.querySelector('#detailVideo video');
  nativeVideo?.pause();
}

function destroyDetailPlayer() {
  pauseDetailPlayback();
  if (detailPlayer) {
    detailPlayer.destroy();
    detailPlayer = null;
  }
  revokeDetailVideoUrl();
}

function destroyModalPlayer() {
  if (modalPlayer) {
    modalPlayer.destroy();
    modalPlayer = null;
  }
  const host = document.getElementById('modalVideo');
  if (host) host.innerHTML = '';
  revokeModalVideoUrl();
}

function fileTypeLabel(fileName) {
  const ext = getExt(fileName).toUpperCase() || 'UNKNOWN';
  return isVideo(fileName) ? `视频 ${ext}` : `图片 ${ext}`;
}

function applyThumbPreset(preset) {
  state.thumbPreset = THUMB_PRESETS[preset] ? preset : 'medium';
  state.thumbSize = THUMB_PRESETS[state.thumbPreset];
}

function applyGalleryDensity() {
  const gallery = document.getElementById('gallery');
  if (!gallery) return;
  const layout = THUMB_LAYOUTS[state.thumbPreset] || THUMB_LAYOUTS.medium;
  gallery.style.setProperty('--thumb-frame-h', `${layout.frameHeight}px`);
  gallery.style.setProperty('--thumb-gap', `${layout.gap}px`);
  gallery.style.setProperty('--thumb-name-size', `${layout.nameSize}px`);
  gallery.style.setProperty('--thumb-meta-size', `${layout.metaSize}px`);
  gallery.style.setProperty('--thumb-min-col-w', `${layout.minColWidth}px`);
}

function closestThumbPreset(size) {
  const candidates = Object.entries(THUMB_PRESETS);
  let best = 'medium';
  let distance = Number.POSITIVE_INFINITY;
  for (const [preset, value] of candidates) {
    const gap = Math.abs(value - size);
    if (gap < distance) {
      distance = gap;
      best = preset;
    }
  }
  return best;
}

function waitForNextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function maybeYield(counter, every = LOOP_YIELD_EVERY) {
  if (counter > 0 && counter % every === 0) {
    await waitForNextFrame();
  }
}

function showLoading(message = '正在加载文件...', options = {}) {
  clearTimeout(loadingTimer);
  const { cancelable = false, hint = '' } = options;
  const overlay = document.getElementById('loadingOverlay');
  const label = document.getElementById('loadingLabel');
  const hintEl = document.getElementById('loadingHint');
  const cancelBtn = document.getElementById('cancelLoadingBtn');
  state.loadingCancelable = cancelable;
  if (label) label.textContent = message;
  if (hintEl) {
    hintEl.textContent =
      hint ||
      (cancelable
        ? '大型目录扫描期间可随时取消，本次操作不会破坏当前页面里已经打开的内容。'
        : '正在处理，请稍候。');
  }
  if (cancelBtn) {
    cancelBtn.hidden = !cancelable;
    cancelBtn.disabled = false;
    cancelBtn.textContent = '取消本次加载';
  }
  if (overlay.classList.contains('show')) return;
  loadingTimer = setTimeout(() => {
    overlay.classList.add('show');
  }, 360);
}

function hideLoading() {
  clearTimeout(loadingTimer);
  state.loadingCancelable = false;
  const overlay = document.getElementById('loadingOverlay');
  const cancelBtn = document.getElementById('cancelLoadingBtn');
  if (cancelBtn) {
    cancelBtn.hidden = true;
    cancelBtn.disabled = false;
    cancelBtn.textContent = '取消本次加载';
  }
  overlay.classList.remove('show');
}

function beginScanTask(message) {
  state.activeScanId += 1;
  state.cancelScanRequested = false;
  startTreeScanProgress();
  showLoading(message, { cancelable: true });
  return state.activeScanId;
}

function finishScanTask(scanId) {
  if (scanId !== state.activeScanId) return;
  state.cancelScanRequested = false;
  hideLoading();
  completeScanProgress();
}

function cancelCurrentScan() {
  if (!state.loadingCancelable && !state.scanVisible) return;
  state.cancelScanRequested = true;
  if (state.loadingCancelable) {
    showLoading('正在取消当前加载...', {
      cancelable: true,
      hint: '会在本轮扫描让出主线程时尽快停止，并保留当前页面内容。',
    });
  }
  const cancelBtn = document.getElementById('cancelLoadingBtn');
  const inlineCancelBtn = document.getElementById('cancelScanInlineBtn');
  if (cancelBtn) {
    cancelBtn.disabled = true;
    cancelBtn.textContent = '正在取消...';
  }
  if (inlineCancelBtn) {
    inlineCancelBtn.disabled = true;
    inlineCancelBtn.textContent = '正在取消...';
  }
  renderScanProgress();
}

function renderScanProgress() {
  const container = document.getElementById('scanProgress');
  const label = document.getElementById('scanProgressLabel');
  const meta = document.getElementById('scanProgressMeta');
  const bar = document.getElementById('scanProgressBar');
  const cancelBtn = document.getElementById('cancelScanInlineBtn');
  if (!container || !label || !meta || !bar || !cancelBtn) return;

  if (!state.scanVisible) {
    container.hidden = true;
    cancelBtn.hidden = true;
    cancelBtn.disabled = false;
    cancelBtn.textContent = '取消扫描';
    bar.classList.remove('is-indeterminate');
    bar.style.width = '0';
    return;
  }

  container.hidden = false;
  cancelBtn.hidden = false;
  cancelBtn.disabled = state.cancelScanRequested;
  cancelBtn.textContent = state.cancelScanRequested ? '正在取消...' : '取消扫描';

  if (state.scanPhase === 'building-tree') {
    label.textContent = '正在扫描目录结构...';
    meta.textContent = state.excludeCommonDirs
      ? '已启用工程目录排除，正在准备文件列表。'
      : '正在遍历目录结构并统计可浏览媒体。';
    bar.classList.add('is-indeterminate');
    bar.style.width = '34%';
    return;
  }

  const total = state.scanTotalCount;
  const found = state.scanFoundCount;
  label.textContent = '正在逐步加载文件列表...';
  meta.textContent = total > 0
    ? `已发现 ${found} / ${total} 个媒体文件，当前展示 ${state.currentFiles.length} 个`
    : `已发现 ${found} 个媒体文件，当前展示 ${state.currentFiles.length} 个`;
  bar.classList.toggle('is-indeterminate', total <= 0);
  if (total > 0) {
    const ratio = Math.max(0, Math.min(1, found / total));
    bar.style.width = `${Math.max(4, Math.round(ratio * 100))}%`;
  } else {
    bar.style.width = '34%';
  }
}

function startTreeScanProgress() {
  state.scanVisible = false;
  state.scanPhase = 'building-tree';
  state.scanFoundCount = 0;
  state.scanTotalCount = 0;
  renderScanProgress();
}

function startCollectScanProgress(totalCount) {
  state.scanVisible = totalCount >= INLINE_SCAN_PROGRESS_THRESHOLD || state.largeFolderMode;
  state.scanPhase = 'collecting';
  state.scanFoundCount = 0;
  state.scanTotalCount = Number.isFinite(totalCount) ? totalCount : 0;
  renderScanProgress();
}

function updateCollectScanProgress(foundCount) {
  state.scanFoundCount = foundCount;
  if (state.scanTotalCount > 0 && foundCount >= state.scanTotalCount) {
    completeScanProgress();
    return;
  }
  renderScanProgress();
}

function completeScanProgress() {
  state.scanVisible = false;
  state.scanPhase = 'idle';
  state.scanFoundCount = 0;
  state.scanTotalCount = 0;
  renderScanProgress();
}

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(THUMB_STORE)) {
        req.result.createObjectStore(THUMB_STORE);
      }
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) {
        req.result.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function normalizeCacheRecord(record) {
  if (!record) return null;
  if (record instanceof Blob) {
    return { blob: record, size: record.size || 0, updatedAt: Date.now() };
  }
  if (record.blob instanceof Blob) {
    return {
      blob: record.blob,
      size: Number.isFinite(record.size) ? record.size : record.blob.size || 0,
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
    };
  }
  return null;
}

async function getCachedThumb(key) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(THUMB_STORE, 'readonly');
    const req = tx.objectStore(THUMB_STORE).get(key);
    req.onsuccess = () => resolve(normalizeCacheRecord(req.result));
    req.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}

async function writeCacheRecord(key, blob, updatedAt = Date.now()) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(THUMB_STORE, 'readwrite');
    tx.objectStore(THUMB_STORE).put({ blob, size: blob.size || 0, updatedAt }, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

async function putCachedThumb(key, blob) {
  await writeCacheRecord(key, blob);
  scheduleCacheAudit(300);
}

async function touchCachedThumb(key, record) {
  if (!record?.blob) return;
  await writeCacheRecord(key, record.blob, Date.now());
}

async function clearThumbCache() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(THUMB_STORE, 'readwrite');
    tx.objectStore(THUMB_STORE).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

async function getThumbCacheStats() {
  const db = await openDB();
  return new Promise((resolve) => {
    let totalBytes = 0;
    let count = 0;
    const tx = db.transaction(THUMB_STORE, 'readonly');
    const store = tx.objectStore(THUMB_STORE);
    const req = store.openCursor();

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const record = normalizeCacheRecord(cursor.value);
      if (record) {
        totalBytes += record.size;
        count += 1;
      }
      cursor.continue();
    };

    req.onerror = () => resolve({ totalBytes: 0, count: 0 });
    tx.oncomplete = () => {
      db.close();
      resolve({ totalBytes, count });
    };
  });
}

async function trimThumbCache(targetBytes = CACHE_TRIM_TARGET_BYTES) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(THUMB_STORE, 'readwrite');
    const store = tx.objectStore(THUMB_STORE);
    const req = store.openCursor();
    const entries = [];

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const record = normalizeCacheRecord(cursor.value);
      if (record) {
        entries.push({ key: cursor.key, size: record.size, updatedAt: record.updatedAt || 0 });
      }
      cursor.continue();
    };

    tx.oncomplete = async () => {
      db.close();
      let total = entries.reduce((sum, entry) => sum + entry.size, 0);
      if (total <= targetBytes) {
        resolve({ cleared: false, total });
        return;
      }

      entries.sort((a, b) => a.updatedAt - b.updatedAt);
      const deleteDb = await openDB();
      const deleteTx = deleteDb.transaction(THUMB_STORE, 'readwrite');
      const deleteStore = deleteTx.objectStore(THUMB_STORE);
      for (const entry of entries) {
        if (total <= targetBytes) break;
        deleteStore.delete(entry.key);
        total -= entry.size;
      }
      deleteTx.oncomplete = () => {
        deleteDb.close();
        resolve({ cleared: true, total });
      };
      deleteTx.onerror = () => {
        deleteDb.close();
        resolve({ cleared: true, total });
      };
    };

    tx.onerror = () => {
      db.close();
      resolve({ cleared: false, total: 0 });
    };
  });
}

function renderCacheStatus() {
  const el = document.getElementById('cacheStatus');
  el.textContent = `缓存 ${formatSize(state.cacheBytes)} / ${formatSize(CACHE_MAX_BYTES)}`;
  el.title = `缩略图缓存：${formatSize(state.cacheBytes)}，共 ${state.cacheItems} 项，超过 ${formatSize(CACHE_MAX_BYTES)} 会自动清理较早缓存`;
  el.classList.remove('warning', 'danger');
  if (state.cacheBytes >= CACHE_MAX_BYTES) el.classList.add('danger');
  else if (state.cacheBytes >= CACHE_WARN_BYTES) el.classList.add('warning');
}

async function runCacheAudit() {
  if (cacheAuditRunning) return;
  cacheAuditRunning = true;
  try {
    let stats = await getThumbCacheStats();
    state.cacheBytes = stats.totalBytes;
    state.cacheItems = stats.count;

    if (stats.totalBytes > CACHE_MAX_BYTES) {
      const result = await trimThumbCache();
      stats = await getThumbCacheStats();
      state.cacheBytes = stats.totalBytes;
      state.cacheItems = stats.count;
      if (result.cleared) {
        toast('缩略图缓存超出上限，已自动清理较早缓存');
      }
      state.cacheWarningShown = false;
    } else if (stats.totalBytes >= CACHE_WARN_BYTES && !state.cacheWarningShown) {
      toast('缩略图缓存接近上限，达到上限后会自动清理');
      state.cacheWarningShown = true;
    } else if (stats.totalBytes < CACHE_WARN_BYTES) {
      state.cacheWarningShown = false;
    }

    renderCacheStatus();
  } finally {
    cacheAuditRunning = false;
  }
}

function scheduleCacheAudit(delay = 200) {
  clearTimeout(cacheAuditTimer);
  cacheAuditTimer = setTimeout(() => {
    runCacheAudit().catch(() => {});
  }, delay);
}

async function saveDirectoryHandle(handle) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, 'last-folder');
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

async function loadDirectoryHandle() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(HANDLE_STORE, 'readonly');
    const req = tx.objectStore(HANDLE_STORE).get('last-folder');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}

async function clearSavedDirectoryHandle() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).delete('last-folder');
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

function savePrefs() {
  const prefs = {
    sidebarMode: state.sidebarMode,
    sortKey: state.sortKey,
    sortOrder: state.sortOrder,
    thumbPreset: state.thumbPreset,
    detailPanelOpen: state.detailPanelOpen,
    typeFilter: state.typeFilter,
    autoRestoreLastFolder: state.autoRestoreLastFolder,
    includeSubfolders: state.includeSubfolders,
    excludeCommonDirs: state.excludeCommonDirs,
    lastActiveFolderPath: state.lastActiveFolderPath,
  };
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw);

    if (prefs.sidebarMode === 'tree' || prefs.sidebarMode === 'flat') state.sidebarMode = prefs.sidebarMode;
    if (['name', 'date', 'size', 'type'].includes(prefs.sortKey)) state.sortKey = prefs.sortKey;
    if (prefs.sortOrder === 'asc' || prefs.sortOrder === 'desc') state.sortOrder = prefs.sortOrder;
    if (typeof prefs.detailPanelOpen === 'boolean') state.detailPanelOpen = prefs.detailPanelOpen;
    if (['all', 'image', 'video'].includes(prefs.typeFilter)) state.typeFilter = prefs.typeFilter;
    if (typeof prefs.autoRestoreLastFolder === 'boolean') state.autoRestoreLastFolder = prefs.autoRestoreLastFolder;
    if (typeof prefs.includeSubfolders === 'boolean') state.includeSubfolders = prefs.includeSubfolders;
    if (typeof prefs.excludeCommonDirs === 'boolean') state.excludeCommonDirs = prefs.excludeCommonDirs;
    if (typeof prefs.lastActiveFolderPath === 'string') state.lastActiveFolderPath = prefs.lastActiveFolderPath;

    if (prefs.thumbPreset && THUMB_PRESETS[prefs.thumbPreset]) {
      applyThumbPreset(prefs.thumbPreset);
    } else if (Number.isFinite(prefs.thumbSize)) {
      applyThumbPreset(closestThumbPreset(prefs.thumbSize));
    }
  } catch {
    // ignore malformed prefs
  }
}

function syncControlsFromState() {
  const treeBtn = document.getElementById('treeViewBtn');
  const flatBtn = document.getElementById('flatViewBtn');
  treeBtn.classList.toggle('active', state.sidebarMode === 'tree');
  flatBtn.classList.toggle('active', state.sidebarMode === 'flat');

  document.getElementById('sortSelect').value = state.sortKey;
  document.getElementById('sortOrder').value = state.sortOrder;
  document.getElementById('autoRestoreLastFolder').checked = state.autoRestoreLastFolder;
  document.getElementById('includeSubfolders').checked = state.includeSubfolders;
  document.getElementById('excludeCommonDirs').checked = state.excludeCommonDirs;
  document.getElementById('searchInput').value = state.searchQuery;

  document.querySelectorAll('#typeFilterGroup .segmented-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.typeFilter === state.typeFilter);
  });

  document.querySelectorAll('#thumbPresetGroup .segmented-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.thumbPreset === state.thumbPreset);
  });

  const detailPanel = document.getElementById('detailPanel');
  const toggleBtn = document.getElementById('toggleDetailBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  detailPanel.classList.toggle('open', state.detailPanelOpen);
  toggleBtn.classList.toggle('active', state.detailPanelOpen);
  settingsBtn?.classList.toggle('active', state.settingsPanelOpen);
  settingsBtn?.setAttribute('aria-expanded', state.settingsPanelOpen ? 'true' : 'false');
  renderSettingsPanelState();
}

function renderRestoreNotice() {
  const notice = document.getElementById('restoreNotice');
  if (!notice) return;
  if (!state.pendingRestoreHandle || state.rootHandle) {
    notice.hidden = true;
    renderSettingsPanelState();
    return;
  }
  const folderName = state.pendingRestoreName || state.pendingRestoreHandle.name || '未命名文件夹';
  document.getElementById('restoreTitle').textContent = `检测到上次打开的文件夹：${folderName}`;
  document.getElementById('restoreText').textContent = '可手动恢复，或直接忘记这次记录。';
  notice.hidden = false;
  renderSettingsPanelState();
}

function clearRestoreNotice() {
  state.pendingRestoreHandle = null;
  state.pendingRestoreName = '';
  renderRestoreNotice();
}

async function forgetLastFolder(toastMessage = true) {
  await clearSavedDirectoryHandle();
  clearRestoreNotice();
  if (!state.rootHandle) {
    state.lastActiveFolderPath = '';
    savePrefs();
  }
  if (toastMessage) toast('已忘记上次目录');
}

function renderSettingsPanelState() {
  const panel = document.getElementById('settingsPanel');
  const forgetBtn = document.getElementById('forgetSavedFolderBtn');
  if (!panel) return;
  panel.hidden = !state.settingsPanelOpen;
  if (forgetBtn) {
    forgetBtn.disabled = !(state.rootHandle || state.pendingRestoreHandle || state.lastActiveFolderPath);
  }
}

function setSettingsPanelOpen(open) {
  if (state.settingsPanelOpen === open) return;
  state.settingsPanelOpen = open;
  syncControlsFromState();
}

async function setDetailPanelOpen(open) {
  if (state.detailPanelOpen === open) return;

  state.detailPanelOpen = open;
  savePrefs();
  syncControlsFromState();

  if (open && state.selectedIndex >= 0) {
    await renderDetail(state.selectedIndex);
  }
}

async function buildFolderTree(dirHandle, parentPath = '', depth = 0, scanId = state.activeScanId) {
  ensureScanActive(scanId);
  const path = parentPath ? `${parentPath}/${dirHandle.name}` : dirHandle.name;
  const node = {
    name: dirHandle.name,
    path,
    handle: dirHandle,
    depth,
    parentPath,
    fileCount: 0,
    totalMediaCount: 0,
    children: [],
    hasMedia: false,
  };

  const entries = [];
  let counter = 0;
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      ensureScanActive(scanId);
      entries.push({ name, handle });
      counter += 1;
      await maybeYield(counter);
    }
  } catch (error) {
    if (error?.isTaskAbort) throw error;
    return node;
  }

  for (const entry of entries) {
    ensureScanActive(scanId);
    if (entry.handle.kind === 'file' && isMediaFile(entry.name)) {
      node.fileCount += 1;
      node.hasMedia = true;
    }
    counter += 1;
    await maybeYield(counter);
  }

  const subDirs = entries
    .filter((entry) => entry.handle.kind === 'directory')
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  for (const sub of subDirs) {
    ensureScanActive(scanId);
    if (state.excludeCommonDirs && isIgnoredDirectory(sub.name)) {
      counter += 1;
      await maybeYield(counter);
      continue;
    }
    const child = await buildFolderTree(sub.handle, path, depth + 1, scanId);
    if (child.hasMedia) {
      node.children.push(child);
      node.hasMedia = true;
    }
    counter += 1;
    await maybeYield(counter);
  }

  node.totalMediaCount = node.fileCount + node.children.reduce((sum, child) => sum + child.totalMediaCount, 0);
  return node;
}

function findNodeByPath(node, path) {
  if (!node) return null;
  if (node.path === path) return node;
  for (const child of node.children) {
    const hit = findNodeByPath(child, path);
    if (hit) return hit;
  }
  return null;
}

function flattenTree(node, list = []) {
  list.push(node);
  for (const child of node.children) flattenTree(child, list);
  return list;
}

function getNodeChildren(node) {
  return Array.isArray(node?.children) ? node.children.filter((child) => child.hasMedia) : [];
}

async function collectMediaFiles(node, includeSubfolders, scanId = state.activeScanId, options = {}) {
  ensureScanActive(scanId);
  const { onChunk = null, chunkSize = COLLECT_CHUNK_SIZE } = options;
  const files = [];
  let pendingChunk = [];
  let counter = 0;

  async function flushChunk(force = false) {
    if (!onChunk || pendingChunk.length === 0) return;
    const chunk = pendingChunk;
    pendingChunk = [];
    await onChunk(chunk, { foundCount: files.length, force });
  }

  async function collectOne(targetNode) {
    ensureScanActive(scanId);
    try {
      for await (const [name, handle] of targetNode.handle.entries()) {
        ensureScanActive(scanId);
        if (handle.kind === 'file' && isMediaFile(name)) {
          const fileEntry = {
            name,
            ext: getExt(name),
            handle,
            folderPath: targetNode.path,
            path: `${targetNode.path}/${name}`,
            size: undefined,
            lastModified: undefined,
            duration: undefined,
            width: undefined,
            height: undefined,
          };
          files.push(fileEntry);
          if (onChunk) {
            pendingChunk.push(fileEntry);
            if (pendingChunk.length >= chunkSize) {
              await flushChunk();
              ensureScanActive(scanId);
            }
          }
        }
        counter += 1;
        await maybeYield(counter);
      }
    } catch (error) {
      if (error?.isTaskAbort) throw error;
      // ignore read errors for broken entries
    }

    if (!includeSubfolders) return;
    for (const child of targetNode.children) {
      ensureScanActive(scanId);
      await collectOne(child);
      counter += 1;
      await maybeYield(counter);
    }
  }

  await collectOne(node);
  await flushChunk(true);
  return files;
}

async function ensureMeta(file) {
  if (file.size !== undefined && file.lastModified !== undefined) return;
  try {
    const raw = await file.handle.getFile();
    file.size = raw.size;
    file.lastModified = raw.lastModified;
  } catch {
    file.size = 0;
    file.lastModified = 0;
  }
}

async function ensureMetaForList(files) {
  for (let i = 0; i < files.length; i += 40) {
    const slice = files.slice(i, i + 40);
    await Promise.all(slice.map((file) => ensureMeta(file)));
    await waitForNextFrame();
  }
}

function getTargetMediaCount(node, includeSubfolders) {
  if (!node) return 0;
  return includeSubfolders ? node.totalMediaCount : node.fileCount;
}

function prepareProgressiveFolderState(folderTree, targetNode) {
  state.folderTree = folderTree;
  state.activeFolderPath = targetNode.path;
  state.lastActiveFolderPath = targetNode.path;
  state.currentFolderPath = targetNode.path;
  state.currentFolderName = targetNode.name;
  state.allFiles = [];
  state.currentFiles = [];
  state.selectedIndex = -1;
  state.openItemPath = '';
  state.detailItemPath = '';
  state.largeFolderMode = getTargetMediaCount(targetNode, state.includeSubfolders) >= LARGE_FOLDER_THRESHOLD;

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('gallery').style.display = '';

  updatePathDisplay();
  renderSidebar();
  renderGallery();
  updateStats();
  renderDetailEmpty();
}

async function progressivelyCollectIntoGallery(targetNode, scanId, options = {}) {
  const preserveSelectionPath = options.preserveSelectionPath || '';
  const totalCount = getTargetMediaCount(targetNode, state.includeSubfolders);
  let latestSelectionPath = preserveSelectionPath;
  let chunkIndex = 0;

  startCollectScanProgress(totalCount);
  hideLoading();
  renderGallery();
  updateStats();

  const allFiles = await collectMediaFiles(targetNode, state.includeSubfolders, scanId, {
    chunkSize: COLLECT_CHUNK_SIZE,
    onChunk: async (chunk, meta) => {
      ensureScanActive(scanId);
      state.allFiles = state.allFiles.concat(chunk);
      updateCollectScanProgress(meta.foundCount);
      await applyFilters({
        preserveSelectionPath: latestSelectionPath,
        skipDetail: true,
      });
      latestSelectionPath = state.currentFiles[state.selectedIndex]?.path || latestSelectionPath;
      chunkIndex += 1;
      await waitForNextFrame();
    },
  });

  ensureScanActive(scanId);
  state.allFiles = allFiles;
  if (state.scanVisible) completeScanProgress();
  await applyFilters({ preserveSelectionPath: latestSelectionPath });
  return allFiles;
}

async function openDirectoryHandle(handle) {
  const scanId = beginScanTask('正在打开文件夹...');
  try {
    const folderTree = await buildFolderTree(handle, '', 0, scanId);

    if (!folderTree?.hasMedia) {
      ensureScanActive(scanId);
      state.rootHandle = handle;
      state.folderTree = folderTree;
      state.activeFolderPath = folderTree?.path || '';
      state.lastActiveFolderPath = folderTree?.path || '';
      state.currentFolderPath = folderTree?.path || '';
      state.currentFolderName = folderTree?.name || '';
      state.collapsedPaths.clear();
      document.getElementById('emptyState').style.display = '';
      document.getElementById('gallery').style.display = 'none';
      state.currentFiles = [];
      state.allFiles = [];
      state.selectedIndex = -1;
      state.largeFolderMode = false;
      renderGallery();
      renderSidebar();
      updatePathDisplay();
      updateStats();
      renderDetailEmpty();
      await saveDirectoryHandle(handle);
      savePrefs();
      clearRestoreNotice();
      toast('该目录中没有可浏览的图片或视频');
      return true;
    }

    const initialNode = findNodeByPath(folderTree, state.lastActiveFolderPath) || folderTree;
    state.rootHandle = handle;
    state.collapsedPaths.clear();
    prepareProgressiveFolderState(folderTree, initialNode);

    await saveDirectoryHandle(handle);
    savePrefs();
    clearRestoreNotice();
    const allFiles = await progressivelyCollectIntoGallery(initialNode, scanId);

    if (state.largeFolderMode) {
      toast(`已进入大型目录模式，当前共发现 ${allFiles.length} 个媒体文件`);
    }
    return true;
  } catch (error) {
    if (error?.isTaskAbort) {
      if (scanId === state.activeScanId && state.cancelScanRequested) {
        toast('已取消当前加载');
      }
      return false;
    }
    if (error?.name !== 'AbortError') {
      console.error(error);
      toast('打开文件夹失败');
    }
    return false;
  } finally {
    finishScanTask(scanId);
  }
}

async function openFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read', id: 'gallery-viewer' });
    clearRestoreNotice();
    await openDirectoryHandle(handle);
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error(error);
      toast('无法打开文件夹');
    }
  }
}

async function navigateToFolder(node) {
  const scanId = beginScanTask('正在切换文件夹...');
  try {
    prepareProgressiveFolderState(state.folderTree, node);
    savePrefs();
    await progressivelyCollectIntoGallery(node, scanId);
  } catch (error) {
    if (error?.isTaskAbort) {
      if (scanId === state.activeScanId && state.cancelScanRequested) {
        toast('已取消当前加载');
      }
      return;
    }
    console.error(error);
    toast('切换文件夹失败');
  } finally {
    finishScanTask(scanId);
  }
}

async function refreshCurrentFolder() {
  if (!state.rootHandle) {
    toast('请先打开文件夹');
    return;
  }

  const scanId = beginScanTask('正在刷新当前目录...');
  const previousFolderPath = state.activeFolderPath || state.lastActiveFolderPath;
  const previousSelectedPath = state.currentFiles[state.selectedIndex]?.path || '';

  try {
    const folderTree = await buildFolderTree(state.rootHandle, '', 0, scanId);

    if (!folderTree?.hasMedia) {
      ensureScanActive(scanId);
      state.folderTree = folderTree;
      state.activeFolderPath = folderTree?.path || '';
      state.lastActiveFolderPath = folderTree?.path || '';
      state.currentFolderPath = folderTree?.path || '';
      state.currentFolderName = folderTree?.name || '';
      document.getElementById('emptyState').style.display = '';
      document.getElementById('gallery').style.display = 'none';
      state.currentFiles = [];
      state.allFiles = [];
      state.selectedIndex = -1;
      state.largeFolderMode = false;
      renderGallery();
      renderSidebar();
      updatePathDisplay();
      updateStats();
      renderDetailEmpty();
      savePrefs();
      toast('当前目录中没有可浏览的图片或视频');
      return;
    }

    const targetNode = findNodeByPath(folderTree, previousFolderPath) || folderTree;
    state.folderTree = folderTree;
    prepareProgressiveFolderState(folderTree, targetNode);
    savePrefs();
    await progressivelyCollectIntoGallery(targetNode, scanId, {
      preserveSelectionPath: previousSelectedPath,
    });

    if (previousSelectedPath) {
      const nextIndex = state.currentFiles.findIndex((file) => file.path === previousSelectedPath);
      if (nextIndex >= 0 && nextIndex !== state.selectedIndex) {
        await selectFile(nextIndex, false);
      }
    }

    toast('当前目录已刷新');
  } catch (error) {
    if (error?.isTaskAbort) {
      if (scanId === state.activeScanId && state.cancelScanRequested) {
        toast('已取消当前加载');
      }
      return;
    }
    console.error(error);
    toast('刷新当前目录失败');
  } finally {
    finishScanTask(scanId);
  }
}

function updatePathDisplay() {
  const el = document.getElementById('pathDisplay');
  el.innerHTML = '';
  el.title = state.currentFolderPath || '未选择文件夹';

  if (!state.currentFolderPath) {
    el.textContent = '未选择文件夹';
    return;
  }

  const parts = state.currentFolderPath.split('/');
  parts.forEach((part, index) => {
    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = part;
    crumb.title = part;

    if (index < parts.length - 1) {
      crumb.classList.add('is-link');
      const targetPath = parts.slice(0, index + 1).join('/');
      crumb.addEventListener('click', async () => {
        const node = findNodeByPath(state.folderTree, targetPath);
        if (node) await navigateToFolder(node);
      });
    }

    el.appendChild(crumb);

    if (index < parts.length - 1) {
      const sep = document.createElement('span');
      sep.textContent = ' / ';
      sep.style.opacity = '0.45';
      el.appendChild(sep);
    }
  });
}

function toggleNodeCollapse(path) {
  if (state.collapsedPaths.has(path)) state.collapsedPaths.delete(path);
  else state.collapsedPaths.add(path);
  renderSidebar();
}

function buildFolderItem(node, relativeText) {
  const item = document.createElement('div');
  item.className = 'folder-item';
  item.classList.add(`depth-${Math.min(node.depth, 4)}`);
  item.dataset.path = node.path;
  item.style.setProperty('--folder-depth', String(Math.min(node.depth, 4)));
  item.title = node.path;

  item.innerHTML = `
    <span class="folder-chevron" aria-hidden="true"></span>
    <span class="folder-icon" aria-hidden="true"></span>
    <span class="folder-text">
      <span class="folder-name">${escapeHTML(node.name)}</span>
      <span class="folder-subtitle">${escapeHTML(relativeText)}</span>
    </span>
    <span class="folder-count">${node.totalMediaCount}</span>
  `;

  const nameEl = item.querySelector('.folder-name');
  const subEl = item.querySelector('.folder-subtitle');
  nameEl.title = node.name;
  subEl.title = node.path;

  return item;
}

function buildCurrentLevelItem(node) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'current-level-item';
  item.dataset.path = node.path;
  item.title = node.path;
  item.innerHTML = `
    <span class="current-level-name">${escapeHTML(node.name)}</span>
    <span class="folder-count">${node.totalMediaCount}</span>
  `;
  item.addEventListener('click', async () => {
    await navigateToFolder(node);
  });
  return item;
}

function renderCurrentLevelPanel() {
  const panel = document.getElementById('currentLevelPanel');
  const list = document.getElementById('currentLevelList');
  const count = document.getElementById('currentLevelCount');
  const summary = document.getElementById('currentLevelSummary');
  if (!panel || !list || !count || !summary) return;

  list.innerHTML = '';

  if (!state.folderTree || state.sidebarMode !== 'tree') {
    panel.hidden = true;
    return;
  }

  const activeNode = findNodeByPath(state.folderTree, state.activeFolderPath) || state.folderTree;
  const children = getNodeChildren(activeNode);
  panel.hidden = false;
  count.textContent = `${children.length} 个子文件夹`;
  summary.textContent = children.length
    ? `${activeNode.name} 的直接子文件夹，可快速进入当前层级。`
    : `${activeNode.name} 暂无子文件夹，继续浏览当前媒体内容。`;

  if (!children.length) {
    const empty = document.createElement('div');
    empty.className = 'current-level-empty';
    empty.textContent = '当前层级没有更深的媒体文件夹。';
    list.appendChild(empty);
    return;
  }

  children.forEach((child) => {
    const item = buildCurrentLevelItem(child);
    item.classList.toggle('active', item.dataset.path === state.activeFolderPath);
    list.appendChild(item);
  });
}

function renderSidebar() {
  const container = document.getElementById('folderList');
  container.innerHTML = '';
  if (!state.folderTree) {
    renderCurrentLevelPanel();
    return;
  }

  if (state.sidebarMode === 'flat') renderFlatSidebar(container);
  else renderTreeSidebar(container);

  container.querySelectorAll('.folder-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.path === state.activeFolderPath);
  });

  renderCurrentLevelPanel();
}

function renderTreeSidebar(container) {
  function renderNode(node) {
    const relative = node.depth === 0 ? '根目录' : (node.path.replace(`${state.folderTree.name}/`, '') || node.name);
    const item = buildFolderItem(node, relative);
    const hasChildren = node.children.length > 0;
    const isExpanded = !state.collapsedPaths.has(node.path);

    if (hasChildren) item.classList.add('is-collapsible');
    if (hasChildren && isExpanded) item.classList.add('is-expanded');

    const chevron = item.querySelector('.folder-chevron');
    if (hasChildren) {
      chevron.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleNodeCollapse(node.path);
      });
    }

    item.addEventListener('click', async () => {
      await navigateToFolder(node);
    });

    container.appendChild(item);

    if (!hasChildren || !isExpanded) return;
    for (const child of node.children) renderNode(child);
  }

  renderNode(state.folderTree);
}

function renderFlatSidebar(container) {
  const nodes = flattenTree(state.folderTree).filter((node) => node.hasMedia);
  nodes.forEach((node) => {
    const relative = node.depth === 0 ? '根目录' : node.path.replace(`${state.folderTree.name}/`, '');
    const item = buildFolderItem(node, relative || node.name);
    item.classList.remove('depth-1', 'depth-2', 'depth-3', 'depth-4');
    item.classList.add('depth-0');
    item.addEventListener('click', async () => {
      await navigateToFolder(node);
    });
    container.appendChild(item);
  });
}

async function applyFilters(options = {}) {
  const preserveSelectionPath = options.preserveSelectionPath ?? state.currentFiles[state.selectedIndex]?.path ?? '';
  const skipDetail = Boolean(options.skipDetail);
  let files = [...state.allFiles];
  const query = state.searchQuery.trim().toLowerCase();

  if (query) {
    files = files.filter((file) => file.name.toLowerCase().includes(query) || file.ext.toLowerCase().includes(query));
  }

  if (state.typeFilter === 'image') files = files.filter((file) => isImage(file.name));
  if (state.typeFilter === 'video') files = files.filter((file) => isVideo(file.name));

  if (state.sortKey === 'size' || state.sortKey === 'date') {
    await ensureMetaForList(files);
  }

  files.sort((a, b) => {
    let compare = 0;
    switch (state.sortKey) {
      case 'date':
        compare = (a.lastModified || 0) - (b.lastModified || 0);
        break;
      case 'size':
        compare = (a.size || 0) - (b.size || 0);
        break;
      case 'type':
        compare = a.ext.localeCompare(b.ext, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN');
        break;
      case 'name':
      default:
        compare = a.name.localeCompare(b.name, 'zh-CN');
        break;
    }
    return state.sortOrder === 'desc' ? -compare : compare;
  });

  state.currentFiles = files;
  if (preserveSelectionPath) {
    const nextIndex = files.findIndex((file) => file.path === preserveSelectionPath);
    state.selectedIndex = nextIndex >= 0 ? nextIndex : (files.length > 0 ? 0 : -1);
  } else if (state.selectedIndex < 0 && files.length > 0) {
    state.selectedIndex = 0;
  }
  if (state.selectedIndex >= files.length) state.selectedIndex = files.length - 1;

  renderGallery();
  updateStats();

  if (skipDetail) return;
  if (state.selectedIndex >= 0) {
    const selectedPath = state.currentFiles[state.selectedIndex]?.path || '';
    if (state.detailItemPath !== selectedPath) {
      await renderDetail(state.selectedIndex);
    }
  } else {
    renderDetailEmpty();
  }
}

function updateStats() {
  const fileCount = document.getElementById('fileCount');
  fileCount.textContent = `${state.currentFiles.length} 个文件`;
  fileCount.title = state.largeFolderMode ? '大型目录模式已启用分批渲染与懒加载' : '当前筛选后的文件数量';

  const sel = document.getElementById('selectionStatus');
  if (state.selectedIndex >= 0 && state.currentFiles[state.selectedIndex]) {
    sel.textContent = `已选中 ${state.selectedIndex + 1} / ${state.currentFiles.length}`;
  } else if (state.largeFolderMode) {
    sel.textContent = '大型目录模式';
  } else {
    sel.textContent = '未选中';
  }
  renderScanProgress();
}

function setupObserver() {
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }

  state.observer = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      loadThumbForCard(entry.target).catch(() => {});
    });
  }, {
    root: document.getElementById('galleryWrap'),
    rootMargin: '280px 0px',
    threshold: 0.02,
  });
}

function createGalleryCard(file, index) {
  const card = document.createElement('article');
  card.className = 'thumb-card';
  card.classList.add('is-pending');
  if (index === state.selectedIndex) card.classList.add('selected');
  if (file.path === state.openItemPath) card.classList.add('is-open');
  card.dataset.index = String(index);
  card.dataset.path = file.path;
  card.title = file.path;

  const type = isVideo(file.name) ? 'video' : 'image';
  card.innerHTML = `
    <div class="thumb-img-wrap">
      <span class="format-badge">${escapeHTML(file.ext.toUpperCase() || 'FILE')}</span>
      ${type === 'video' ? '<span class="video-badge">视频</span><span class="video-overlay"><span class="video-play" aria-hidden="true"></span></span>' : ''}
    </div>
    <div class="thumb-body">
      <div class="thumb-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</div>
      <div class="thumb-meta">
        <span class="thumb-dimension">尺寸读取中...</span>
        <span class="thumb-size">--</span>
      </div>
    </div>
  `;
  if (type === 'video') card.classList.add('is-video');

  card.addEventListener('click', () => {
    selectFile(index, true).catch(() => {});
  });

  card.addEventListener('dblclick', (event) => {
    event.preventDefault();
    openModal(index).catch(() => {});
  });

  return card;
}

function createGallerySkeletonCard(index) {
  const card = document.createElement('article');
  card.className = 'thumb-card is-pending';
  card.dataset.skeleton = String(index);
  card.innerHTML = `
    <div class="thumb-img-wrap"></div>
    <div class="thumb-body">
      <div class="thumb-name">正在准备文件...</div>
      <div class="thumb-meta">
        <span class="thumb-dimension">尺寸读取中...</span>
        <span class="thumb-size">--</span>
      </div>
    </div>
  `;
  return card;
}

function renderGallery() {
  const gallery = document.getElementById('gallery');
  const token = ++state.renderToken;
  gallery.innerHTML = '';
  applyGalleryDensity();
  const singleMode = state.currentFiles.length === 1;
  gallery.classList.toggle('is-single', singleMode);
  gallery.style.gridTemplateColumns = singleMode
    ? 'minmax(0, 420px)'
    : 'repeat(auto-fit, minmax(min(100%, var(--thumb-min-col-w)), 1fr))';

  if (state.currentFiles.length === 0) {
    if (state.scanVisible && state.scanPhase === 'collecting') {
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < GALLERY_SKELETON_COUNT; i += 1) {
        fragment.appendChild(createGallerySkeletonCard(i));
      }
      gallery.appendChild(fragment);
      return;
    }
    const msg = document.createElement('div');
    msg.className = 'gallery-message';
    msg.textContent = state.searchQuery || state.typeFilter !== 'all'
      ? '没有匹配的文件，试试修改筛选条件。'
      : '当前目录没有可显示的文件。';
    gallery.appendChild(msg);
    return;
  }

  setupObserver();

  const appendBatch = async (startIndex) => {
    if (token !== state.renderToken) return;
    const fragment = document.createDocumentFragment();
    const end = Math.min(startIndex + GALLERY_BATCH_SIZE, state.currentFiles.length);

    for (let i = startIndex; i < end; i += 1) {
      const card = createGalleryCard(state.currentFiles[i], i);
      fragment.appendChild(card);
    }

    if (token !== state.renderToken) return;
    gallery.appendChild(fragment);

    Array.from(gallery.querySelectorAll('.thumb-card')).slice(startIndex, end).forEach((card) => {
      state.observer.observe(card);
    });

    if (end < state.currentFiles.length) {
      await waitForNextFrame();
      appendBatch(end);
    }
  };

  appendBatch(0).catch(() => {});
}

async function loadThumbForCard(card) {
  const index = Number(card.dataset.index);
  const file = state.currentFiles[index];
  if (!file) return;

  const wrap = card.querySelector('.thumb-img-wrap');
  const dimensionLabel = card.querySelector('.thumb-dimension');
  const sizeLabel = card.querySelector('.thumb-size');
  if (!wrap) return;

  const thumbPromise = generateThumb(file, isVideo(file.name));
  const metaPromise = ensureCardVisualMeta(file);

  const thumbURL = await thumbPromise;
  if (card.dataset.index !== String(index) || !card.isConnected) {
    if (thumbURL) URL.revokeObjectURL(thumbURL);
    return;
  }

  if (thumbURL) {
    const img = document.createElement('img');
    img.className = 'thumb-img';
    img.loading = 'lazy';
    img.src = thumbURL;
    img.alt = file.name;
    img.draggable = false;
    img.addEventListener('load', () => {
      img.classList.add('is-ready');
      URL.revokeObjectURL(thumbURL);
    }, { once: true });
    img.addEventListener('error', () => {
      URL.revokeObjectURL(thumbURL);
    }, { once: true });
    wrap.appendChild(img);
  }

  card.classList.remove('is-pending');

  await metaPromise;
  if (card.dataset.index !== String(index) || !card.isConnected) return;

  if (dimensionLabel) {
    if (isVideo(file.name)) {
      const durationText = formatDuration(file.duration);
      dimensionLabel.textContent = durationText ? `时长 ${durationText}` : '时长未知';
      dimensionLabel.title = [
        durationText ? `时长 ${durationText}` : '时长未知',
        file.width && file.height ? `${file.width} × ${file.height}` : '分辨率未知',
      ].join(' / ');
    } else {
      dimensionLabel.textContent = file.width && file.height ? `${file.width} × ${file.height}` : '尺寸未知';
      dimensionLabel.title = dimensionLabel.textContent;
    }
  }
  if (sizeLabel) {
    sizeLabel.textContent = formatSize(file.size);
    sizeLabel.title = sizeLabel.textContent;
  }
}

async function ensureCardVisualMeta(file) {
  await ensureMeta(file);
  if (file.width !== undefined && file.height !== undefined) return;

  try {
    const raw = await file.handle.getFile();
    if (isVideo(file.name)) {
      const meta = await extractVideoMeta(raw);
      file.width = meta.width;
      file.height = meta.height;
      file.duration = meta.duration;
      return;
    }

    const meta = await extractImageMeta(raw);
    file.width = meta.width;
    file.height = meta.height;
  } catch {
    file.width = undefined;
    file.height = undefined;
  }
}

async function generateThumb(file, fromVideo) {
  const cacheKey = `${file.path}_${state.thumbPreset}_v2`;
  const cached = await getCachedThumb(cacheKey);
  if (cached?.blob) {
    touchCachedThumb(cacheKey, cached).catch(() => {});
    return URL.createObjectURL(cached.blob);
  }

  try {
    const raw = await file.handle.getFile();
    const objectURL = URL.createObjectURL(raw);
    const ext = getExt(file.name);

    let thumbBlob = null;
    if (fromVideo) thumbBlob = await captureVideoFrame(objectURL, state.thumbSize);
    else thumbBlob = await createImageThumb(raw, objectURL, state.thumbSize, ext);

    URL.revokeObjectURL(objectURL);

    if (!thumbBlob) return null;
    await putCachedThumb(cacheKey, thumbBlob);
    return URL.createObjectURL(thumbBlob);
  } catch {
    return null;
  }
}

function createImageThumb(fileBlob, url, size, ext) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longestSide = Math.max(img.width, img.height);
      const scale = longestSide > size ? size / longestSide : 1;
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));

      // Keep small source assets at original size to avoid fuzzy upscaling.
      if (scale === 1) {
        resolve(fileBlob);
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);

      const shouldKeepLossless = ['png', 'gif', 'bmp', 'svg'].includes(ext);
      if (shouldKeepLossless) {
        canvas.toBlob((blob) => resolve(blob), 'image/png');
        return;
      }

      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function captureVideoFrame(url, size) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };

    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, (video.duration || 0) / 4 || 0.5);
    };

    video.onseeked = () => {
      const ratio = video.videoWidth / video.videoHeight;
      const canvas = document.createElement('canvas');
      const width = ratio >= 1 ? size : Math.round(size * ratio);
      const height = ratio >= 1 ? Math.round(size / ratio) : size;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, width, height);
      cleanup();
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85);
    };

    video.onerror = () => {
      cleanup();
      resolve(null);
    };

    video.src = url;
  });
}

async function selectFile(index, focusCard = false) {
  if (index < 0 || index >= state.currentFiles.length) return;
  state.selectedIndex = index;

  document.querySelectorAll('.thumb-card').forEach((card, cardIndex) => {
    card.classList.toggle('selected', cardIndex === index);
  });

  updateStats();

  if (state.detailPanelOpen) {
    await renderDetail(index);
  }

  if (focusCard) {
    const card = document.querySelector(`.thumb-card[data-index="${index}"]`);
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function renderDetailEmpty() {
  state.detailRenderToken += 1;
  state.detailItemPath = '';
  destroyDetailPlayer();
  const content = document.getElementById('detailContent');
  content.innerHTML = `
    <div class="detail-empty">
      <p>暂未选择文件</p>
      <p>提示：单击缩略图可查看详情，双击可进入预览。</p>
    </div>
  `;
}

async function extractImageMeta(fileObj) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(fileObj);
    const img = new Image();
    img.onload = () => {
      const width = img.width;
      const height = img.height;
      URL.revokeObjectURL(url);
      resolve({ width, height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: undefined, height: undefined });
    };
    img.src = url;
  });
}

async function extractVideoMeta(fileObj) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(fileObj);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      resolve({ width: undefined, height: undefined, duration: undefined });
      URL.revokeObjectURL(url);
    };
    video.src = url;
  });
}

async function parseExifData(fileObj) {
  if (typeof EXIF === 'undefined') return [];
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const tags = EXIF.readFromBinaryFile(event.target.result);
        if (!tags || Object.keys(tags).length === 0) {
          resolve([]);
          return;
        }

        const list = [];
        if (tags.DateTime) list.push(['拍摄时间', tags.DateTime]);
        if (tags.Make || tags.Model) list.push(['设备', `${tags.Make || ''} ${tags.Model || ''}`.trim()]);
        if (tags.FNumber) list.push(['光圈', `f/${tags.FNumber}`]);
        if (tags.ExposureTime) {
          const exp = tags.ExposureTime;
          const shutter = exp < 1 ? `1/${Math.round(1 / exp)}` : `${exp}s`;
          list.push(['快门', shutter]);
        }
        if (tags.ISOSpeedRatings) list.push(['ISO', String(tags.ISOSpeedRatings)]);
        if (tags.FocalLength) list.push(['焦距', `${tags.FocalLength} mm`]);
        resolve(list);
      } catch {
        resolve([]);
      }
    };
    reader.onerror = () => resolve([]);
    reader.readAsArrayBuffer(fileObj);
  });
}

function preloadDisplayImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

async function renderDetail(index) {
  const renderToken = ++state.detailRenderToken;
  const file = state.currentFiles[index];
  if (!file) {
    renderDetailEmpty();
    return;
  }
  state.detailItemPath = file.path;

  const content = document.getElementById('detailContent');
  destroyDetailPlayer();
  await ensureMeta(file);

  let fileObj;
  try {
    fileObj = await file.handle.getFile();
  } catch {
    renderDetailEmpty();
    return;
  }

  if (isImage(file.name) && (file.width === undefined || file.height === undefined)) {
    const meta = await extractImageMeta(fileObj);
    file.width = meta.width;
    file.height = meta.height;
  }

  if (isVideo(file.name) && (file.width === undefined || file.height === undefined || file.duration === undefined)) {
    const meta = await extractVideoMeta(fileObj);
    file.width = meta.width;
    file.height = meta.height;
    file.duration = meta.duration;
  }

  const previewUrl = isVideo(file.name) ? '' : URL.createObjectURL(fileObj);
  const exifRows = isImage(file.name) ? await parseExifData(fileObj) : [];

  if (previewUrl && !isVideo(file.name)) {
    await preloadDisplayImage(previewUrl);
  }

  if (renderToken !== state.detailRenderToken) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    return;
  }

  const exifHtml = exifRows.length
    ? `
      <section class="detail-section">
        <p class="detail-section-title">EXIF 信息</p>
        <div class="detail-exif-list">
          ${exifRows
            .map(([key, value]) => `<div class="detail-exif-item"><span class="detail-label">${escapeHTML(key)}</span><span class="detail-value">${escapeHTML(value)}</span></div>`)
            .join('')}
        </div>
      </section>
    `
    : '';

  content.innerHTML = `
    <section class="detail-section">
      <div class="detail-preview${isVideo(file.name) ? ' is-video' : ''}">
        ${isVideo(file.name)
          ? '<video id="detailVideo" class="detail-native-video" controls muted playsinline preload="metadata"></video>'
          : `<img id="detailThumb" alt="detail-thumb" src="${previewUrl || ''}">`}
      </div>
      <p class="detail-name">${escapeHTML(file.name)}</p>
      <p class="detail-subtitle">${escapeHTML(file.folderPath)}</p>
    </section>

    <section class="detail-section">
      <p class="detail-section-title">基础信息</p>
      <div class="detail-grid">
        <div class="detail-row"><span class="detail-label">格式</span><span class="detail-value">${escapeHTML(fileTypeLabel(file.name))}</span></div>
        <div class="detail-row"><span class="detail-label">大小</span><span class="detail-value">${formatSize(file.size)}</span></div>
        <div class="detail-row"><span class="detail-label">修改时间</span><span class="detail-value">${escapeHTML(formatDate(file.lastModified))}</span></div>
        <div class="detail-row"><span class="detail-label">分辨率</span><span class="detail-value">${file.width && file.height ? `${file.width} × ${file.height}` : '--'}</span></div>
        ${isVideo(file.name) ? `<div class="detail-row"><span class="detail-label">时长</span><span class="detail-value">${formatDuration(file.duration)}</span></div>` : ''}
      </div>
    </section>

    ${exifHtml}
  `;

  if (isVideo(file.name)) {
    const detailVideo = document.getElementById('detailVideo');
    detailVideoUrl = URL.createObjectURL(fileObj);
    if (detailVideo) {
      detailVideo.draggable = false;
      detailVideo.defaultMuted = true;
      detailVideo.muted = true;
      detailVideo.src = detailVideoUrl;
      detailVideo.load();
    }
  } else if (previewUrl) {
    const detailThumb = document.getElementById('detailThumb');
    detailThumb?.addEventListener('load', () => {
      URL.revokeObjectURL(previewUrl);
    }, { once: true });
    detailThumb?.addEventListener('error', () => {
      URL.revokeObjectURL(previewUrl);
    }, { once: true });
  }
}

function resetModalTransform() {
  modalScale = 1;
  modalTranslateX = 0;
  modalTranslateY = 0;
}

function applyModalTransform() {
  const img = document.getElementById('modalMedia');
  img.style.transform = `translate(${modalTranslateX}px, ${modalTranslateY}px) scale(${modalScale})`;
}

function applyModalImageSizing(img, file) {
  const maxWidth = Math.floor(window.innerWidth * 0.9);
  const maxHeight = Math.floor(window.innerHeight * 0.82);
  const naturalWidth = file?.width || img.naturalWidth || 0;
  const naturalHeight = file?.height || img.naturalHeight || 0;
  const shouldKeepOriginalSize = naturalWidth > 0 && naturalHeight > 0 && naturalWidth <= maxWidth && naturalHeight <= maxHeight;

  img.style.maxWidth = `${maxWidth}px`;
  img.style.maxHeight = `${maxHeight}px`;

  if (shouldKeepOriginalSize) {
    img.style.width = `${naturalWidth}px`;
    img.style.height = `${naturalHeight}px`;
    img.style.objectFit = 'none';
    return;
  }

  img.style.width = 'auto';
  img.style.height = 'auto';
  img.style.objectFit = 'contain';
}

function clearPreloaded() {
  Object.values(state.preloaded).forEach((url) => URL.revokeObjectURL(url));
  state.preloaded = {};
}

function preloadAdjacent(index) {
  [-1, 1].forEach((delta) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= state.currentFiles.length || state.preloaded[nextIndex]) return;
    const file = state.currentFiles[nextIndex];
    if (!file || isVideo(file.name)) return;

    file.handle.getFile().then((raw) => {
      state.preloaded[nextIndex] = URL.createObjectURL(raw);
    }).catch(() => {});
  });
}

async function openModal(index) {
  const file = state.currentFiles[index];
  if (!file) return;

  pauseDetailPlayback();
  state.modalIndex = index;
  state.openItemPath = file.path;
  document.querySelectorAll('.thumb-card').forEach((card) => {
    card.classList.toggle('is-open', card.dataset.path === state.openItemPath);
  });

  resetModalTransform();

  const modal = document.getElementById('modal');
  const img = document.getElementById('modalMedia');
  const video = document.getElementById('modalVideo');
  const info = document.getElementById('modalInfo');

  img.style.display = 'none';
  video.style.display = 'none';
  modal.classList.toggle('is-video', isVideo(file.name));

  const preloadHit = !isVideo(file.name) ? state.preloaded[index] : null;
  if (preloadHit) delete state.preloaded[index];

  clearPreloaded();
  preloadAdjacent(index);

  let raw;
  try {
    raw = await file.handle.getFile();
  } catch {
    toast('预览打开失败');
    return;
  }

  await ensureMeta(file);

  if (isImage(file.name) && (file.width === undefined || file.height === undefined)) {
    const meta = await extractImageMeta(raw);
    file.width = meta.width;
    file.height = meta.height;
  }

  if (isVideo(file.name) && (file.width === undefined || file.height === undefined || file.duration === undefined)) {
    const meta = await extractVideoMeta(raw);
    file.width = meta.width;
    file.height = meta.height;
    file.duration = meta.duration;
  }

  const src = preloadHit || URL.createObjectURL(raw);
  modal.classList.add('open');

  if (isVideo(file.name)) {
    modalVideoUrl = src;
    video.style.display = '';
    modalPlayer = createXgPlayer(video, {
      url: src,
      autoplay: true,
      muted: false,
    });
    modalPlayer?.play?.().catch?.(() => {});
  } else {
    img.onload = () => {
      applyModalImageSizing(img, file);
      applyModalTransform();
    };
    img.src = src;
    img.style.display = '';
    img.draggable = false;
  }

  info.innerHTML = [
    `<span class="modal-pill">${escapeHTML(file.name)}</span>`,
    `<span class="modal-pill">${formatSize(file.size)}</span>`,
  ].join('');
}

function closeModal() {
  const modal = document.getElementById('modal');
  const img = document.getElementById('modalMedia');

  modal.classList.remove('open');
  modal.classList.remove('is-video');

  if (img.src) {
    URL.revokeObjectURL(img.src);
    img.src = '';
  }
  destroyModalPlayer();

  state.modalIndex = -1;
  state.openItemPath = '';
  document.querySelectorAll('.thumb-card').forEach((card) => card.classList.remove('is-open'));
  clearPreloaded();
}

function navigateModal(delta) {
  if (state.modalIndex < 0) return;
  const nextIndex = state.modalIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.currentFiles.length) return;

  const img = document.getElementById('modalMedia');
  if (img.src) {
    URL.revokeObjectURL(img.src);
    img.src = '';
  }
  destroyModalPlayer();

  openModal(nextIndex).catch(() => {});
}

function getGalleryColumnCount() {
  const cards = [...document.querySelectorAll('#gallery .thumb-card')];
  if (cards.length <= 1) return 1;
  const firstTop = cards[0].offsetTop;
  let count = 0;
  for (const card of cards) {
    if (Math.abs(card.offsetTop - firstTop) > 4) break;
    count += 1;
  }
  return Math.max(1, count);
}

async function moveSelection(delta) {
  if (state.currentFiles.length === 0) return;

  let nextIndex = state.selectedIndex;
  if (nextIndex < 0) nextIndex = 0;
  else nextIndex = Math.max(0, Math.min(state.currentFiles.length - 1, nextIndex + delta));

  await selectFile(nextIndex, true);
}

async function updateFolderScope() {
  const node = findNodeByPath(state.folderTree, state.activeFolderPath);
  if (!node) return;

  const scanId = beginScanTask('正在更新浏览范围...');
  try {
    state.allFiles = [];
    state.currentFiles = [];
    state.selectedIndex = -1;
    state.openItemPath = '';
    state.detailItemPath = '';
    state.largeFolderMode = getTargetMediaCount(node, state.includeSubfolders) >= LARGE_FOLDER_THRESHOLD;
    renderDetailEmpty();
    renderGallery();
    updateStats();
    await progressivelyCollectIntoGallery(node, scanId);
  } catch (error) {
    if (error?.isTaskAbort) {
      if (scanId === state.activeScanId && state.cancelScanRequested) {
        toast('已取消当前加载');
      }
      return;
    }
    console.error(error);
    toast('更新浏览范围失败');
  } finally {
    finishScanTask(scanId);
  }
}

function bindEvents() {
  document.getElementById('openBtn').addEventListener('click', openFolder);
  document.getElementById('refreshFolderBtn').addEventListener('click', refreshCurrentFolder);
  document.getElementById('cancelLoadingBtn').addEventListener('click', cancelCurrentScan);
  document.getElementById('cancelScanInlineBtn').addEventListener('click', cancelCurrentScan);
  document.getElementById('settingsBtn').addEventListener('click', () => {
    setSettingsPanelOpen(!state.settingsPanelOpen);
  });
  document.getElementById('restoreLastBtn').addEventListener('click', async () => {
    const handle = state.pendingRestoreHandle;
    if (!handle) return;
    try {
      const options = { mode: 'read' };
      let permission = await handle.queryPermission(options);
      if (permission === 'prompt') permission = await handle.requestPermission(options);
      if (permission !== 'granted') {
        toast('未授予目录读取权限');
        return;
      }
      const opened = await openDirectoryHandle(handle);
      if (opened) toast('已恢复上次打开的文件夹');
    } catch {
      await forgetLastFolder(false);
      toast('上次目录已失效，已帮你清除恢复记录');
    }
  });
  document.getElementById('skipRestoreBtn').addEventListener('click', () => {
    clearRestoreNotice();
  });
  document.getElementById('forgetRestoreBtn').addEventListener('click', async () => {
    await forgetLastFolder(true);
  });

  document.getElementById('treeViewBtn').addEventListener('click', () => {
    state.sidebarMode = 'tree';
    savePrefs();
    syncControlsFromState();
    renderSidebar();
  });

  document.getElementById('flatViewBtn').addEventListener('click', () => {
    state.sidebarMode = 'flat';
    savePrefs();
    syncControlsFromState();
    renderSidebar();
  });

  document.getElementById('sortSelect').addEventListener('change', async (event) => {
    state.sortKey = event.target.value;
    savePrefs();
    await applyFilters();
  });

  document.getElementById('sortOrder').addEventListener('change', async (event) => {
    state.sortOrder = event.target.value;
    savePrefs();
    await applyFilters();
  });

  document.getElementById('autoRestoreLastFolder').addEventListener('change', (event) => {
    state.autoRestoreLastFolder = event.target.checked;
    savePrefs();
  });

  document.querySelectorAll('#thumbPresetGroup .segmented-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      applyThumbPreset(btn.dataset.thumbPreset);
      savePrefs();
      syncControlsFromState();
      renderGallery();
    });
  });

  document.getElementById('searchInput').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.searchQuery = event.target.value || '';
      await applyFilters();
    }, SEARCH_DEBOUNCE_MS);
  });

  document.querySelectorAll('#typeFilterGroup .segmented-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.typeFilter = btn.dataset.typeFilter;
      savePrefs();
      syncControlsFromState();
      await applyFilters();
    });
  });

  document.getElementById('includeSubfolders').addEventListener('change', async (event) => {
    state.includeSubfolders = event.target.checked;
    savePrefs();
    await updateFolderScope();
  });

  document.getElementById('excludeCommonDirs').addEventListener('change', async (event) => {
    state.excludeCommonDirs = event.target.checked;
    savePrefs();
    if (state.rootHandle) {
      await refreshCurrentFolder();
    }
  });

  document.getElementById('clearCacheBtn').addEventListener('click', async () => {
    await clearThumbCache();
    state.cacheBytes = 0;
    state.cacheItems = 0;
    renderCacheStatus();
    toast('缩略图缓存已清除');
    renderGallery();
  });
  document.getElementById('forgetSavedFolderBtn').addEventListener('click', async () => {
    await forgetLastFolder(true);
  });

  document.getElementById('toggleDetailBtn').addEventListener('click', async () => {
    await setDetailPanelOpen(!state.detailPanelOpen);
  });

  document.getElementById('detailCloseBtn').addEventListener('click', async () => {
    await setDetailPanelOpen(false);
  });

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalPrev').addEventListener('click', () => navigateModal(-1));
  document.getElementById('modalNext').addEventListener('click', () => navigateModal(1));

  document.getElementById('modal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal();
  });

  document.addEventListener('click', (event) => {
    if (!state.settingsPanelOpen) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('#settingsPanel') || target.closest('#settingsBtn')) return;
    setSettingsPanelOpen(false);
  });

  const modalImg = document.getElementById('modalMedia');
  modalImg.addEventListener('wheel', (event) => {
    if (state.modalIndex < 0) return;
    event.preventDefault();

    const rect = modalImg.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;

    const ix = (mx - modalTranslateX) / modalScale;
    const iy = (my - modalTranslateY) / modalScale;
    const delta = event.deltaY > 0 ? -0.14 : 0.14;
    const newScale = Math.max(0.1, Math.min(10, modalScale + delta));

    modalTranslateX = mx - ix * newScale;
    modalTranslateY = my - iy * newScale;
    modalScale = newScale;
    applyModalTransform();
  });

  modalImg.addEventListener('mousedown', (event) => {
    if (state.modalIndex < 0) return;
    isDragging = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragStartTX = modalTranslateX;
    dragStartTY = modalTranslateY;
  });

  window.addEventListener('mousemove', (event) => {
    if (!isDragging) return;
    modalTranslateX = dragStartTX + (event.clientX - dragStartX);
    modalTranslateY = dragStartTY + (event.clientY - dragStartY);
    applyModalTransform();
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  window.addEventListener('resize', () => {
    renderGallery();
  });

  window.addEventListener('keydown', async (event) => {

    const modalOpen = state.modalIndex >= 0;

    if ((state.loadingCancelable || state.scanVisible) && event.key === 'Escape') {
      event.preventDefault();
      cancelCurrentScan();
      return;
    }

    if (state.settingsPanelOpen && event.key === 'Escape') {
      event.preventDefault();
      setSettingsPanelOpen(false);
      return;
    }

    if (modalOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigateModal(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigateModal(1);
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        resetModalTransform();
        applyModalTransform();
        return;
      }
    }

    if (event.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      await moveSelection(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      await moveSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      await moveSelection(-getGalleryColumnCount());
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      await moveSelection(getGalleryColumnCount());
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (state.selectedIndex >= 0) {
        event.preventDefault();
        await openModal(state.selectedIndex);
      }
    }
  }, true);

  document.addEventListener('dragstart', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('#gallery') || target.closest('#modal') || target.closest('#detailPanel')) {
      event.preventDefault();
    }
  });
}

async function tryRestoreLastFolder() {
  try {
    const handle = await loadDirectoryHandle();
    if (!handle) return;
    const permission = await handle.queryPermission({ mode: 'read' });
    if (state.autoRestoreLastFolder && permission === 'granted') {
      state.pendingRestoreHandle = null;
      state.pendingRestoreName = '';
      renderRestoreNotice();
      const opened = await openDirectoryHandle(handle);
      if (!opened) return;
      toast('已自动恢复上次打开的文件夹');
      return;
    }
    state.pendingRestoreHandle = handle;
    state.pendingRestoreName = handle.name || '';
    renderRestoreNotice();
  } catch {
    await forgetLastFolder(false);
  }
}

function init() {
  loadPrefs();
  bindEvents();
  syncControlsFromState();
  renderDetailEmpty();
  renderCacheStatus();
  renderRestoreNotice();
  updateStats();
  scheduleCacheAudit(10);
  tryRestoreLastFolder().catch(() => {});
}

init();
