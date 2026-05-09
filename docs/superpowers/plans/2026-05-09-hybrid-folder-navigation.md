# Hybrid Folder Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `galleryViewer` 左侧导航落地为“轻量树 + 当前层级”的混合模式，同时保留全局平铺文件夹入口。

**Architecture:** 不改目录扫描、缓存、文件读取、缩略图生成和媒体详情逻辑，只在现有 `state.sidebarMode`、`renderSidebar()`、`renderTreeSidebar()`、`renderFlatSidebar()` 周围增加当前层级渲染。HTML 保留现有按钮 ID，CSS 继续采用轻量媒体 App 风格，JS 复用 `folderTree`、`activeFolderPath`、`findNodeByPath()`、`navigateToFolder()`。

**Tech Stack:** 原生 HTML/CSS/JavaScript，Web File System Access API，IndexedDB，现有 `python3 -m http.server` 本地预览流程。

---

## Scope And Guardrails

- 保留 `treeViewBtn`、`flatViewBtn`、`folderList`、`sidebarMode`、`renderTreeSidebar()`、`renderFlatSidebar()`。
- 不改 `buildFolderTree()`、`collectMediaFiles()`、`openDirectoryHandle()`、缓存清理、缩略图生成、EXIF 或视频播放器逻辑。
- 默认模式仍是 `tree`，但树模式下额外展示“当前层级”模块。
- 平铺模式仍显示全局包含媒体的目录列表，并隐藏“当前层级”模块。
- CSS 必须保留 `[hidden] { display: none !important; }`。

## File Map

- Modify: `index.html`
  - 在 `#folderList` 下方增加 `#currentLevelPanel`、`#currentLevelSummary`、`#currentLevelList`，用于树模式下展示当前目录的直接子文件夹。
- Modify: `css/style.css`
  - 调整左侧导航为轻量树样式。
  - 新增当前层级模块、子文件夹卡片、平铺模式状态样式。
  - 降低树线、边框和计数视觉权重。
- Modify: `js/app.js`
  - 新增 `renderCurrentLevelPanel()`、`buildCurrentLevelItem()`、`getNodeChildren()`。
  - 在 `renderSidebar()` 和模式切换中同步当前层级模块。
  - 保持 `renderFlatSidebar()` 的全局平铺能力。
- Verify only: `docs/superpowers/gallery-layout-sketch.html`
  - 仅作为视觉参考，不把草图脚本复制进正式应用。

---

### Task 1: Add Current-Level Markup

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Locate sidebar structure**

Read `index.html` around the left sidebar and confirm this block exists:

```html
<div id="folderList"></div>
```

Expected: `#folderList` is inside `<aside id="sidebar">` and after `.sidebar-hint`.

- [ ] **Step 2: Insert current-level panel after `#folderList`**

Replace this exact block:

```html
<div id="folderList"></div>
```

with:

```html
<div id="folderList"></div>
<section id="currentLevelPanel" class="current-level-panel" hidden>
  <div class="current-level-head">
    <span class="group-label">当前层级</span>
    <span id="currentLevelCount" class="current-level-count">0 个子文件夹</span>
  </div>
  <p id="currentLevelSummary" class="current-level-summary">
    选择目录后，这里会显示当前目录的直接子文件夹。
  </p>
  <div id="currentLevelList" class="current-level-list"></div>
</section>
```

- [ ] **Step 3: Verify HTML structure**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
html = Path('index.html').read_text(encoding='utf-8')
required = ['id="currentLevelPanel"', 'id="currentLevelCount"', 'id="currentLevelSummary"', 'id="currentLevelList"']
missing = [item for item in required if item not in html]
if missing:
    raise SystemExit(f'Missing markup: {missing}')
print('current-level markup present')
PY
```

Expected output:

```text
current-level markup present
```

- [ ] **Step 4: Commit task**

Run:

```bash
git add index.html
git commit -m "feat: add current-level folder panel markup"
```

Expected: one commit containing only `index.html` changes for this task.

---

### Task 2: Style Hybrid Sidebar

**Files:**
- Modify: `css/style.css`

- [ ] **Step 1: Preserve global hidden rule**

Confirm `css/style.css` still contains:

```css
[hidden] {
  display: none !important;
}
```

- [ ] **Step 2: Add current-level styles after existing `.folder-count` rule**

Insert this CSS after the `.folder-count` block:

```css
.current-level-panel {
  margin-top: 4px;
  padding: 10px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.032);
  border: 1px solid rgba(148, 163, 184, 0.07);
}

.current-level-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.current-level-count {
  color: rgba(134, 150, 176, 0.78);
  font-size: 10px;
}

