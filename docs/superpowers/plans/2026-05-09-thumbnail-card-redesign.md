# Thumbnail Card Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the gallery thumbnail card so the media frame, metadata, and selection state have separate boundaries and cannot visually clip each other.

**Architecture:** Keep the existing `article.thumb-card > .thumb-img-wrap + .thumb-body` DOM contract. Make `.thumb-card` a non-clipping layout container, `.thumb-img-wrap` the only clipping/radius media frame, and `.thumb-body` a normal-flow metadata area below the image.

**Tech Stack:** Vanilla JavaScript, CSS Grid/Flexbox, static HTML served by `python3 -m http.server`.

---

### Task 1: Verify Current Failure

**Files:**
- Read: `css/style.css`
- Read: `js/app.js`

- [ ] **Step 1: Run failing structural check**

```bash
python3 - <<'PY'
from pathlib import Path
css = Path('css/style.css').read_text(encoding='utf-8')
checks = {
    'card does not clip metadata': '.thumb-card {\n  width: 100%;\n  overflow: visible;' in css,
    'media frame owns clipping': '.thumb-img-wrap {\n  position: relative;\n  overflow: hidden;' in css,
    'selection does not use border box clipping': 'box-shadow: 0 0 0 3px var(--accent)' in css,
    'metadata stays in normal flow': '.thumb-body {\n  position: static;' in css,
}
failed = [name for name, ok in checks.items() if not ok]
if failed:
    raise SystemExit(f'Missing thumbnail redesign markers: {failed}')
print('thumbnail redesign markers present')
PY
```

Expected: FAIL listing missing thumbnail redesign markers.

### Task 2: Rebuild CSS Boundaries

**Files:**
- Modify: `css/style.css`

- [ ] **Step 1: Replace the current Google Photos wall override**

Use these rules for the final override block:

```css
/* Google Photos wall: separate media, metadata, and selection boundaries. */
#gallery {
  gap: max(10px, var(--thumb-gap));
}

.thumb-card {
  width: 100%;
  overflow: visible;
  padding: 4px;
  border: 0;
  border-radius: 18px;
  background: transparent;
  box-shadow: none;
}

.thumb-img-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  aspect-ratio: 1 / 1;
  border-radius: 16px;
  background: #11151d;
}

.thumb-body {
  position: static;
  padding: 8px 2px 0;
}
```

- [ ] **Step 2: Ensure selection ring does not clip content**

Use `box-shadow`/`outline` on `.thumb-card.selected`, not a border that participates in layout. Keep `.thumb-card.selected::before` disabled.

- [ ] **Step 3: Keep media sizing behavior**

Keep default `object-fit: contain`. Keep `.thumb-img-wrap.is-small-media img` using `width: auto` and `height: auto` so small media displays at original size.

### Task 3: Stabilize JS Structure

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: Keep DOM boundaries explicit**

Keep each thumbnail card in this shape:

```html
<article class="thumb-card">
  <div class="thumb-img-wrap">
    <span class="format-badge" aria-hidden="true">PNG</span>
  </div>
  <div class="thumb-body">
    <div class="thumb-name">filename.png</div>
    <div class="thumb-meta">
      <span class="thumb-dimension">270 × 270</span>
      <span class="thumb-size">17.2 KB</span>
    </div>
  </div>
</article>
```

- [ ] **Step 2: Keep small-media detection**

After metadata resolves, keep:

```js
const isSmallMedia = file.width && file.height
  && file.width <= wrap.clientWidth
  && file.height <= wrap.clientHeight;
wrap.classList.toggle('is-small-media', Boolean(isSmallMedia));
```

### Task 4: Verify

**Files:**
- Check: `css/style.css`
- Check: `js/app.js`

- [ ] **Step 1: Run marker verification**

```bash
python3 - <<'PY'
from pathlib import Path
css = Path('css/style.css').read_text(encoding='utf-8')
js = Path('js/app.js').read_text(encoding='utf-8')
checks = {
    'card does not clip metadata': '.thumb-card {\n  width: 100%;\n  overflow: visible;' in css,
    'media frame owns clipping': '.thumb-img-wrap {\n  position: relative;\n  display: flex;' in css and 'overflow: hidden;' in css,
    'selection uses non-layout ring': 'box-shadow: 0 0 0 3px var(--accent)' in css,
    'old selected pseudo hidden': '.thumb-card.selected::before {\n  display: none;' in css,
    'metadata normal flow': '.thumb-body {\n  position: static;' in css,
    'contain kept': 'object-fit: contain;' in css,
    'small media kept': "wrap.classList.toggle('is-small-media'" in js,
}
failed = [name for name, ok in checks.items() if not ok]
if failed:
    raise SystemExit(f'Missing thumbnail redesign markers: {failed}')
print('thumbnail redesign markers present')
PY
```

Expected: PASS with `thumbnail redesign markers present`.

- [ ] **Step 2: Check diagnostics**

Run editor diagnostics for `css/style.css` and `js/app.js`. Expected: no new errors; existing cSpell info messages are acceptable.

- [ ] **Step 3: Check local resources**

```bash
python3 - <<'PY'
from urllib.request import urlopen
for url in ['http://localhost:4173/index.html', 'http://localhost:4173/css/style.css', 'http://localhost:4173/js/app.js']:
    with urlopen(url, timeout=5) as response:
        print(f'{url} -> {response.status}')
PY
```

Expected: all three resources return `200`.
