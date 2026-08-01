// ---------- State ----------
let currentProfile = null;
let xtream = null;
let currentSection = 'live';
let liveCatalog = null, vodCatalog = null, seriesCatalog = null;
let activeCategoryId = null;
let currentItems = [];
let currentPlayingItem = null;
let hlsInstance = null;
let mpegtsInstance = null;
let editingProfileIndex = null;
let seriesListBackup = null;
let leftPanelOpen = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- localStorage yardımcıları (electron-store'un web karşılığı) ----------
function storeGet(key) {
  try {
    const raw = localStorage.getItem('engtv_' + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function storeSet(key, value) {
  try { localStorage.setItem('engtv_' + key, JSON.stringify(value)); } catch (e) { console.error('[ENGTV] localStorage hatası:', e); }
}
function storeDelete(key) {
  try { localStorage.removeItem('engtv_' + key); } catch (e) {}
}

function showError(msg) { $('#login-error').textContent = msg; }

// ---------- Kayıtlı profiller ----------
function loadSavedProfiles() {
  const profiles = storeGet('profiles') || [];
  const container = $('#saved-profiles');
  container.innerHTML = '';
  if (!profiles.length) return;
  const label = document.createElement('div');
  label.className = 'saved-profiles-label';
  label.textContent = 'Kayıtlı profiller';
  container.appendChild(label);
  profiles.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'saved-profile-item';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name;
    const editSpan = document.createElement('span');
    editSpan.className = 'del'; editSpan.textContent = '✎'; editSpan.title = 'Düzenle';
    const delSpan = document.createElement('span');
    delSpan.className = 'del'; delSpan.textContent = '✕'; delSpan.title = 'Sil';
    row.appendChild(nameSpan); row.appendChild(editSpan); row.appendChild(delSpan);
    nameSpan.addEventListener('click', async () => {
      showError(''); editingProfileIndex = null;
      try { await connectWithProfile(p); } catch (err) { showError(`Bağlanılamadı: ${err.message}`); }
    });
    editSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      editingProfileIndex = idx;
      $('#x-name').value = p.name || '';
      $('#x-host').value = p.host || '';
      $('#x-user').value = p.username || '';
      $('#x-pass').value = p.password || '';
      showError('Bilgileri güncelleyip "Bağlan"a bas.');
    });
    delSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      const list = storeGet('profiles') || [];
      list.splice(idx, 1);
      storeSet('profiles', list);
      loadSavedProfiles();
    });
    container.appendChild(row);
  });
}

function saveProfile(profile) {
  const list = storeGet('profiles') || [];
  if (editingProfileIndex != null && list[editingProfileIndex]) {
    list[editingProfileIndex] = profile;
    editingProfileIndex = null;
  } else {
    list.push(profile);
  }
  storeSet('profiles', list);
}

$('#xtream-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const profile = {
    type: 'xtream',
    name: $('#x-name').value.trim(),
    host: $('#x-host').value.trim(),
    username: $('#x-user').value.trim(),
    password: $('#x-pass').value
  };
  try {
    saveProfile(profile); // önce kaydet — bağlantı başarısız olsa bile bilgiler kaybolmasın
    await connectWithProfile(profile);
  } catch (err) {
    showError(err.message);
  }
});

async function connectWithProfile(profile) {
  showError('');
  xtream = new XtreamClient(profile.host, profile.username, profile.password);
  const authData = await xtream.authenticate();
  liveCatalog = vodCatalog = seriesCatalog = null;
  currentProfile = profile;
  const expiry = formatExpiry(authData && authData.user_info && authData.user_info.exp_date);
  $('#active-profile-label').textContent = profile.name + (expiry ? ` — ${expiry}` : '');
  $('#login-screen').classList.remove('active');
  $('#app-screen').classList.add('active');
  storeSet('lastProfile', profile);
  switchSection('home');
}

function formatExpiry(expDate) {
  if (!expDate) return '';
  const ts = Number(expDate);
  if (!ts) return '';
  const diffDays = Math.ceil((ts * 1000 - Date.now()) / 86400000);
  const dateStr = new Date(ts * 1000).toLocaleDateString('tr-TR');
  if (diffDays < 0) return `Süre doldu (${dateStr})`;
  if (diffDays === 0) return `Bugün sona eriyor (${dateStr})`;
  return `${diffDays} gün kaldı (${dateStr})`;
}

