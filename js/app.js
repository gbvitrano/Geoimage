'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════════════════ */
const state = {
  mode           : 'pan',        // 'pan' | 'gcp'
  image          : null,         // { dataUrl, width, height, name }
  overlay        : null,         // Leaflet layer (DistortableImage or ImageOverlay)
  overlayType    : 'distortable',// 'distortable' | 'simple'
  gcps           : [],           // [{ px, py, lat, lng, marker }]
  originalCorners: null,         // corners at first placement, for reset
  overlayLocked  : false,        // when true, handles are hidden
};

/* ═══════════════════════════════════════════════════════════════════════════
   UNDO / REDO  (cronologia posizioni overlay)
   ═══════════════════════════════════════════════════════════════════════════ */
const HISTORY_MAX = 50;
let overlayHistory    = [];    // array di snapshot: [{lat,lng}×4]
let overlayHistoryIdx = -1;    // indice corrente
let _isRestoring      = false; // guard: impedisce pushHistory durante un restore

function pushHistory() {
  if (_isRestoring) return;    // ← evita che la ricostruzione degli handle azzeri il redo
  if (!state.overlay) return;
  const c = getOverlayCorners();
  if (!c) return;
  // Elimina gli stati "futuri" (redo invalidato da nuova azione)
  overlayHistory = overlayHistory.slice(0, overlayHistoryIdx + 1);
  overlayHistory.push(c.map(p => ({ lat: p.lat, lng: p.lng })));
  if (overlayHistory.length > HISTORY_MAX) overlayHistory.shift();
  overlayHistoryIdx = overlayHistory.length - 1;
  _updateUndoRedoBtns();
}

function _restoreHistory(snap) {
  _isRestoring = true;
  try {
    setOverlayCorners(snap.map(p => L.latLng(p.lat, p.lng)));
    updateHandlePositions();
  } finally {
    _isRestoring = false; // garantito anche in caso di eccezione
  }
  saveToLocalStorage();
  _updateUndoRedoBtns();
}

function undoOverlay(steps = 1) {
  if (overlayHistoryIdx <= 0) return;
  overlayHistoryIdx = Math.max(0, overlayHistoryIdx - steps);
  _restoreHistory(overlayHistory[overlayHistoryIdx]);
  setStatus('Annullato — passo ' + overlayHistoryIdx + '/' + (overlayHistory.length - 1) + '.');
}

function redoOverlay(steps = 1) {
  if (overlayHistoryIdx >= overlayHistory.length - 1) return;
  overlayHistoryIdx = Math.min(overlayHistory.length - 1, overlayHistoryIdx + steps);
  _restoreHistory(overlayHistory[overlayHistoryIdx]);
  setStatus('Ripristinato — passo ' + overlayHistoryIdx + '/' + (overlayHistory.length - 1) + '.');
}

function _updateUndoRedoBtns() {
  const u = document.getElementById('btn-undo');
  const r = document.getElementById('btn-redo');
  if (u) u.disabled = overlayHistoryIdx <= 0;
  if (r) r.disabled = overlayHistoryIdx >= overlayHistory.length - 1;
}

function clearHistory() {
  overlayHistory = []; overlayHistoryIdx = -1; _updateUndoRedoBtns();
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAP + BASEMAPS
   ═══════════════════════════════════════════════════════════════════════════ */
const map = L.map('map', { center: [41.9, 12.5], zoom: 6, zoomControl: true });

const basemaps = {
  'osm'        : L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
                   { attribution: '© OpenStreetMap contributors', maxZoom: 20 }),
  'esri'       : L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                   { attribution: 'Tiles © Esri', maxZoom: 20 }),
  'carto-light': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
                   { attribution: '© OpenStreetMap © CARTO', maxZoom: 20 }),
  'carto-dark' : L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
                   { attribution: '© OpenStreetMap © CARTO', maxZoom: 20 }),
};
basemaps['osm'].addTo(map);

document.getElementById('basemap-select').addEventListener('change', e => {
  Object.values(basemaps).forEach(l => map.removeLayer(l));
  basemaps[e.target.value].addTo(map);
  if (state.overlay) state.overlay.bringToFront();
});

map.on('mousemove', e => {
  document.getElementById('cursor-coords').textContent =
    `Lat: ${e.latlng.lat.toFixed(6)}  Lon: ${e.latlng.lng.toFixed(6)}`;
});

/* ═══════════════════════════════════════════════════════════════════════════
   OPACITY SLIDER
   ═══════════════════════════════════════════════════════════════════════════ */
const opacitySlider = document.getElementById('opacity-slider');
const opacityValEl  = document.getElementById('opacity-val');

opacitySlider.addEventListener('input', () => {
  const v = parseInt(opacitySlider.value);
  opacityValEl.textContent = v + '%';
  if (state.overlay) state.overlay.setOpacity(v / 100);
});

/* ═══════════════════════════════════════════════════════════════════════════
   IMAGE LOADING
   ═══════════════════════════════════════════════════════════════════════════ */
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

document.getElementById('btn-remove-img').addEventListener('click', () => {
  removeOverlay();
  clearGcps();
  state.image = null;
  dropZone.className = ''; // reset all classes
  dropZone.innerHTML = `<div class="drop-icon"><i class="fa-solid fa-folder-open"></i></div><div>Carica mappa storica</div>
    <div class="drop-sub">JPG · PNG · WEBP · BMP — oppure trascina qui</div>`;
  document.getElementById('btn-remove-img').style.display = 'none';
  fileInput.value = '';
  localStorage.removeItem('geoimage_project');
  setStatus('Immagine rimossa.');
});

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) loadImageFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) loadImageFile(e.target.files[0]);
});

// Also allow drag & drop directly on the map
map.getContainer().addEventListener('dragover', e => e.preventDefault());
map.getContainer().addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) loadImageFile(e.dataTransfer.files[0]);
});

function loadImageFile(file) {
  if (!file.type.startsWith('image/')) {
    setStatus('Formato non supportato. Usa JPG, PNG, WEBP o BMP.'); return;
  }
  const reader = new FileReader();
  reader.onload = ev => {
    const dataUrl = ev.target.result;
    const img = new Image();
    img.onload = () => {
      state.image = { dataUrl, width: img.naturalWidth, height: img.naturalHeight, name: file.name };
      dropZone.classList.add('has-image');
      dropZone.innerHTML = `<div class="drop-icon"><i class="fa-solid fa-circle-check" style="color:#16a34a"></i></div><div>${file.name}</div>
        <div class="drop-sub">${img.naturalWidth}×${img.naturalHeight} px</div>`;
      document.getElementById('img-info').textContent = '';
      document.getElementById('btn-remove-img').style.display = 'block';
      placeOverlay(dataUrl);
      setStatus('Immagine caricata. Posizionala sulla mappa, poi aggiungi i GCP (tasto G).');
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

/* ═══════════════════════════════════════════════════════════════════════════
   OVERLAY PLACEMENT
   ═══════════════════════════════════════════════════════════════════════════ */
function placeOverlay(dataUrl) {
  if (state.overlay) { map.removeLayer(state.overlay); state.overlay = null; }
  clearGcps();

  const center = map.getCenter();
  const bounds = map.getBounds();
  const latSpan = (bounds.getNorth() - bounds.getSouth()) * 0.38;
  const lngSpan = (bounds.getEast()  - bounds.getWest())  * 0.38;

  const aspect = state.image.width / state.image.height;
  const viewAspect = lngSpan / latSpan;
  let dLat, dLng;
  if (aspect > viewAspect) { dLng = lngSpan; dLat = lngSpan / aspect; }
  else                     { dLat = latSpan; dLng = latSpan * aspect;  }

  const corners = [
    L.latLng(center.lat + dLat / 2, center.lng - dLng / 2), // NW
    L.latLng(center.lat + dLat / 2, center.lng + dLng / 2), // NE
    L.latLng(center.lat - dLat / 2, center.lng - dLng / 2), // SW
    L.latLng(center.lat - dLat / 2, center.lng + dLng / 2), // SE
  ];
  state.originalCorners = corners.map(c => L.latLng(c.lat, c.lng));

  const opacity = parseInt(opacitySlider.value) / 100;

  // Try Leaflet.DistortableImage; fall back to plain ImageOverlay
  try {
    if (typeof L.distortableImageOverlay !== 'function') throw new Error('not loaded');
    state.overlay     = L.distortableImageOverlay(dataUrl, { corners, opacity });
    state.overlayType = 'distortable';
    state.overlay.addTo(map);
    // We use custom handles — keep DistortableImage editing off
    state.overlay.on('add', () => { try { state.overlay.editing.disable(); } catch (_) {} });
  } catch (_) {
    console.warn('Leaflet.DistortableImage non disponibile — uso ImageOverlay base.');
    state.overlayType = 'simple';
    const imgBounds = L.latLngBounds(
      [corners[2].lat, corners[0].lng],  // SW
      [corners[0].lat, corners[1].lng]   // NE
    );
    state.overlay = L.imageOverlay(dataUrl, imgBounds, { opacity, interactive: true });
    state.overlay.addTo(map);
    setStatus('⚠ Libreria distorsione non caricata: overlay base attivo. ' +
              'Le maniglie di distorsione non sono disponibili.');
  }

  // Zoom to overlay and show handles
  overlayHandleMode = 'scale'; // reimposta sempre in modalità scala al caricamento
  clearHistory();              // nuova immagine = cronologia azzerata
  map.fitBounds(L.latLngBounds(corners), { padding: [30, 30], maxZoom: 16 });
  // showEditHandles() needs the overlay to be in the DOM first
  setTimeout(() => { showEditHandles(); attachOverlayClickToggle(); pushHistory(); }, 150);

  showPosPanel(true);
  updateExportButtons();
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODE MANAGEMENT
   ═══════════════════════════════════════════════════════════════════════════ */
const btnPan   = document.getElementById('btn-pan');
const btnGcp   = document.getElementById('btn-gcp');
const modeBadge = document.getElementById('mode-badge');

btnPan.addEventListener('click', setModePan);
btnGcp.addEventListener('click', setModeGcp);
document.getElementById('btn-undo').addEventListener('click', e => undoOverlay(e.shiftKey ? 10 : 1));
document.getElementById('btn-redo').addEventListener('click', e => redoOverlay(e.shiftKey ? 10 : 1));
document.getElementById('btn-clear').addEventListener('click', clearGcps);

document.addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key === 'g' || e.key === 'G')            setModeGcp();
  if (e.key === 'Escape') {
    if (pendingGcp) { cancelPendingGcp(); setStatus('GCP — Step 1: clicca sull\'anteprima immagine nella sidebar per selezionare il punto.'); }
    else setModePan();
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.gcps.length) removeGcp(state.gcps.length - 1);
  }
  if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveToLocalStorage(); }
  if (e.ctrlKey && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoOverlay(1); }
  if (e.ctrlKey && e.key === 'Z' &&  e.shiftKey) { e.preventDefault(); undoOverlay(10); }
  if (e.ctrlKey && e.key === 'y' && !e.shiftKey) { e.preventDefault(); redoOverlay(1); }
  if (e.ctrlKey && e.key === 'Y' &&  e.shiftKey) { e.preventDefault(); redoOverlay(10); }
});

function setModePan() {
  state.mode = 'pan';
  btnPan.classList.add('active');  btnGcp.classList.remove('active');
  modeBadge.classList.add('hidden');
  map.getContainer().style.cursor = '';
  cancelPendingGcp();
  document.getElementById('panel-gcp-preview').style.display = 'none';
  showEditHandles();
  setStatus('Pan: trascina ✥ per spostare · 1° clic immagine = SCALA (↖↘) · 2° clic = DEFORMA (◇) · arancio ↻ per ruotare.');
}

