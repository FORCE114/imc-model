import { createExcavation, createMapWithOpening } from './excavation.js';
let excavationRoot=null, excavationBounds=null, mapSurface=null, mapOpening=null;
import { createFacadeFinish } from './imc-facade-finish.js?v=windows-3';
import { createTowerCranes } from './imc-tower-cranes.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const $ = id => document.getElementById(id);
// Leaf disciplines (one GLB each), listed in panel order.
const definitions = [
  ['STR', 'إنشائي', '#4b7895'],
  ['ARCH', 'معماري', '#bc9460'],
  ['HV', 'تكييف', '#3a9298'],
  ['PL', 'صحي', '#57815e'],
  ['ELEC', 'كهرباء', '#d4a42d'],
  ['TELECOM', 'اتصالات', '#8c6bac']
];
// Panel groups: a single-member group is shown as one row; others get a parent row.
const groupDefinitions = [
  { id: 'G-STR', name: 'إنشائي', members: ['STR'] },
  { id: 'G-ARCH', name: 'معماري', members: ['ARCH'] },
  { id: 'G-MECH', name: 'ميكانيكا', members: ['HV', 'PL'] },
  { id: 'G-ELEC', name: 'كهرباء', members: ['ELEC', 'TELECOM'] }
];
const disciplines = definitions.map(([id, name, colour]) => ({ id, name, colour, selected: false, status: 'idle', metadata: null, root: null, bounds: null, actualTriangles: null, error: null, phase: '', levelObjects: [] }));
const byId = new Map(disciplines.map(item => [item.id, item]));
const groupOf = new Map(groupDefinitions.flatMap(group => group.members.map(id => [id, group])));
// Unified floors across disciplines: key -> { key, name, elevation, visible, perDiscipline: Map(id -> count) }.
const FLOOR_MERGE_METRES = 0.3;
const NO_FLOOR = 'none';
let floors = [];
const floorKeyByLevel = new Map(); // `${discipline}|${levelName}` -> floor key
const number = new Intl.NumberFormat('ar-SA');
const metres = new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 1 });
const queue = [];
let renderer, scene, camera, controls, grid, current = null, pumping = false;
let requestPending = false, fittedOnce = false, fatal = false, disposed = false;
let sectionBounds = null, manifestAvailable = false, initialBatchFitPending = true;
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const errors = [];
let facadeFinish = null;
let towerCranes = null;
let hospitalRoot = null, hospitalBounds = null, hospitalState = 'loading', hospitalTriangles = 0;
let siteMap = null, siteMapState = 'loading', siteOverviewBounds = null;
const sitePlacement = { centre: [30.03, -0.12, 10.36], rotationY: Math.atan2(93.54149094388504, 61.0807227184105), scale: 1, method: 'visual-footprint-alignment' };


function count(value) { return Number.isFinite(value) && value >= 0 ? number.format(value) : '—'; }
function getElementCount(item) { return item.metadata?.elementCount ?? null; }
function getTriangleCount(item) { return item.actualTriangles ?? item.metadata?.triangleCount ?? null; }
function visibleItems() { return disciplines.filter(item => item.root && item.selected); }
function nextFrame() { return new Promise(resolve => requestAnimationFrame(resolve)); }

function buildRows() {
  for (const group of groupDefinitions) {
    if (group.members.length > 1) {
      const parent = document.createElement('div');
      parent.className = 'group-row';
      parent.innerHTML = '<label class="group-label" for="toggle-' + group.id + '"><input type="checkbox" id="toggle-' + group.id + '"><span class="group-name">' + group.name + '</span><small id="stats-' + group.id + '"></small></label>';
      $('disciplines').appendChild(parent);
      group.checkbox = $('toggle-' + group.id);
      group.checkbox.addEventListener('change', () => {
        for (const id of group.members) setSelected(id, group.checkbox.checked);
      });
    }
    for (const id of group.members) buildLeafRow(byId.get(id), group);
  }
}

function buildLeafRow(item, group) {
  {
    const row = document.createElement('div');
    row.className = 'discipline-row' + (group.members.length > 1 ? ' child' : '');
    row.dataset.discipline = item.id;
    row.style.setProperty('--discipline-colour', item.colour);
    // Definitions are local constants; model names and error strings use textContent.
    row.innerHTML = '<label class="discipline-label" for="toggle-' + item.id + '"><input type="checkbox" id="toggle-' + item.id + '" aria-describedby="stats-' + item.id + ' status-' + item.id + '"><span class="discipline-copy"><span class="discipline-name"><span class="discipline-dot" aria-hidden="true"></span><span>' + item.name + '</span><small class="discipline-stats" id="stats-' + item.id + '"></small></span></span></label><div class="row-status"><span id="status-' + item.id + '"></span><button class="retry-button" id="retry-' + item.id + '" aria-label="إعادة تحميل تخصص ' + item.name + '" hidden>إعادة المحاولة</button></div><progress class="load-progress" aria-label="تحميل تخصص ' + item.name + '" hidden></progress><p class="export-warning" hidden></p>';
    $('disciplines').appendChild(row);
    item.row = row;
    item.checkbox = $('toggle-' + item.id);
    item.checkbox.addEventListener('change', () => setSelected(item.id, item.checkbox.checked));
    $('retry-' + item.id).addEventListener('click', () => void retry(item.id));
    updateRow(item);
  }
}