$('#logout-btn').addEventListener('click', () => {
  closePlayer();
  currentProfile = null; xtream = null;
  storeDelete('lastProfile');
  $('#app-screen').classList.remove('active');
  $('#login-screen').classList.add('active');
  loadSavedProfiles();
});

// ---------- Kataloglama (panelin category_id filtrelemesi güvenilmez olabileceğinden
// tüm içeriği tek seferde çekip kendi tarafımızda gruplarız) ----------
function buildCatalog(cats, items) {
  const byCategory = new Map();
  (items || []).forEach(item => {
    const idsRaw = [];
    if (item.category_id != null) idsRaw.push(String(item.category_id));
    if (Array.isArray(item.category_ids)) item.category_ids.forEach(id => idsRaw.push(String(id)));
    const ids = idsRaw.length ? [...new Set(idsRaw)] : ['__none__'];
    ids.forEach(id => {
      if (!byCategory.has(id)) byCategory.set(id, []);
      byCategory.get(id).push(item);
    });
  });
  const validCats = (cats || []).filter(c => byCategory.has(String(c.category_id)));
  return { cats: validCats, byCategory };
}

function mapLiveItem(s) { return { id: s.stream_id, name: s.name, icon: s.stream_icon, playUrl: xtream.liveUrl(s.stream_id, 'm3u8'), kind: 'live' }; }
function mapVodItem(s) { return { id: s.stream_id, name: s.name, icon: s.stream_icon, playUrl: xtream.vodUrl(s.stream_id, s.container_extension || 'mp4'), kind: 'vod' }; }
function mapSeriesItem(s) { return { id: s.series_id, name: s.name, icon: s.cover, kind: 'series' }; }

// ---------- Bölüm gezinme ----------
$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => switchSection(btn.dataset.section)));
$$('.home-tile').forEach(tile => tile.addEventListener('click', () => switchSection(tile.dataset.section)));

async function switchSection(section) {
  currentSection = section;
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === section));
  activeCategoryId = null;
  $('#search-box').value = '';
  closePlayer();
  $('#item-grid').innerHTML = '';

  if (section === 'home') {
    $('#home-tiles').classList.add('active');
    $('#panes').style.display = 'none';
    return;
  }
  $('#home-tiles').classList.remove('active');
  $('#panes').style.display = 'flex';

  if (section === 'favorites') {
    renderCategoryList([]);
    renderFavorites();
    return;
  }

  $('#item-grid').innerHTML = '<div class="empty-msg">Kategoriler yükleniyor...</div>';
  try {
    let cats = [];
    if (section === 'live') {
      if (!liveCatalog) {
        const [c, streams] = await Promise.all([xtream.getLiveCategories(), xtream.getAllLiveStreams()]);
        liveCatalog = buildCatalog(c, streams);
      }
      cats = liveCatalog.cats;
    }
    if (section === 'movies') {
      if (!vodCatalog) {
        const [c, streams] = await Promise.all([xtream.getVodCategories(), xtream.getAllVodStreams()]);
        vodCatalog = buildCatalog(c, streams);
      }
      cats = vodCatalog.cats;
    }
    if (section === 'series') {
      if (!seriesCatalog) {
        const [c, list] = await Promise.all([xtream.getSeriesCategories(), xtream.getAllSeries()]);
        seriesCatalog = buildCatalog(c, list);
      }
      cats = seriesCatalog.cats;
    }
    const activeCatalog = section === 'live' ? liveCatalog : section === 'movies' ? vodCatalog : seriesCatalog;
    const mapped = (cats || []).map(c => ({ id: c.category_id, name: c.category_name, count: (activeCatalog.byCategory.get(String(c.category_id)) || []).length }));
    renderCategoryList(mapped);
    if (mapped.length) selectCategory(mapped[0].id);
    else $('#item-grid').innerHTML = '<div class="empty-msg">Bu bölüm için panelden içerik alınamadı.</div>';
  } catch (err) {
    console.error('[ENGTV]', err);
    renderCategoryList([]);
    $('#item-grid').innerHTML = `<div class="empty-msg">Kategoriler alınamadı: ${err.message}</div>`;
  }
}