function setModeGcp() {
  if (!state.overlay) { setStatus('Carica prima un\'immagine storica.'); return; }
  state.mode = 'gcp';
  btnGcp.classList.add('active'); btnPan.classList.remove('active');
  modeBadge.classList.remove('hidden');
  map.getContainer().style.cursor = 'crosshair';
  hideEditHandles();
  document.getElementById('panel-gcp-preview').style.display = 'block';
  drawPreviewCanvas();
  setStatus('GCP — Step 1: clicca sull\'immagine storica sulla mappa per selezionare il punto.');
}

/* ═══════════════════════════════════════════════════════════════════════════
   OVERLAY POSITIONING CONTROLS
   ═══════════════════════════════════════════════════════════════════════════ */

function setOverlayCorners(corners) {
  if (!state.overlay) return;
  if (state.overlayType === 'distortable') {
    try {
      state.overlay.setCorners(corners);
    } catch (_) {
      // DistortableImage lancia errori interni sulla toolbar anche se le coordinate
      // vengono comunque aggiornate correttamente — ignoriamo l'eccezione.
    }
  } else {
    state.overlay.setBounds(L.latLngBounds(
      [Math.min(...corners.map(c => c.lat)), Math.min(...corners.map(c => c.lng))],
      [Math.max(...corners.map(c => c.lat)), Math.max(...corners.map(c => c.lng))]
    ));
  }
}

function overlayCenter() {
  const c = getOverlayCorners();
  return L.latLng(
    c.reduce((s, p) => s + p.lat, 0) / 4,
    c.reduce((s, p) => s + p.lng, 0) / 4
  );
}

// Step = 5 % of the shorter overlay dimension
function nudgeStep() {
  const c = getOverlayCorners();
  const dLat = Math.abs(c[0].lat - c[2].lat);
  const dLng = Math.abs(c[0].lng - c[1].lng);
  return Math.min(dLat, dLng) * 0.05;
}

function moveOverlay(dLat, dLng) {
  setOverlayCorners(getOverlayCorners().map(c => L.latLng(c.lat + dLat, c.lng + dLng)));
}

function rotateOverlay(deg) {
  const rad  = deg * Math.PI / 180;
  const cos  = Math.cos(rad), sin = Math.sin(rad);
  const ctr  = overlayCenter();
  const latR = Math.cos(ctr.lat * Math.PI / 180);
  setOverlayCorners(getOverlayCorners().map(c => {
    const dlat =  c.lat - ctr.lat;
    const dlng = (c.lng - ctr.lng) * latR;
    return L.latLng(
      ctr.lat + dlat * cos - dlng * sin,
      ctr.lng + (dlat * sin + dlng * cos) / latR
    );
  }));
}

function scaleOverlay(factor) {
  const ctr = overlayCenter();
  setOverlayCorners(getOverlayCorners().map(c => L.latLng(
    ctr.lat + (c.lat - ctr.lat) * factor,
    ctr.lng + (c.lng - ctr.lng) * factor
  )));
}

// Wire up positioning buttons (buttons also update handles and save)
document.getElementById('pos-up').addEventListener('click',     () => { moveOverlay( nudgeStep(), 0); updateHandlePositions(); pushHistory(); saveToLocalStorage(); });
document.getElementById('pos-down').addEventListener('click',   () => { moveOverlay(-nudgeStep(), 0); updateHandlePositions(); pushHistory(); saveToLocalStorage(); });
document.getElementById('pos-left').addEventListener('click',   () => { moveOverlay(0, -nudgeStep()); updateHandlePositions(); pushHistory(); saveToLocalStorage(); });
document.getElementById('pos-right').addEventListener('click',  () => { moveOverlay(0,  nudgeStep()); updateHandlePositions(); pushHistory(); saveToLocalStorage(); });
document.getElementById('pos-rot-l').addEventListener('click',  () => { rotateOverlay(-5); updateHandlePositions(); pushHistory(); saveToLocalStorage(); });
document.getElementById('pos-rot-r').addEventListener('click',  () => { rotateOverlay( 5); updateHandlePositions(); pushHistory(); saveToLocalStorage(); });
document.getElementById('pos-scale-d').addEventListener('click',() => { scaleOverlay(0.9); updateHandlePositions(); pushHistory(); saveToLocalStorage(); });
document.getElementById('pos-scale-u').addEventListener('click',() => { scaleOverlay(1.1); updateHandlePositions(); pushHistory(); saveToLocalStorage(); });
document.getElementById('pos-fit').addEventListener('click', () => {
  const c = getOverlayCorners();
  if (c) map.fitBounds(L.latLngBounds(c), { padding: [30, 30], maxZoom: 17 });
});

function showPosPanel(visible) {
  document.getElementById('panel-pos').style.display = visible ? 'block' : 'none';
}

/* ═══════════════════════════════════════════════════════════════════════════
   INTERACTIVE OVERLAY HANDLES  (drag to move / resize / rotate)
   ═══════════════════════════════════════════════════════════════════════════ */
const eh = { corners: [null,null,null,null], center: null, rotate: null };
// 'scale' = 1° click (ridimensiona proporzionalmente), 'distort' = 2° click (deforma libera)
let overlayHandleMode = 'scale';

function rotHandlePos() {
  const c = getOverlayCorners(), ctr = overlayCenter();
  const topMidLat = (c[0].lat + c[1].lat) / 2;
  const topMidLng = (c[0].lng + c[1].lng) / 2;
  // Place 30% beyond top-mid edge away from center
  return L.latLng(
    topMidLat + (topMidLat - ctr.lat) * 0.3,
    topMidLng + (topMidLng - ctr.lng) * 0.3
  );
}

function showEditHandles() {
  if (!state.overlay) return;
  if (state.overlayLocked) return;
  hideEditHandles();
  const corners = getOverlayCorners();

  // ── 4 corner handles ────────────────────────────────────────────────
  // Rotazione freccia diagonale per la modalità scala: ogni angolo punta verso l'esterno
  // fa-arrows-left-right ruotato: NW=-45°(↖↘), NE=+45°(↗↙), SW=+45°(↗↙), SE=-45°(↖↘)
  const _scaleArrowRot = [-45, 45, 45, -45];
  // Cursore CSS per modalità scala: NW/SE = nwse-resize, NE/SW = nesw-resize
  const _scaleCursor   = ['nwse-resize', 'nesw-resize', 'nesw-resize', 'nwse-resize'];

  corners.forEach((c, i) => {
    const isScale = overlayHandleMode === 'scale';

    const iconHtml = isScale
      ? `<div class="eh-corner-scale" style="cursor:${_scaleCursor[i]}"><i class="fa-solid fa-arrows-left-right" style="transform:rotate(${_scaleArrowRot[i]}deg);pointer-events:none"></i></div>`
      : `<div class="eh-corner-distort" style="cursor:move"></div>`;
    const iSize  = isScale ? [17, 17] : [13, 13];
    const iAnchor = isScale ? [8, 8]  : [6, 6];

    const m = L.marker(c, {
      icon: L.divIcon({ className:'', html: iconHtml, iconSize: iSize, iconAnchor: iAnchor }),
      draggable: true, zIndexOffset: 2000,
    }).addTo(map);

    if (isScale) {
      // ── Modalità SCALA: ridimensiona proporzionalmente dall'angolo opposto ──
      let _startCorners = null, _anchor = null, _d0lat = null, _d0lng = null;

      m.on('dragstart', () => {
        _startCorners = getOverlayCorners().map(c => L.latLng(c.lat, c.lng));
        _anchor = L.latLng(_startCorners[3 - i].lat, _startCorners[3 - i].lng);
        const latR = Math.cos(_anchor.lat * Math.PI / 180);
        _d0lat = _startCorners[i].lat - _anchor.lat;
        _d0lng = (_startCorners[i].lng - _anchor.lng) * latR;
      });

      m.on('drag', e => {
        if (!_startCorners) return;
        const latR  = Math.cos(_anchor.lat * Math.PI / 180);
        const d1lat = e.latlng.lat - _anchor.lat;
        const d1lng = (e.latlng.lng - _anchor.lng) * latR;
        const dot00 = _d0lat * _d0lat + _d0lng * _d0lng;
        if (dot00 === 0) return;
        const scale = (d1lat * _d0lat + d1lng * _d0lng) / dot00;
        const nc = _startCorners.map(c => L.latLng(
          _anchor.lat + (c.lat - _anchor.lat) * scale,
          _anchor.lng + (c.lng - _anchor.lng) * scale
        ));
        setOverlayCorners(nc);
        // Usa nc direttamente: più affidabile che ri-leggere dall'overlay
        eh.corners.forEach((hm, j) => { if (j !== i && hm) hm.setLatLng(nc[j]); });
        if (eh.center) eh.center.setLatLng(overlayCenter());
        if (eh.rotate) eh.rotate.setLatLng(rotHandlePos());
      });

      m.on('dragend', () => {
        // Leaflet ha spostato il marker alla posizione del mouse durante il drag,
        // ma il corner reale è sul punto proiettato: riallineiamo.
        _startCorners = null;
        updateHandlePositions();
        pushHistory();
        saveToLocalStorage();
      });

    } else {
      // ── Modalità DEFORMA: ogni angolo si muove liberamente ──
      m.on('drag', e => {
        const cur = getOverlayCorners();
        cur[i] = e.latlng;
        setOverlayCorners(cur);
        eh.corners.forEach((hm, j) => { if (j !== i && hm) hm.setLatLng(getOverlayCorners()[j]); });
        if (eh.center) eh.center.setLatLng(overlayCenter());
        if (eh.rotate) eh.rotate.setLatLng(rotHandlePos());
      });
      m.on('dragend', () => { pushHistory(); saveToLocalStorage(); });
    }

    eh.corners[i] = m;
  });

  // ── Center handle (move) ─────────────────────────────────────────────
  // Use absolute delta from dragstart to avoid accumulation drift
  let moveStartCorners = null;
  let moveStartMouse   = null;
  const cm = L.marker(overlayCenter(), {
    icon: L.divIcon({ className:'', html:'<div class="eh-center"><i class="fa-solid fa-up-down-left-right"></i></div>',
                      iconSize:[28,28], iconAnchor:[14,14] }),
    draggable: true, zIndexOffset: 2000,
  }).addTo(map);

  cm.on('dragstart', e => {
    moveStartMouse   = e.target.getLatLng();
    moveStartCorners = getOverlayCorners().map(c => L.latLng(c.lat, c.lng));
  });
  cm.on('drag', e => {
    if (!moveStartMouse || !moveStartCorners) return;
    const dLat = e.latlng.lat - moveStartMouse.lat;
    const dLng = e.latlng.lng - moveStartMouse.lng;
    setOverlayCorners(moveStartCorners.map(c => L.latLng(c.lat + dLat, c.lng + dLng)));
    const nc = getOverlayCorners();
    eh.corners.forEach((hm, i) => { if (hm) hm.setLatLng(nc[i]); });
    if (eh.rotate) eh.rotate.setLatLng(rotHandlePos());
  });
  cm.on('dragend', () => { pushHistory(); saveToLocalStorage(); });
  eh.center = cm;

  // ── Rotation handle ──────────────────────────────────────────────────
  // Absolute approach: angle always computed from dragstart, never incremental
  let rotStartAngle   = null;
  let rotStartCorners = null;
  let rotStartCenter  = null;

  const rm = L.marker(rotHandlePos(), {
    icon: L.divIcon({ className:'', html:'<div class="eh-rotate"><i class="fa-solid fa-rotate-right"></i></div>',
                      iconSize:[22,22], iconAnchor:[11,11] }),
    draggable: true, zIndexOffset: 2000,
  }).addTo(map);

  rm.on('dragstart', e => {
    rotStartCenter  = overlayCenter();
    rotStartCorners = getOverlayCorners().map(c => L.latLng(c.lat, c.lng));
    const latR = Math.cos(rotStartCenter.lat * Math.PI / 180);
    const p    = e.target.getLatLng();
    rotStartAngle = Math.atan2(p.lat - rotStartCenter.lat, (p.lng - rotStartCenter.lng) * latR);
  });

  rm.on('drag', e => {
    if (rotStartAngle === null) return;
    const latR     = Math.cos(rotStartCenter.lat * Math.PI / 180);
    const newAngle = Math.atan2(e.latlng.lat - rotStartCenter.lat, (e.latlng.lng - rotStartCenter.lng) * latR);
    const rad = newAngle - rotStartAngle;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const newCorners = rotStartCorners.map(c => {
      const dlat =  c.lat - rotStartCenter.lat;
      const dlng = (c.lng - rotStartCenter.lng) * latR;
      return L.latLng(
        rotStartCenter.lat + dlat * cos - dlng * sin,
        rotStartCenter.lng + (dlat * sin + dlng * cos) / latR
      );
    });
    setOverlayCorners(newCorners);
    const nc = getOverlayCorners();
    eh.corners.forEach((hm, i) => { if (hm) hm.setLatLng(nc[i]); });
    if (eh.center) eh.center.setLatLng(overlayCenter());
  });

  rm.on('dragend', () => {
    rotStartAngle = rotStartCorners = rotStartCenter = null;
    rm.setLatLng(rotHandlePos());
    pushHistory();
    saveToLocalStorage();
  });
  eh.rotate = rm;
}

