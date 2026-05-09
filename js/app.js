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
  includeSubfolders: false,

  detailPanelOpen: true,
  preloaded: {},
  observer: null,
  openItemPath: '',
  renderToken: 0,
  detailRenderToken: 0,

  cacheBytes: 0,
  cacheItems: 0,
  cacheWarningShown: false,
  largeFolderMode: false,
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

function showLoading() {
  clearTimeout(loadingTimer);
  const text = arguments[0] || '正在加载文件...';
  loadingTimer = setTimeout(() => {
    const label = document.getElementById('loadingLabel');
    if (label) label.textContent = text;
    document.getElementById('loadingOverlay').classList.add('show');
  }, 360);
}

function hideLoading() {
  clearTimeout(loadingTimer);
  document.getElementById('loadingOverlay').classList.remove('show');
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

function savePrefs() {
  const prefs = {
    sidebarMode: state.sidebarMode,
    sortKey: state.sortKey,
    sortOrder: state.sortOrder,
    thumbPreset: state.thumbPreset,
    detailPanelOpen: state.detailPanelOpen,
    typeFilter: state.typeFilter,
    includeSubfolders: state.includeSubfolders,
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
    if (typeof prefs.includeSubfolders === 'boolean') state.includeSubfolders = prefs.includeSubfolders;
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
  document.getElementById('includeSubfolders').checked = state.includeSubfolders;
  document.getElementById('searchInput').value = state.searchQuery;

  document.querySelectorAll('#typeFilterGroup .segmented-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.typeFilter === state.typeFilter);
  });

  document.querySelectorAll('#thumbPresetGroup .segmented-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.thumbPreset === state.thumbPreset);
  });

  const detailPanel = document.getElementById('detailPanel');
  const toggleBtn = document.getElementById('toggleDetailBtn');
  detailPanel.classList.toggle('open', state.detailPanelOpen);
  toggleBtn.classList.toggle('active', state.detailPanelOpen);
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

async function buildFolderTree(dirHandle, parentPath = '', depth = 0) {
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
      entries.push({ name, handle });
      counter += 1;
      await maybeYield(counter);
    }
  } catch {
    return node;
  }

  for (const entry of entries) {
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
    const child = await buildFolderTree(sub.handle, path, depth + 1);
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

async function collectMediaFiles(node, includeSubfolders) {
  const files = [];
  let counter = 0;

  async function collectOne(targetNode) {
    try {
      for await (const [name, handle] of targetNode.handle.entries()) {
        if (handle.kind === 'file' && isMediaFile(name)) {
          files.push({
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
          });
        }
        counter += 1;
        await maybeYield(counter);
      }
    } catch {
      // ignore read errors for broken entries
    }

    if (!includeSubfolders) return;
    for (const child of targetNode.children) {
      await collectOne(child);
      counter += 1;
      await maybeYield(counter);
    }
  }

  await collectOne(node);
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

async function openDirectoryHandle(handle) {
  showLoading('正在打开文件夹...');
  try {
    state.rootHandle = handle;
    state.folderTree = await buildFolderTree(handle);

    if (!state.folderTree?.hasMedia) {
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
      toast('该目录中没有可浏览的图片或视频');
      return;
    }

    const initialNode = findNodeByPath(state.folderTree, state.lastActiveFolderPath) || state.folderTree;
    state.activeFolderPath = initialNode.path;
    state.lastActiveFolderPath = initialNode.path;
    state.currentFolderPath = initialNode.path;
    state.currentFolderName = initialNode.name;
    state.collapsedPaths.clear();

    state.allFiles = await collectMediaFiles(initialNode, state.includeSubfolders);
    state.currentFiles = [];
    state.selectedIndex = -1;
    state.openItemPath = '';
    state.largeFolderMode = state.allFiles.length >= LARGE_FOLDER_THRESHOLD;

    await saveDirectoryHandle(handle);
    savePrefs();

    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('gallery').style.display = '';

    updatePathDisplay();
    renderSidebar();
    await applyFilters();

    if (state.largeFolderMode) {
      toast(`已进入大型目录模式，当前共发现 ${state.allFiles.length} 个媒体文件`);
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error(error);
      toast('打开文件夹失败');
    }
  } finally {
    hideLoading();
  }
}

async function openFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read', id: 'gallery-viewer' });
    await openDirectoryHandle(handle);
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error(error);
      toast('无法打开文件夹');
    }
  }
}