function renderCategoryList(cats) {
  const list = $('#category-list');
  list.innerHTML = '';
  cats.forEach(c => {
    const div = document.createElement('div');
    div.className = 'cat-item';
    div.tabIndex = 0;
    div.dataset.id = c.id;
    div.textContent = c.name + (c.count != null ? ` (${c.count})` : '');
    div.addEventListener('click', () => selectCategory(c.id));
    div.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectCategory(c.id); });
    list.appendChild(div);
  });
}

function selectCategory(id) {
  activeCategoryId = id;
  $$('.cat-item').forEach(el => el.classList.toggle('active', el.dataset.id == id));
  closePlayer();
  seriesListBackup = null;
  try {
    if (currentSection === 'live') currentItems = (liveCatalog.byCategory.get(String(id)) || []).map(mapLiveItem);
    else if (currentSection === 'movies') currentItems = (vodCatalog.byCategory.get(String(id)) || []).map(mapVodItem);
    else if (currentSection === 'series') currentItems = (seriesCatalog.byCategory.get(String(id)) || []).map(mapSeriesItem);
    renderItemGrid(currentItems);
  } catch (err) {
    $('#item-grid').innerHTML = `<div class="empty-msg">İçerik alınamadı: ${err.message}</div>`;
  }
}

// ---------- Arama (bölümün tüm kategorilerinde) ----------
$('#search-box').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { renderItemGrid(currentItems); return; }
  if (currentSection === 'favorites') { renderItemGrid(currentItems.filter(i => i.name.toLowerCase().includes(q))); return; }
  const catalog = currentSection === 'live' ? liveCatalog : currentSection === 'movies' ? vodCatalog : seriesCatalog;
  if (!catalog) return;
  const mapper = currentSection === 'live' ? mapLiveItem : currentSection === 'movies' ? mapVodItem : mapSeriesItem;
  const seen = new Set(); const results = [];
  catalog.byCategory.forEach(arr => arr.forEach(raw => {
    const key = raw.stream_id ?? raw.series_id;
    if (seen.has(key) || !(raw.name || '').toLowerCase().includes(q)) return;
    seen.add(key); results.push(mapper(raw));
  }));
  renderItemGrid(results);
});

// ---------- Favoriler ----------
function toggleFavorite(item) {
  const favs = storeGet('favorites') || [];
  const idx = favs.findIndex(f => f.playUrl === item.playUrl);
  if (idx >= 0) favs.splice(idx, 1); else favs.push(item);
  storeSet('favorites', favs);
}
function renderFavorites() {
  currentItems = storeGet('favorites') || [];
  renderItemGrid(currentItems);
}

// ---------- Izgara (parça parça render) ----------
const GRID_PAGE_SIZE = 150;
let gridBatchState = null;

function renderItemGrid(items) {
  const grid = $('#item-grid');
  grid.innerHTML = '';
  if (!items.length) { grid.innerHTML = '<div class="empty-msg">İçerik bulunamadı.</div>'; gridBatchState = null; return; }
  const favs = storeGet('favorites') || [];
  const favSet = new Set(favs.map(f => f.playUrl));
  gridBatchState = { items, rendered: 0, favSet };
  renderNextGridBatch();
}
function renderNextGridBatch() {
  if (!gridBatchState) return;
  const grid = $('#item-grid');
  const { items, rendered, favSet } = gridBatchState;
  const old = $('#grid-load-more'); if (old) old.remove();
  const next = items.slice(rendered, rendered + GRID_PAGE_SIZE);
  next.forEach((item, i) => grid.appendChild(buildItemCard(item, favSet, rendered + i + 1)));
  gridBatchState.rendered += next.length;
  if (gridBatchState.rendered < items.length) {
    const btn = document.createElement('button');
    btn.id = 'grid-load-more'; btn.className = 'grid-load-more';
    btn.textContent = `Daha fazla göster (${gridBatchState.rendered}/${items.length})`;
    btn.addEventListener('click', renderNextGridBatch);
    grid.appendChild(btn);
  }
}