// Attacca il click sull'overlay per alternare modalità scala ↔ deforma.
// Usa map.on('click') + geoToPixel perché DistortableImage disabilita pointer-events
// sull'elemento <img>, rendendo inaffidabile state.overlay.on('click').
function attachOverlayClickToggle() { /* no-op: handled by map click below */ }

// Guard: evita toggle accidentale dopo drag (Leaflet emette click alla fine dei drag)
let _overlayDragging = false;
map.on('dragstart', () => { _overlayDragging = true; });
map.on('dragend',   () => { setTimeout(() => { _overlayDragging = false; }, 50); });

map.on('click', e => {
  if (_overlayDragging) return;
  if (state.mode !== 'pan' || !state.overlay || state.overlayLocked) return;
  const hit = geoToPixel(e.latlng.lat, e.latlng.lng);
  if (!hit.valid) return;
  overlayHandleMode = (overlayHandleMode === 'scale') ? 'distort' : 'scale';
  hideEditHandles();
  showEditHandles();
  setStatus(overlayHandleMode === 'scale'
    ? 'Modalità SCALA — trascina gli angoli per ridimensionare proporzionalmente. Clicca l\'immagine per passare alla deformazione.'
    : 'Modalità DEFORMA — trascina gli angoli liberamente per distorcere. Clicca l\'immagine per tornare alla scala.');
});

function updateHandlePositions() {
  const c = getOverlayCorners();
  if (!c) return;
  c.forEach((pt, i) => { if (eh.corners[i]) eh.corners[i].setLatLng(pt); });
  if (eh.center) eh.center.setLatLng(overlayCenter());
  if (eh.rotate) eh.rotate.setLatLng(rotHandlePos());
}