function updateGroupRow(group) {
  if (!group?.checkbox) return;
  const members = group.members.map(id => byId.get(id));
  const selected = members.filter(item => item.selected).length;
  group.checkbox.checked = selected === members.length;
  group.checkbox.indeterminate = selected > 0 && selected < members.length;
  group.checkbox.disabled = fatal;
  const counts = members.map(getElementCount);
  $('stats-' + group.id).textContent = counts.every(value => value !== null) ? count(counts.reduce((a, b) => a + b, 0)) : '—';
}

function updateRow(item) {
  $('stats-' + item.id).textContent = count(getElementCount(item)) + ' عنصر';
  updateGroupRow(groupOf.get(item.id));
  item.checkbox.checked = item.selected;
  item.checkbox.disabled = fatal;
  let label = 'جاهز للتحميل';
  if (item.status === 'queued') label = 'في انتظار التحميل';
  if (item.status === 'loading') label = item.phase || 'جارٍ التحميل…';
  if (item.status === 'ready') label = item.selected ? 'ظاهر' : 'مخفي';
  if (item.status === 'missing') label = 'ملف النموذج غير متوفر';
  if (item.status === 'error') label = 'تعذّر التحميل';
  if (item.status === 'idle' && item.metadata?.status === 'missing') label = 'بانتظار التصدير والتحويل';
  if (item.status === 'idle' && item.metadata?.status === 'failed') label = 'راجع سجل التصدير والتحويل';
  const warning = item.row.querySelector('.export-warning');
  warning.hidden = !(item.metadata?.exportGeometryErrors > 0);
  warning.textContent = warning.hidden ? '' : 'تصدير جزئي: ' + number.format(item.metadata.exportGeometryErrors) + ' أخطاء هندسية؛ راجع progress.log';
  const rowStatus = item.row.querySelector('.row-status');
  rowStatus.dataset.state = item.status;
  $('status-' + item.id).textContent = label;
  $('status-' + item.id).title = item.error || '';
  $('retry-' + item.id).hidden = !['missing', 'error'].includes(item.status);
  $('retry-' + item.id).disabled = fatal;
  item.row.querySelector('progress').hidden = item.status !== 'loading';
  item.row.setAttribute('aria-busy', String(item.status === 'loading'));
}

function updateSummary() {
  if(excavationRoot?.visible && !visibleItems().length){$('emptyState').hidden=true;$('fitView').disabled=$('topView').disabled=false;$('loadStatus').textContent='مرحلة الحفر والسور · عمق تقديري ٤٫٢ م';return;}

  const visible = visibleItems();
  $('visibleCount').textContent = number.format(visible.length) + ' / ' + number.format(disciplines.length);
  const sum = getter => visible.length && visible.every(item => getter(item) !== null) ? visible.reduce((n, item) => n + getter(item), 0) : visible.length ? null : 0;
  $('totalElements').textContent = count(sum(getElementCount)) + ' عنصر محمّل';
  $('totalTriangles').textContent = count(sum(getTriangleCount)) + ' مثلث';
  $('fitView').disabled = fatal || !visible.length;
  $('topView').disabled = fatal || !visible.length;
  $('sectionEnabled').disabled = fatal || !visible.length;
  $('sectionHeight').disabled = fatal || !visible.length || !$('sectionEnabled').checked;
  if (fatal) return;
  const waiting = disciplines.some(item => item.selected && (item.status === 'queued' || item.status === 'loading'));
  const missing = disciplines.filter(item => item.selected && item.status === 'missing');
  const failed = disciplines.filter(item => item.selected && item.status === 'error');
  const selected = disciplines.some(item => item.selected);
  $('emptyState').hidden = visible.length > 0;
  $('emptyRetry').hidden = waiting || !(missing.length || failed.length);
  if (!visible.length) {
    if (waiting) {
      $('emptyTitle').textContent = 'جارٍ تحميل النموذج';
      $('emptyText').textContent = 'تُحمّل التخصصات بالتتابع. قد يستغرق النموذج الكبير بعض الوقت.';
    } else if (missing.length) {
      $('emptyTitle').textContent = 'لم تُجهّز ملفات النموذج بعد';
      $('emptyText').textContent = 'أكمل التصدير من Revit ثم شغّل التحويل.\nستظهر التخصصات هنا فور تجهيز ملفاتها.';
    } else if (failed.length) {
      $('emptyTitle').textContent = 'تعذّر تحميل النموذج';
      $('emptyText').textContent = 'تحقّق من اكتمال التحويل، ثم أعد المحاولة.\nتفاصيل الخطوات في «تجهيز ملفات النموذج».';
    } else {
      $('emptyTitle').textContent = 'اختر تخصصًا لبدء العرض';
      $('emptyText').textContent = selected ? 'لا توجد هندسة ظاهرة في التخصص المحدد.' : 'فعّل تخصصًا من القائمة، أو اضغط «إظهار الكل».';
    }
  }
  if (current) $('loadStatus').textContent = current.name + ': ' + (current.phase || 'جارٍ التحميل…');
  else if (waiting) $('loadStatus').textContent = 'تجهيز التخصص التالي…';
  else if (missing.length || failed.length) $('loadStatus').textContent = number.format(missing.length + failed.length) + ' تخصص غير متاح حاليًا؛ يمكن إعادة المحاولة بعد تجهيز ملفاته.';
  else if (visible.length) $('loadStatus').textContent = 'يعرض ' + number.format(visible.length) + ' من ' + number.format(disciplines.length) + ' تخصصات';
  else $('loadStatus').textContent = 'اختر التخصصات التي تريد عرضها.';
}