function buildItemCard(item, favSet, seq) {
  const card = document.createElement('div');
  card.className = 'item-card';
  card.tabIndex = 0;

  if (item.kind === 'live' && seq != null) {
    const num = document.createElement('span'); num.className = 'chan-num'; num.textContent = seq;
    card.appendChild(num);
  }
  const thumb = document.createElement('div'); thumb.className = 'thumb';
  const initials = (item.name || '?').trim().slice(0, 2).toUpperCase();
  if (item.icon) {
    const img = document.createElement('img'); img.loading = 'lazy'; img.src = item.icon;
    img.addEventListener('error', () => {
      const fb = document.createElement('div'); fb.className = 'thumb-fallback'; fb.textContent = initials;
      img.replaceWith(fb);
    }, { once: true });
    thumb.appendChild(img);
  } else {
    const fb = document.createElement('div'); fb.className = 'thumb-fallback'; fb.textContent = initials;
    thumb.appendChild(fb);
  }
  card.appendChild(thumb);
  const title = document.createElement('div'); title.className = 'title'; title.textContent = item.name; title.title = item.name;
  card.appendChild(title);

  if (item.playUrl) {
    const star = document.createElement('button');
    const isFav = favSet.has(item.playUrl);
    star.className = 'fav-star' + (isFav ? ' active' : '');
    star.textContent = isFav ? '★' : '☆';
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(item);
      if (currentSection === 'favorites') renderFavorites();
      else { const now = star.classList.toggle('active'); star.textContent = now ? '★' : '☆'; }
    });
    card.appendChild(star);
  }
  const activate = () => {
    if (item.kind === 'series') openSeriesInfo(item);
    else if (item.kind === 'vod') openMovieInfo(item);
    else playItem(item);
  };
  card.addEventListener('click', activate);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') activate(); });
  card.addEventListener('dblclick', () => { if (item.kind !== 'series') playItem(item); });
  return card;
}

// ---------- Film/Dizi detay ekranı ----------
let detailCurrentItem = null, detailMode = null;
function showDetailModal({ title, poster, backdrop, plot, meta }) {
  $('#detail-title').textContent = title || '';
  $('#detail-poster').src = poster || '';
  $('#detail-backdrop').style.backgroundImage = backdrop ? `url("${backdrop}")` : (poster ? `url("${poster}")` : 'none');
  $('#detail-plot').textContent = plot || '';
  const rows = $('#detail-meta-rows'); rows.innerHTML = '';
  [['🎬','Yönetmen',meta&&meta.director],['📅','Tarih',meta&&meta.releaseDate],['⏱️','Süre',meta&&meta.duration],
   ['🎭','Tür',meta&&meta.genre],['👥','Oyuncular',meta&&meta.cast],['⭐','Puan',meta&&meta.rating]].forEach(([icon,label,value]) => {
    if (!value) return;
    const row = document.createElement('div'); row.className = 'detail-meta-row';
    const iconSpan = document.createElement('span'); iconSpan.textContent = icon;
    const textSpan = document.createElement('span');
    const labelSpan = document.createElement('span'); labelSpan.className = 'dm-label'; labelSpan.textContent = label + ': ';
    textSpan.appendChild(labelSpan); textSpan.appendChild(document.createTextNode(value));
    row.appendChild(iconSpan); row.appendChild(textSpan);
    rows.appendChild(row);
  });
  $('#detail-modal').classList.add('active');
}
function closeDetailModal() { $('#detail-modal').classList.remove('active'); detailCurrentItem = null; detailMode = null; }
$('#detail-close').addEventListener('click', closeDetailModal);