function hideEditHandles() {
  [...eh.corners, eh.center, eh.rotate].forEach(m => { if (m) map.removeLayer(m); });
  eh.corners = [null,null,null,null]; eh.center = null; eh.rotate = null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   OVERLAY CORNERS HELPER  (works for both DistortableImage and ImageOverlay)
   ═══════════════════════════════════════════════════════════════════════════ */
function getOverlayCorners() {
  if (!state.overlay) return null;
  if (state.overlayType === 'distortable') {
    return state.overlay.getCorners(); // [NW, NE, SW, SE]
  }
  // L.imageOverlay fallback — reconstruct corners from bounds
  const b = state.overlay.getBounds();
  return [
    L.latLng(b.getNorth(), b.getWest()), // NW
    L.latLng(b.getNorth(), b.getEast()), // NE
    L.latLng(b.getSouth(), b.getWest()), // SW
    L.latLng(b.getSouth(), b.getEast()), // SE
  ];
}

/* ═══════════════════════════════════════════════════════════════════════════
   GEO ↔ PIXEL CONVERSION  (bilinear / Newton)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Given a geo click (lat, lng), return the pixel coordinates on the historical
 * image using bilinear interpolation over the current overlay corners.
 * Corners order: [NW, NE, SW, SE] = [0,0], [W,0], [0,H], [W,H]
 */
function geoToPixel(lat, lng) {
  if (!state.overlay || !state.image) return { px: -1, py: -1, valid: false };

  const corners = getOverlayCorners();
  if (!corners || corners.length < 4) return { px: -1, py: -1, valid: false };

  const [NW, NE, SW, SE] = corners;
  const W = state.image.width, H = state.image.height;

  // Bilinear: P(s,t) = (1-s)(1-t)*NW + s(1-t)*NE + (1-s)t*SW + s*t*SE
  // Solve for s,t via Newton's method
  let s = 0.5, t = 0.5;

  for (let i = 0; i < 30; i++) {
    const fLat = (1-s)*(1-t)*NW.lat + s*(1-t)*NE.lat + (1-s)*t*SW.lat + s*t*SE.lat - lat;
    const fLng = (1-s)*(1-t)*NW.lng + s*(1-t)*NE.lng + (1-s)*t*SW.lng + s*t*SE.lng - lng;

    if (Math.abs(fLat) < 1e-11 && Math.abs(fLng) < 1e-11) break;

    const dLat_ds = -(1-t)*NW.lat + (1-t)*NE.lat - t*SW.lat + t*SE.lat;
    const dLat_dt = -(1-s)*NW.lat - s*NE.lat     + (1-s)*SW.lat + s*SE.lat;
    const dLng_ds = -(1-t)*NW.lng + (1-t)*NE.lng - t*SW.lng + t*SE.lng;
    const dLng_dt = -(1-s)*NW.lng - s*NE.lng     + (1-s)*SW.lng + s*SE.lng;

    const det = dLat_ds * dLng_dt - dLat_dt * dLng_ds;
    if (Math.abs(det) < 1e-15) break;

    s -= (fLat * dLng_dt - fLng * dLat_dt) / det;
    t -= (dLat_ds * fLng - dLng_ds * fLat) / det;
  }

  const px = s * W, py = t * H;
  const valid = s >= -0.02 && s <= 1.02 && t >= -0.02 && t <= 1.02;
  return { px: Math.round(px), py: Math.round(py), valid };
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAP CLICK — ADD GCP  (two-step: image overlay click → base map click)
   ═══════════════════════════════════════════════════════════════════════════ */
let pendingGcp = null;        // { px, py } — waiting for step-2 map click
let pendingGcpMarker = null;  // temporary marker shown during step 1 → 2

function cancelPendingGcp() {
  if (pendingGcp) {
    pendingGcp = null;
    if (pendingGcpMarker) { map.removeLayer(pendingGcpMarker); pendingGcpMarker = null; }
    drawPreviewCanvas();
  }
}

map.on('click', e => {
  if (state.mode !== 'gcp' || !state.overlay) return;

  if (!pendingGcp) {
    // ── Step 1: click on the image overlay → compute pixel coords ──────
    const { lat, lng } = e.latlng;
    const result = geoToPixel(lat, lng);
    if (!result.valid) {
      setStatus('Step 1: clicca sull\'immagine storica sulla mappa per selezionare il punto.');
      return;
    }
    pendingGcp = { px: result.px, py: result.py };
    // show a temporary crosshair marker at the clicked overlay position
    if (pendingGcpMarker) map.removeLayer(pendingGcpMarker);
    pendingGcpMarker = L.circleMarker([lat, lng], {
      radius: 8, color: '#f59e0b', weight: 2.5, fillColor: 'rgba(245,158,11,0.6)', fillOpacity: 1
    }).addTo(map);
    drawPreviewCanvas();
    setStatus(`Pixel (${result.px}, ${result.py}) selezionato — Step 2: clicca sulla mappa base nel punto reale corrispondente. Esc per annullare.`);
    return;
  }

  // ── Step 2: click anywhere on the map → real-world coords ───────────
  const { lat, lng } = e.latlng;
  if (pendingGcpMarker) { map.removeLayer(pendingGcpMarker); pendingGcpMarker = null; }
  addGcp(lat, lng, pendingGcp.px, pendingGcp.py);
  pendingGcp = null;
  drawPreviewCanvas();
  setStatus(`GCP ${state.gcps.length} aggiunto. Step 1: clicca sull\'immagine per il prossimo punto, Esc per uscire.`);
});

/* ═══════════════════════════════════════════════════════════════════════════
   GCP CANVAS PREVIEW  — accurate pixel coords independent of overlay position
   ═══════════════════════════════════════════════════════════════════════════ */

function drawPreviewCanvas() {
  const canvas = document.getElementById('gcp-preview-canvas');
  if (!canvas || !state.image) return;
  const W = state.image.width, H = state.image.height;
  canvas.width  = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0);

    // Draw confirmed GCP markers
    state.gcps.forEach((g, i) => {
      ctx.beginPath();
      ctx.arc(g.px, g.py, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(10, Math.round(W / 80))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), g.px, g.py);
    });

    // Draw pending marker (step-1 click awaiting step-2)
    if (pendingGcp) {
      const r = 11;
      ctx.beginPath();
      ctx.arc(pendingGcp.px, pendingGcp.py, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(245,158,11,0.85)';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      // crosshair lines
      ctx.beginPath();
      ctx.moveTo(pendingGcp.px - r * 1.7, pendingGcp.py);
      ctx.lineTo(pendingGcp.px + r * 1.7, pendingGcp.py);
      ctx.moveTo(pendingGcp.px, pendingGcp.py - r * 1.7);
      ctx.lineTo(pendingGcp.px, pendingGcp.py + r * 1.7);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  };
  img.src = state.image.dataUrl;
}

// ── Canvas — display only, no click interaction ───────────────────────────────

/* ═══════════════════════════════════════════════════════════════════════════
   GCP MANAGEMENT
   ═══════════════════════════════════════════════════════════════════════════ */
function addGcp(lat, lng, px, py) {
  const idx = state.gcps.length;

  const icon = makeGcpIcon(idx + 1);
  const marker = L.marker([lat, lng], { icon, draggable: true }).addTo(map);

  marker.bindTooltip(
    `<b>GCP ${idx + 1}</b><br>Lat ${lat.toFixed(6)}<br>Lon ${lng.toFixed(6)}<br>Px ${px} · Py ${py}`,
    { direction: 'top', offset: [0, -14] }
  );

  marker.on('dragend', () => {
    const gcp = state.gcps.find(g => g.marker === marker);
    if (!gcp) return;
    const pos = marker.getLatLng();
    gcp.lat = pos.lat; gcp.lng = pos.lng;
    // px/py stay fixed — they come from the canvas click (step 1) and represent
    // actual image content positions, independent of overlay placement.
    marker.setTooltipContent(
      `<b>GCP ${state.gcps.indexOf(gcp) + 1}</b><br>Lat ${pos.lat.toFixed(6)}<br>Lon ${pos.lng.toFixed(6)}<br>Px ${gcp.px} · Py ${gcp.py}`
    );
    updateGcpTable(); updateRmse(); saveToLocalStorage();
  });

  state.gcps.push({ lat, lng, px, py, marker });
  updateGcpTable(); updateRmse(); updateExportButtons(); drawPreviewCanvas(); saveToLocalStorage();
}

function removeGcp(idx) {
  if (idx < 0 || idx >= state.gcps.length) return;
  map.removeLayer(state.gcps[idx].marker);
  state.gcps.splice(idx, 1);
  // Re-number markers
  state.gcps.forEach((g, i) => {
    g.marker.setIcon(makeGcpIcon(i + 1));
  });
  updateGcpTable(); updateRmse(); updateExportButtons(); drawPreviewCanvas(); saveToLocalStorage();
}

function clearGcps() {
  state.gcps.forEach(g => map.removeLayer(g.marker));
  state.gcps = [];
  updateGcpTable(); updateRmse(); updateExportButtons(); drawPreviewCanvas();
}

function removeOverlay() {
  hideEditHandles();
  if (state.overlay) { map.removeLayer(state.overlay); state.overlay = null; }
  showPosPanel(false);
}

function makeGcpIcon(n) {
  return L.divIcon({
    className: '',
    html: `<div class="gcp-icon">${n}</div>`,
    iconSize: [22, 22], iconAnchor: [11, 11],
  });
}

function updateGcpTable() {
  const n = state.gcps.length;
  const min = getMinGcps();
  document.getElementById('gcp-count').textContent =
    n === 0 ? 'Nessun GCP inserito' :
    n < min  ? `${n} GCP — ne servono almeno ${min}` :
    `${n} GCP`;

  // Compute per-GCP residuals if transform available
  const t   = n >= min ? computeActiveTransform() : null;
  const res = t ? computeResiduals(t) : [];
  const mean = res.length ? res.reduce((a,b)=>a+b,0)/res.length : 0;

  const tbody = document.getElementById('gcp-tbody');
  tbody.innerHTML = '';
  state.gcps.forEach((g, i) => {
    const r = res[i];
    const resText = r != null ? r.toFixed(1) : '—';
    const resClass = r == null ? '' : r < mean*1.5 ? 'gcp-res-good' : r < mean*3 ? 'gcp-res-warn' : 'gcp-res-bad';
    const tr = document.createElement('tr');
    if (resClass) tr.className = resClass;
    tr.innerHTML = `
      <td>${i+1}</td>
      <td>${g.lat.toFixed(5)}</td>
      <td>${g.lng.toFixed(5)}</td>
      <td>${g.px}</td>
      <td>${g.py}</td>
      <td>${resText}</td>
      <td><button class="gcp-del" title="Rimuovi"><i class="fa-solid fa-xmark"></i></button></td>`;
    tr.querySelector('.gcp-del').addEventListener('click', () => removeGcp(i));
    tbody.appendChild(tr);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   AFFINE LEAST-SQUARES TRANSFORM
   pixel → geo:  lon = a·px + b·py + c
                 lat = d·px + e·py + f
   ═══════════════════════════════════════════════════════════════════════════ */
function computeAffine() {
  const gcps = state.gcps;
  if (gcps.length < 3) return null;

  let sPxPx = 0, sPxPy = 0, sPyPy = 0, sPx = 0, sPy = 0;
  let sPxLon = 0, sPyLon = 0, sLon = 0;
  let sPxLat = 0, sPyLat = 0, sLat = 0;
  const n = gcps.length;

  gcps.forEach(g => {
    sPxPx += g.px*g.px; sPxPy += g.px*g.py; sPyPy += g.py*g.py;
    sPx   += g.px;      sPy   += g.py;
    sPxLon += g.px*g.lng; sPyLon += g.py*g.lng; sLon += g.lng;
    sPxLat += g.px*g.lat; sPyLat += g.py*g.lat; sLat += g.lat;
  });

  const M = [[sPxPx, sPxPy, sPx],
             [sPxPy, sPyPy, sPy],
             [sPx,   sPy,   n  ]];

  const sLon3 = solve3([...M.map(r=>[...r])], [sPxLon, sPyLon, sLon]);
  const sLat3 = solve3([...M.map(r=>[...r])], [sPxLat, sPyLat, sLat]);

  if (!sLon3 || !sLat3) return null;

  return { a: sLon3[0], b: sLon3[1], c: sLon3[2],
           d: sLat3[0], e: sLat3[1], f: sLat3[2] };
}

function applyAffine(t, px, py) {
  return { lng: t.a*px + t.b*py + t.c, lat: t.d*px + t.e*py + t.f };
}

// Generic Gaussian elimination solver (n×n)
function solveLinear(M, b) {
  const n = b.length;
  const A = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let mx = col;
    for (let r = col+1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[mx][col])) mx = r;
    [A[col], A[mx]] = [A[mx], A[col]];
    if (Math.abs(A[col][col]) < 1e-12) return null;
    for (let r = col+1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      for (let k = col; k <= n; k++) A[r][k] -= f * A[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n-1; i >= 0; i--) {
    x[i] = A[i][n];
    for (let j = i+1; j < n; j++) x[i] -= A[i][j]*x[j];
    x[i] /= A[i][i];
  }
  return x;
}
function solve3(M, b) { return solveLinear(M, b); } // backward compat

// Least squares via normal equations  A^T A x = A^T b
function solveLeastSquares(A, b) {
  const n = A.length, m = A[0].length;
  const AtA = Array.from({length:m}, () => new Array(m).fill(0));
  const Atb = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) for (let k = 0; k < n; k++) AtA[i][j] += A[k][i]*A[k][j];
    for (let k = 0; k < n; k++) Atb[i] += A[k][i]*b[k];
  }
  return solveLinear(AtA, Atb);
}

/* ═══════════════════════════════════════════════════════════════════════════
   POLYNOMIAL 2 TRANSFORM
   lon = a0 + a1·px + a2·py + a3·px² + a4·px·py + a5·py²
   lat = b0 + b1·px + b2·py + b3·px² + b4·px·py + b5·py²
   ═══════════════════════════════════════════════════════════════════════════ */
function computePoly2() {
  const gcps = state.gcps;
  if (gcps.length < 6) return null;
  const A = gcps.map(g => [1, g.px, g.py, g.px*g.px, g.px*g.py, g.py*g.py]);
  const cLon = solveLeastSquares(A, gcps.map(g => g.lng));
  const cLat = solveLeastSquares(A, gcps.map(g => g.lat));
  if (!cLon || !cLat) return null;
  return { order: 2, cLon, cLat };
}

function applyPoly2(t, px, py) {
  const v = [1, px, py, px*px, px*py, py*py];
  return {
    lng: t.cLon.reduce((s,c,i) => s+c*v[i], 0),
    lat: t.cLat.reduce((s,c,i) => s+c*v[i], 0),
  };
}

// Iterative inverse of poly2 (Newton-Raphson, initial guess from linear part)
function inversePoly2(t, lon, lat) {
  const aff = { a:t.cLon[1], b:t.cLon[2], c:t.cLon[0], d:t.cLat[1], e:t.cLat[2], f:t.cLat[0] };
  const init = inverseAffine(aff, lon, lat);
  let px = init ? init.px : 0, py = init ? init.py : 0;
  for (let i = 0; i < 50; i++) {
    const g = applyPoly2(t, px, py);
    const dl = g.lng-lon, db = g.lat-lat;
    if (Math.abs(dl) < 1e-11 && Math.abs(db) < 1e-11) break;
    const J00 = t.cLon[1] + 2*t.cLon[3]*px + t.cLon[4]*py;
    const J01 = t.cLon[2] + t.cLon[4]*px   + 2*t.cLon[5]*py;
    const J10 = t.cLat[1] + 2*t.cLat[3]*px + t.cLat[4]*py;
    const J11 = t.cLat[2] + t.cLat[4]*px   + 2*t.cLat[5]*py;
    const det = J00*J11 - J01*J10;
    if (Math.abs(det) < 1e-15) break;
    px -= ( J11*dl - J01*db) / det;
    py -= (-J10*dl + J00*db) / det;
  }
  return { px, py };
}

// ── Active transform helpers ─────────────────────────────────────────────────
function getTransformType() {
  return document.getElementById('transform-type')?.value || 'poly1';
}
function getMinGcps() { return getTransformType() === 'poly2' ? 6 : 3; }

function computeActiveTransform() {
  return getTransformType() === 'poly2' ? computePoly2() : computeAffine();
}
function applyTransform(t, px, py) {
  return t.order === 2 ? applyPoly2(t, px, py) : applyAffine(t, px, py);
}
function inverseTransform(t, lon, lat) {
  return t.order === 2 ? inversePoly2(t, lon, lat) : inverseAffine(t, lon, lat);
}

function computeResiduals(t) {
  return state.gcps.map(g => {
    const p = applyTransform(t, g.px, g.py);
    const dlat = (p.lat - g.lat) * 111320;
    const dlng = (p.lng - g.lng) * 111320 * Math.cos(g.lat * Math.PI / 180);
    return Math.sqrt(dlat*dlat + dlng*dlng);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   RMSE
   ═══════════════════════════════════════════════════════════════════════════ */
function updateRmse() {
  const row = document.getElementById('rmse-row');
  if (state.gcps.length < getMinGcps()) { row.style.display = 'none'; return; }
  const t = computeActiveTransform();
  if (!t) { row.style.display = 'none'; return; }
  const res = computeResiduals(t);
  const rmse = Math.sqrt(res.reduce((s,r) => s+r*r, 0) / res.length);
  document.getElementById('rmse-val').textContent = rmse.toFixed(2);
  row.style.display = 'block';
}

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORT BUTTONS STATE
   ═══════════════════════════════════════════════════════════════════════════ */
function updateExportButtons() {
  const hasImg  = !!state.overlay;
  const hasGcps = state.gcps.length >= getMinGcps();
  document.getElementById('btn-kml').disabled        = !(hasImg && hasGcps);
  document.getElementById('btn-geotiff').disabled    = !(hasImg && hasGcps);
  document.getElementById('btn-qgis').disabled       = !(state.gcps.length >= 1);
  document.getElementById('btn-worldfile').disabled  = !(hasImg && state.gcps.length >= 3);
  document.getElementById('btn-geojson').disabled    = !(state.gcps.length >= 1);
  document.getElementById('btn-apply-gcp').disabled  = !(hasImg && hasGcps);
}

/* ═══════════════════════════════════════════════════════════════════════════
   KMZ EXPORT  (KML + immagine incorporata come file separato nello ZIP)
   ═══════════════════════════════════════════════════════════════════════════ */
document.getElementById('btn-kml').addEventListener('click', async () => {
  if (!state.overlay || !state.image) return;
  const corners = getOverlayCorners(); // [NW, NE, SW, SE]
  const [NW, NE, SW, SE] = corners;

  // Determine image mime/extension from dataUrl
  const mime = state.image.dataUrl.split(';')[0].split(':')[1]; // e.g. 'image/jpeg'
  const ext  = mime.split('/')[1].replace('jpeg', 'jpg');
  const imgName = `files/${baseName(state.image.name)}.${ext}`;
  const imgBase64 = state.image.dataUrl.split(',')[1];

  const gcpPlacemarks = state.gcps.map((g, i) => `    <Placemark>
      <name>GCP ${i+1}</name>
      <description>Pixel: ${g.px}, ${g.py}</description>
      <Point><coordinates>${g.lng.toFixed(8)},${g.lat.toFixed(8)},0</coordinates></Point>
    </Placemark>`).join('\n');

  // Use gx:LatLonQuad to place the image at the exact four corner coordinates.
  // This correctly handles rotated and distorted overlays.
  // Corner order for gx:LatLonQuad: SW, SE, NE, NW (counterclockwise from lower-left).
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"
     xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>Mappa storica georeferenziata</name>
    <GroundOverlay>
      <name>${escXml(state.image.name)}</name>
      <Icon><href>${imgName}</href></Icon>
      <gx:LatLonQuad>
        <coordinates>
          ${SW.lng.toFixed(8)},${SW.lat.toFixed(8)},0
          ${SE.lng.toFixed(8)},${SE.lat.toFixed(8)},0
          ${NE.lng.toFixed(8)},${NE.lat.toFixed(8)},0
          ${NW.lng.toFixed(8)},${NW.lat.toFixed(8)},0
        </coordinates>
      </gx:LatLonQuad>
    </GroundOverlay>
    <Folder>
      <name>Ground Control Points</name>
${gcpPlacemarks}
    </Folder>
  </Document>
</kml>`;

  const zip = new JSZip();
  zip.file('doc.kml', kml);
  zip.folder('files').file(`${baseName(state.image.name)}.${ext}`, imgBase64, { base64: true });
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  downloadBlob(blob, baseName(state.image.name) + '_georef.kmz');
  setStatus('KMZ esportato (immagine incorporata).');
});

function escXml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ═══════════════════════════════════════════════════════════════════════════
   GEOTIFF EXPORT  — settings dialog + warp pipeline + geotiff.js writer
   ═══════════════════════════════════════════════════════════════════════════ */

// CRS definitions for proj4 reprojection
proj4.defs('EPSG:4326',  '+proj=longlat +datum=WGS84 +no_defs');
proj4.defs('EPSG:32632', '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs');
proj4.defs('EPSG:32633', '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs');
proj4.defs('EPSG:3857',  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +no_defs');

// ── Inverse affine: (lon,lat) → (px,py) ─────────────────────────────────────
function inverseAffine(t, lon, lat) {
  const det = t.a * t.e - t.b * t.d;
  if (Math.abs(det) < 1e-15) return null;
  const dl = lon - t.c, db = lat - t.f;
  return { px: (t.e*dl - t.b*db)/det, py: (-t.d*dl + t.a*db)/det };
}

// ── Pixel samplers ───────────────────────────────────────────────────────────
function sampleNearest(d, W, H, px, py) {
  const x = Math.round(px), y = Math.round(py);
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const i = (y*W+x)*4;
  return [d[i], d[i+1], d[i+2]];
}

function sampleBilinear(d, W, H, px, py) {
  if (px < -0.5 || py < -0.5 || px > W-0.5 || py > H-0.5) return null;
  const x0 = Math.max(0, Math.min(W-1, Math.floor(px)));
  const y0 = Math.max(0, Math.min(H-1, Math.floor(py)));
  const x1 = Math.min(x0+1, W-1), y1 = Math.min(y0+1, H-1);
  const fx = Math.max(0, Math.min(1, px-x0)), fy = Math.max(0, Math.min(1, py-y0));
  const i00=(y0*W+x0)*4, i10=(y0*W+x1)*4, i01=(y1*W+x0)*4, i11=(y1*W+x1)*4;
  return [0,1,2].map(c =>
    d[i00+c]*(1-fx)*(1-fy) + d[i10+c]*fx*(1-fy) +
    d[i01+c]*(1-fx)*fy    + d[i11+c]*fx*fy
  );
}

// ── Dialog ───────────────────────────────────────────────────────────────────
const gtiffDlgOv = document.getElementById('gtiff-dialog-overlay');
const gtiffDlg   = document.getElementById('gtiff-dialog');

function openGtiffDialog() {
  gtiffDlgOv.classList.add('open');
  gtiffDlg.style.display = 'block';
  requestAnimationFrame(() => gtiffDlg.classList.add('open'));
  syncGtiffNote();
}

function closeGtiffDialog() {
  gtiffDlg.classList.remove('open');
  gtiffDlgOv.classList.remove('open');
  setTimeout(() => { if (!gtiffDlg.classList.contains('open')) gtiffDlg.style.display = 'none'; }, 220);
}

function syncGtiffNote() {
  const epsg = parseInt(document.getElementById('gtiff-crs').value);
  const rg   = document.getElementById('gtiff-resample-group');
  const nt   = document.getElementById('gtiff-note-text');
  if (epsg === 4326) {
    nt.textContent = 'EPSG:4326: trasformazione affine incorporata nel file, nessun ricampionamento necessario.';
    rg.style.opacity = '0.4'; rg.style.pointerEvents = 'none';
  } else {
    const crsLabel = document.getElementById('gtiff-crs').selectedOptions[0].text;
    const method   = document.getElementById('gtiff-resample').selectedOptions[0].text;
    nt.textContent = `I pixel verranno ricampionati (${method}) per riproiettare l'immagine in ${crsLabel.split('—')[0].trim()}.`;
    rg.style.opacity = '1'; rg.style.pointerEvents = '';
  }
}

document.getElementById('btn-geotiff').addEventListener('click', () => {
  if (!state.image) return;
  if (!computeAffine()) { setStatus('Servono almeno 3 GCP per il GeoTIFF.'); return; }
  openGtiffDialog();
});

document.getElementById('btn-gtiff-close').addEventListener('click',  closeGtiffDialog);
document.getElementById('btn-gtiff-cancel').addEventListener('click', closeGtiffDialog);
gtiffDlgOv.addEventListener('click', closeGtiffDialog);
document.getElementById('gtiff-crs').addEventListener('change',      syncGtiffNote);
document.getElementById('gtiff-resample').addEventListener('change', syncGtiffNote);

document.getElementById('btn-gtiff-export').addEventListener('click', async () => {
  const epsg        = parseInt(document.getElementById('gtiff-crs').value);
  const resample    = document.getElementById('gtiff-resample').value;
  const maxRes      = parseInt(document.getElementById('gtiff-maxres').value);
  const compression = parseInt(document.getElementById('gtiff-compression').value);
  closeGtiffDialog();
  await runGeoTIFFExport(epsg, resample, maxRes, compression);
});

// ── Export pipeline ──────────────────────────────────────────────────────────
async function runGeoTIFFExport(epsg, resample, maxRes, compression) {
  const t = computeActiveTransform();
  if (!t || !state.image) { setStatus('Servono almeno ' + getMinGcps() + ' GCP per il GeoTIFF.'); return; }
  setStatus('Caricamento immagine…');

  const img = await loadImg(state.image.dataUrl);
  let srcW = img.naturalWidth, srcH = img.naturalHeight;
  let sc = 1;
  if (srcW > maxRes || srcH > maxRes) {
    sc = maxRes / Math.max(srcW, srcH);
    srcW = Math.round(srcW * sc); srcH = Math.round(srcH * sc);
  }

  const cv = Object.assign(document.createElement('canvas'), { width: srcW, height: srcH });
  cv.getContext('2d').drawImage(img, 0, 0, srcW, srcH);
  const imgData = cv.getContext('2d').getImageData(0, 0, srcW, srcH).data;

  let W_out, H_out, rgb, georef;

  // EPSG:4326 + poly1 (affine): embed scaled affine directly — no warp needed
  const isPoly1 = !t.order || t.order !== 2;
  if (epsg === 4326 && isPoly1) {
    const ts = { a: t.a/sc, b: t.b/sc, c: t.c, d: t.d/sc, e: t.e/sc, f: t.f };
    W_out = srcW; H_out = srcH;
    setStatus('Preparazione GeoTIFF WGS84…');
    rgb = new Uint8Array(W_out * H_out * 3);
    for (let i = 0; i < W_out * H_out; i++) {
      rgb[i*3]=imgData[i*4]; rgb[i*3+1]=imgData[i*4+1]; rgb[i*3+2]=imgData[i*4+2];
    }
    georef = { type: 'affine', t: ts };
  } else {
    // Warp to projected grid (also handles poly2+4326: warp to north-up WGS84)
    const r = await warpToProjected(
      imgData, srcW, srcH, t, sc, epsg, maxRes,
      resample === 'nearest' ? sampleNearest : sampleBilinear
    );
    ({ W: W_out, H: H_out, rgb } = r);
    georef = { type: 'northup', epsg,
               originX: r.originX, originY: r.originY,
               pixSizeX: r.pixSizeX, pixSizeY: r.pixSizeY };
  }

  setStatus('Scrittura file GeoTIFF…');
  const buf = await writeGeoTiffBuf(W_out, H_out, rgb, georef, compression);
  downloadBlob(
    new Blob([buf], { type: 'image/tiff' }),
    baseName(state.image.name) + `_georef_EPSG${epsg}.tif`
  );
  setStatus(`GeoTIFF EPSG:${epsg} esportato — ${W_out}×${H_out} px.`);
}

// ── Warp pixels to a north-up projected grid ─────────────────────────────────
// t   = active transform (poly1 or poly2) in original image pixel coordinates
// sc  = downscale factor (scaled_px = orig_px * sc); 1 if no downscaling was applied
async function warpToProjected(imgData, srcW, srcH, t, sc, toEPSG, maxRes, resampleFn) {
  const FROM = 'EPSG:4326', TO = 'EPSG:' + toEPSG;

  // Project 4 image corners → target CRS → output bounding box
  // srcW/sc = original image width; corners expressed in original pixel coords
  const corners = [[0,0],[srcW,0],[0,srcH],[srcW,srcH]].map(([px,py]) => {
    const g = applyTransform(t, px/sc, py/sc);
    return proj4(FROM, TO, [g.lng, g.lat]);
  });
  const minX = Math.min(...corners.map(c=>c[0]));
  const maxX = Math.max(...corners.map(c=>c[0]));
  const minY = Math.min(...corners.map(c=>c[1]));
  const maxY = Math.max(...corners.map(c=>c[1]));

  // Estimate output pixel size (preserve source resolution in target units)
  const g00 = applyTransform(t,0,0);
  const g10 = applyTransform(t,srcW/sc,0);
  const g01 = applyTransform(t,0,srcH/sc);
  const p00 = proj4(FROM,TO,[g00.lng,g00.lat]);
  const p10 = proj4(FROM,TO,[g10.lng,g10.lat]);
  const p01 = proj4(FROM,TO,[g01.lng,g01.lat]);
  const spanX = Math.hypot(p10[0]-p00[0], p10[1]-p00[1]);
  const spanY = Math.hypot(p01[0]-p00[0], p01[1]-p00[1]);
  const pixSize = Math.min(spanX/srcW, spanY/srcH);

  let W_out = Math.max(1, Math.round((maxX-minX)/pixSize));
  let H_out = Math.max(1, Math.round((maxY-minY)/pixSize));
  if (W_out > maxRes || H_out > maxRes) {
    const f = maxRes / Math.max(W_out, H_out);
    W_out = Math.round(W_out*f); H_out = Math.round(H_out*f);
  }

  const pixSizeX = (maxX-minX)/W_out;
  const pixSizeY = (maxY-minY)/H_out;
  const rgb = new Uint8Array(W_out * H_out * 3);

  // Row-by-row warp: project left and right edge of each row, then interpolate.
  // inverseTransform returns original pixel coords → multiply by sc for scaled image coords.
  for (let iy = 0; iy < H_out; iy++) {
    const dstY = maxY - (iy + 0.5) * pixSizeY;
    const wL = proj4(TO, FROM, [minX + 0.5*pixSizeX,           dstY]);
    const wR = proj4(TO, FROM, [minX + (W_out-0.5)*pixSizeX,   dstY]);
    const sLo = inverseTransform(t, wL[0], wL[1]);
    const sRo = inverseTransform(t, wR[0], wR[1]);
    if (!sLo || !sRo) continue;
    const sL = { px: sLo.px * sc, py: sLo.py * sc };
    const sR = { px: sRo.px * sc, py: sRo.py * sc };

    for (let ix = 0; ix < W_out; ix++) {
      const a  = W_out > 1 ? ix/(W_out-1) : 0;
      const px = sL.px + a*(sR.px-sL.px);
      const py = sL.py + a*(sR.py-sL.py);
      const px_val = resampleFn(imgData, srcW, srcH, px, py);
      if (!px_val) continue;
      const oi = (iy*W_out+ix)*3;
      rgb[oi]=Math.round(px_val[0]); rgb[oi+1]=Math.round(px_val[1]); rgb[oi+2]=Math.round(px_val[2]);
    }

    if (iy % 25 === 0) {
      setStatus(`Ricampionamento ${Math.round(iy/H_out*100)}%…`);
      await new Promise(r => setTimeout(r, 0)); // yield to UI
    }
  }

  return { W: W_out, H: H_out, rgb, originX: minX, originY: maxY, pixSizeX, pixSizeY };
}

// ── Write GeoTIFF using geotiff.js (with LZW) or fallback custom writer ───────
let _gtiffMod = undefined; // undefined = not tried yet, null = failed
async function loadGtiffModule() {
  if (_gtiffMod !== undefined) return _gtiffMod;
  try {
    _gtiffMod = await import('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js');
  } catch (e) { _gtiffMod = null; }
  return _gtiffMod;
}

async function writeGeoTiffBuf(W, H, rgb, georef, compression) {
  const mod = await loadGtiffModule();

  if (mod && typeof mod.writeArrayBuffer === 'function') {
    try {
      const r = new Uint8Array(W*H), g = new Uint8Array(W*H), b = new Uint8Array(W*H);
      for (let i = 0; i < W*H; i++) { r[i]=rgb[i*3]; g[i]=rgb[i*3+1]; b[i]=rgb[i*3+2]; }

      const meta = {
        height: H, width: W,
        SamplesPerPixel: 3, BitsPerSample: [8,8,8],
        PhotometricInterpretation: 2,
        Compression: compression,
        GTRasterTypeGeoKey: 1,
      };

      if (georef.type === 'affine') {
        const { t } = georef;
        Object.assign(meta, {
          ModelTransformation: [t.a,t.b,0,t.c, t.d,t.e,0,t.f, 0,0,1,0, 0,0,0,1],
          GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326, GeogAngularUnitsGeoKey: 9102,
        });
      } else {
        Object.assign(meta, {
          ModelPixelScale: [georef.pixSizeX, georef.pixSizeY, 0],
          ModelTiepoint:   [0, 0, 0, georef.originX, georef.originY, 0],
          ...(georef.epsg === 4326
            ? { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326, GeogAngularUnitsGeoKey: 9102 }
            : { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: georef.epsg }),
        });
      }

      return mod.writeArrayBuffer([r, g, b], meta);
    } catch (e) {
      console.warn('geotiff.js write error, using native writer:', e.message);
    }
  }

  // Fallback: custom writer (no LZW compression)
  if (georef.type === 'affine') return writeTiff(W, H, rgb, georef.t);
  return writeTiffNorthUp(W, H, rgb, georef.originX, georef.originY,
                          georef.pixSizeX, georef.pixSizeY, georef.epsg);
}

// ── Custom north-up GeoTIFF writer (fallback, no compression) ────────────────
function writeTiffNorthUp(W, H, rgb, originX, originY, pixSizeX, pixSizeY, epsg) {
  const isGeo = (epsg === 4326);
  const nKeys = isGeo ? 4 : 3;
  const geoKB = (nKeys + 1) * 4 * 2; // (keys+header) × 4 SHORTs × 2 B

  const N_ENTRIES = 13;
  const HDR = 8, IFD_SZ = 2 + N_ENTRIES*12 + 4;
  let off = HDR + IFD_SZ;
  const bpsOff = off; off += 6;
  const scOff  = off; off += 24;  // ModelPixelScale: 3 doubles
  const tpOff  = off; off += 48;  // ModelTiepoint: 6 doubles
  const gkOff  = off; off += geoKB;
  const pxOff  = off; off += rgb.length;

  const buf = new ArrayBuffer(off), dv = new DataView(buf), by = new Uint8Array(buf);
  dv.setUint8(0,0x49); dv.setUint8(1,0x49); dv.setUint16(2,42,true); dv.setUint32(4,HDR,true);

  let p = HDR;
  dv.setUint16(p, N_ENTRIES, true); p += 2;
  function entry(tag, type, count, val) {
    dv.setUint16(p,tag,true); p+=2; dv.setUint16(p,type,true); p+=2;
    dv.setUint32(p,count,true); p+=4; dv.setUint32(p,val,true); p+=4;
  }
  entry(256,3,1,W);  entry(257,3,1,H);   entry(258,3,3,bpsOff);
  entry(259,3,1,1);  entry(262,3,1,2);   entry(273,4,1,pxOff);
  entry(277,3,1,3);  entry(278,4,1,H);   entry(279,4,1,rgb.length);
  entry(284,3,1,1);
  entry(33550,12,3,scOff);              // ModelPixelScaleTag
  entry(33922,12,6,tpOff);             // ModelTiepointTag
  entry(34735,3,(nKeys+1)*4,gkOff);    // GeoKeyDirectoryTag
  dv.setUint32(p,0,true);

  dv.setUint16(bpsOff,8,true); dv.setUint16(bpsOff+2,8,true); dv.setUint16(bpsOff+4,8,true);
  [pixSizeX,pixSizeY,0].forEach((v,i) => dv.setFloat64(scOff+i*8,v,true));
  [0,0,0,originX,originY,0].forEach((v,i) => dv.setFloat64(tpOff+i*8,v,true));

  const gk = isGeo
    ? [1,1,0,4, 1024,0,1,2, 1025,0,1,1, 2048,0,1,4326, 2054,0,1,9102]
    : [1,1,0,3, 1024,0,1,1, 1025,0,1,1, 3072,0,1,epsg];
  gk.forEach((v,i) => dv.setUint16(gkOff+i*2,v,true));

  by.set(rgb, pxOff);
  return buf;
}

/**
 * Write a minimal uncompressed GeoTIFF (little-endian, RGB, WGS84).
 * Uses ModelTransformationTag (33920) for full affine support (handles rotation).
 * transform: lon = a·px + b·py + c  /  lat = d·px + e·py + f
 */
function writeTiff(W, H, rgb, t) {
  // ── Data layout ──────────────────────────────────────────────────────────
  //   BitsPerSample [8,8,8]        : 3 × SHORT  =  6 B
  //   ModelTransformationTag       : 16 × DOUBLE = 128 B
  //   GeoKeyDirectory (4 keys)     : (4+1)×4 × SHORT = 20 SHORTs = 40 B
  //   pixel strip                  : W×H×3 B

  // N_ENTRIES = 12  (no GeoDoubleParamsTag — unused)
  const N_ENTRIES = 12;
  const HDR    = 8;
  const IFD_SZ = 2 + N_ENTRIES * 12 + 4;
  let off = HDR + IFD_SZ;

  const bpsOff    = off; off += 6;
  const transOff  = off; off += 128;
  const geoKeyOff = off; off += 40;   // 20 SHORTs × 2 B = 40 B  ← was 16 (bug)
  const pixOff    = off; off += rgb.length;

  const buf   = new ArrayBuffer(off);
  const dv    = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // ── TIFF header ──────────────────────────────────────────────────────────
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); // 'II' little-endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, HDR, true);                  // IFD offset = 8

  // ── IFD ──────────────────────────────────────────────────────────────────
  let p = HDR;
  dv.setUint16(p, N_ENTRIES, true); p += 2;

  function entry(tag, type, count, val) {
    dv.setUint16(p, tag,   true); p += 2;
    dv.setUint16(p, type,  true); p += 2;
    dv.setUint32(p, count, true); p += 4;
    dv.setUint32(p, val,   true); p += 4;
  }
  // SHORT=3, LONG=4, DOUBLE=12  — entries must be sorted by tag number
  entry(256,   3,  1,  W);            // ImageWidth
  entry(257,   3,  1,  H);            // ImageLength
  entry(258,   3,  3,  bpsOff);       // BitsPerSample [8,8,8]
  entry(259,   3,  1,  1);            // Compression = none
  entry(262,   3,  1,  2);            // PhotometricInterpretation = RGB
  entry(273,   4,  1,  pixOff);       // StripOffsets
  entry(277,   3,  1,  3);            // SamplesPerPixel
  entry(278,   4,  1,  H);            // RowsPerStrip = full image
  entry(279,   4,  1,  rgb.length);   // StripByteCounts
  entry(284,   3,  1,  1);            // PlanarConfiguration = chunky (RGB RGB…)
  entry(34264, 12, 16, transOff);     // ModelTransformationTag (16 doubles) — tag 0x85D8
  entry(34735, 3,  20, geoKeyOff);    // GeoKeyDirectoryTag: 20 SHORTs ← was 8 (bug)
  dv.setUint32(p, 0, true);           // next IFD = 0

  // ── BitsPerSample ────────────────────────────────────────────────────────
  dv.setUint16(bpsOff,     8, true);
  dv.setUint16(bpsOff + 2, 8, true);
  dv.setUint16(bpsOff + 4, 8, true);

  // ── ModelTransformationTag — 4×4 affine (row-major, pixel→geo) ───────────
  // [ lon ]   [ a  b  0  c ] [ px ]
  // [ lat ] = [ d  e  0  f ] [ py ]
  // [  z  ]   [ 0  0  1  0 ] [  0 ]
  // [  1  ]   [ 0  0  0  1 ] [  1 ]
  const mx = [t.a, t.b, 0, t.c,  t.d, t.e, 0, t.f,  0, 0, 1, 0,  0, 0, 0, 1];
  mx.forEach((v, i) => dv.setFloat64(transOff + i * 8, v, true));

  // ── GeoKeyDirectoryTag ───────────────────────────────────────────────────
  // Header: [KeyDirVersion, KeyRevision, MinorRevision, NumberOfKeys]
  // Each key: [KeyID, TIFFTagLoc(0=direct), Count, Value]
  const gk = [
    1, 1, 0, 4,           // header: 4 keys
    1024, 0, 1, 2,        // GTModelTypeGeoKey       = 2 (Geographic)
    1025, 0, 1, 1,        // GTRasterTypeGeoKey      = 1 (RasterPixelIsArea)
    2048, 0, 1, 4326,     // GeographicTypeGeoKey    = 4326 (WGS84)
    2054, 0, 1, 9102,     // GeogAngularUnitsGeoKey  = 9102 (degree)
  ];
  gk.forEach((v, i) => dv.setUint16(geoKeyOff + i * 2, v, true));

  // ── Pixel data ───────────────────────────────────────────────────────────
  bytes.set(rgb, pixOff);

  return buf;
}

/* ═══════════════════════════════════════════════════════════════════════════
   QGIS GCP EXPORT (.points)
   ═══════════════════════════════════════════════════════════════════════════ */
document.getElementById('btn-qgis').addEventListener('click', () => {
  let csv = 'mapX,mapY,sourceX,sourceY,enable\n';
  state.gcps.forEach(g => { csv += `${g.lng},${g.lat},${g.px},${-g.py},1\n`; });
  downloadBlob(new Blob([csv], { type: 'text/plain' }), 'gcp_qgis.points');
  setStatus('File GCP per QGIS Georeferencer esportato.');
});

/* ═══════════════════════════════════════════════════════════════════════════
   PROJECT SAVE / LOAD (JSON + localStorage)
   ═══════════════════════════════════════════════════════════════════════════ */
document.getElementById('btn-save-json').addEventListener('click', () => {
  const d = getProjectData();
  if (!d) { setStatus('Nessun progetto da esportare.'); return; }
  downloadBlob(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }),
    'geoimage_progetto.json');
  setStatus('Progetto esportato.');
});

document.getElementById('btn-load-json').addEventListener('click', () =>
  document.getElementById('json-input').click());

document.getElementById('json-input').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try { restoreProject(JSON.parse(ev.target.result)); }
    catch (err) { setStatus('Errore nel file JSON: ' + err.message); }
  };
  reader.readAsText(f);
  e.target.value = '';
});