async function readJson(relativePath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(relativePath, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function acceptMetadata(entry) {
  const item = byId.get(entry?.discipline);
  if (!item) return;
  const clean = { status: entry.status, levels: [] };
  // Large GLBs are published in parts (GitHub's 100 MB file limit); the manifest lists them in order.
  if (Array.isArray(entry.parts) && entry.parts.every(name => /^[A-Za-z0-9_.-]+$/.test(name))) clean.parts = entry.parts;
  for (const key of ['elementCount', 'triangleCount', 'sourceTriangleCount', 'bytes', 'exportGeometryErrors', 'exportSkippedLinks']) {
    if (Number.isFinite(entry[key]) && entry[key] >= 0) clean[key] = entry[key];
  }
  if (entry.status === 'ready' && Array.isArray(entry.levels)) {
    clean.levels = entry.levels
      .filter(level => typeof level?.name === 'string' && Number.isFinite(level.elementCount))
      .map(level => ({ name: level.name, elevation: Number.isFinite(level.elevation) ? level.elevation : null, elementCount: level.elementCount }));
  }
  item.metadata = clean;
  updateRow(item);
}

// ---- Floor filter -------------------------------------------------------

function rebuildFloors() {
  const previous = new Map(floors.map(floor => [floor.key, floor.visible]));
  const entries = [];
  for (const item of disciplines) {
    for (const level of item.metadata?.levels || []) entries.push({ discipline: item.id, ...level });
  }
  // Merge levels of all disciplines that sit at the same elevation; STR names win.
  const clusters = [];
  const leveled = entries.filter(entry => entry.name && entry.elevation !== null).sort((a, b) => a.elevation - b.elevation);
  for (const entry of leveled) {
    let cluster = clusters.at(-1);
    if (!cluster || Math.abs(entry.elevation - cluster.elevation) > FLOOR_MERGE_METRES) {
      cluster = { elevation: entry.elevation, names: [], entries: [] };
      clusters.push(cluster);
    }
    cluster.entries.push(entry);
    cluster.names.push(entry);
  }
  floorKeyByLevel.clear();
  floors = [];
  for (const cluster of clusters) {
    const named = cluster.names.find(entry => entry.discipline === 'STR') || cluster.names[0];
    const key = 'floor@' + named.elevation.toFixed(2);
    const perDiscipline = new Map();
    for (const entry of cluster.entries) {
      floorKeyByLevel.set(entry.discipline + '|' + entry.name, key);
      perDiscipline.set(entry.discipline, (perDiscipline.get(entry.discipline) || 0) + entry.elementCount);
    }
    floors.push({ key, name: named.name, elevation: named.elevation, visible: previous.get(key) ?? true, perDiscipline });
  }
  const unassigned = new Map();
  for (const entry of entries) {
    if (entry.name && entry.elevation !== null) continue;
    floorKeyByLevel.set(entry.discipline + '|' + entry.name, NO_FLOOR);
    unassigned.set(entry.discipline, (unassigned.get(entry.discipline) || 0) + entry.elementCount);
  }
  floors = floors.filter(floor => [...floor.perDiscipline.values()].some(n => n > 0)).reverse(); // top floor first
  if ([...unassigned.values()].some(n => n > 0)) floors.push({ key: NO_FLOOR, name: 'بدون دور', elevation: null, visible: previous.get(NO_FLOOR) ?? true, perDiscipline: unassigned });
  renderFloors();
}

function renderFloors() {
  const list = $('floors');
  list.textContent = '';
  for (const floor of floors) {
    const label = document.createElement('label');
    label.className = 'floor-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = floor.visible;
    input.addEventListener('change', () => setFloorVisible(floor.key, input.checked));
    const name = document.createElement('span');
    name.textContent = floor.name;
    const level = document.createElement('bdi');
    level.className = 'floor-elevation';
    level.textContent = floor.elevation === null ? '' : (floor.elevation >= 0 ? '+' : '') + floor.elevation.toFixed(2);
    const small = document.createElement('small');
    small.id = 'floor-count-' + floor.key;
    label.append(input, name, level, small);
    floor.input = input;
    list.appendChild(label);
  }
  $('floorEmpty').hidden = floors.length > 0;
  $('allFloors').disabled = fatal || !floors.length;
  $('isolateFloor').disabled = fatal || !floors.length;
  updateFloorCounts();
}

function updateFloorCounts() {
  const selected = disciplines.filter(item => item.selected).map(item => item.id);
  for (const floor of floors) {
    const total = selected.reduce((n, id) => n + (floor.perDiscipline.get(id) || 0), 0);
    const cell = $('floor-count-' + floor.key);
    if (cell) cell.textContent = number.format(total);
    floor.input?.closest('.floor-row')?.classList.toggle('empty', total === 0);
  }
  const shown = floors.filter(floor => floor.visible).length;
  $('floorCount').textContent = floors.length ? number.format(shown) + ' / ' + number.format(floors.length) : '';
}

function setFloorVisible(key, visible) {
  if ($('isolateFloor').checked && visible) {
    for (const floor of floors) floor.visible = floor.key === key;
  } else {
    const floor = floors.find(item => item.key === key);
    if (floor) floor.visible = visible;
  }
  syncFloorInputs();
  applyFloors();
}

function syncFloorInputs() {
  for (const floor of floors) if (floor.input) floor.input.checked = floor.visible;
  updateFloorCounts();
}

function floorVisible(discipline, levelName) {
  const key = floorKeyByLevel.get(discipline + '|' + (levelName || ''));
  if (key === undefined) return true; // level unknown to the metadata: never hide it by mistake
  return floors.find(floor => floor.key === key)?.visible ?? true;
}

function applyFloors() {
  facadeFinish?.syncDetails($('referenceFinish').checked && floorVisible('ARCH','5th FLOOR')); 
  for (const item of disciplines) {
    for (const { object, level } of item.levelObjects) {
      // ARCH sidecar maps this single context group exclusively to Revit element 3250027.
      const replacedContext = item.id === 'ARCH' && object.userData.groupId === 'group-00144' && hospitalRoot?.visible;
      object.visible = !replacedContext && floorVisible(item.id, level) && (object.userData.category !== 'Rooms' || $('showRooms').checked);
    }
  }
  renderSoon();
}

async function refreshMetadata(id = null) {
  const manifest = await readJson('./assets/imc/manifest.json');
  manifestAvailable = !!Array.isArray(manifest?.disciplines);
  if (manifestAvailable) manifest.disciplines.forEach(acceptMetadata);
  else {
    const fallback = id ? [id] : disciplines.map(item => item.id);
    const entries = await Promise.all(fallback.map(key => readJson('./assets/imc/' + key + '.json')));
    entries.forEach(acceptMetadata);
  }
  rebuildFloors();
  applyFloors();
  updateSummary();
}

function setSelected(id, value) {
  const item = byId.get(id);
  if (!item || fatal) return;
  item.selected = Boolean(value);
  if (item.root) item.root.visible = item.selected;
  if (item.selected && ['idle', 'missing', 'error'].includes(item.status)) enqueue(item);
  if (!item.selected && item.status === 'queued') item.status = 'idle';
  updateRow(item);
  updateFloorCounts();
  updateSectionRange();
  updateSummary();
  renderSoon();
}

function enqueue(item) {
  if (item.root || item.status === 'loading' || item.status === 'queued') return;
  item.status = 'queued';
  item.error = null;
  queue.push(item);
  updateRow(item);
  void pump();
}

async function retry(id) {
  if (fatal) return;
  const items = id ? [byId.get(id)] : disciplines.filter(item => item.selected && ['missing', 'error'].includes(item.status));
  await refreshMetadata(id);
  for (const item of items) if (item) setSelected(item.id, true);
}

async function pump() {
  if (pumping || fatal || disposed) return;
  pumping = true;
  try {
    while (queue.length && !disposed) {
      const item = queue.shift();
      if (!item.selected || item.root || item.status !== 'queued') continue;
      current = item;
      item.status = 'loading';
      item.phase = 'تحميل الملف…';
      updateRow(item);
      updateSummary();
      await nextFrame();
      try {
        await loadDiscipline(item);
      } catch (error) {
        item.status = error?.missing ? 'missing' : 'error';
        item.error = error?.message || String(error);
        if (!error?.missing) errors.push({ discipline: item.id, message: item.error });
      } finally {
        current = null;
        item.phase = '';
        updateRow(item);
        updateSummary();
        renderSoon();
      }
      // Let input/paint work finish before parsing another large model.
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    pumping = false;
    current = null;
    if (initialBatchFitPending && visibleItems().length) {
      initialBatchFitPending = false;
      fitView();
    }
    updateSummary();
  }
}

async function loadDiscipline(item) {
  // A failed conversion can leave an older GLB on disk. The manifest is authoritative.
  if (item.metadata && ['missing', 'failed'].includes(item.metadata.status)) {
    const error = new Error(item.metadata.status === 'missing' ? 'ملف التخصص غير جاهز؛ أكمل التصدير والتحويل ثم أعد المحاولة.' : 'لم يكتمل تصدير أو تحويل التخصص؛ راجع progress.log وسجل التحويل.');
    error.missing = item.metadata.status === 'missing';
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600000);
  let bytes;
  try {
    const names = item.metadata?.parts || [item.id + '.glb'];
    const chunks = [];
    for (const name of names) {
      const response = await fetch('./assets/imc/' + name, { cache: 'no-cache', signal: controller.signal });
      if (!response.ok) {
        const error = new Error(name + ': HTTP ' + response.status);
        error.missing = response.status === 404;
        throw error;
      }
      chunks.push(new Uint8Array(await response.arrayBuffer()));
    }
    if (chunks.length === 1) bytes = chunks[0].buffer;
    else {
      const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
      bytes = joined.buffer;
    }
  } finally { clearTimeout(timeout); }
  item.phase = 'فك الضغط وتجهيز النموذج…';
  updateRow(item);
  updateSummary();
  await nextFrame();
  const gltf = await loader.parseAsync(bytes, new URL('./assets/imc/', location.href).href);
  bytes = null;
  const root = gltf.scene;
  root.name = 'IMC-' + item.id;
  // Preserve every GLB transform: no recentering, scaling or axis conversion here.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) {
    disposeModel(root);
    throw new Error(item.id + ': no finite mesh bounds in model');
  }
  let triangles = 0;
  const physicalBounds = new THREE.Box3();
  root.traverse(object => {
    if (!object.isMesh) return;
    let roomVolume = false;
    for (let ancestor = object; ancestor; ancestor = ancestor.parent) {
      if (ancestor.userData?.category === 'Rooms') { roomVolume = true; break; }
    }
    if (!roomVolume) physicalBounds.expandByObject(object);
    const geometry = object.geometry;
    const count = geometry.index ? geometry.index.count : geometry.getAttribute('position')?.count || 0;
    triangles += Math.floor(count / 3) * (object.isInstancedMesh ? object.count : 1);
    object.castShadow = false;
    object.receiveShadow = false;
  });
  // Converter node extras (GLTFLoader -> userData) carry each batch's Revit level.
  item.levelObjects = [];
  root.traverse(object => {
    if (typeof object.userData?.level === 'string') item.levelObjects.push({ object, level: object.userData.level });
  });
  if (!triangles) {
    disposeModel(root);
    throw new Error(item.id + ': no triangles in model');
  }
  if (item.id === 'ARCH' && facadeFinish) { facadeFinish.register(root); facadeFinish.apply($('referenceFinish').checked); }
  item.root = root;
  item.bounds = box;
  item.physicalBounds = physicalBounds.isEmpty() ? box : physicalBounds;
  item.actualTriangles = triangles;
  root.visible = item.selected;
  scene.add(root);
  item.status = 'ready';
  item.error = null;
  applyFloors();
  updateGrid();
  updateSectionRange();
  if (!fittedOnce && item.selected) { fitView(); fittedOnce = true; }
  renderSoon();
}

function combinedBounds(visibleOnly = true) {
  const box = new THREE.Box3();
  for (const item of disciplines) if (item.bounds && (!visibleOnly || item.selected)) {
    box.union($('showRooms').checked ? item.bounds : (item.physicalBounds || item.bounds));
  }
  if(excavationRoot?.visible && excavationBounds)box.union(excavationBounds);
  return box;
}



async function loadExistingHospital() {
  try {
    const result = await loader.loadAsync('assets/hospital/IMC_EXISTING_HOSPITAL.glb');
    hospitalRoot = result.scene;
    hospitalRoot.name = 'Existing IMC Hospital (photo reconstruction)';
    hospitalRoot.position.fromArray(sitePlacement.centre);
    hospitalRoot.rotation.y = sitePlacement.rotationY;
    hospitalRoot.updateMatrixWorld(true);
    hospitalRoot.traverse(node => { if (node.isMesh) hospitalTriangles += (node.geometry.index?.count || node.geometry.attributes.position.count) / 3; });
    hospitalBounds = new THREE.Box3().setFromObject(hospitalRoot);
    scene.add(hospitalRoot); hospitalState = 'ready';
    $('hospitalFocus').disabled = false;
    $('hospitalStatus').textContent = 'نموذج تقريبي من الصور · أبعاد تقديرية';
    applyHospital();
    if (visibleItems().length && !current && !queue.length) fitView();
  } catch (error) {
    hospitalState = 'error'; $('showHospital').checked = false;
    $('hospitalStatus').textContent = 'تعذّر تحميل مبنى المستشفى؛ أعد تحميل الصفحة للمحاولة.';
    renderSoon();
  }
}
function applyHospital() {
  if (hospitalRoot) hospitalRoot.visible = $('showHospital').checked;
  applyFloors();
  renderSoon();
}

async function loadSiteMap() {
  try {
    const data = await readJson('assets/site-map/site-geometry.json');
    if (!data?.imc_site?.corners || !data?.image_rect_m) throw new Error('Map geometry unavailable');
    const texture = await new THREE.TextureLoader().loadAsync('assets/site-map/MAP_satellite.png');
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const group = new THREE.Group(); group.name = 'IMC site reference map';
    group.position.fromArray(sitePlacement.centre); group.rotation.y = sitePlacement.rotationY;
    const rect = data.image_rect_m;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(...rect.size), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.DoubleSide }));
    plane.rotation.x = -Math.PI / 2;
    plane.position.set((rect.min[0] + rect.max[0]) / 2, 0, -(rect.min[1] + rect.max[1]) / 2);
    mapSurface=plane;
    mapOpening=createMapWithOpening(rect,data.imc_site.corners,plane.material);group.add(mapOpening);
    excavationRoot=createExcavation(data.imc_site.corners);
    excavationRoot.position.fromArray(sitePlacement.centre);excavationRoot.rotation.y=sitePlacement.rotationY;
    scene.add(excavationRoot);excavationRoot.updateMatrixWorld(true);excavationBounds=new THREE.Box3().setFromObject(excavationRoot);
    THREE.DefaultLoadingManager.onLoad=renderSoon;
    applyExcavation();updateSummary();fitView();
    group.add(plane);
    for (const [plot, colour] of [[data.imc_site, '#ffffff'], [data.large_plot, '#ffda49']]) {
      const points = plot.corners.map(([x,y]) => new THREE.Vector3(x, 0.16, -y));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: colour, toneMapped: false }));
      group.add(line);
    }
    group.updateMatrixWorld(true);
    siteOverviewBounds = new THREE.Box3();
    for (const plot of [data.imc_site, data.large_plot]) for (const [x,y] of plot.corners) siteOverviewBounds.expandByPoint(group.localToWorld(new THREE.Vector3(x,0,-y)));
    siteOverviewBounds.max.y = 36;
    siteMap = group; scene.add(group); siteMapState = 'ready';
    $('siteOverview').disabled = false;
    $('siteMapStatus').textContent = 'قطعة IMC: ٥٬٥٤٤ م² · محاذاة بصرية بالمتر';
    applySiteMap();
  } catch (error) {
    siteMapState = 'error'; $('showSiteMap').checked = false;
    $('siteMapStatus').textContent = 'تعذّر تحميل الخريطة؛ أعد تحميل الصفحة للمحاولة.';
    applySiteMap();
  }
}