function updateDetailFavStar(item) {
  const favs = storeGet('favorites') || [];
  const isFav = item.playUrl && favs.some(f => f.playUrl === item.playUrl);
  const btn = $('#detail-fav');
  btn.style.display = item.playUrl ? 'inline-block' : 'none';
  btn.textContent = isFav ? '★ Favoride' : '☆ Favorilere Ekle';
}
async function openMovieInfo(item) {
  detailCurrentItem = item; detailMode = 'movie';
  showDetailModal({ title: item.name, poster: item.icon, plot: 'Açıklama yükleniyor...' });
  $('#detail-primary').textContent = '▶ Oynat';
  updateDetailFavStar(item);
  try {
    const data = await xtream.getVodInfo(item.id);
    const info = (data && data.info) || {};
    showDetailModal({
      title: item.name, poster: info.movie_image || info.cover_big || item.icon,
      backdrop: (Array.isArray(info.backdrop_path) && info.backdrop_path[0]) || info.movie_image || item.icon,
      plot: info.plot || 'Bu içerik için açıklama bulunamadı.',
      meta: { director: info.director, releaseDate: info.releasedate, duration: info.duration, genre: info.genre, cast: info.cast || info.actors, rating: info.rating ? String(info.rating) : null }
    });
  } catch (err) {
    showDetailModal({ title: item.name, poster: item.icon, plot: 'Açıklama alınamadı.' });
  }
}
async function openSeriesInfo(item) {
  detailCurrentItem = item; detailMode = 'series';
  showDetailModal({ title: item.name, poster: item.icon, plot: 'Açıklama yükleniyor...' });
  $('#detail-primary').textContent = '📀 Bölümleri Gör';
  $('#detail-fav').style.display = 'none';
  try {
    const data = await xtream.getSeriesInfo(item.id);
    const info = (data && data.info) || {};
    showDetailModal({
      title: item.name, poster: info.cover || item.icon,
      backdrop: (Array.isArray(info.backdrop_path) && info.backdrop_path[0]) || info.cover || item.icon,
      plot: info.plot || 'Bu içerik için açıklama bulunamadı.',
      meta: { director: info.director, releaseDate: info.releaseDate || info.releasedate, genre: info.genre, cast: info.cast || info.actors, rating: info.rating ? String(info.rating) : null }
    });
    detailCurrentItem = { ...item, _seriesInfo: data };
  } catch (err) {
    showDetailModal({ title: item.name, poster: item.icon, plot: 'Açıklama alınamadı.' });
  }
}
$('#detail-primary').addEventListener('click', () => {
  const item = detailCurrentItem, mode = detailMode;
  closeDetailModal();
  if (!item) return;
  if (mode === 'movie') playItem(item);
  else if (mode === 'series') openSeries(item, item._seriesInfo);
});
$('#detail-fav').addEventListener('click', () => {
  if (!detailCurrentItem) return;
  toggleFavorite(detailCurrentItem);
  updateDetailFavStar(detailCurrentItem);
});

let gridBackShown = false;
async function openSeries(item, preloadedInfo) {
  const info = preloadedInfo || await xtream.getSeriesInfo(item.id);
  const episodes = [];
  if (info && info.episodes) {
    Object.keys(info.episodes).forEach(season => {
      info.episodes[season].forEach(ep => {
        episodes.push({
          id: ep.id, name: `${item.name} - S${season}B${ep.episode_num} - ${ep.title || (ep.episode_num + '. Bölüm')}`,
          icon: item.icon, playUrl: xtream.seriesUrl(ep.id, ep.container_extension || 'mp4'), kind: 'series-ep'
        });
      });
    });
  }
  seriesListBackup = currentItems;
  currentItems = episodes;
  renderItemGrid(episodes);
}

// ---------- Oynatıcı ----------
function playItem(item, opts) {
  opts = opts || {};
  currentPlayingItem = item;
  $('#player-title').textContent = item.name;
  const isLive = item.kind === 'live';
  $('#chan-prev').style.display = isLive ? 'inline-block' : 'none';
  $('#chan-next').style.display = isLive ? 'inline-block' : 'none';
  $('#seek-back').style.display = isLive ? 'none' : 'inline-block';
  $('#seek-fwd').style.display = isLive ? 'none' : 'inline-block';
  const showProgress = !isLive && item.kind !== 'series';
  $('#progress-row').style.display = showProgress ? 'flex' : 'none';
  if (showProgress) startProgressPolling(); else stopProgressPolling();

  $('#player-pane').classList.add('active');
  renderMiniList(item);
  if (!opts.keepPanelOpen) closeLeftPanel();
  resetTrackSelectors();
  showControlsBar();
  attemptPlayback(item);

  if (!opts.skipAutoFullscreen) {
    const pane = $('#player-pane');
    if (pane.requestFullscreen) pane.requestFullscreen().catch(() => {});
  }
}

function renderMiniList(activeItem) {
  const list = $('#mini-list');
  list.innerHTML = '';
  currentItems.forEach(item => {
    if (!item.playUrl) return;
    const isCurrent = item.playUrl === activeItem.playUrl;
    const row = document.createElement('div');
    row.className = 'mini-item' + (isCurrent ? ' active' : '');
    row.textContent = item.name; row.tabIndex = 0;
    const act = () => {
      if (isCurrent && currentPlayingItem && currentPlayingItem.playUrl === item.playUrl) closeLeftPanel();
      else playItem(item, { keepPanelOpen: true, skipAutoFullscreen: true });
    };
    row.addEventListener('click', act);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') act(); });
    list.appendChild(row);
  });
}

const VIDEO_ERROR_NAMES = { 1: 'İptal edildi', 2: 'Ağ hatası', 3: 'Kod çözülemedi', 4: 'Format desteklenmiyor' };