function getProjectData() {
  if (!state.overlay || !state.image) return null;
  const corners = getOverlayCorners();
  return {
    version      : 1,
    imageName    : state.image.name,
    imageWidth   : state.image.width,
    imageHeight  : state.image.height,
    imageDataUrl : state.image.dataUrl,
    overlayCorners: corners.map(c => [c.lat, c.lng]),
    opacity      : parseInt(opacitySlider.value) / 100,
    gcps         : state.gcps.map(g => ({ px: g.px, py: g.py, lat: g.lat, lng: g.lng })),
  };
}

function saveToLocalStorage() {
  try {
    const d = getProjectData();
    if (d) localStorage.setItem('geoimage_project', JSON.stringify(d));
  } catch (_) { /* QuotaExceededError — silently skip */ }
}

function restoreProject(data) {
  if (!data || !data.imageDataUrl) { setStatus('File JSON non valido.'); return; }

  state.image = {
    dataUrl : data.imageDataUrl,
    width   : data.imageWidth  || 0,
    height  : data.imageHeight || 0,
    name    : data.imageName   || 'immagine',
  };

  if (state.overlay) { map.removeLayer(state.overlay); state.overlay = null; }
  clearGcps();

  dropZone.classList.add('has-image');
  dropZone.innerHTML =
    `<div class="drop-icon"><i class="fa-solid fa-circle-check" style="color:#16a34a"></i></div><div>${state.image.name}</div>
     <div class="drop-sub">${state.image.width}×${state.image.height} px</div>`;
  document.getElementById('btn-remove-img').style.display = 'block';

  const corners = (data.overlayCorners || []).map(c => L.latLng(c[0], c[1]));
  state.originalCorners = corners.map(c => L.latLng(c.lat, c.lng));
  const opacity = data.opacity ?? 0.7;

  try {
    if (typeof L.distortableImageOverlay !== 'function') throw new Error('not loaded');
    state.overlay     = L.distortableImageOverlay(data.imageDataUrl, { corners, opacity });
    state.overlayType = 'distortable';
    state.overlay.addTo(map);
    state.overlay.on('add', () => { try { state.overlay.editing.enable(); } catch (_) {} });
  } catch (_) {
    state.overlayType = 'simple';
    const b = L.latLngBounds(
      [corners[2].lat, corners[0].lng],
      [corners[0].lat, corners[1].lng]
    );
    state.overlay = L.imageOverlay(data.imageDataUrl, b, { opacity, interactive: true });
    state.overlay.addTo(map);
  }

  const pct = Math.round(opacity * 100);
  opacitySlider.value = pct;
  opacityValEl.textContent = pct + '%';

  (data.gcps || []).forEach(g => addGcp(g.lat, g.lng, g.px, g.py));

  if (corners.length >= 2) map.fitBounds(L.latLngBounds(corners), { padding: [40, 40] });
  overlayHandleMode = 'scale';
  clearHistory();
  setTimeout(() => { showEditHandles(); attachOverlayClickToggle(); pushHistory(); }, 150);
  showPosPanel(true);
  updateExportButtons();
  setStatus('Progetto caricato da file JSON.');
}

