'use strict';

/* =========================================================
   家庭票据盒 — 纯本地发票收纳
   数据：IndexedDB（含图片 Blob），无服务器、无账号
   ========================================================= */

const DB_NAME = 'invoice-box';
const DB_VERSION = 1;
const STORE = 'invoices';

const CATEGORIES = [
  { id: 'food',      name: '餐饮',  color: '#d97742' },
  { id: 'transport', name: '交通',  color: '#4a7fd4' },
  { id: 'medical',   name: '医疗',  color: '#c94f63' },
  { id: 'education', name: '教育',  color: '#7a5fbf' },
  { id: 'home',      name: '住房',  color: '#6d8a4a' },
  { id: 'digital',   name: '数码',  color: '#3f8f96' },
  { id: 'shopping',  name: '购物',  color: '#c1762c' },
  { id: 'other',     name: '其他',  color: '#8a837a' },
];
const CAT_MAP = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

const state = {
  items: [],
  query: '',
  category: 'all',
  draft: null,
  detailId: null,
  viewFiles: [],
  viewIndex: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------- 工具 ---------------- */

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function money(n) {
  return '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${y}.${m}.${d}`;
}

function monthLabel(iso) {
  if (!iso) return '未填日期';
  const [y, m] = iso.split('-');
  return `${y}年${Number(m)}月`;
}

function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function catOf(id) {
  return CAT_MAP[id] || CAT_MAP.other;
}

/* 高亮第一个匹配片段（先转义再拼接，避免注入） */
function highlight(text, q) {
  const esc = escapeHtml(text);
  if (!q) return esc;
  const idx = esc.toLowerCase().indexOf(escapeHtml(q).toLowerCase());
  if (idx < 0) return esc;
  const len = escapeHtml(q).length;
  return esc.slice(0, idx) + '<mark>' + esc.slice(idx, idx + len) + '</mark>' + esc.slice(idx + len);
}

const urlCache = new WeakMap();
function blobUrl(blob) {
  let url = urlCache.get(blob);
  if (!url) {
    url = URL.createObjectURL(blob);
    urlCache.set(blob, url);
  }
  return url;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------------- 数据库 ---------------- */

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('date', 'date');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function dbAll() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(record) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

/* ---------------- 图片处理 ---------------- */

async function compressImage(file, maxSide = 1600, quality = 0.82) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    if (Math.max(width, height) <= maxSide && file.size < 900 * 1024) {
      bitmap.close && bitmap.close();
      return file;
    }
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close && bitmap.close();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob) return file;
    const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
    return new File([blob], base + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
  } catch (err) {
    console.warn('图片压缩失败，使用原文件', err);
    return file;
  }
}

/* ---------------- 渲染：顶部 / 分类 / 列表 ---------------- */