function attemptPlayback(item) {
  const video = $('#video');
  resetTrackSelectors();
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  if (mpegtsInstance) { mpegtsInstance.destroy(); mpegtsInstance = null; }
  video.onerror = null;
  video.removeAttribute('src'); video.load();

  let url = item.playUrl;
  if (item.kind === 'live') {
    // Canlı yayında önce m3u8, olmazsa .ts dene (mpegts.js ile)
    tryPlayUrl(item, url, 0);
  } else {
    tryPlayUrl(item, url, 0);
  }
}

function tryPlayUrl(item, url, attempt) {
  const video = $('#video');
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  if (mpegtsInstance) { mpegtsInstance.destroy(); mpegtsInstance = null; }
  video.onerror = null;
  video.removeAttribute('src'); video.load();

  const advance = (reason) => {
    if (attempt === 0 && item.kind === 'live') {
      tryPlayUrl(item, url.replace(/\.m3u8$/, '.ts'), 1);
    } else if (attempt <= 1 && item.kind !== 'live') {
      const alt = url.endsWith('.mp4') ? url.replace(/\.mp4$/, '.mkv') : url.replace(/\.\w+$/, '.mp4');
      tryPlayUrl(item, alt, attempt + 1);
    } else {
      showPlayerError(friendlyErrorMessage(reason));
    }
  };

  if (url.endsWith('.m3u8') && window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls({ manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2 });
    hlsInstance.loadSource(url); hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) { hlsInstance.destroy(); hlsInstance = null; advance(data.details); } });
    hlsInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => populateHlsAudioTracks(hlsInstance));
    hlsInstance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => populateHlsSubtitleTracks(hlsInstance));
  } else if (url.endsWith('.ts') && window.mpegts && mpegts.isSupported()) {
    mpegtsInstance = mpegts.createPlayer({ type: 'mpegts', isLive: item.kind === 'live', url });
    mpegtsInstance.attachMediaElement(video);
    mpegtsInstance.on(mpegts.Events.ERROR, (type) => { mpegtsInstance.destroy(); mpegtsInstance = null; advance(`mpegts-${type}`); });
    mpegtsInstance.load();
  } else {
    video.src = url;
    video.onerror = () => { const code = video.error ? video.error.code : 0; advance(`video-error-${code}`); };
    video.addEventListener('loadedmetadata', () => { populateNativeAudioTracks(video); populateNativeSubtitleTracks(video); }, { once: true });
  }
  clearPlayerError();
  video.play().catch(() => {});
}

function friendlyErrorMessage(reason) {
  if (reason === 'manifestLoadError' || reason === 'levelLoadError') return 'Yayına ulaşılamadı (CORS engeli olabilir — bazı paneller tarayıcıdan erişime izin vermez).';
  if (typeof reason === 'string' && reason.startsWith('video-error-4')) return 'Bu formatı (MKV/HEVC gibi) tarayıcı oynatamıyor. Bu, tarayıcıların ortak bir kısıtı.';
  if (typeof reason === 'string' && reason.startsWith('video-error-2')) return 'Ağ hatası: dosyaya ulaşılamadı (CORS engeli olabilir).';
  return `Oynatma hatası: ${reason}`;
}

function showPlayerError(msg) {
  let box = $('#player-error');
  if (!box) { box = document.createElement('div'); box.id = 'player-error'; box.style.cssText = 'position:absolute;top:90px;left:20px;right:20px;text-align:center;color:#ff3b52;background:rgba(0,0,0,0.75);padding:14px;border-radius:8px;font-size:14px;z-index:22;'; $('#video-stage').appendChild(box); }
  box.textContent = msg;
}
function clearPlayerError() { const box = $('#player-error'); if (box) box.remove(); }