function applyExcavation(){
  const visible=$('showExcavation').checked;
  if(excavationRoot)excavationRoot.visible=visible;
  if(mapSurface)mapSurface.visible=!visible;
  if(mapOpening)mapOpening.visible=visible;
  updateSummary();renderSoon();
}
function applySiteMap() {
  if (siteMap) siteMap.visible = $('showSiteMap').checked;
  if (grid) grid.visible = !siteMap?.visible;
  renderSoon();
}

function updateGrid() {
  const box = combinedBounds(false);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const extent = Math.max(size.x, size.z, 10) * 1.3;
  if (grid) { scene.remove(grid); grid.geometry.dispose(); for (const material of [].concat(grid.material)) material.dispose(); }
  grid = new THREE.GridHelper(extent, 20, '#aec4d2', '#cddce5');
  grid.position.set(centre.x, box.min.y - Math.max(size.y * 0.002, 0.03), centre.z);
  grid.material.transparent = true;
  grid.material.opacity = 0.48;
  grid.material.depthWrite = false;
  scene.add(grid);
  applySiteMap();
}

function updateSectionRange() {
  if (!renderer) return;
  const box = combinedBounds();
  if (box.isEmpty()) { renderer.clippingPlanes = []; return; }
  const oldValue = Number($('sectionHeight').value);
  const wasAtTop = !sectionBounds || oldValue >= sectionBounds.max.y - 0.15;
  const low = Math.floor(box.min.y * 10) / 10;
  const high = Math.ceil(box.max.y * 10) / 10 + 0.1;
  $('sectionHeight').min = String(low);
  $('sectionHeight').max = String(Math.max(high, low + 0.1));
  $('sectionHeight').value = String(wasAtTop ? high : Math.max(low, Math.min(high, oldValue)));
  sectionBounds = box;
  applySection();
}