.current-level-summary {
  margin-bottom: 8px;
  color: rgba(175, 189, 214, 0.78);
  font-size: 11px;
  line-height: 1.45;
}

.current-level-list {
  display: grid;
  gap: 5px;
}

.current-level-item {
  width: 100%;
  min-height: 38px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.025);
  color: var(--text-muted);
  text-align: left;
  cursor: pointer;
  transition:
    background 0.16s var(--easing),
    border-color 0.16s var(--easing),
    color 0.16s var(--easing),
    transform 0.16s var(--easing);
}

.current-level-item:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.055);
  border-color: rgba(148, 163, 184, 0.1);
  transform: translateY(-1px);
}

.current-level-item.active {
  color: var(--text);
  background: rgba(108, 140, 255, 0.14);
  border-color: rgba(108, 140, 255, 0.24);
}

.current-level-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 650;
}

.current-level-empty {
  padding: 9px 10px;
  border-radius: 13px;
  color: rgba(134, 150, 176, 0.78);
  background: rgba(255, 255, 255, 0.025);
  font-size: 11px;
  line-height: 1.45;
}
```

- [ ] **Step 3: Lighten tree line visual weight**

In `.folder-item::before`, use this background and opacity behavior:

```css
.folder-item::before {
  content: "";
  position: absolute;
  left: calc(18px + (var(--folder-depth, 0) * 14px));
  top: -4px;
  bottom: -4px;
  width: 1px;
  background: rgba(148, 163, 184, 0.08);
  opacity: 0;
}
```

Keep the existing depth selectors that set `opacity: 1` for nested folders.

- [ ] **Step 4: Verify CSS selectors exist**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
css = Path('css/style.css').read_text(encoding='utf-8')
required = ['.current-level-panel', '.current-level-item', '.current-level-empty', '[hidden]']
missing = [item for item in required if item not in css]
if missing:
    raise SystemExit(f'Missing CSS selectors: {missing}')
print('hybrid sidebar CSS present')
PY
```

Expected output:

```text
hybrid sidebar CSS present
```

- [ ] **Step 5: Commit task**

Run:

```bash
git add css/style.css
git commit -m "style: add hybrid sidebar current-level styles"
```

Expected: one commit containing only `css/style.css` changes for this task.

---

### Task 3: Implement Current-Level Rendering

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: Add child-node helper after `flattenTree()`**

Insert after the existing `flattenTree(node, list = [])` function:

```js
function getNodeChildren(node) {
  return Array.isArray(node?.children) ? node.children.filter((child) => child.hasMedia) : [];
}
```

- [ ] **Step 2: Add current-level item builder after `buildFolderItem()`**

Insert after the existing `buildFolderItem(node, relativeText)` function:

```js
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
```

- [ ] **Step 3: Add panel renderer after `buildCurrentLevelItem()`**

Insert immediately after `buildCurrentLevelItem()`:

```js
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
```

- [ ] **Step 4: Call panel renderer from `renderSidebar()`**

Update `renderSidebar()` to call `renderCurrentLevelPanel()` after folder item active-state sync:

```js
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
```

- [ ] **Step 5: Verify JS symbols exist**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
js = Path('js/app.js').read_text(encoding='utf-8')
required = ['function getNodeChildren', 'function buildCurrentLevelItem', 'function renderCurrentLevelPanel', 'renderCurrentLevelPanel();']
missing = [item for item in required if item not in js]
if missing:
    raise SystemExit(f'Missing JS symbols: {missing}')
print('hybrid sidebar JS present')
PY
```

Expected output:

```text
hybrid sidebar JS present
```

- [ ] **Step 6: Commit task**

Run:

```bash
git add js/app.js
git commit -m "feat: render current-level folder shortcuts"
```

Expected: one commit containing only `js/app.js` changes for this task.

---

### Task 4: Sync Mode Copy And Flat Mode Behavior

**Files:**
- Modify: `index.html`
- Modify: `js/app.js`

- [ ] **Step 1: Update sidebar hint copy in `index.html`**

Replace the current `.sidebar-hint` text with:

```html
<div class="sidebar-hint">
  默认保留轻量目录树；选中目录后，下方会突出当前层级子文件夹。平铺视图仍可快速扫视全部媒体目录。