// ---------- Ses/Altyazı parça seçimi ----------
function resetTrackSelectors() {
  $('#audio-track-select').style.display = 'none'; $('#audio-track-select').innerHTML = '';
  $('#subtitle-track-select').style.display = 'none'; $('#subtitle-track-select').innerHTML = '';
}
function populateHlsAudioTracks(hls) {
  const sel = $('#audio-track-select');
  if (!hls.audioTracks || hls.audioTracks.length < 2) { sel.style.display = 'none'; return; }
  sel.innerHTML = '';
  hls.audioTracks.forEach((t, i) => { const o = document.createElement('option'); o.value = i; o.textContent = '🔊 ' + (t.name || t.lang || `Ses ${i+1}`); sel.appendChild(o); });
  sel.value = hls.audioTrack; sel.style.display = 'inline-block';
}
function populateHlsSubtitleTracks(hls) {
  const sel = $('#subtitle-track-select');
  if (!hls.subtitleTracks || !hls.subtitleTracks.length) { sel.style.display = 'none'; return; }
  sel.innerHTML = '';
  const off = document.createElement('option'); off.value = -1; off.textContent = '💬 Kapalı'; sel.appendChild(off);
  hls.subtitleTracks.forEach((t, i) => { const o = document.createElement('option'); o.value = i; o.textContent = '💬 ' + (t.name || t.lang || `Altyazı ${i+1}`); sel.appendChild(o); });
  sel.value = hls.subtitleTrack; sel.style.display = 'inline-block';
}
function populateNativeAudioTracks(video) {
  const sel = $('#audio-track-select');
  const tracks = video.audioTracks;
  if (!tracks || tracks.length < 2) { sel.style.display = 'none'; return; }
  sel.innerHTML = '';
  for (let i = 0; i < tracks.length; i++) { const t = tracks[i]; const o = document.createElement('option'); o.value = i; o.textContent = '🔊 ' + (t.label || t.language || `Ses ${i+1}`); if (t.enabled) sel.value = i; sel.appendChild(o); }
  sel.style.display = 'inline-block';
}
function populateNativeSubtitleTracks(video) {
  const sel = $('#subtitle-track-select');
  const tracks = video.textTracks;
  const usable = tracks ? Array.from(tracks).filter(t => t.kind === 'subtitles' || t.kind === 'captions') : [];
  if (!usable.length) { sel.style.display = 'none'; return; }
  sel.innerHTML = '';
  const off = document.createElement('option'); off.value = -1; off.textContent = '💬 Kapalı'; sel.appendChild(off);
  usable.forEach((t, i) => { const o = document.createElement('option'); o.value = i; o.textContent = '💬 ' + (t.label || t.language || `Altyazı ${i+1}`); if (t.mode === 'showing') sel.value = i; sel.appendChild(o); });
  sel.style.display = 'inline-block';
}
$('#audio-track-select').addEventListener('change', (e) => {
  e.target.blur();
  const video = $('#video');
  if (hlsInstance) { hlsInstance.audioTrack = Number(e.target.value); return; }
  if (video.audioTracks) { const idx = Number(e.target.value); for (let i = 0; i < video.audioTracks.length; i++) video.audioTracks[i].enabled = (i === idx); }
});
$('#subtitle-track-select').addEventListener('change', (e) => {
  e.target.blur();
  const video = $('#video');
  if (hlsInstance) { hlsInstance.subtitleTrack = Number(e.target.value); hlsInstance.subtitleDisplay = Number(e.target.value) !== -1; return; }
  if (video.textTracks) { const idx = Number(e.target.value); Array.from(video.textTracks).filter(t => t.kind === 'subtitles' || t.kind === 'captions').forEach((t, i) => { t.mode = (i === idx) ? 'showing' : 'hidden'; }); }
});