function applySection() {
  if (!renderer) return;
  const height = Number($('sectionHeight').value);
  clipPlane.constant = height;
  renderer.clippingPlanes = $('sectionEnabled').checked && visibleItems().length ? [clipPlane] : [];
  $('sectionValue').textContent = metres.format(height) + ' م';
  $('sectionHeight').disabled = fatal || !$('sectionEnabled').checked || !visibleItems().length;
  renderSoon();
}

function focusFacade() {
  setSelected("STR",false);
  const centre = new THREE.Vector3(30,17,12);
  const halfFov=THREE.MathUtils.degToRad(camera.fov)/2;
  const distance=58/Math.sin(Math.min(halfFov,Math.atan(Math.tan(halfFov)*camera.aspect)))*1.12;
  camera.position.copy(centre).addScaledVector(new THREE.Vector3(1,.12,1.45).normalize(),distance);
  camera.near=.05;camera.far=3000;camera.updateProjectionMatrix();controls.target.copy(centre);controls.update();renderSoon();
}

function fitView(top = false, overview = false, hospitalOnly = false, cranesOnly = false) {
  if (!camera || !controls) return;
  const box = cranesOnly && towerCranes ? towerCranes.bounds.clone() : hospitalOnly && hospitalBounds ? hospitalBounds.clone() : overview && siteOverviewBounds ? siteOverviewBounds.clone() : combinedBounds();
  if (!cranesOnly && !hospitalOnly && hospitalRoot?.visible && hospitalBounds) box.union(hospitalBounds);
  if (!hospitalOnly && !cranesOnly && towerCranes?.root.visible) box.union(new THREE.Box3().setFromObject(towerCranes.solids));
  if (box.isEmpty()) return;
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5);
  const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const limitingFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect));
  const distance = radius / Math.sin(limitingFov) * 1.16;
  const direction = top ? new THREE.Vector3(0, 1, 0.0001) : new THREE.Vector3(1, 0.7, 1).normalize();
  camera.position.copy(centre).addScaledVector(direction, distance);
  camera.near = Math.max(0.01, radius / 10000);
  camera.far = Math.max(1000, distance + radius * 12);
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.minDistance = Math.max(0.02, radius * 0.002);
  controls.maxDistance = distance * 8;
  controls.update();
  renderSoon();
}