/* Auto-restore from localStorage */
try {
  const saved = localStorage.getItem('geoimage_project');
  if (saved) restoreProject(JSON.parse(saved));
} catch (_) {}

/* ═══════════════════════════════════════════════════════════════════════════
   SPOTLIGHT  — CSS clip-path on overlayPane reveals the historical image
   ═══════════════════════════════════════════════════════════════════════════ */
const compareCursorEl  = document.getElementById('compare-cursor');
const btnCompare       = document.getElementById('btn-compare');
const compareSizeSlider= document.getElementById('compare-size');
const compareSizeVal   = document.getElementById('compare-size-val');

let spotlightActive = false;
let spotlightRadius = 125; // px

// ── SVG clip-path with a "hole" (rectangle - circle, evenodd rule) ──────────
const _svgNS = 'http://www.w3.org/2000/svg';
const _svgEl = document.createElementNS(_svgNS, 'svg');
_svgEl.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
_svgEl.innerHTML =
  `<defs><clipPath id="sp-hole" clipPathUnits="userSpaceOnUse">` +
  `<path fill-rule="evenodd" id="sp-path" d=""/></clipPath></defs>`;
document.body.appendChild(_svgEl);
const _spPath = document.getElementById('sp-path');

function _setHolePath(x, y, r) {
  const R = r * 2;
  _spPath.setAttribute('d',
    `M-99999,-99999 H99999 V99999 H-99999 Z ` +           // full plane
    `M${x},${y} m${-r},0 a${r},${r} 0 1,0 ${R},0 a${r},${r} 0 1,0 ${-R},0`); // circle hole
}