async function navigateToFolder(node) {
  showLoading('正在切换文件夹...');
  try {
    state.activeFolderPath = node.path;
    state.lastActiveFolderPath = node.path;
    state.currentFolderPath = node.path;
    state.currentFolderName = node.name;
    savePrefs();

    state.allFiles = await collectMediaFiles(node, state.includeSubfolders);
    state.currentFiles = [];
    state.selectedIndex = -1;
    state.openItemPath = '';
    state.largeFolderMode = state.allFiles.length >= LARGE_FOLDER_THRESHOLD;

    updatePathDisplay();
    renderSidebar();
    await applyFilters();
  } finally {
    hideLoading();
  }
}

async function refreshCurrentFolder() {
  if (!state.rootHandle) {
    toast('请先打开文件夹');
    return;
  }

  showLoading('正在刷新当前目录...');
  const previousFolderPath = state.activeFolderPath || state.lastActiveFolderPath;
  const previousSelectedPath = state.currentFiles[state.selectedIndex]?.path || '';

  try {
    state.folderTree = await buildFolderTree(state.rootHandle);

    if (!state.folderTree?.hasMedia) {
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
      toast('当前目录中没有可浏览的图片或视频');
      return;
    }

    const targetNode = findNodeByPath(state.folderTree, previousFolderPath) || state.folderTree;
    state.activeFolderPath = targetNode.path;
    state.lastActiveFolderPath = targetNode.path;
    state.currentFolderPath = targetNode.path;
    state.currentFolderName = targetNode.name;
    savePrefs();

    state.allFiles = await collectMediaFiles(targetNode, state.includeSubfolders);
    state.currentFiles = [];
    state.selectedIndex = -1;
    state.openItemPath = '';
    state.largeFolderMode = state.allFiles.length >= LARGE_FOLDER_THRESHOLD;

    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('gallery').style.display = '';

    updatePathDisplay();
    renderSidebar();
    await applyFilters();

    if (previousSelectedPath) {
      const nextIndex = state.currentFiles.findIndex((file) => file.path === previousSelectedPath);
      if (nextIndex >= 0 && nextIndex !== state.selectedIndex) {
        await selectFile(nextIndex, false);
      }
    }

    toast('当前目录已刷新');
  } catch (error) {
    console.error(error);
    toast('刷新当前目录失败');
  } finally {
    hideLoading();
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

function renderSidebar() {
  const container = document.getElementById('folderList');
  container.innerHTML = '';
  if (!state.folderTree) return;

  if (state.sidebarMode === 'flat') renderFlatSidebar(container);
  else renderTreeSidebar(container);

  container.querySelectorAll('.folder-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.path === state.activeFolderPath);
  });
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

async function applyFilters() {
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
  if (state.selectedIndex < 0 && files.length > 0) {
    state.selectedIndex = 0;
  }
  if (state.selectedIndex >= files.length) state.selectedIndex = files.length - 1;

  renderGallery();
  updateStats();

  if (state.selectedIndex >= 0) {
    await renderDetail(state.selectedIndex);
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

function renderGallery() {
  const gallery = document.getElementById('gallery');
  const token = ++state.renderToken;
  gallery.innerHTML = '';
  applyGalleryDensity();
  gallery.style.gridTemplateColumns = 'repeat(auto-fit, minmax(min(100%, var(--thumb-min-col-w)), 1fr))';

  if (state.currentFiles.length === 0) {
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

  await ensureCardVisualMeta(file);
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

  const thumbURL = await generateThumb(file, isVideo(file.name));
  if (!thumbURL) {
    return;
  }

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

  showLoading('正在更新浏览范围...');
  try {
    state.allFiles = await collectMediaFiles(node, state.includeSubfolders);
    state.currentFiles = [];
    state.selectedIndex = -1;
    state.openItemPath = '';
    state.largeFolderMode = state.allFiles.length >= LARGE_FOLDER_THRESHOLD;
    updateStats();
    await applyFilters();
  } finally {
    hideLoading();
  }
}

function bindEvents() {
  document.getElementById('openBtn').addEventListener('click', openFolder);
  document.getElementById('refreshFolderBtn').addEventListener('click', refreshCurrentFolder);

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

  document.getElementById('clearCacheBtn').addEventListener('click', async () => {
    await clearThumbCache();
    state.cacheBytes = 0;
    state.cacheItems = 0;
    renderCacheStatus();
    toast('缩略图缓存已清除');
    renderGallery();
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

    const options = { mode: 'read' };
    let permission = await handle.queryPermission(options);
    if (permission === 'prompt') permission = await handle.requestPermission(options);
    if (permission !== 'granted') return;

    await openDirectoryHandle(handle);
    toast('已自动恢复上次打开的文件夹');
  } catch {
    // ignore stale handles
  }
}

function init() {
  loadPrefs();
  syncControlsFromState();
  bindEvents();
  renderDetailEmpty();
  renderCacheStatus();
  updateStats();
  scheduleCacheAudit(10);
  tryRestoreLastFolder().catch(() => {});
}

init();