function renderSoon() {
  if (!renderer || requestPending || disposed || fatal) return;
  requestPending = true;
  requestAnimationFrame(() => {
    requestPending = false;
    if (disposed || fatal) return;
    controls.update();
    renderer.render(scene, camera);
    $('renderStatus').textContent = number.format(renderer.info.render.calls) + ' أمر رسم · ' + number.format(renderer.info.render.triangles) + ' مثلث';
  });
}

function resize() {
  if (!renderer) return;
  const width = $('viewport').clientWidth;
  const height = $('viewport').clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderSoon();
}

function fail(message) {
  fatal = true;
  errors.push({ message });
  $('emptyState').hidden = true;
  $('fatalError').hidden = false;
  $('fatalText').textContent = message;
  $('loadStatus').textContent = 'تعذّر تشغيل العرض';
  for (const item of disciplines) updateRow(item);
  for (const id of ['showAll', 'hideAll', 'fitView', 'topView', 'sectionEnabled', 'sectionHeight', 'allFloors', 'isolateFloor']) $(id).disabled = true;
}

function disposeModel(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [].concat(object.material || [])) materials.add(material);
  });
  for (const material of materials) for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
  geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); textures.forEach(value => value.dispose());
}

async function start() {
  buildRows();
  $('reloadPage').addEventListener('click', () => location.reload());
  if (location.protocol === 'file:') { fail('شغّل START_VIEWER TOWEC.cmd، ثم افتح imc-model.html من عنوان الخادم المحلي.'); return; }
  try {
    if (!MeshoptDecoder.supported) throw new Error('WebAssembly غير متاح لفك ضغط النماذج.');
    await MeshoptDecoder.ready;
    // Two local decoder workers keep compressed ARCH buffers off the UI thread.
    try { MeshoptDecoder.useWorkers(Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))); } catch { /* Decoder retains its main-thread fallback. */ }
    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', 'النموذج ثلاثي الأبعاد؛ استخدم الماوس أو اللمس للتدوير والتقريب');
    renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); fail('فُقد اتصال العرض ببطاقة الرسوم. أعد تحميل الصفحة، ثم حمّل عددًا أقل من التخصصات في المرة الواحدة.'); });
    $('viewport').appendChild(renderer.domElement);
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#e5edf2');
    facadeFinish = createFacadeFinish(renderer, scene);
    scene.add(new THREE.HemisphereLight('#ffffff', '#879aa4', 2.1));
    const sun = new THREE.DirectionalLight('#fff7ed', 2.6);
    sun.position.set(140, 200, 90); scene.add(sun);
    const fill = new THREE.DirectionalLight('#dfedff', 1.0);
    fill.position.set(-100, 70, -90); scene.add(fill);
    camera = new THREE.PerspectiveCamera(45, 1, 0.05, 10000);
    camera.position.set(100, 80, 100);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.dampingFactor = 0.1;
    controls.screenSpacePanning = true;
    controls.maxPolarAngle = Math.PI * 0.98;
    controls.listenToKeyEvents(renderer.domElement);
    controls.addEventListener('change', renderSoon);
    new ResizeObserver(resize).observe($('viewport'));
    resize();
    $('showSiteMap').addEventListener('change', applySiteMap);
    $('siteOverview').addEventListener('click', () => { $('showSiteMap').checked = true; applySiteMap(); fitView(false, true); });
    void loadSiteMap();
    $('showHospital').addEventListener('change', applyHospital);
    $('hospitalFocus').addEventListener('click', () => { $('showHospital').checked = true; applyHospital(); fitView(false, false, true); });
    void loadExistingHospital();
    towerCranes = createTowerCranes(); scene.add(towerCranes.root);
    $('showCranes').addEventListener('change', () => { towerCranes.root.visible = $('showCranes').checked; renderSoon(); });
    $('showCraneRanges').addEventListener('change', () => { towerCranes.ranges.visible = $('showCraneRanges').checked; renderSoon(); });
    $('cranePlan').addEventListener('click', () => { $('showCranes').checked = true; $('showCraneRanges').checked = true; towerCranes.root.visible = true; towerCranes.ranges.visible = true; fitView(true, false, false, true); });
    $('showExcavation').addEventListener('change',applyExcavation);
    $('excavationPhase').addEventListener('click',()=>{for(const d of disciplines)setSelected(d.id,false);$('showExcavation').checked=true;applyExcavation();fitView();});
    $('buildingPhase').addEventListener('click',()=>{$('showExcavation').checked=false;applyExcavation();setSelected('STR',true);setSelected('ARCH',true);});
    $('referenceFinish').addEventListener('change', () => { facadeFinish.apply($('referenceFinish').checked); applyFloors(); renderSoon(); });
    $('facadeFocus').addEventListener('click', focusFacade);
    $('fitView').addEventListener('click', () => fitView());
    $('topView').addEventListener('click', () => fitView(true));
    $('sectionEnabled').addEventListener('change', applySection);
    $('sectionHeight').addEventListener('input', applySection);
    $('showAll').addEventListener('click', () => {
      for (const id of ['STR', 'ELEC', 'TELECOM', 'HV', 'PL', 'ARCH']) setSelected(id, true);
    });
    $('hideAll').addEventListener('click', () => disciplines.forEach(item => setSelected(item.id, false)));
    $('emptyRetry').addEventListener('click', () => void retry());
    $('allFloors').addEventListener('click', () => {
      $('isolateFloor').checked = false;
      for (const floor of floors) floor.visible = true;
      syncFloorInputs();
      applyFloors();
    });
    $('isolateFloor').addEventListener('change', () => {
      if (!$('isolateFloor').checked) return;
      // Keep the first floor that is currently shown (top-down), hide the rest.
      const keep = floors.find(floor => floor.visible) || floors[0];
      for (const floor of floors) floor.visible = floor === keep;
      syncFloorInputs();
      applyFloors();
    });
    $('fullscreen').addEventListener('click', async () => {
      try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
      catch { $('loadStatus').textContent = 'وضع ملء الشاشة غير متاح في هذا المتصفح.'; }
    });
    document.addEventListener('fullscreenchange', () => {
      $('fullscreen').setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
      $('fullscreen').textContent = document.fullscreenElement ? 'إنهاء ملء الشاشة' : 'ملء الشاشة';
      resize();
    });
    if (!document.fullscreenEnabled) $('fullscreen').hidden = true;
    await refreshMetadata();
    $('showRooms').addEventListener('change', () => {
      applyFloors(); updateGrid(); updateSectionRange(); fitView();
    });
    setSelected('STR', true);
    setSelected('ARCH', true);
  } catch (error) { fail('تعذّر بدء العرض ثلاثي الأبعاد. تأكد من دعم WebGL 2 وتحديث المتصفح. ' + (error?.message || '')); }
}