// ---------- İlerleme çubuğu ----------
let progressTimer = null, progressDragging = false;
function startProgressPolling() { stopProgressPolling(); progressTimer = setInterval(updateProgressBar, 1000); updateProgressBar(); }
function stopProgressPolling() { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '00:00';
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60);
  const p = n => String(n).padStart(2,'0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
function updateProgressBar() {
  if (progressDragging || $('#progress-row').style.display === 'none') return;
  const video = $('#video');
  const position = video.currentTime || 0;
  const duration = isFinite(video.duration) ? video.duration : 0;
  $('#progress-current').textContent = formatTime(position);
  $('#progress-duration').textContent = formatTime(duration);
  $('#progress-fill').style.width = duration > 0 ? `${Math.min(100,(position/duration)*100)}%` : '0%';
}
$('#progress-track').addEventListener('click', (e) => {
  const rect = $('#progress-track').getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const video = $('#video');
  if (isFinite(video.duration)) video.currentTime = ratio * video.duration;
});

// ---------- Sol panel (kanallar+kategoriler) ----------
function applyLeftPanelState() { $('#mini-list').classList.toggle('show', leftPanelOpen); }
function openLeftPanel() { leftPanelOpen = true; applyLeftPanelState(); }
function toggleLeftPanel() { leftPanelOpen = !leftPanelOpen; applyLeftPanelState(); }
function closeLeftPanel() { leftPanelOpen = false; applyLeftPanelState(); }
$('#top-list-toggle-btn').addEventListener('click', toggleLeftPanel);
$('#video').addEventListener('click', () => { if (leftPanelOpen) closeLeftPanel(); });

// ---------- Kanal ileri/geri ----------
function playAdjacentItem(dir, wrap) {
  const playable = currentItems.filter(i => i.playUrl);
  if (!playable.length || !currentPlayingItem) return;
  const idx = playable.findIndex(i => i.playUrl === currentPlayingItem.playUrl);
  if (idx === -1) return;
  let nextIdx = idx + dir;
  if (wrap) nextIdx = (nextIdx + playable.length) % playable.length;
  if (nextIdx < 0 || nextIdx >= playable.length) return;
  playItem(playable[nextIdx], { keepPanelOpen: true, skipAutoFullscreen: true });
}
$('#chan-prev').addEventListener('click', () => playAdjacentItem(-1, true));
$('#chan-next').addEventListener('click', () => playAdjacentItem(1, true));
$('#video').addEventListener('ended', () => { if (currentPlayingItem && currentPlayingItem.kind === 'series-ep') playAdjacentItem(1, false); });

// ---------- Sarma / Tam ekran / Kapat ----------
function seekBy(sec) {
  const video = $('#video');
  const max = isFinite(video.duration) ? video.duration : Infinity;
  video.currentTime = Math.min(max, Math.max(0, video.currentTime + sec));
}
$('#seek-back').addEventListener('click', () => seekBy(-10));
$('#seek-fwd').addEventListener('click', () => seekBy(10));
$('#player-fullscreen').addEventListener('click', () => {
  const pane = $('#player-pane');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else pane.requestFullscreen().catch(() => {});
});
function closePlayer() {
  const video = $('#video');
  video.onerror = null; video.pause(); video.removeAttribute('src'); video.load();
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  if (mpegtsInstance) { mpegtsInstance.destroy(); mpegtsInstance = null; }
  clearPlayerError(); resetTrackSelectors(); stopProgressPolling();
  clearTimeout(controlsHideTimer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('#player-pane').classList.remove('active');
  currentPlayingItem = null;
}
$('#player-close').addEventListener('click', closePlayer);

// ---------- YouTube tarzı çift tık ----------
$('#video-stage').addEventListener('dblclick', (e) => {
  const rect = $('#video-stage').getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  if (ratio < 0.35) seekBy(-10);
  else if (ratio > 0.65) seekBy(10);
  else $('#player-fullscreen').click();
});

// ---------- Üst çubuk otomatik gizlenme ----------
let controlsHideTimer = null;
function showControlsBar() {
  $('#player-top').classList.remove('controls-hidden');
  clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(() => $('#player-top').classList.add('controls-hidden'), 3000);
}
$('#video-wrap').addEventListener('mousemove', showControlsBar);
$('#video-wrap').addEventListener('mouseenter', showControlsBar);

// ---------- Klavye / D-pad kısayolları ----------
document.addEventListener('keydown', (e) => {
  if (!$('#player-pane').classList.contains('active')) return;
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.key === 'Escape') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else closePlayer();
    return;
  }
  const isLive = currentPlayingItem && currentPlayingItem.kind === 'live';
  if (e.key === 'ArrowRight') { e.preventDefault(); isLive ? playAdjacentItem(1, true) : seekBy(10); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); isLive ? playAdjacentItem(-1, true) : seekBy(-10); return; }
  const video = $('#video');
  if (e.key === 'ArrowUp') { video.volume = Math.min(1, video.volume + 0.05); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { video.volume = Math.max(0, video.volume - 0.05); e.preventDefault(); }
  else if (e.key === 'm' || e.key === 'M') { video.muted = !video.muted; }
  else if (e.key === ' ') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
});

// ---------- Başlangıç ----------
(async function initApp() {
  loadSavedProfiles();
  const last = storeGet('lastProfile');
  if (!last) return;
  try {
    await connectWithProfile(last);
  } catch (err) {
    showError(`Otomatik giriş başarısız (${err.message}) — lütfen tekrar giriş yapın.`);
  }
})();
