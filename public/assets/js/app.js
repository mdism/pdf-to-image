/* PDF to Image: draws each page with pdf.js onto a canvas and saves it as JPG or PNG, all in memory. */
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const { dropZone, formatBytes, download, baseName, vetFiles, say } = window.Tool;
const $ = s => document.querySelector(s);
const MAX_PAGES = 500;
const MAX_PIXELS = 40e6; // per page; very large pages are drawn smaller so the browser doesn't run out of memory
const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;

const msg = $('#msg'), tiles = $('#tiles'), results = $('#results'), bar = $('#bar');
let file = null, doc = null, images = [], fmt = 'image/jpeg', busy = false;

/* ---------- settings ---------- */
document.querySelectorAll('[data-fmt]').forEach(b => b.addEventListener('click', () => {
  fmt = b.dataset.fmt;
  document.querySelectorAll('[data-fmt]').forEach(x => x.setAttribute('aria-pressed', x === b));
  $('#qualityBox').hidden = fmt !== 'image/jpeg';
}));
$('#quality').addEventListener('input', e => { $('#qualityOut').textContent = e.target.value; });

/** "1-3, 5, end" → [1,2,3,5,N] (page numbers). Empty means every page. */
function parseRange(text, count) {
  const parts = text.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return [...Array(count).keys()].map(i => i + 1);
  const out = new Set();
  for (const part of parts) {
    const m = part.match(/^(\d+|end)\s*(?:-\s*(\d+|end))?$/i);
    if (!m) throw new Error(`"${part}" is not a page or range. Use something like 1-3, 5.`);
    const num = v => v.toLowerCase() === 'end' ? count : +v;
    const a = num(m[1]), b = m[2] ? num(m[2]) : a;
    if (a < 1 || b < 1 || a > count || b > count) throw new Error(`Page ${Math.max(a, b)} does not exist. This PDF has ${count} pages.`);
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

/* ---------- open ---------- */
async function open(password) {
  // pdf.js takes ownership of the bytes it is given, so read a fresh copy each time.
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data, password, isEvalSupported: false, enableXfa: false,
    cMapUrl: VENDOR + 'cmaps/', cMapPacked: true, standardFontDataUrl: VENDOR + 'standard_fonts/',
  });
  try {
    doc = await task.promise;
  } catch (e) {
    if (e?.name === 'PasswordException') {
      $('#pwBox').hidden = false;
      say(msg, e.code === 2 ? 'That password is not right. Please try again.' : 'Type the PDF password to open it. It is only used on your device.');
      $('#pw').focus();
      return;
    }
    throw new Error(`"${file.name}" could not be read as a PDF. It may be damaged.`);
  }
  $('#pwBox').hidden = true;
  say(msg, doc.numPages > MAX_PAGES ? `This PDF has ${doc.numPages} pages. Up to ${MAX_PAGES} can be converted at once, so pick a range.` : '');
  $('#fileMeta').textContent = `${formatBytes(file.size)} · ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
  $('#goBtn').disabled = false;
  $('#goBtn').textContent = doc.numPages === 1 ? 'Convert to image' : `Convert ${doc.numPages} pages to images`;
}

dropZone($('#drop'), async files => {
  if (busy) return;
  const { ok, problems } = await vetFiles(files.slice(0, 1), { kinds: ['pdf'], maxMB: 150, maxCount: 1 });
  say(msg, problems.join(' '));
  if (!ok[0]) return;
  reset();
  file = ok[0];
  $('#fileName').textContent = file.name;
  $('#fileMeta').textContent = `${formatBytes(file.size)} · reading…`;
  $('#drop').hidden = true; $('#fileBox').hidden = false;
  try { await open(); } catch (e) { say(msg, e.message); $('#fileMeta').textContent = formatBytes(file.size); }
});

$('#pwBtn').addEventListener('click', () => open($('#pw').value).catch(e => say(msg, e.message)));
$('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') $('#pwBtn').click(); });

function clearImages() {
  images.forEach(i => URL.revokeObjectURL(i.url));
  images = [];
  tiles.textContent = '';
  results.hidden = true;
}

function reset() {
  clearImages();
  doc?.destroy();
  doc = file = null;
  $('#pw').value = ''; $('#pwBox').hidden = true; $('#goBtn').disabled = true;
}

$('#clearBtn').addEventListener('click', () => {
  if (busy) return;
  reset(); say(msg, '');
  $('#fileBox').hidden = true; $('#drop').hidden = false;
});

/* ---------- convert ---------- */
async function renderPage(n, dpi, quality) {
  const page = await doc.getPage(n);
  let scale = dpi / 72;
  const base = page.getViewport({ scale: 1 });
  if (base.width * base.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (base.width * base.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  const blob = await new Promise(res => canvas.toBlob(res, fmt, quality));
  canvas.width = canvas.height = 0; // free the pixels right away
  if (!blob) throw new Error(`Page ${n} is too large for this browser to turn into an image. Try a lower resolution.`);
  return { blob, w: Math.ceil(vp.width), h: Math.ceil(vp.height) };
}

function addTile(img) {
  const li = document.createElement('li');
  li.className = 'tile';
  li.innerHTML = '<span class="num"></span><div class="pic"><img alt=""></div><div class="meta"></div><div class="tools"><button class="btn small" type="button">Download</button></div>';
  li.querySelector('.num').textContent = img.page;
  li.querySelector('img').src = img.url;
  li.querySelector('img').alt = `Page ${img.page}`;
  li.querySelector('.meta').textContent = `${img.w}×${img.h} · ${formatBytes(img.blob.size)}`;
  li.querySelector('button').addEventListener('click', () => download(img.blob, img.name));
  tiles.appendChild(li);
}

$('#goBtn').addEventListener('click', async () => {
  let pages;
  try { pages = parseRange($('#range').value, doc.numPages); } catch (e) { say(msg, e.message); return; }
  if (pages.length > MAX_PAGES) { say(msg, `That is ${pages.length} pages. Please pick ${MAX_PAGES} or fewer.`); return; }

  const btn = $('#goBtn'), label = btn.textContent;
  const dpi = +$('#dpi').value, quality = +$('#quality').value / 100;
  const ext = fmt === 'image/png' ? 'png' : 'jpg', name = baseName(file.name), pad = String(doc.numPages).length;
  busy = true; btn.disabled = true; say(msg, ''); clearImages();
  bar.hidden = false; bar.firstElementChild.style.width = '0';
  try {
    for (const [i, n] of pages.entries()) {
      btn.textContent = `Converting page ${i + 1} of ${pages.length}…`;
      const { blob, w, h } = await renderPage(n, dpi, quality);
      const img = { page: n, blob, w, h, url: URL.createObjectURL(blob), name: `${name}-page-${String(n).padStart(pad, '0')}.${ext}` };
      images.push(img);
      addTile(img);
      results.hidden = false;
      bar.firstElementChild.style.width = `${((i + 1) / pages.length) * 100}%`;
    }
    const total = images.reduce((s, i) => s + i.blob.size, 0);
    $('#summary').textContent = `${images.length} image${images.length === 1 ? '' : 's'} · ${formatBytes(total)} in total`;
    $('#zipBtn').textContent = images.length === 1 ? 'Download image' : 'Download all (.zip)';
  } catch (e) {
    say(msg, e.message || 'Something went wrong while converting. Try a lower resolution.');
  }
  bar.hidden = true; btn.textContent = label; btn.disabled = false; busy = false;
});

$('#zipBtn').addEventListener('click', async () => {
  if (!images.length) return;
  if (images.length === 1) return download(images[0].blob, images[0].name);
  const files = {};
  for (const img of images) files[img.name] = [new Uint8Array(await img.blob.arrayBuffer()), { level: 0 }]; // already compressed
  download(new Blob([fflate.zipSync(files)], { type: 'application/zip' }), `${baseName(file.name)}-images.zip`);
});