</div>
```

- [ ] **Step 2: Ensure tree mode shows current-level panel and flat mode hides it**

Confirm the existing click handlers remain structurally identical except they call `renderSidebar()`:

```js
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
```

The `renderCurrentLevelPanel()` logic from Task 3 hides the panel when `state.sidebarMode !== 'tree'`.

- [ ] **Step 3: Verify copy and behavior hooks**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
html = Path('index.html').read_text(encoding='utf-8')
js = Path('js/app.js').read_text(encoding='utf-8')
if '默认保留轻量目录树' not in html:
    raise SystemExit('Sidebar hint copy not updated')
if "state.sidebarMode !== 'tree'" not in js:
    raise SystemExit('Current-level panel does not hide outside tree mode')
print('mode copy and panel visibility are wired')
PY
```

Expected output:

```text
mode copy and panel visibility are wired
```

- [ ] **Step 4: Commit task**

Run:

```bash
git add index.html js/app.js
git commit -m "feat: sync hybrid sidebar mode behavior"
```

Expected: one commit containing sidebar copy and mode visibility changes.

---

### Task 5: Manual Browser Verification

**Files:**
- Verify: `index.html`
- Verify: `css/style.css`
- Verify: `js/app.js`

- [ ] **Step 1: Start local server**

Run:

```bash
python3 -m http.server 4173
```

Expected output contains:

```text
Serving HTTP on :: port 4173
```

If port `4173` is already in use by the sketch preview server, use:

```bash
python3 -m http.server 4174
```

- [ ] **Step 2: Open the app**

Open one of these URLs:

```text
http://localhost:4173/
http://localhost:4174/
```

Expected: Gallery Viewer loads without console errors.

- [ ] **Step 3: Select a local media folder**

Use “打开文件夹” and choose a directory with at least one nested folder containing images or videos.

Expected:

```text
左侧显示目录树；中间显示媒体缩略图；右侧详情面板保持可用。
```

- [ ] **Step 4: Verify tree mode hybrid panel**

Click several folders in the left tree.

Expected:

```text
当前层级面板随选中目录更新；有子文件夹时显示子文件夹快捷入口；无子文件夹时显示空状态文案。
```

- [ ] **Step 5: Verify current-level item navigation**

Click a child folder inside the current-level panel.

Expected:

```text
当前目录切换到该子文件夹；中间媒体网格刷新；路径面包屑刷新；左侧 active 状态刷新。
```

- [ ] **Step 6: Verify flat mode is preserved**

Click `flatViewBtn`.

Expected:

```text
左侧切换为全局平铺文件夹列表；当前层级面板隐藏；点击平铺列表项仍能导航。
```

- [ ] **Step 7: Verify return to tree mode**

Click `treeViewBtn`.

Expected:

```text
左侧回到轻量树；当前层级面板重新出现；此前选中的目录仍处于 active 状态。
```

- [ ] **Step 8: Verify unrelated core behavior**

Check these existing behaviors:

```text
搜索文件名、类型筛选、包含子目录、排序、缩略图大小、详情面板开关、双击预览。
```

Expected: behavior is unchanged compared with implementation前。

- [ ] **Step 9: Commit verification pass if final tweaks were needed**

If Task 5 required CSS or JS fixes, commit them:

```bash
git add index.html css/style.css js/app.js
git commit -m "fix: polish hybrid sidebar navigation"
```

Expected: commit only exists if manual verification revealed and fixed issues.

---

## Final Verification

Run these commands before claiming implementation is complete:

```bash
python3 - <<'PY'
from pathlib import Path
checks = {
    'index.html': ['currentLevelPanel', 'currentLevelList'],
    'css/style.css': ['[hidden]', '.current-level-panel', '.current-level-item'],
    'js/app.js': ['renderCurrentLevelPanel', 'buildCurrentLevelItem', 'getNodeChildren'],
}
for file, tokens in checks.items():
    text = Path(file).read_text(encoding='utf-8')
    missing = [token for token in tokens if token not in text]
    if missing:
        raise SystemExit(f'{file} missing {missing}')
print('hybrid folder navigation implementation markers present')
PY
```

Expected output:

```text
hybrid folder navigation implementation markers present
```

Then run:

```bash
git status --short
```

Expected after all planned commits:

```text
 D PRD.md
?? README.md
?? docs/
```

Note: these documentation changes existed before this implementation plan. Do not revert or delete them unless the user explicitly requests it.

---

## Self-Review

- Spec coverage: the plan covers preserving tree mode, preserving flat mode, adding current-level child shortcuts, keeping thumbnail grid as the visual center, and avoiding core scanning/cache changes.
- Scope check: the work is limited to sidebar markup, sidebar styles, and sidebar rendering logic.
- Consistency check: function names are consistent across tasks: `getNodeChildren()`, `buildCurrentLevelItem()`, `renderCurrentLevelPanel()`.
- Risk control: final verification explicitly checks existing high-frequency controls and warns not to touch unrelated documentation changes.
