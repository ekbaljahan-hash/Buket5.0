/* ==========================================================================
   SOMEDAY — Bucket List — app logic

   Sections below:
   1. Config / storage keys / state
   2. Storage helpers
   3. Spring physics utility (real damped-oscillator, not a CSS bezier)
   4. Auto-icon selection
   5. Google Sign-In
   6. Sheets & modals (open/close plumbing)
   7. Task CRUD + render + reveal-on-scroll
   8. Complete / remove flows + level/XP
   9. Settings: theme, font, background mode
   10. Background collage algorithm + luminance sampling for glass tint
   11. Specular highlight (pointer + gyroscope) + tap ripple
   12. Reminders / notifications
   13. Toast
   14. Init
   ========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Binds safely: if an id doesn't exist, this warns in the console and
  // skips it instead of throwing — one bad id can no longer take down
  // every other button's event binding with it.
  function on(id, evt, handler, opts) {
    const el = $(id);
    if (el) el.addEventListener(evt, handler, opts);
    else console.warn('[Someday] Missing element for id:', id);
  }

  /* -------------------------------------------------------------------
     1. Config / storage keys / state
  ------------------------------------------------------------------- */
  const STORAGE_KEY = 'someday_tasks_v1';
  const PREFS_KEY   = 'someday_prefs_v1';
  const USER_KEY    = 'someday_user_v1';
  const XP_KEY      = 'someday_xp_v1';
  const BG_IMG_KEY  = 'someday_bg_image_v1';

  // Paste a free Unsplash API access key here (unsplash.com/developers) to
  // get real, topical photos for the collage. Without one, the collage
  // still works using seeded placeholder photos, so nothing ever breaks.
  const UNSPLASH_ACCESS_KEY = '';

  // Pinterest has no anonymous, browser-callable image search endpoint —
  // its API requires OAuth plus a server-side proxy (a browser can't call
  // it directly). fetchTileUrl() below is the single place that decides
  // where a tile image comes from, so once you have a Pinterest backend
  // you can swap its call in right there without touching anything else.

  const WEEK_MS  = 7  * 24 * 60 * 60 * 1000;
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

  let state = {
    tasks: [],
    prefs: { font: 'system', bgMode: 'collage' },
    user: null,
    xp: 0
  };

  let editingTaskId = null;
  let pendingCompleteId = null;
  let pendingRemoveId = null;
  let openSheetId = null;

  /* -------------------------------------------------------------------
     2. Storage helpers
  ------------------------------------------------------------------- */
  function loadState() {
    try { state.tasks = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch (e) { state.tasks = []; }

    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      state.prefs = Object.assign({ font: 'system', bgMode: 'collage' }, saved);
    } catch (e) { /* keep defaults */ }

    try { state.user = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch (e) { state.user = null; }

    state.xp = parseInt(localStorage.getItem(XP_KEY) || '0', 10) || 0;

    // Video backgrounds use object URLs that die on reload — never
    // restore into a mode that would show nothing.
    if (state.prefs.bgMode === 'video') state.prefs.bgMode = 'collage';
  }

  function saveTasks() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks)); }
    catch (e) { showToast('Storage is full — this change may not be saved.'); }
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch (e) {}
  }

  /* -------------------------------------------------------------------
     3. Spring physics utility
     A real damped harmonic oscillator driven by requestAnimationFrame —
     used for press feedback, the checkbox pop, and task removal, so
     those interactions overshoot and settle like physical glass rather
     than following a fixed-duration easing curve.
  ------------------------------------------------------------------- */
  function springAnimate(el, { from = 0, to = 1, stiffness = 260, damping = 22, mass = 1, mapToCss, onComplete }) {
    if (!el) return;
    const prevTransition = el.style.transition;
    el.style.transition = 'none';
    let x = from, v = 0, last = performance.now();

    function apply(value) {
      if (mapToCss) mapToCss(el, value);
      else el.style.transform = `scale(${value})`;
    }

    function frame(now) {
      const dt = Math.min((now - last) / 1000, 0.032);
      last = now;
      const accel = (-stiffness * (x - to) - damping * v) / mass;
      v += accel * dt;
      x += v * dt;
      apply(x);
      if (Math.abs(to - x) > 0.001 || Math.abs(v) > 0.001) {
        requestAnimationFrame(frame);
      } else {
        apply(to);
        el.style.transition = prevTransition;
        onComplete && onComplete();
      }
    }
    requestAnimationFrame(frame);
  }

  /* -------------------------------------------------------------------
     4. Auto-icon selection (replaces manual emoji picking)
  ------------------------------------------------------------------- */
  const ICON_RULES = [
    [/travel|trip|flight|passport|abroad|countr/i, '✈️'],
    [/beach|island|ocean|sea\b|surf|dive|scuba|snorkel/i, '🏝️'],
    [/mountain|hike|hiking|trek|climb|summit|peak/i, '⛰️'],
    [/book|read|novel|library/i, '📚'],
    [/write|writing|journal|blog|novel/i, '✍️'],
    [/run|marathon|race|5k|10k|jog/i, '🏃'],
    [/cook|bake|recipe|kitchen|chef/i, '🍳'],
    [/music|concert|guitar|piano|sing|song|album/i, '🎵'],
    [/paint|draw|art|sketch|gallery/i, '🎨'],
    [/dance|dancing|ballet/i, '💃'],
    [/car|drive|road trip|motorcycle/i, '🚗'],
    [/photo|camera|photography/i, '📷'],
    [/language|learn.*speak|fluent/i, '🗣️'],
    [/garden|plant|flower/i, '🌻'],
    [/pet|dog|cat|animal|wildlife/i, '🐾'],
    [/stars|astronomy|northern lights|aurora|space/i, '✨'],
    [/skydive|jump|bungee|extreme/i, '🪂'],
    [/wine|beer|brew|distillery/i, '🍷'],
    [/movie|film|cinema/i, '🎬'],
    [/volunteer|charity|help others/i, '🤝'],
    [/save.*money|invest|financial/i, '💰'],
    [/house|home|apartment|renovate/i, '🏡'],
    [/wedding|marry|marriage|propose/i, '💍'],
    [/degree|study|university|college|course|certif/i, '🎓'],
    [/business|startup|company|entrepreneur/i, '💼'],
    [/swim|pool/i, '🏊'],
    [/ski|snowboard|snow/i, '🎿'],
    [/camp|tent|outdoors/i, '🏕️'],
    [/city|visit|explore|museum/i, '🏙️'],
    [/tattoo/i, '🖋️'],
    [/meditat|yoga|mindful/i, '🧘'],
  ];
  function autoIcon(text) {
    const t = (text || '').toLowerCase();
    for (const [re, icon] of ICON_RULES) if (re.test(t)) return icon;
    return '🌱';
  }

  /* -------------------------------------------------------------------
     5. Google Sign-In
  ------------------------------------------------------------------- */
  function initGoogleSignIn() {
    const tryInit = () => {
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.initialize({
          client_id: 'REPLACE_WITH_YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
          callback: handleGoogleCredential,
          auto_select: false
        });
        google.accounts.id.renderButton($('google-signin-button'), {
          theme: 'filled_black', shape: 'pill', size: 'large', width: 280
        });
      } else {
        setTimeout(tryInit, 300);
      }
    };
    tryInit();
  }

  function handleGoogleCredential(resp) {
    const payload = decodeJwt(resp.credential);
    state.user = { name: payload.name || 'Friend', email: payload.email || '', picture: payload.picture || '' };
    try { localStorage.setItem(USER_KEY, JSON.stringify(state.user)); } catch (e) {}
    enterApp();
  }

  function decodeJwt(token) {
    try {
      const base = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(base).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(json);
    } catch (e) { return {}; }
  }

  function enterApp() {
    $('screen-signin').hidden = true;
    $('screen-home').hidden = false;
    $('home-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    renderTasks();
    updateLevelPill();
    setBackgroundMode(state.prefs.bgMode || 'collage');
    if (state.prefs.bgMode === 'collage') buildCollage();
    scheduleSampleAndSpecRefresh();
  }

  /* -------------------------------------------------------------------
     6. Sheets & modals
  ------------------------------------------------------------------- */
  const SHEET_IDS = ['sheet-add-task', 'sheet-settings', 'sheet-font-picker'];

  function openSheet(id) {
    SHEET_IDS.forEach((sid) => {
      if (sid !== id) { const s = $(sid); s.classList.remove('show'); s.hidden = true; }
    });
    const scrim = $('sheet-scrim');
    const sheet = $(id);
    scrim.hidden = false;
    sheet.hidden = false;
    requestAnimationFrame(() => {
      scrim.classList.add('show');
      sheet.classList.add('show');
    });
    openSheetId = id;
    scheduleSampleAndSpecRefresh();
  }
  function closeSheet(id) {
    const sheet = $(id);
    sheet.classList.remove('show');
    $('sheet-scrim').classList.remove('show');
    setTimeout(() => { sheet.hidden = true; $('sheet-scrim').hidden = true; }, 500);
    if (openSheetId === id) openSheetId = null;
  }

  function showModal(id) {
    const m = $(id);
    m.hidden = false;
    requestAnimationFrame(() => m.classList.add('show'));
  }
  function hideModal(id) {
    const m = $(id);
    m.classList.remove('show');
    setTimeout(() => { m.hidden = true; }, 320);
  }

  /* -------------------------------------------------------------------
     7. Task CRUD + render + reveal-on-scroll
  ------------------------------------------------------------------- */
  function openAddSheet(task) {
    editingTaskId = task ? task.id : null;
    $('sheet-add-title').textContent = task ? 'Edit Someday' : 'New Someday';
    $('input-task-title').value = task ? task.title : '';
    $('input-task-notes').value = task ? (task.notes || '') : '';
    $('select-reminder').value = task ? task.reminder : 'weekly';

    $('location-chip-text').textContent = (task && task.location) ? task.location : 'Add location';
    $('input-location-text').value = (task && task.location) ? task.location : '';
    $('input-location-text').hidden = true;

    if (task && task.image) {
      $('task-image-preview').src = task.image;
      $('task-image-preview').hidden = false;
      $('image-chip-text').textContent = 'Photo added';
    } else {
      $('task-image-preview').hidden = true;
      $('task-image-preview').removeAttribute('src');
      $('image-chip-text').textContent = 'Add photo';
    }
    $('input-image-file').value = '';
    $('task-icon-preview').textContent = task ? (task.icon || autoIcon(task.title)) : '🌱';

    openSheet('sheet-add-task');
    setTimeout(() => $('input-task-title').focus(), 350);
  }

  function saveTaskFromForm() {
    const title = $('input-task-title').value.trim();
    if (!title) { $('input-task-title').focus(); return; }
    const notes = $('input-task-notes').value.trim();
    const location = $('input-location-text').value.trim();
    const reminder = $('select-reminder').value;
    const image = $('task-image-preview').hidden ? null : $('task-image-preview').src;
    const icon = autoIcon(title);

    if (editingTaskId) {
      const t = state.tasks.find((x) => x.id === editingTaskId);
      if (t) {
        Object.assign(t, { title, notes, location, reminder, image, icon });
        if (reminder === 'none') t.nextReminderAt = null;
        else if (!t.nextReminderAt) t.nextReminderAt = Date.now() + intervalFor(reminder);
      }
    } else {
      state.tasks.push({
        id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        title, notes, location, reminder, image, icon,
        completed: false, createdAt: Date.now(), completedAt: null,
        nextReminderAt: reminder === 'none' ? null : Date.now() + intervalFor(reminder)
      });
      requestNotificationPermission();
    }
    saveTasks();
    renderTasks();
    closeSheet('sheet-add-task');
    if (state.prefs.bgMode === 'collage') buildCollage();
  }

  function renderTasks() {
    const list = $('task-list');
    list.innerHTML = '';
    $('empty-state').hidden = state.tasks.length > 0;

    const sorted = [...state.tasks].sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      return a.createdAt - b.createdAt;
    });
    const frag = document.createDocumentFragment();
    sorted.forEach((t) => frag.appendChild(buildTaskEl(t)));
    list.appendChild(frag);

    initRevealObserver();
    updateProgress();
    scheduleSampleAndSpecRefresh();
  }

  function buildTaskEl(t) {
    const li = document.createElement('li');
    li.className = 'task-item' + (t.completed ? ' is-done' : '');
    li.dataset.id = t.id;

    const glass = document.createElement('div');
    glass.className = 'liquid-glass';
    glass.dataset.lgTier = '2';

    const spec = document.createElement('span');
    spec.className = 'lg-specular';
    spec.setAttribute('aria-hidden', 'true');

    const content = document.createElement('div');
    content.className = 'lg-content';

    const row = document.createElement('div');
    row.className = 'task-row' + (t.image ? ' has-thumb' : '');

    const checkbox = document.createElement('button');
    checkbox.className = 'task-checkbox';
    checkbox.type = 'button';
    checkbox.setAttribute('aria-label', 'Mark as complete');
    checkbox.innerHTML = '<svg viewBox="0 0 24 24"><path fill="none" stroke="#0b0c10" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
    checkbox.addEventListener('click', (ev) => { ev.stopPropagation(); openCompleteModal(t.id); });

    const main = document.createElement('div');
    main.className = 'task-main';
    bindLongPress(main, () => openAddSheet(t));

    const title = document.createElement('p');
    title.className = 'task-title';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'task-icon';
    iconSpan.textContent = t.icon || '🌱';
    const titleText = document.createElement('span');
    titleText.textContent = t.title;
    title.appendChild(iconSpan);
    title.appendChild(titleText);
    main.appendChild(title);

    if (t.location || (t.reminder && t.reminder !== 'none')) {
      const meta = document.createElement('div');
      meta.className = 'task-meta';
      if (t.location) {
        const s = document.createElement('span');
        s.textContent = '📍 ' + t.location;
        meta.appendChild(s);
      }
      if (t.reminder && t.reminder !== 'none') {
        const s = document.createElement('span');
        s.textContent = t.reminder === 'weekly' ? 'Weekly nudge' : 'Monthly nudge';
        meta.appendChild(s);
      }
      main.appendChild(meta);
    }

    row.appendChild(checkbox);
    row.appendChild(main);

    if (t.image) {
      const img = document.createElement('img');
      img.className = 'task-thumb';
      img.src = t.image;
      img.alt = '';
      row.appendChild(img);
    }

    const del = document.createElement('button');
    del.className = 'task-delete-btn';
    del.type = 'button';
    del.setAttribute('aria-label', 'Remove task');
    del.textContent = '✕';
    del.addEventListener('click', (ev) => { ev.stopPropagation(); openRemoveModal(t.id); });
    row.appendChild(del);

    content.appendChild(row);
    glass.appendChild(spec);
    glass.appendChild(content);
    li.appendChild(glass);
    return li;
  }

  let revealObserver = null;
  function initRevealObserver() {
    if (revealObserver) revealObserver.disconnect();
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add('reveal');
          revealObserver.unobserve(en.target);
        }
      });
    }, { root: $('task-scroll'), threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.task-item:not(.reveal)').forEach((el) => revealObserver.observe(el));
  }

  /* -------------------------------------------------------------------
     8. Complete / remove flows + level/XP
  ------------------------------------------------------------------- */
  function openCompleteModal(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    pendingCompleteId = id;
    $('modal-complete-name').textContent = t.title;
    showModal('modal-complete');
  }
  function openRemoveModal(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    pendingRemoveId = id;
    $('modal-remove-name').textContent = `"${t.title}" will be removed for good.`;
    showModal('modal-remove');
  }

  function markComplete(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    t.completed = true;
    t.completedAt = Date.now();
    t.nextReminderAt = null;
    saveTasks();
    addXp(20);
    playCompleteBurst();

    const el = document.querySelector(`.task-item[data-id="${id}"]`);
    if (el) {
      el.classList.add('is-done');
      const check = el.querySelector('.task-checkbox');
      springAnimate(check, {
        from: 0.4, to: 1, stiffness: 420, damping: 14,
        mapToCss: (e, v) => { e.style.transform = `scale(${v})`; }
      });
    }
    setTimeout(renderTasks, 600);
  }

  function removeTask(id) {
    const el = document.querySelector(`.task-item[data-id="${id}"]`);
    const finish = () => {
      state.tasks = state.tasks.filter((x) => x.id !== id);
      saveTasks();
      renderTasks();
      if (state.prefs.bgMode === 'collage') buildCollage();
    };
    if (el) {
      springAnimate(el, {
        from: 1, to: 0, stiffness: 300, damping: 24,
        mapToCss: (e, v) => { e.style.transform = `scale(${v}) translateX(${(1 - v) * 40}px)`; e.style.opacity = v; },
        onComplete: finish
      });
    } else finish();
  }

  function playCompleteBurst() {
    const burst = $('complete-burst');
    const wrap = $('burst-particles');
    wrap.innerHTML = '';
    const n = 14;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('span');
      p.className = 'burst-particle';
      const angle = (Math.PI * 2 * i) / n + Math.random() * 0.3;
      const dist = 70 + Math.random() * 50;
      p.style.setProperty('--px', Math.cos(angle) * dist + 'px');
      p.style.setProperty('--py', Math.sin(angle) * dist + 'px');
      p.style.background = i % 2 ? 'var(--accent-mint)' : 'var(--accent)';
      wrap.appendChild(p);
    }
    burst.hidden = false;
    burst.classList.remove('play');
    void burst.offsetWidth;
    burst.classList.add('play');
    setTimeout(() => { burst.hidden = true; burst.classList.remove('play'); }, 900);
  }

  function updateProgress() {
    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.completed).length;
    $('progress-text').textContent = total ? `${done} of ${total} complete` : 'No tasks yet';
    $('progress-fill').style.width = total ? (done / total * 100) + '%' : '0%';
  }

  function addXp(n) {
    state.xp += n;
    try { localStorage.setItem(XP_KEY, String(state.xp)); } catch (e) {}
    updateLevelPill();
  }
  function updateLevelPill() {
    const level = Math.floor(state.xp / 100) + 1;
    const ep = state.xp % 100;
    $('level-number').textContent = String(level);
    $('level-ep').textContent = String(ep);
  }

  /* -------------------------------------------------------------------
     9. Settings: font, background mode
     (Dark is the only theme — no toggle, no light-mode branch anywhere.)
  ------------------------------------------------------------------- */
  const FONTS = [
    { id: 'system', label: 'System', family: 'var(--font-system)' },
    { id: 'serif', label: 'Fraunces Serif', family: 'var(--font-serif)' },
    { id: 'rounded', label: 'Rounded', family: 'var(--font-rounded)', google: 'Varela+Round' },
    { id: 'playful', label: 'Playful', family: 'var(--font-playful)', google: 'Fredoka:wght@500' },
    { id: 'mono', label: 'Mono', family: 'var(--font-mono)' }
  ];
  function applyFont(id) {
    const f = FONTS.find((x) => x.id === id) || FONTS[0];
    if (f.google) ensureGoogleFont(f.google);
    document.documentElement.style.setProperty('--font-current', f.family);
    document.body.dataset.font = f.id;
    $('font-value').textContent = f.label;
    state.prefs.font = f.id;
    savePrefs();
  }
  function ensureGoogleFont(spec) {
    const linkId = 'gf-' + spec.replace(/[^a-zA-Z0-9]/g, '');
    if ($(linkId)) return;
    const link = document.createElement('link');
    link.id = linkId;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
    document.head.appendChild(link);
  }
  function buildFontList() {
    const list = $('font-list');
    list.innerHTML = '';
    FONTS.forEach((f) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'liquid-glass font-option' + (state.prefs.font === f.id ? ' is-selected' : '');
      btn.dataset.lgTier = '2';

      const spec = document.createElement('span');
      spec.className = 'lg-specular';
      spec.setAttribute('aria-hidden', 'true');

      const content = document.createElement('span');
      content.className = 'lg-content';
      content.style.fontFamily = f.family;

      const label = document.createElement('span');
      label.textContent = f.label;
      const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      check.setAttribute('class', 'font-check');
      check.setAttribute('viewBox', '0 0 24 24');
      check.setAttribute('width', '16');
      check.setAttribute('height', '16');
      check.innerHTML = '<path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>';

      content.appendChild(label);
      content.appendChild(check);
      btn.appendChild(spec);
      btn.appendChild(content);

      btn.addEventListener('click', () => {
        applyFont(f.id);
        closeSheet('sheet-font-picker');
        setTimeout(() => openSheet('sheet-settings'), 260);
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function setBackgroundMode(mode) {
    state.prefs.bgMode = mode;
    $('bg-collage').hidden = mode !== 'collage';
    $('bg-custom-img').hidden = mode !== 'image';
    $('bg-custom-video').hidden = mode !== 'video';
    if (mode === 'video') { const v = $('bg-custom-video'); v.play && v.play().catch(() => {}); }
    savePrefs();
    scheduleSampleAndSpecRefresh();
  }

  /* -------------------------------------------------------------------
     10. Background collage algorithm + luminance sampling
  ------------------------------------------------------------------- */
  const KEYWORD_FALLBACKS = ['wanderlust', 'adventure', 'travel', 'dream', 'skyline', 'ocean', 'mountains', 'northern lights'];
  const STOPWORDS = new Set(['the','a','an','to','and','of','in','on','for','with','my','at','go','get','see','visit','do','someday','trip','this','that','have','make']);

  function extractKeywords() {
    const freq = {};
    state.tasks.forEach((t) => {
      const words = ((t.title || '') + ' ' + (t.notes || '')).toLowerCase().match(/[a-z]{3,}/g) || [];
      words.forEach((w) => { if (!STOPWORDS.has(w)) freq[w] = (freq[w] || 0) + 1; });
    });
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    return sorted.length ? sorted.slice(0, 8) : KEYWORD_FALLBACKS;
  }

  async function fetchTileUrl(keyword, index) {
    if (UNSPLASH_ACCESS_KEY) {
      try {
        const res = await fetch(`https://api.unsplash.com/photos/random?query=${encodeURIComponent(keyword)}&content_filter=high&client_id=${UNSPLASH_ACCESS_KEY}`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.urls && data.urls.small) return data.urls.small;
        }
      } catch (e) { /* fall through to placeholder */ }
    }
    // CORS-friendly seeded placeholder — always works, no key required.
    return `https://picsum.photos/seed/${encodeURIComponent(keyword + '-' + index)}/480/480`;
  }

  let collageImages = [];
  let collageBuildToken = 0;
  async function buildCollage() {
    const myToken = ++collageBuildToken;
    const keywords = extractKeywords();
    const cols = 4, count = 16;
    const urls = await Promise.all(
      Array.from({ length: count }, (_, i) => fetchTileUrl(keywords[i % keywords.length], i))
    );
    if (myToken !== collageBuildToken) return; // superseded by a newer build

    const grid = $('bg-collage');
    grid.innerHTML = '';
    collageImages = [];
    const frag = document.createDocumentFragment();
    urls.forEach((url, i) => {
      const tile = document.createElement('div');
      tile.className = 'collage-tile';
      tile.style.backgroundImage = `url("${url}")`;
      frag.appendChild(tile);

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = scheduleSampleAndSpecRefresh;
      img.src = url;
      collageImages.push({ img, col: i % cols, row: Math.floor(i / cols) });
    });
    grid.appendChild(frag);
    scheduleSampleAndSpecRefresh();
  }

  // Off-screen composite used only to estimate what's behind the glass —
  // never rendered on screen.
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 64; sampleCanvas.height = 64;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  let sampleReady = false;

  function composeSampleCanvas() {
    try {
      sampleCtx.clearRect(0, 0, 64, 64);
      if (state.prefs.bgMode === 'collage') {
        const cell = 16; // 64 / 4 cols
        collageImages.forEach((c) => {
          if (c.img.complete && c.img.naturalWidth) {
            sampleCtx.drawImage(c.img, c.col * cell, c.row * cell, cell, cell);
          }
        });
      } else if (state.prefs.bgMode === 'image') {
        const imgEl = $('bg-custom-img');
        if (imgEl.complete && imgEl.naturalWidth) sampleCtx.drawImage(imgEl, 0, 0, 64, 64);
      } else if (state.prefs.bgMode === 'video') {
        const vid = $('bg-custom-video');
        if (vid.readyState >= 2) sampleCtx.drawImage(vid, 0, 0, 64, 64);
      }
      sampleReady = true;
    } catch (e) {
      sampleReady = false; // tainted / not loaded yet — safe fallback used below
    }
  }

  function getLuminanceAtRect(rect) {
    if (!sampleReady) return null;
    const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    const x = Math.max(0, Math.min(63, Math.floor((rect.left + rect.width / 2) / vw * 64)));
    const y = Math.max(0, Math.min(63, Math.floor((rect.top + rect.height / 2) / vh * 64)));
    try {
      const d = sampleCtx.getImageData(x, y, 1, 1).data;
      return (0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]) / 255;
    } catch (e) { return null; }
  }

  function updateGlassSampling() {
    const fallback = 0.14; // dark theme only
    document.querySelectorAll('.liquid-glass').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < -80 || rect.top > window.innerHeight + 80) return;
      const lum = getLuminanceAtRect(rect);
      const l = lum === null ? fallback : lum;
      el.style.setProperty('--lg-l', l.toFixed(2));
      el.setAttribute('data-lg-mode', l > 0.55 ? 'on-light' : 'on-dark');
    });
  }

  let sampleRAF = null;
  function scheduleSampleAndSpecRefresh() {
    if (sampleRAF) return;
    sampleRAF = requestAnimationFrame(() => {
      composeSampleCanvas();
      updateGlassSampling();
      sampleRAF = null;
    });
  }

  /* -------------------------------------------------------------------
     11. Specular highlight (pointer + gyroscope) + tap ripple
  ------------------------------------------------------------------- */
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  let specRAF = null;
  let lastPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  function scheduleSpecUpdate(x, y) {
    lastPointer = { x, y };
    if (specRAF) return;
    specRAF = requestAnimationFrame(() => { applySpecular(lastPointer.x, lastPointer.y); specRAF = null; });
  }
  function applySpecular(x, y) {
    document.querySelectorAll('.liquid-glass').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < -50 || rect.top > window.innerHeight + 50) return;
      const px = ((x - rect.left) / rect.width) * 100;
      const py = ((y - rect.top) / rect.height) * 100;
      el.style.setProperty('--spec-x', clamp(px, -20, 120) + '%');
      el.style.setProperty('--spec-y', clamp(py, -20, 120) + '%');
    });
  }

  // Touch/press feedback (ripple + press-scale) has been removed —
  // only the desktop specular tracking remains.
  function bindGlassInteractions() {
    // Only devices with an actual mouse get the moving specular
    // highlight — on touch phones there's no cursor to track, so we
    // skip the continuous pointermove work entirely (battery + perf).
    const hasFinePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (hasFinePointer) {
      window.addEventListener('pointermove', (e) => scheduleSpecUpdate(e.clientX, e.clientY));
    }
  }

  // Long-press (click and hold) helper — used to open a task for
  // editing without an animated press effect. A short move cancels it,
  // so scrolling past a row never accidentally triggers it.
  function bindLongPress(el, callback, ms) {
    const holdMs = ms || 480;
    let timer = null, startX = 0, startY = 0;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener('pointerdown', (e) => {
      startX = e.clientX; startY = e.clientY;
      cancel();
      timer = setTimeout(() => { timer = null; callback(); }, holdMs);
    });
    el.addEventListener('pointermove', (e) => {
      if (!timer) return;
      if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) cancel();
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* -------------------------------------------------------------------
     12. Reminders / notifications
  ------------------------------------------------------------------- */
  function intervalFor(freq) { return freq === 'monthly' ? MONTH_MS : WEEK_MS; }

  let notifAsked = false;
  function requestNotificationPermission() {
    if (notifAsked) return;
    notifAsked = true;
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function fireReminder(t) {
    const body = `Still on your someday list: ${t.title}`;
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Someday reminder', { body }); }
      catch (e) { showToast(body); }
    } else {
      showToast(body);
    }
  }

  // This scheduler fires reminders while the app is open and persists each
  // task's next-fire timestamp, so it "catches up" correctly on reopen.
  // True delivery while the app/tab is fully closed needs a service worker
  // registered with a push server — a browser tab alone can't do that.
  function checkReminders() {
    const now = Date.now();
    let changed = false;
    state.tasks.forEach((t) => {
      if (t.completed || !t.reminder || t.reminder === 'none') return;
      if (!t.nextReminderAt) { t.nextReminderAt = now + intervalFor(t.reminder); changed = true; return; }
      if (now >= t.nextReminderAt) {
        fireReminder(t);
        t.nextReminderAt = now + intervalFor(t.reminder);
        changed = true;
      }
    });
    if (changed) saveTasks();
  }
  function scheduleReminderCheck() {
    checkReminders();
    setInterval(checkReminders, 30 * 60 * 1000);
  }

  /* -------------------------------------------------------------------
     13. Toast
  ------------------------------------------------------------------- */
  let toastTimer = null;
  function showToast(text) {
    const toast = $('toast');
    $('toast-text').textContent = text;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => { toast.hidden = true; }, 400);
    }, 3200);
  }

  /* -------------------------------------------------------------------
     14. Init + event bindings
  ------------------------------------------------------------------- */
  function bindUI() {
    on('btn-fallback-signin', 'click', () => {
      if (window.google && google.accounts && google.accounts.id) google.accounts.id.prompt();
      else showToast('Add your Google Client ID in script.js to enable sign-in.');
    });
    on('btn-skip-signin', 'click', () => { state.user = null; enterApp(); });

    on('btn-open-settings', 'click', () => openSheet('sheet-settings'));
    on('btn-close-settings', 'click', () => closeSheet('sheet-settings'));

    on('btn-add-task', 'click', () => openAddSheet(null));

    on('btn-cancel-task', 'click', () => closeSheet('sheet-add-task'));
    on('btn-save-task', 'click', saveTaskFromForm);
    on('input-task-title', 'input', (e) => {
      $('task-icon-preview').textContent = autoIcon(e.target.value);
    });

    on('btn-add-location', 'click', () => {
      const input = $('input-location-text');
      input.hidden = false;
      input.focus();
    });
    on('input-location-text', 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('input-location-text').blur(); }
    });
    on('input-location-text', 'blur', () => {
      const input = $('input-location-text');
      const val = input.value.trim();
      $('location-chip-text').textContent = val ? (val.length > 18 ? val.slice(0, 18) + '…' : val) : 'Add location';
      input.hidden = true;
    });

    on('btn-add-image', 'click', () => $('input-image-file').click());
    on('input-image-file', 'change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        $('task-image-preview').src = reader.result;
        $('task-image-preview').hidden = false;
        $('image-chip-text').textContent = 'Photo added';
      };
      reader.readAsDataURL(file);
    });

    on('modal-remove', 'click', (e) => { if (e.target.id === 'modal-remove') hideModal('modal-remove'); });
    on('modal-complete', 'click', (e) => { if (e.target.id === 'modal-complete') hideModal('modal-complete'); });
    on('btn-remove-no', 'click', () => hideModal('modal-remove'));
    on('btn-remove-yes', 'click', () => { hideModal('modal-remove'); removeTask(pendingRemoveId); });
    on('btn-complete-no', 'click', () => hideModal('modal-complete'));
    on('btn-complete-yes', 'click', () => { hideModal('modal-complete'); markComplete(pendingCompleteId); });

    on('row-font', 'click', () => {
      closeSheet('sheet-settings');
      setTimeout(() => { buildFontList(); openSheet('sheet-font-picker'); }, 260);
    });
    on('btn-close-font', 'click', () => {
      closeSheet('sheet-font-picker');
      setTimeout(() => openSheet('sheet-settings'), 260);
    });

    on('row-bg-collage', 'click', () => { setBackgroundMode('collage'); buildCollage(); showToast('Using your auto collage.'); });
    on('row-bg-image', 'click', () => $('input-bg-image').click());
    on('input-bg-image', 'change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        $('bg-custom-img').src = reader.result;
        setBackgroundMode('image');
        try { localStorage.setItem(BG_IMG_KEY, reader.result); }
        catch (err) { showToast('Photo applied — too large to keep for next visit.'); }
        showToast('Background photo applied.');
      };
      reader.readAsDataURL(file);
    });
    on('bg-custom-img', 'load', scheduleSampleAndSpecRefresh);

    on('row-bg-video', 'click', () => $('input-bg-video').click());
    on('input-bg-video', 'change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $('bg-custom-video').src = URL.createObjectURL(file);
      setBackgroundMode('video');
      showToast('Background video applied for this session.');
    });
    on('bg-custom-video', 'loadeddata', scheduleSampleAndSpecRefresh);

    on('row-signout', 'click', () => {
      try { localStorage.removeItem(USER_KEY); } catch (e) {}
      state.user = null;
      closeSheet('sheet-settings');
      $('screen-home').hidden = true;
      $('screen-signin').hidden = false;
    });

    on('task-scroll', 'scroll', scheduleSampleAndSpecRefresh, { passive: true });
    window.addEventListener('resize', scheduleSampleAndSpecRefresh);
    setInterval(() => { if (state.prefs.bgMode === 'video') scheduleSampleAndSpecRefresh(); }, 600);

    bindGlassInteractions();
  }

  function init() {
    try {
      loadState();
      applyFont(state.prefs.font);

      if (state.prefs.bgMode === 'image') {
        try {
          const saved = localStorage.getItem(BG_IMG_KEY);
          if (saved) $('bg-custom-img').src = saved;
          else state.prefs.bgMode = 'collage';
        } catch (e) { state.prefs.bgMode = 'collage'; }
      }

      bindUI();
      initGoogleSignIn();
      scheduleReminderCheck();

      if (state.user) enterApp();
    } catch (err) {
      // Never let an unexpected error leave a blank page — the sign-in
      // screen (visible by default in the HTML) still shows either way.
      console.error('[Someday] init() failed:', err);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