function setSpotlightActive(active) {
  spotlightActive = active;
  const pane = map.getPane('overlayPane');

  if (active) {
    if (!state.overlay) {
      setStatus('Carica prima un\'immagine per usare lo spotlight.');
      spotlightActive = false; return;
    }
    map.on('mousemove', onSpotlightMove);
    map.getContainer().addEventListener('mouseleave', onSpotlightLeave);
    map.getContainer().addEventListener('mouseenter', onSpotlightEnter);
    if (pane) pane.style.clipPath = 'url(#sp-hole)';
    compareCursorEl.style.display = 'block';
    compareCursorEl.style.width   = (spotlightRadius * 2) + 'px';
    compareCursorEl.style.height  = (spotlightRadius * 2) + 'px';
    btnCompare.classList.add('active');
    btnCompare.innerHTML = '<i class="fa-solid fa-circle-half-stroke"></i> Disattiva spotlight';
    setStatus('Spotlight: muovi il mouse per vedere la cartografia di base sotto l\'immagine.');
  } else {
    map.off('mousemove', onSpotlightMove);
    map.getContainer().removeEventListener('mouseleave', onSpotlightLeave);
    map.getContainer().removeEventListener('mouseenter', onSpotlightEnter);
    if (pane) pane.style.clipPath = '';
    _setHolePath(-99999, -99999, 1); // reset path
    compareCursorEl.style.display = 'none';
    btnCompare.classList.remove('active');
    btnCompare.innerHTML = '<i class="fa-solid fa-circle-half-stroke"></i> Attiva spotlight';
    setStatus('Spotlight disattivato.');
  }
}

function onSpotlightMove(e) {
  const pane = map.getPane('overlayPane');
  if (!pane) return;
  const pr = pane.getBoundingClientRect();
  applySpotlightClip(
    e.originalEvent.clientX - pr.left,
    e.originalEvent.clientY - pr.top
  );
  compareCursorEl.style.left = e.containerPoint.x + 'px';
  compareCursorEl.style.top  = e.containerPoint.y + 'px';
}

function onSpotlightLeave() {
  _setHolePath(-99999, -99999, spotlightRadius); // move hole off-screen
  compareCursorEl.style.display = 'none';
}

function onSpotlightEnter() {
  compareCursorEl.style.display = 'block';
}

let spotlightInverted = false; // false = buco nell'immagine (default), true = immagine nel cerchio

function applySpotlightClip(x, y) {
  const pane = map.getPane('overlayPane');
  if (!pane) return;
  if (spotlightInverted) {
    // Immagine visibile SOLO nel cerchio
    pane.style.clipPath = `circle(${spotlightRadius}px at ${x}px ${y}px)`;
    _setHolePath(-99999, -99999, 1); // reset SVG hole (non usata in questa modalità)
  } else {
    // Buco nell'immagine — basemap visibile nel cerchio
    pane.style.clipPath = 'url(#sp-hole)';
    _setHolePath(x, y, spotlightRadius);
  }
}

btnCompare.addEventListener('click', () => setSpotlightActive(!spotlightActive));

document.getElementById('btn-compare-invert').addEventListener('click', () => {
  spotlightInverted = !spotlightInverted;
  const btn = document.getElementById('btn-compare-invert');
  btn.classList.toggle('active', spotlightInverted);
  btn.title = spotlightInverted
    ? 'Modalita\': immagine nel cerchio — clicca per invertire'
    : 'Modalita\': basemap nel cerchio — clicca per invertire';
  // Se spotlight attivo, aggiorna subito il clip
  if (spotlightActive) {
    const pane = map.getPane('overlayPane');
    if (pane) pane.style.clipPath = spotlightInverted ? '' : 'url(#sp-hole)';
  }
});

compareSizeSlider.addEventListener('input', () => {
  spotlightRadius = Math.round(parseInt(compareSizeSlider.value) / 2);
  compareSizeVal.textContent = spotlightRadius * 2;
  compareCursorEl.style.width  = (spotlightRadius * 2) + 'px';
  compareCursorEl.style.height = (spotlightRadius * 2) + 'px';
});

/* ═══════════════════════════════════════════════════════════════════════════
   GEOCODING  (Nominatim / OpenStreetMap — no API key required)
   ═══════════════════════════════════════════════════════════════════════════ */
const geocodeInput   = document.getElementById('geocode-input');
const geocodeResults = document.getElementById('geocode-results');