function filteredItems() {
  const q = state.query.trim().toLowerCase();
  return state.items.filter((it) => {
    if (state.category !== 'all' && it.category !== state.category) return false;
    if (!q) return true;
    const hay = [
      it.title, it.note, catOf(it.category).name, it.date,
      ...(it.tags || []),
      it.amount != null ? String(it.amount) : '',
      it.amount != null ? money(it.amount) : '',
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderSummary() {
  const total = state.items.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
  const withAmount = state.items.filter((it) => it.amount != null).length;
  const el = $('#summary');
  if (!state.items.length) {
    el.textContent = '还没有发票';
    return;
  }
  el.textContent = withAmount
    ? `共 ${state.items.length} 张 · 合计 ${money(total)}`
    : `共 ${state.items.length} 张`;
}

function renderCategories() {
  const bar = $('#categoryBar');
  const counts = {};
  state.items.forEach((it) => { counts[it.category] = (counts[it.category] || 0) + 1; });

  const chips = [{ id: 'all', name: '全部', color: '#221f1b', count: state.items.length }]
    .concat(CATEGORIES.filter((c) => counts[c.id]).map((c) => ({ ...c, count: counts[c.id] })));

  bar.innerHTML = chips.map((c) => `
    <button class="chip ${state.category === c.id ? 'active' : ''}" data-cat="${c.id}" role="tab" aria-selected="${state.category === c.id}">
      <span class="dot" style="--c:${c.color}"></span>${c.name}
      <span class="chip-count">${c.count}</span>
    </button>
  `).join('');
}

function thumbHTML(item) {
  const first = item.files && item.files[0];
  const extra = item.files && item.files.length > 1
    ? `<span class="count">${item.files.length}</span>` : '';
  if (!first) {
    return `<div class="thumb">${fileIcon()}</div>`;
  }
  if (first.type.startsWith('image/')) {
    return `<div class="thumb"><img src="${blobUrl(first.blob)}" alt="" loading="lazy">${extra}</div>`;
  }
  return `<div class="thumb">${fileIcon()}<span class="count">PDF</span></div>`;
}

function fileIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 3.5h7l4.5 4.5v12.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/>
    <path d="M14 3.5V8h4.5"/></svg>`;
}

function renderList() {
  const list = $('#list');
  const empty = $('#empty');
  const items = filteredItems();
  const q = state.query.trim();

  if (!items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    if (state.items.length === 0) {
      $('#emptyTitle').textContent = '还没有收录发票';
      $('#emptySub').innerHTML = '点右下角的「+」，拍一张或从相册选一张，<br>把重要的票据都放进这个盒子。';
      $('#emptyAddBtn').hidden = false;
    } else if (q) {
      $('#emptyTitle').textContent = '没有找到相关发票';
      $('#emptySub').textContent = `没有匹配「${q}」的记录，换个关键词试试。`;
      $('#emptyAddBtn').hidden = true;
    } else {
      $('#emptyTitle').textContent = '这个分类还是空的';
      $('#emptySub').textContent = '换一个分类看看，或添加一张新的票据。';
      $('#emptyAddBtn').hidden = true;
    }
    return;
  }

  empty.hidden = true;
  const frag = document.createDocumentFragment();
  let lastMonth = '';

  items.forEach((it) => {
    const month = monthLabel(it.date);
    if (month !== lastMonth) {
      const label = document.createElement('div');
      label.className = 'day-label';
      label.textContent = month;
      frag.appendChild(label);
      lastMonth = month;
    }

    const cat = catOf(it.category);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card';
    btn.dataset.id = it.id;
    btn.innerHTML = `
      ${thumbHTML(it)}
      <div class="card-body">
        <div class="card-top">
          <span class="card-title">${highlight(it.title || '未命名发票', q)}</span>
          <span class="card-amount ${it.amount == null ? 'zero' : ''}">${it.amount == null ? '未填金额' : money(it.amount)}</span>
        </div>
        <div class="card-meta">
          <span class="dot" style="--c:${cat.color}"></span>${cat.name}
          ${it.date ? `<span class="sep">·</span>${shortDate(it.date)}` : ''}
        </div>
        ${(it.tags && it.tags.length) ? `<div class="card-tags">${it.tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      </div>`;
    frag.appendChild(btn);
  });

  list.innerHTML = '';
  list.appendChild(frag);
}

function render() {
  renderSummary();
  renderCategories();
  renderList();
}

/* ---------------- 抽屉控制 ---------------- */

function lockScroll(locked) {
  document.body.style.overflow = locked ? 'hidden' : '';
}

function openSheet(id) {
  const el = document.getElementById(id);
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  lockScroll(true);
}

function closeSheet(el) {
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  if (!$('.sheet.open')) lockScroll(false);
}

/* ---------------- 编辑器 ---------------- */

function setDraft(record) {
  state.draft = {
    id: record ? record.id : null,
    title: record ? record.title : '',
    amount: record && record.amount != null ? String(record.amount) : '',
    date: record ? record.date : todayISO(),
    category: record ? record.category : 'other',
    tags: record ? [...(record.tags || [])] : [],
    note: record ? record.note || '' : '',
    files: record ? [...(record.files || [])] : [],
    createdAt: record ? record.createdAt : null,
  };
}

function openEditor(record) {
  setDraft(record);
  $('#editorTitle').textContent = record ? '编辑发票' : '新增发票';
  delete $('#fTitle').dataset.edited;
  $('#fTitle').value = state.draft.title;
  $('#fAmount').value = state.draft.amount;
  $('#fDate').value = state.draft.date;
  $('#fNote').value = state.draft.note;
  $('#fTagInput').value = '';
  renderCategoryPicker();
  renderDraftFiles();
  renderTagPills();
  openSheet('editor');
  setTimeout(() => {
    if (!state.draft.files.length) $('#fTitle').focus({ preventScroll: true });
  }, 340);
}

function renderCategoryPicker() {
  $('#fCategory').innerHTML = CATEGORIES.map((c) => `
    <button type="button" class="chip ${state.draft.category === c.id ? 'active' : ''}" data-pick="${c.id}">
      <span class="dot" style="--c:${c.color}"></span>${c.name}
    </button>`).join('');
}

function renderDraftFiles() {
  const box = $('#draftFiles');
  box.innerHTML = state.draft.files.map((f, i) => {
    const inner = f.type.startsWith('image/')
      ? `<img src="${blobUrl(f.blob)}" alt="">`
      : `<span class="pdf-badge">${fileIcon()}PDF</span>`;
    return `<div class="draft-thumb">${inner}
      <button type="button" class="remove" data-remove="${i}" aria-label="移除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button></div>`;
  }).join('');
}

function renderTagPills() {
  $('#fTags').innerHTML = state.draft.tags.map((t, i) => `
    <span class="tag-pill">${escapeHtml(t)}
      <button type="button" data-removetag="${i}" aria-label="移除标签">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </span>`).join('');
}

async function addFiles(fileList, autoFill) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  toast(`正在处理 ${files.length} 个文件…`);
  for (const f of files) {
    const isImage = f.type.startsWith('image/');
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
    if (!isImage && !isPdf) {
      toast('只支持图片或 PDF');
      continue;
    }
    const blob = isImage ? await compressImage(f) : f;
    state.draft.files.push({
      id: newId(),
      name: f.name || 'attachment',
      type: isImage ? blob.type : 'application/pdf',
      blob,
    });
  }
  renderDraftFiles();

  // 首次添加且用户还没动过标题时，用文件名兜底，省得每次手打
  if (autoFill && !$('#fTitle').dataset.edited && !$('#fTitle').value.trim() && files.length === 1) {
    const guess = (files[0].name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    if (guess && guess.length <= 30 && !/^(img|image|photo|微信图片|scan)/i.test(guess)) {
      $('#fTitle').value = guess;
    }
  }
}

function collectDraft() {
  const amountRaw = $('#fAmount').value.trim();
  const amount = amountRaw === '' ? null : Math.round(parseFloat(amountRaw) * 100) / 100;
  return {
    id: state.draft.id || newId(),
    title: $('#fTitle').value.trim() || '未命名发票',
    amount: Number.isFinite(amount) ? amount : null,
    date: $('#fDate').value || todayISO(),
    category: state.draft.category,
    tags: state.draft.tags,
    note: $('#fNote').value.trim(),
    files: state.draft.files,
    createdAt: state.draft.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

async function saveDraft() {
  if (!state.draft.files.length && !$('#fTitle').value.trim()) {
    toast('先加一张照片，或写个标题');
    return;
  }
  const record = collectDraft();
  try {
    await dbPut(record);
  } catch (err) {
    console.error(err);
    toast('保存失败，存储空间可能已满');
    return;
  }
  await reload();
  closeSheet($('#editor'));
  toast(state.draft.id ? '已更新' : '已保存');
}

/* ---------------- 详情 ---------------- */

function renderDetail(item) {
  const cat = catOf(item.category);
  const gallery = (item.files || []).map((f, i) => {
    if (f.type.startsWith('image/')) {
      return `<div class="gallery-item" data-open="${i}"><img src="${blobUrl(f.blob)}" alt=""></div>`;
    }
    return `<div class="gallery-item pdf-tile" data-open="${i}">
      <div class="pdf-inner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 3.5h7l4.5 4.5v12.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/>
          <path d="M14 3.5V8h4.5"/><path d="M8.5 15.5h7"/>
        </svg>
        <span>PDF 文件 · 点击查看</span>
      </div></div>`;
  }).join('');

  $('#detailBody').innerHTML = `
    ${gallery ? `<div class="detail-gallery">${gallery}</div>` : ''}
    <div class="detail-hero">
      <div class="detail-amount ${item.amount == null ? 'zero' : ''}">
        ${item.amount == null ? '未填金额' : `<span class="cur">¥</span>${Number(item.amount).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
      </div>
      <h3 class="detail-title">${escapeHtml(item.title || '未命名发票')}</h3>
    </div>
    <div class="detail-rows">
      <div class="detail-row"><span class="k">日期</span><span class="v">${item.date ? escapeHtml(shortDate(item.date)) : '未填'}</span></div>
      <div class="detail-row"><span class="k">分类</span><span class="v">${cat.name}</span></div>
      ${(item.tags && item.tags.length) ? `<div class="detail-row"><span class="k">标签</span><span class="v tags">${item.tags.map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join('')}</span></div>` : ''}
      ${item.note ? `<div class="detail-row"><span class="k">备注</span><span class="v">${escapeHtml(item.note)}</span></div>` : ''}
      <div class="detail-row"><span class="k">附件</span><span class="v">${(item.files || []).length} 张</span></div>
    </div>`;
}

function openDetail(id) {
  const item = state.items.find((it) => it.id === id);
  if (!item) return;
  state.detailId = id;
  renderDetail(item);
  openSheet('detail');
}

/* ---------------- 大图查看 ---------------- */

function openViewer(files, index) {
  state.viewFiles = files;
  state.viewIndex = index;
  const track = $('#viewerTrack');
  track.innerHTML = files.map((f) => {
    const url = blobUrl(f.blob);
    return f.type.startsWith('image/')
      ? `<div class="viewer-slide"><img src="${url}" alt=""></div>`
      : `<div class="viewer-slide"><iframe src="${url}" title="PDF"></iframe></div>`;
  }).join('');
  $('#viewer').hidden = false;
  $('#viewerCounter').textContent = `${index + 1} / ${files.length}`;
  requestAnimationFrame(() => {
    track.scrollLeft = index * track.clientWidth;
  });
}

function closeViewer() {
  $('#viewer').hidden = true;
  $('#viewerTrack').innerHTML = '';
}

/* ---------------- 备份 ---------------- */

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

async function exportBackup() {
  if (!state.items.length) { toast('还没有发票可备份'); return; }
  toast('正在打包备份…');
  const invoices = [];
  for (const it of state.items) {
    invoices.push({
      ...it,
      files: await Promise.all((it.files || []).map(async (f) => ({
        id: f.id, name: f.name, type: f.type, data: await blobToBase64(f.blob),
      }))),
    });
  }
  const payload = { app: 'invoice-box', version: 1, exportedAt: new Date().toISOString(), invoices };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const name = `票据备份-${todayISO()}.json`;
  const file = new File([blob], name, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '票据盒备份' });
      toast('备份已导出');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('备份已下载');
}

async function importBackup(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const list = Array.isArray(payload) ? payload : payload.invoices;
    if (!Array.isArray(list) || !list.length) throw new Error('格式不对');

    let count = 0;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const files = (raw.files || []).map((f) => ({
        id: f.id || newId(),
        name: f.name || 'attachment',
        type: f.type || 'application/octet-stream',
        blob: base64ToBlob(f.data || '', f.type),
      })).filter((f) => f.blob.size > 0);
      await dbPut({
        id: raw.id || newId(),
        title: raw.title || '未命名发票',
        amount: raw.amount == null ? null : Number(raw.amount),
        date: raw.date || todayISO(),
        category: CAT_MAP[raw.category] ? raw.category : 'other',
        tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 12) : [],
        note: raw.note || '',
        files,
        createdAt: raw.createdAt || Date.now(),
        updatedAt: Date.now(),
      });
      count++;
    }
    await reload();
    toast(`已导入 ${count} 张发票`);
  } catch (err) {
    console.error(err);
    toast('导入失败，请确认是本应用导出的备份文件');
  }
}

/* ---------------- 安装 / 存储信息 ---------------- */

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

async function promptInstall() {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === 'accepted') toast('已添加到桌面');
    return;
  }
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  toast(isIOS ? 'Safari 分享 → 添加到主屏幕' : '浏览器菜单 → 添加到主屏幕 / 安装应用');
}

async function showStorageInfo() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return;
    const { usage } = await navigator.storage.estimate();
    if (usage != null) {
      $('#storageInfo').textContent = `当前已使用约 ${(usage / 1024 / 1024).toFixed(1)} MB 本地存储（含照片）。`;
    }
  } catch (_) { /* 忽略 */ }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#addBtn').addEventListener('click', () => openEditor(null));
  $('#emptyAddBtn').addEventListener('click', () => openEditor(null));

  // 用户手动输入过标题后，自动填充（文件名兜底）不再介入
  $('#fTitle').addEventListener('input', () => {
    $('#fTitle').dataset.edited = '1';
  });

  // 搜索
  const search = $('#searchInput');
  search.addEventListener('input', () => {
    state.query = search.value;
    $('#clearSearch').hidden = !search.value;
    renderList();
  });
  $('#clearSearch').addEventListener('click', () => {
    search.value = '';
    state.query = '';
    $('#clearSearch').hidden = true;
    renderList();
    search.focus();
  });

  // 分类筛选
  $('#categoryBar').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    state.category = chip.dataset.cat;
    renderCategories();
    renderList();
  });

  // 列表 → 详情
  $('#list').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) openDetail(card.dataset.id);
  });

  // 关闭抽屉
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) closeSheet(closer.closest('.sheet'));
  });

  // 编辑器：分类
  $('#fCategory').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (!pick) return;
    state.draft.category = pick.dataset.pick;
    renderCategoryPicker();
  });

  // 编辑器：附件
  $('#cameraInput').addEventListener('change', async (e) => {
    await addFiles(e.target.files, true);
    e.target.value = '';
  });
  $('#fileInput').addEventListener('change', async (e) => {
    await addFiles(e.target.files, true);
    e.target.value = '';
  });
  $('#draftFiles').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (!rm) return;
    state.draft.files.splice(Number(rm.dataset.remove), 1);
    renderDraftFiles();
  });

  // 编辑器：标签
  const tagInput = $('#fTagInput');
  const commitTag = () => {
    const raw = tagInput.value.replace(/[，,]/g, ',').split(',').map((s) => s.trim()).filter(Boolean);
    raw.forEach((t) => {
      if (t.length > 20) return;
      if (state.draft.tags.includes(t)) return;
      if (state.draft.tags.length >= 8) return;
      state.draft.tags.push(t);
    });
    tagInput.value = '';
    renderTagPills();
  };
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      commitTag();
    }
  });
  tagInput.addEventListener('blur', commitTag);
  $('#fTags').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-removetag]');
    if (!rm) return;
    state.draft.tags.splice(Number(rm.dataset.removetag), 1);
    renderTagPills();
  });
  $('#saveBtn').addEventListener('click', saveDraft);

  // 详情：图片/PDF 查看
  $('#detailBody').addEventListener('click', (e) => {
    const item = e.target.closest('[data-open]');
    if (!item) return;
    const record = state.items.find((it) => it.id === state.detailId);
    if (!record) return;
    openViewer(record.files, Number(item.dataset.open));
  });

  $('#editBtn').addEventListener('click', () => {
    const record = state.items.find((it) => it.id === state.detailId);
    if (!record) return;
    closeSheet($('#detail'));
    setTimeout(() => openEditor(record), 220);
  });

  $('#deleteBtn').addEventListener('click', async () => {
    const record = state.items.find((it) => it.id === state.detailId);
    if (!record) return;
    if (!window.confirm(`删除「${record.title || '未命名发票'}」？删除后无法恢复。`)) return;
    await dbDelete(record.id);
    await reload();
    closeSheet($('#detail'));
    toast('已删除');
  });

  // 查看器
  $('#viewerClose').addEventListener('click', closeViewer);
  $('#viewerTrack').addEventListener('scroll', () => {
    const track = $('#viewerTrack');
    if (!track.clientWidth) return;
    const index = Math.round(track.scrollLeft / track.clientWidth);
    $('#viewerCounter').textContent = `${index + 1} / ${state.viewFiles.length}`;
  });

  // 菜单
  const menu = $('#menuPop');
  const menuOverlay = $('#menuOverlay');
  const closeMenu = () => {
    menu.hidden = true;
    menuOverlay.hidden = true;
  };
  $('#menuBtn').addEventListener('click', () => {
    menu.hidden = false;
    menuOverlay.hidden = false;
  });
  menuOverlay.addEventListener('click', closeMenu);

  menu.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    closeMenu();
    if (action === 'export') exportBackup();
    if (action === 'import') $('#importInput').click();
    if (action === 'install') promptInstall();
    if (action === 'about') {
      openSheet('about');
      showStorageInfo();
    }
  });

  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!window.confirm('导入备份会与现有发票合并，相同记录会被覆盖。继续？')) return;
    await importBackup(file);
  });

  // 桌面拖拽
  ['dragover', 'drop'].forEach((type) => {
    window.addEventListener(type, (e) => {
      if (!state.draft || !$('#editor').classList.contains('open')) return;
      e.preventDefault();
      if (type === 'drop' && e.dataTransfer && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files, true);
      }
    });
  });

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#viewer').hidden) return closeViewer();
    if (!$('#menuPop').hidden) return closeMenu();
    const open = $('.sheet.open');
    if (open) closeSheet(open);
  });
}

/* ---------------- 启动 ---------------- */

async function reload() {
  state.items = await dbAll();
  state.items.sort((a, b) => {
    if ((a.date || '') === (b.date || '')) return (b.createdAt || 0) - (a.createdAt || 0);
    return (a.date || '') < (b.date || '') ? 1 : -1;
  });
  render();
}

async function boot() {
  bindEvents();
  $('#fDate').value = todayISO();
  try {
    await reload();
  } catch (err) {
    console.error(err);
    toast('本地存储不可用，请关闭无痕模式后重试');
    render();
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