// Small read-only snapshot API supports evidence checks without exposing model buffers.
window.imcModelViewer = {
  version: 1,
  setDiscipline: setSelected,
  setFloor: setFloorVisible,
  fit: fitView,
  retry,
  snapshot: () => ({
    excavation:excavationRoot?{visible:excavationRoot.visible,depth:excavationRoot.userData.depthMetres,mapOpening:mapOpening.visible,bounds:{min:excavationBounds.min.toArray(),max:excavationBounds.max.toArray()}}:null,
    threeRevision: THREE.REVISION,
    facadeFinish: {enabled:$('referenceFinish').checked,...facadeFinish?.snapshot()},
    towerCranes: towerCranes ? {visible:towerCranes.root.visible,ranges:towerCranes.ranges.visible,definitions:towerCranes.definitions} : null,
    hospital: { status: hospitalState, visible: Boolean(hospitalRoot?.visible), triangles: hospitalTriangles, replacedContextHidden: byId.get('ARCH').levelObjects.some(({object}) => object.userData.groupId === 'group-00144' && !object.visible), bounds: hospitalBounds ? {min:hospitalBounds.min.toArray(),max:hospitalBounds.max.toArray()} : null },
    siteMap: { status: siteMapState, visible: Boolean(siteMap?.visible), placement: sitePlacement },
    manifestAvailable,
    loading: current?.id || null,
    queue: queue.filter(item => item.selected && item.status === 'queued').map(item => item.id),
    disciplines: disciplines.map(item => ({ id: item.id, selected: item.selected, status: item.status, elementCount: getElementCount(item), triangleCount: getTriangleCount(item), exportGeometryErrors: item.metadata?.exportGeometryErrors ?? null, bounds: item.bounds ? { min: item.bounds.min.toArray(), max: item.bounds.max.toArray() } : null, rootTransform: item.root ? { position: item.root.position.toArray(), quaternion: item.root.quaternion.toArray(), scale: item.root.scale.toArray() } : null, error: item.error })),
    floors: floors.map(floor => ({ key: floor.key, name: floor.name, elevation: floor.elevation, visible: floor.visible, perDiscipline: Object.fromEntries(floor.perDiscipline) })),
    isolate: $('isolateFloor').checked,
    roomsEnabled: $('showRooms').checked,
    hiddenRoomBatches: disciplines.reduce((n, item) => n + item.levelObjects.filter(entry => entry.object.userData.category === 'Rooms' && !entry.object.visible).length, 0),
    hiddenBatches: disciplines.reduce((n, item) => n + item.levelObjects.filter(entry => !entry.object.visible).length, 0),
    clipping: Boolean(renderer?.clippingPlanes.length),
    clipHeight: clipPlane.constant,
    camera: camera ? { position: camera.position.toArray(), target: controls.target.toArray() } : null,
    render: renderer ? { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles } : null,
    errors: [...errors],
    fatal
  })
};
void start();