async function doGeocode() {
  const q = geocodeInput.value.trim();
  if (!q) return;
  geocodeResults.innerHTML = '<div class="geo-none">Ricerca in corso…</div>';
  setStatus('Ricerca: ' + q);
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}`
              + `&format=json&limit=5&addressdetails=0`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'it,en' } });
    const data = await res.json();
    renderGeocodeResults(data);
  } catch (err) {
    geocodeResults.innerHTML = '<div class="geo-none">Errore di rete. Riprova.</div>';
    setStatus('Errore geocoding: ' + err.message);
  }
}

function renderGeocodeResults(data) {
  if (!data.length) {
    geocodeResults.innerHTML = '<div class="geo-none">Nessun risultato trovato.</div>';
    return;
  }
  geocodeResults.innerHTML = data.map(r => {
    // Split display_name: first part = place name, rest = breadcrumb
    const parts = r.display_name.split(',');
    const name  = parts.slice(0, 2).join(',').trim();
    const crumb = parts.slice(2, 4).join(',').trim();
    return `<div class="geo-result"
              data-lat="${r.lat}" data-lon="${r.lon}"
              data-bb="${r.boundingbox.join(',')}">
              <b>${name}</b>${crumb ? '<br><span style="opacity:.7">' + crumb + '</span>' : ''}
            </div>`;
  }).join('');

  geocodeResults.querySelectorAll('.geo-result').forEach(el => {
    el.addEventListener('click', () => {
      const bb  = el.dataset.bb.split(',').map(Number); // [south,north,west,east]
      map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 15, animate: true });
      geocodeInput.value = el.querySelector('b').textContent;
      geocodeResults.innerHTML = '';
      setStatus('Mappa centrata. Carica ora l\'immagine storica.');
    });
  });
}

// Trigger on button click or Enter key
document.getElementById('geocode-btn').addEventListener('click', doGeocode);
geocodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doGeocode(); });

// Close results if clicking elsewhere
document.addEventListener('click', e => {
  if (!e.target.closest('#geocode-input') && !e.target.closest('#geocode-results'))
    geocodeResults.innerHTML = '';
});

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function setStatus(msg) {
  document.getElementById('status-msg').textContent = msg;
}

function baseName(filename) {
  return (filename || 'mappa').replace(/\.[^/.]+$/, '');
}

function loadImg(src) {
  return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = src; });
}

/* ═══════════════════════════════════════════════════════════════════════════
   ALIGN OVERLAY TO GCPs
   ═══════════════════════════════════════════════════════════════════════════ */
document.getElementById('btn-apply-gcp').addEventListener('click', () => {
  const t = computeActiveTransform();
  if (!t || !state.image) return;

  const W = state.image.width, H = state.image.height;

  const newCorners = [[0,0],[W,0],[0,H],[W,H]].map(([px,py]) => {
    const g = applyTransform(t, px, py);
    return L.latLng(g.lat, g.lng);
  });
  // corners order: NW, NE, SW, SE

  hideEditHandles();
  setOverlayCorners(newCorners);
  map.fitBounds(L.latLngBounds(newCorners), { padding: [40, 40], maxZoom: 16 });
  setTimeout(() => { showEditHandles(); pushHistory(); }, 100);
  saveToLocalStorage();
  setStatus('Immagine allineata alle coordinate dei GCP.');
});

/* ═══════════════════════════════════════════════════════════════════════════
   RESET OVERLAY
   ═══════════════════════════════════════════════════════════════════════════ */
document.getElementById('btn-reset-overlay').addEventListener('click', () => {
  if (!state.overlay || !state.originalCorners) return;
  const orig = state.originalCorners.map(c => L.latLng(c.lat, c.lng));
  hideEditHandles();
  setOverlayCorners(orig);
  map.fitBounds(L.latLngBounds(orig), { padding: [30, 30], maxZoom: 16 });
  setTimeout(() => { showEditHandles(); pushHistory(); }, 100);
  saveToLocalStorage();
  setStatus('Overlay riportato alla posizione originale.');
});

/* ═══════════════════════════════════════════════════════════════════════════
   INFO MODAL
   ═══════════════════════════════════════════════════════════════════════════ */
const infoModal   = document.getElementById('info-modal');
const infoOverlay = document.getElementById('info-overlay');

function openInfo() {
  infoOverlay.classList.add('open');
  infoModal.offsetHeight;
  infoModal.classList.add('open');
  infoModal.removeAttribute('aria-hidden');
  document.getElementById('btn-info-close').focus();
}

function closeInfo() {
  infoModal.classList.remove('open');
  infoOverlay.classList.remove('open');
  infoModal.setAttribute('aria-hidden', 'true');
}

document.getElementById('btn-info').addEventListener('click', openInfo);
document.getElementById('btn-info-close').addEventListener('click', closeInfo);
infoOverlay.addEventListener('click', closeInfo);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && infoModal.classList.contains('open')) closeInfo();
});

/* ═══════════════════════════════════════════════════════════════════════════
   GUIDE MODAL
   ═══════════════════════════════════════════════════════════════════════════ */
const guideModal   = document.getElementById('guide-modal');
const guideOverlay = document.getElementById('guide-overlay');

function openGuide() {
  guideOverlay.classList.add('open');
  // Trigger reflow so the CSS transition plays from translateY(100%)
  guideModal.offsetHeight;
  guideModal.classList.add('open');
  guideModal.removeAttribute('aria-hidden');
  document.getElementById('btn-guide-close').focus();
}

function closeGuide() {
  guideModal.classList.remove('open');
  guideOverlay.classList.remove('open');
  guideModal.setAttribute('aria-hidden', 'true');
}

document.getElementById('btn-help').addEventListener('click', openGuide);
document.getElementById('btn-guide-close').addEventListener('click', closeGuide);
guideOverlay.addEventListener('click', closeGuide);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && guideModal.classList.contains('open')) closeGuide();
});

/* ═══════════════════════════════════════════════════════════════════════════
   SIDEBAR RESIZE
   ═══════════════════════════════════════════════════════════════════════════ */
(function() {
  const resizer  = document.getElementById('sidebar-resizer');
  const sidebar  = document.getElementById('sidebar');
  const MIN_W    = parseInt(getComputedStyle(sidebar).minWidth) || 210;
  const MAX_W    = parseInt(getComputedStyle(sidebar).maxWidth) || 520;
  let dragging   = false;
  let startX     = 0;
  let startWidth = 0;

  resizer.addEventListener('mousedown', e => {
    dragging   = true;
    startX     = e.clientX;
    startWidth = sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor    = 'ew-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    // Moving left = wider sidebar (sidebar is on the right)
    const delta = startX - e.clientX;
    const newW  = Math.max(MIN_W, Math.min(MAX_W, startWidth + delta));
    sidebar.style.width = newW + 'px';
    map.invalidateSize();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });
})();

/* ═══════════════════════════════════════════════════════════════════════════
   COLLAPSIBLE POSITIONING PANEL
   ═══════════════════════════════════════════════════════════════════════════ */
document.getElementById('btn-pos-toggle').addEventListener('click', () => {
  const body   = document.getElementById('pos-panel-body');
  const toggle = document.getElementById('btn-pos-toggle');
  const open   = !body.classList.contains('collapsed');
  body.classList.toggle('collapsed', open);
  toggle.classList.toggle('collapsed', open);
});

/* ═══════════════════════════════════════════════════════════════════════════
   TRANSFORM TYPE CHANGE
   ═══════════════════════════════════════════════════════════════════════════ */
document.getElementById('transform-type').addEventListener('change', () => {
  updateGcpTable(); updateRmse(); updateExportButtons();
});

/* ═══════════════════════════════════════════════════════════════════════════
   GCP DRAG ON CANVAS PREVIEW
   ═══════════════════════════════════════════════════════════════════════════ */
(function() {
  let draggingGcpIdx = null;
  const canvas = document.getElementById('gcp-preview-canvas');

  canvas.addEventListener('mousedown', e => {
    if (state.mode !== 'gcp' || !state.image || pendingGcp !== null) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top)  * scaleY;
    const threshold = 18 * Math.max(scaleX, scaleY);
    let best = -1, bestD = Infinity;
    state.gcps.forEach((g, i) => {
      const d = Math.hypot(g.px - px, g.py - py);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best !== -1 && bestD <= threshold) {
      draggingGcpIdx = best;
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (draggingGcpIdx === null) return;
    const rect = canvas.getBoundingClientRect();
    const g = state.gcps[draggingGcpIdx];
    g.px = Math.max(0, Math.min(state.image.width  - 1, Math.round((e.clientX - rect.left) * (canvas.width  / rect.width))));
    g.py = Math.max(0, Math.min(state.image.height - 1, Math.round((e.clientY - rect.top)  * (canvas.height / rect.height))));
    drawPreviewCanvas();
  });

  function endDrag() {
    if (draggingGcpIdx === null) return;
    draggingGcpIdx = null;
    canvas.style.cursor = '';
    updateGcpTable(); updateRmse(); saveToLocalStorage();
  }
  canvas.addEventListener('mouseup',    endDrag);
  canvas.addEventListener('mouseleave', endDrag);
})();

/* ═══════════════════════════════════════════════════════════════════════════
   LOCK OVERLAY
   ═══════════════════════════════════════════════════════════════════════════ */
function toggleLock() {
  if (!state.overlay) return;
  state.overlayLocked = !state.overlayLocked;
  const btn = document.getElementById('btn-lock-overlay');
  if (state.overlayLocked) {
    btn.classList.add('active');
    btn.innerHTML = '<i class="fa-solid fa-lock"></i> Sblocca (L)';
    hideEditHandles();
    setStatus('Overlay bloccato — le maniglie di posizionamento sono nascoste.');
  } else {
    btn.classList.remove('active');
    btn.innerHTML = '<i class="fa-solid fa-lock-open"></i> Blocca (L)';
    showEditHandles();
    setStatus('Overlay sbloccato.');
  }
}

document.getElementById('btn-lock-overlay').addEventListener('click', toggleLock);
document.addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key === 'l' || e.key === 'L') toggleLock();
});

/* ═══════════════════════════════════════════════════════════════════════════
   SWIPE SLIDER  — clip overlayPane to left portion of map
   ═══════════════════════════════════════════════════════════════════════════ */
let swipeActive = false;
let swipePct    = 50; // percentage of map width from left

// ── Compute and apply the correct pixel clip to the overlayPane ───────────────
// The overlayPane has a 0×0 computed size (its <img> child uses position:absolute
// + CSS transforms, so it doesn't contribute to the parent box).  CSS inset()
// collapses to an empty region on a 0-width element, hiding everything.
// We use polygon() with large ±99999px coordinates instead: those extend deep
// into the pane's overflow area where the image actually renders, so the clip
// works regardless of the pane's layout size.
// map._getMapPanePos() gives the current pan offset without a DOM layout flush,
// which is more reliable than getBoundingClientRect() during CSS transitions.
function updateSwipeClip() {
  if (!swipeActive) return;
  const pane = map.getPane('overlayPane');
  if (!pane) return;
  const mapSize = map.getSize();            // {x: containerWidth, y: containerHeight}
  const panPos  = map._getMapPanePos();     // {x: translateX, y: translateY} of mapPane
  // Divider x-position in the pane's local coordinate system
  const divLocal = Math.round((swipePct / 100) * mapSize.x - panPos.x);
  // Polygon that covers the entire left side up to the divider (including overflow)
  pane.style.clipPath =
    `polygon(-99999px -99999px,${divLocal}px -99999px,${divLocal}px 99999px,-99999px 99999px)`;
}

// Keep clip in sync while panning / zooming
map.on('move zoom moveend zoomend', updateSwipeClip);

function setSwipeActive(active) {
  swipeActive = active;
  const divider = document.getElementById('swipe-divider');
  const pane    = map.getPane('overlayPane');
  const btn     = document.getElementById('btn-swipe');

  if (active) {
    if (!state.overlay) {
      setStatus('Carica prima un\'immagine per usare lo swipe.');
      swipeActive = false; return;
    }
    if (spotlightActive) setSpotlightActive(false);
    divider.style.display = 'block';
    divider.style.left    = swipePct + '%';
    updateSwipeClip();
    btn.classList.add('active');
    setStatus('Swipe: trascina la linea per confrontare.');
  } else {
    divider.style.display = 'none';
    if (pane) pane.style.clipPath = '';
    btn.classList.remove('active');
    setStatus('Swipe disattivato.');
  }
}

document.getElementById('btn-swipe').addEventListener('click', () => setSwipeActive(!swipeActive));

// ── Drag the divider ─────────────────────────────────────────────────────────
(function() {
  const divider = document.getElementById('swipe-divider');
  let dragging = false;

  function startDrag(e) {
    dragging = true;
    e.preventDefault();
    e.stopPropagation(); // impedisce a Leaflet di avviare il pan della mappa
    map.dragging.disable();
  }

  function onDragMove(clientX) {
    if (!dragging || !swipeActive) return;
    const mapRect = map.getContainer().getBoundingClientRect();
    swipePct = Math.max(2, Math.min(98, (clientX - mapRect.left) / mapRect.width * 100));
    divider.style.left = swipePct + '%';
    updateSwipeClip();
  }

  function endDrag() {
    if (dragging) {
      dragging = false;
      map.dragging.enable();
    }
  }

  divider.addEventListener('mousedown', startDrag);
  document.addEventListener('mousemove', e => onDragMove(e.clientX));
  document.addEventListener('mouseup', endDrag);

  // Touch support
  divider.addEventListener('touchstart', e => { startDrag(e.touches[0] || e); }, { passive: false });
  document.addEventListener('touchmove',  e => { if (dragging) { e.preventDefault(); onDragMove(e.touches[0].clientX); } }, { passive: false });
  document.addEventListener('touchend', endDrag);
})();

/* ═══════════════════════════════════════════════════════════════════════════
   WORLD FILE EXPORT  (.wld — 6-line affine, pixel center convention)
   lon = A*col + B*row + C   (col,row are 0-based pixel center coords)
   lat = D*col + E*row + F
   Our affine: lon = a*px + b*py + c  /  lat = d*px + e*py + f
   ═══════════════════════════════════════════════════════════════════════════ */
document.getElementById('btn-worldfile').addEventListener('click', () => {
  if (!state.image) return;
  const t = computeAffine();
  if (!t) { setStatus('Servono almeno 3 GCP per il world file.'); return; }
  const lines = [
    t.a.toFixed(10),   // pixel size in x (degrees per pixel, eastward)
    t.d.toFixed(10),   // rotation about x axis
    t.b.toFixed(10),   // rotation about y axis
    t.e.toFixed(10),   // pixel size in y (degrees per pixel, southward — negative)
    t.c.toFixed(10),   // longitude of upper-left pixel center (px=0, py=0)
    t.f.toFixed(10),   // latitude of upper-left pixel center (px=0, py=0)
  ].join('\n');
  const ext = state.image.name.split('.').pop().toLowerCase();
  const wldExt = { jpg: 'jgw', jpeg: 'jgw', png: 'pgw', tif: 'tfw', tiff: 'tfw' }[ext] || 'wld';
  downloadBlob(new Blob([lines], { type: 'text/plain' }), baseName(state.image.name) + '.' + wldExt);
  setStatus('World file esportato (' + wldExt + ').');
});

/* ═══════════════════════════════════════════════════════════════════════════
   GCP GEOJSON EXPORT
   ═══════════════════════════════════════════════════════════════════════════ */
document.getElementById('btn-geojson').addEventListener('click', () => {
  if (!state.gcps.length) return;
  const fc = {
    type: 'FeatureCollection',
    features: state.gcps.map((g, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
      properties: { id: i + 1, px: g.px, py: g.py, lat: g.lat, lng: g.lng },
    })),
  };
  downloadBlob(
    new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' }),
    baseName(state.image?.name || 'mappa') + '_gcp.geojson'
  );
  setStatus('GeoJSON GCP esportato (' + state.gcps.length + ' punti).');
});

/* ═══════════════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════════════ */
setModePan();
