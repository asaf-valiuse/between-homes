/* global L */

const STORAGE_KEY = "lifepath.addresses.v1";
// Bump cache key so older cached results don't persist (also refreshes coords after geocode improvements).
const GEOCODE_CACHE_KEY = "lifepath.geocodeCache.v4.en";

// Requested: do NOT persist the Step 1 address list. It resets on every load.
const PERSIST_DRAFT_ADDRESSES = false;

function containsHebrew(text) {
  return /[\u0590-\u05FF]/.test(String(text || ""));
}

function transliterateHebrewToLatin(text) {
  const s = String(text || "");
  const map = {
    "א": "a",
    "ב": "b",
    "ג": "g",
    "ד": "d",
    "ה": "h",
    "ו": "v",
    "ז": "z",
    "ח": "kh",
    "ט": "t",
    "י": "y",
    "כ": "k",
    "ך": "k",
    "ל": "l",
    "מ": "m",
    "ם": "m",
    "נ": "n",
    "ן": "n",
    "ס": "s",
    "ע": "a",
    "פ": "p",
    "ף": "f",
    "צ": "ts",
    "ץ": "ts",
    "ק": "k",
    "ר": "r",
    "ש": "sh",
    "ת": "t",
  };

  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out += map[ch] ?? ch;
  }

  // Normalize spacing a bit.
  return out.replace(/\s+/g, " ").trim();
}

function toEnglishLike(text) {
  const s = String(text || "").trim();
  if (!s) return s;
  return containsHebrew(s) ? transliterateHebrewToLatin(s) : s;
}

function tidyToken(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function formatStandardAddress({ country, city, street, number }) {
  const streetLine = tidyToken([tidyToken(street), tidyToken(number)].filter(Boolean).join(" "));
  const parts = [streetLine, tidyToken(city), tidyToken(country)].filter(Boolean);
  return parts.join(", ");
}

async function reverseGeocodeEnglish(lat, lon) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("accept-language", "en");

  const res = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json",
      "Accept-Language": "en",
    },
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (!data || typeof data !== "object") return null;
  return data;
}

/**
 * @typedef {Object} Address
 * @property {string} id
 * @property {string} country
 * @property {string} state
 * @property {string} city
 * @property {string} street
 * @property {string} number
 * @property {number=} belonging_rate
 * @property {boolean=} valid
 * @property {number=} lat
 * @property {number=} lon
 * @property {string=} displayName
 */

function normalizeBelongingRate(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n)) return clamp(Math.round(n), 1, 10);
  if (Number.isFinite(fallback)) return clamp(Math.round(fallback), 1, 10);
  return 5;
}

function stableBelongingRateFromId(id) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  const u = (hashSeed(h) >>> 0);
  return 1 + (u % 10);
}

function belongingColor(rate) {
  const r = normalizeBelongingRate(rate, 5);
  const t = (r - 1) / 9;
  const hue = 220 - t * 200;
  return `hsl(${hue} 85% 52%)`;
}

/** @type {Address[]} */
let addresses = [];

// Ensure old drafts don't survive reloads.
if (!PERSIST_DRAFT_ADDRESSES) {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem("lifepath.lastDraftBackup.v1");
    localStorage.removeItem("lifepath.deleteFirstOnce.v1");
  } catch {
    // ignore
  }
}

/** @type {Record<string, { lat: number, lon: number, displayName: string, normalized?: { street: string, number: string, city: string, country: string }, ts: number }>} */
let geocodeCache = loadJson(GEOCODE_CACHE_KEY, {});

function formatAddressAsInList(addr) {
  const cached = geocodeCache[canonicalKey(addr)];
  const n = cached && cached.normalized ? cached.normalized : null;
  const country = toEnglishLike(tidyToken((n && n.country) || addr.country));
  const city = toEnglishLike(tidyToken((n && n.city) || addr.city));
  const street = toEnglishLike(tidyToken((n && n.street) || addr.street));
  const number = toEnglishLike(tidyToken((n && n.number) || addr.number));
  return formatStandardAddress({ country, city, street, number });
}

function formatAddressForHoverLabel(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  const lower = s.toLowerCase();
  return lower.replace(/\b([a-z])/g, (m, ch) => ch.toUpperCase());
}

/** @type {boolean} */
let currentAddressVerified = false;

/** @type {boolean} */
let belongingLabelShown = false;

const elForm = document.getElementById("addressForm");
const elList = document.getElementById("addressList");
const elStatus = document.getElementById("status");
const elAddressStatus = document.getElementById("addressStatus");
const elAddToListMsg = document.getElementById("addToListMsg");

const elAddBtn = document.getElementById("addBtn");
const elDrawBtn = document.getElementById("drawBtn");
const elDrawBelongingBtn = document.getElementById("drawBelongingBtn");
const elDrawAllBtn = document.getElementById("drawAllBtn");
const elClearBtn = document.getElementById("clearBtn");
const elSaveBtn = document.getElementById("saveBtn");
const elLoadBtn = document.getElementById("loadBtn");
const elExportBtn = document.getElementById("exportBtn");
const elImportBtn = document.getElementById("importBtn");
const elImportFile = document.getElementById("importFile");
const elToggleMapBtn = document.getElementById("toggleMapBtn");
const elMap = document.getElementById("map");
const elToggleGeoBtn = document.getElementById("toggleGeoBtn");
const elToggleSplashBtn = document.getElementById("toggleSplashBtn");
const elHideMapBtn = document.getElementById("hideMapBtn");
const elSignatureLabel = document.getElementById("signatureLabel");
const elZoomLabel = document.getElementById("zoomLabel");
const elSaveMapBtn = document.getElementById("saveMapBtn");
const elBasemapStyleSelect = document.getElementById("basemapStyleSelect");
const elPrintPostcardBtn = document.getElementById("printPostcardBtn");
const elPostcardPreviewOverlay = document.getElementById("postcardPreviewOverlay");
const elPostcardPreviewCloseBtn = document.getElementById("postcardPreviewCloseBtn");
const elPostcardPreviewPrintBtn = document.getElementById("postcardPreviewPrintBtn");
const elPostcardPreviewNativePrintBtn = document.getElementById("postcardPreviewNativePrintBtn");
const elPostcardCardArt = document.getElementById("postcardCardArt");
const elPostcardCardMapHost = document.getElementById("postcardCardMapHost");
const elPostcardCardMapInner = document.getElementById("postcardCardMapInner");
const elPostcardCardMapName = document.getElementById("postcardCardMapName");
const elPostcardRotateBtn = document.getElementById("postcardRotateBtn");

let addToListMsgTimeoutId = 0;

function showAddToListMessage(homeNumber) {
  if (!elAddToListMsg) return;

  const n = Number(homeNumber);
  const label = Number.isFinite(n) ? formatHomeNumber(n) : "";
  elAddToListMsg.textContent = `Home no.${label} has been added to the list`;
  elAddToListMsg.classList.remove("hidden");

  if (addToListMsgTimeoutId) window.clearTimeout(addToListMsgTimeoutId);
  addToListMsgTimeoutId = window.setTimeout(() => {
    elAddToListMsg.classList.add("hidden");
    elAddToListMsg.textContent = "";
    addToListMsgTimeoutId = 0;
  }, 2000);
}

const SAVED_MAPS_KEY = "lifepath.savedMaps.v1";
const ALLMAPS_HIDDEN_KEY = "lifepath.allMaps.hidden.v1";

// Archive numbering: lifemap01, lifemap02, ... in save order.
const SAVED_MAP_SERIAL_KEY = "lifepath.savedMaps.serial.v1";

const BASEMAP_STYLE_KEY = "lifepath.basemapStyle.v1";

const BASEMAP_STYLES = [
  {
    id: "dark",
    label: "Dark (Dark Matter)",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    options: {
      maxZoom: 20,
      subdomains: "abcd",
      // Show the world only once (no horizontal repetition when zooming out).
      noWrap: true,
      // Avoid retina tile downscaling which can make labels too small.
      detectRetina: false,
      attribution: "© OpenStreetMap contributors © CARTO",
    },
  },
];

function getBasemapStyleIdFromStorage() {
  try {
    return String(localStorage.getItem(BASEMAP_STYLE_KEY) || "").trim();
  } catch {
    return "";
  }
}

function setBasemapStyleIdToStorage(id) {
  try {
    localStorage.setItem(BASEMAP_STYLE_KEY, String(id || ""));
  } catch {
    // ignore
  }
}

function normalizeBasemapStyleId(id) {
  const wanted = String(id || "").trim();
  if (wanted && BASEMAP_STYLES.some((s) => s.id === wanted)) return wanted;
  return "dark";
}

function createBasemapTileLayer(styleId) {
  const id = normalizeBasemapStyleId(styleId);
  const style = BASEMAP_STYLES.find((s) => s.id === id) || BASEMAP_STYLES[0];
  if (!style.url) return null;
  const layer = L.tileLayer(style.url, { ...(style.options || {}) });
  layer.on("tileerror", () => {
    showToast("Map tiles failed to load. Try another map style.");
  });
  return layer;
}

function getBasemapStyleMeta(styleId) {
  const id = normalizeBasemapStyleId(styleId);
  return BASEMAP_STYLES.find((s) => s.id === id) || BASEMAP_STYLES[0];
}

function applyBasemapStyleClasses() {
  const meta = getBasemapStyleMeta(basemapStyleId);
  const bw = Boolean(meta && meta.bwFilter);
  if (elMap) elMap.classList.toggle("basemap-bw", bw);
  if (elAllMapsMap) elAllMapsMap.classList.toggle("basemap-bw", bw);

  const dark = isDarkBasemap(basemapStyleId);
  if (elMap) elMap.classList.toggle("basemap-dark", dark);
  if (elAllMapsMap) elAllMapsMap.classList.toggle("basemap-dark", dark);

  if (elPageStep2) {
    // Used by CSS to style top UI when the basemap is visible.
    elPageStep2.classList.toggle("map-visible", Boolean(geoLayerEnabled));
    elPageStep2.classList.toggle("dark-map-ui", Boolean(geoLayerEnabled) && dark);
  }
}

function isLineArtBasemap(styleId) {
  const meta = getBasemapStyleMeta(styleId);
  return Boolean(meta && meta.kind === "lineart");
}

function isDarkBasemap(styleId) {
  const meta = getBasemapStyleMeta(styleId);
  return Boolean(meta && meta.id === "dark");
}

function getOverlayStrokeColor() {
  // When the basemap is hidden, the life path should be black.
  if (!geoLayerEnabled) return "#000000";
  return isDarkBasemap(basemapStyleId) ? "#ffffff" : "#000000";
}

function getAllMapsOverlayStrokeColor() {
  // All Maps should adapt to whether the basemap tiles are visible.
  // - Tiles hidden (white background): black overlays
  // - Dark tiles visible: white overlays
  if (!allMapsTilesVisible) return "#000000";
  return isDarkBasemap(basemapStyleId) ? "#ffffff" : "#000000";
}

function getMinZoomToAvoidBlankViewport(targetMap, fallbackMinZoom = 2) {
  if (!targetMap || typeof targetMap.getSize !== "function") return fallbackMinZoom;
  const size = targetMap.getSize();
  const w = Math.max(1, Number(size?.x) || 0);
  const h = Math.max(1, Number(size?.y) || 0);
  const maxDim = Math.max(w, h);

  // Leaflet default tile size is 256 CSS pixels.
  const tileSize = 256;
  const ratio = maxDim / tileSize;
  const z = Math.ceil(Math.log2(Math.max(1, ratio)));
  if (!isFinite(z)) return fallbackMinZoom;
  return Math.max(fallbackMinZoom, z);
}

function enforceMinZoomToAvoidBlankViewport(targetMap) {
  if (!targetMap || typeof targetMap.setMinZoom !== "function") return;
  const minZ = getMinZoomToAvoidBlankViewport(targetMap, 2);
  try {
    targetMap.setMinZoom(minZ);
    if (typeof targetMap.getZoom === "function") {
      const current = targetMap.getZoom();
      if (isFinite(current) && current < minZ && typeof targetMap.setZoom === "function") {
        targetMap.setZoom(minZ, { animate: false });
      }
    }
  } catch {
    // ignore
  }
}

function restyleStep2OverlaysForBasemap() {
  const color = getOverlayStrokeColor();

  try {
    if (polyline && typeof polyline.setStyle === "function") {
      polyline.setStyle({ color });
    }
  } catch {
    // ignore
  }

  try {
    if (markerLayer && typeof markerLayer.eachLayer === "function") {
      markerLayer.eachLayer((layer) => {
        if (layer && typeof layer.setStyle === "function") layer.setStyle({ color, fillColor: color });
      });
    }
  } catch {
    // ignore
  }
}

function restyleAllMapsOverlaysForBasemap() {
  if (!allMapsVectorLayer) return;
  const baseColor = getAllMapsOverlayStrokeColor();
  const highlightColor = "#ff4800";
  try {
    allMapsVectorLayer.eachLayer((layer) => {
      if (!layer || typeof layer.setStyle !== "function") return;
      const key = String(layer?.options?.lifepathAllMapsKey || "");
      const isHighlighted = Boolean(allMapsHighlightedKey) && Boolean(key) && key === allMapsHighlightedKey;
      const color = isHighlighted ? highlightColor : baseColor;
      layer.setStyle({ color, fillColor: color });
    });
  } catch {
    // ignore
  }
}

const OVERPASS_PROXY_URL = "/api/overpass";

function getHighwayRegexForZoom(z) {
  const zoom = Math.max(0, Math.round(Number(z) || 0));
  if (zoom < 11) return "motorway|trunk|primary";
  if (zoom < 13) return "motorway|trunk|primary|secondary";
  if (zoom < 15) return "motorway|trunk|primary|secondary|tertiary";
  return "motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";
}

function styleForHighway(type) {
  const t = String(type || "");
  if (t.includes("motorway") || t.includes("trunk")) return { color: "#111111", weight: 3.2, opacity: 1 };
  if (t.includes("primary")) return { color: "#1a1a1a", weight: 2.8, opacity: 1 };
  if (t.includes("secondary")) return { color: "#2b2b2b", weight: 2.2, opacity: 0.95 };
  if (t.includes("tertiary")) return { color: "#3f3f3f", weight: 1.6, opacity: 0.9 };
  if (t.includes("residential") || t.includes("unclassified") || t.includes("living_street")) return { color: "#6b6b6b", weight: 1.0, opacity: 0.75 };
  if (t.includes("service")) return { color: "#7c7c7c", weight: 0.8, opacity: 0.65 };
  return { color: "#6b6b6b", weight: 0.9, opacity: 0.7 };
}

function lineArtKey(bounds, zoom) {
  const b = bounds;
  const s = b.getSouthWest();
  const n = b.getNorthEast();
  const z = Math.max(0, Math.round(Number(zoom) || 0));
  // Round to reduce refetches while panning slightly.
  const r = (x) => Math.round(Number(x) * 1000) / 1000;
  return `${z}:${r(s.lat)},${r(s.lng)},${r(n.lat)},${r(n.lng)}:${getHighwayRegexForZoom(z)}`;
}

async function fetchLineArtRoads(bounds, zoom, signal) {
  const padded = bounds.pad(0.12);
  const s = padded.getSouth();
  const w = padded.getWest();
  const n = padded.getNorth();
  const e = padded.getEast();
  const hw = getHighwayRegexForZoom(zoom);

  const query = `data=[out:json][timeout:25];(way["highway"~"${hw}"](${s},${w},${n},${e}););out tags geom;`;

  const res = await fetch(OVERPASS_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Accept": "application/json",
    },
    body: JSON.stringify({ query }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Overpass proxy HTTP ${res.status}`);
  }

  const wrapped = await res.json();
  const json = wrapped && typeof wrapped === "object" ? wrapped.data : null;
  if (!json || typeof json !== "object" || !Array.isArray(json.elements)) {
    throw new Error("Overpass proxy invalid JSON");
  }
  return json;
}

function renderLineArtIntoLayer(layerGroup, overpassJson, renderer) {
  if (!layerGroup) return;
  layerGroup.clearLayers();
  const elements = overpassJson && Array.isArray(overpassJson.elements) ? overpassJson.elements : [];
  for (const el of elements) {
    if (!el || el.type !== "way") continue;
    const geom = Array.isArray(el.geometry) ? el.geometry : [];
    if (geom.length < 2) continue;
    const latLngs = geom.map((p) => [Number(p.lat), Number(p.lon)]).filter((p) => isFinite(p[0]) && isFinite(p[1]));
    if (latLngs.length < 2) continue;
    const hw = el.tags && typeof el.tags === "object" ? el.tags.highway : "";
    const s = styleForHighway(hw);
    const line = L.polyline(latLngs, {
      color: s.color,
      weight: s.weight,
      opacity: s.opacity,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
      renderer,
    });
    layerGroup.addLayer(line);
  }
}

function scheduleLineArtUpdate(targetMap, layerGroup, state) {
  if (!targetMap || !layerGroup || !state) return;
  if (!targetMap.hasLayer(layerGroup)) return;

  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  state.timer = setTimeout(async () => {
    state.timer = null;
    if (!targetMap || !layerGroup || !targetMap.hasLayer(layerGroup)) return;

    const bounds = targetMap.getBounds();
    const zoom = targetMap.getZoom();
    const key = lineArtKey(bounds, zoom);
    if (key === state.lastKey) return;
    state.lastKey = key;

    if (state.abort) state.abort.abort();
    state.abort = new AbortController();

    try {
      const json = await fetchLineArtRoads(bounds, zoom, state.abort.signal);
      if (!state.renderer) state.renderer = L.canvas({ padding: 0.5 });
      renderLineArtIntoLayer(layerGroup, json, state.renderer);
    } catch (e) {
      if (state.abort && state.abort.signal && state.abort.signal.aborted) return;
      showToast("Line art failed to load. Try another map style.");
    }
  }, 350);
}

let basemapStyleId = normalizeBasemapStyleId(getBasemapStyleIdFromStorage());

// Default: tiles hidden until user clicks "Show map".
let geoLayerEnabled = false;

/** @type {{id?:string,label?:string,savedAt?:string} | null} */
let currentEditingSnapshot = null;

function ensureSnapshotId(snapshot) {
  const existing = snapshot && typeof snapshot === "object" ? String(snapshot.id || "") : "";
  if (existing) return existing;
  const fallback = `snap_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return fallback;
}

function getAllMapsHiddenLabels() {
  const raw = localStorage.getItem(ALLMAPS_HIDDEN_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [];
    return new Set(arr.map((x) => String(x || "")).filter(Boolean));
  } catch {
    return new Set();
  }
}

function setAllMapsHiddenLabels(set) {
  const arr = Array.from(set || []).map((x) => String(x || "")).filter(Boolean);
  localStorage.setItem(ALLMAPS_HIDDEN_KEY, JSON.stringify(arr));
}

function getSavedMaps() {
  const raw = localStorage.getItem(SAVED_MAPS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [];
    return ensureSavedMapsHaveSerials(list);
  } catch {
    return [];
  }
}

function normalizeImportedSavedMapSnapshot(rawSnap, fallbackIndex = 0) {
  const snap = rawSnap && typeof rawSnap === "object" ? rawSnap : {};

  const fullName = String(snap.fullName || "").trim();
  const importedAddressesRaw = Array.isArray(snap.addresses) ? snap.addresses : [];

  let migrated = [];
  try {
    migrated = migrateAddresses(JSON.parse(JSON.stringify(importedAddressesRaw)));
  } catch {
    migrated = migrateAddresses(importedAddressesRaw);
  }

  const countRaw = Number(snap.count);
  const count = Number.isFinite(countRaw) ? Math.max(0, Math.floor(countRaw)) : migrated.length;

  const label = String(snap.label || "").trim() || (
    fullName
      ? `${normalizeNameForMapLabel(fullName)}.${formatAddrCount(count)}addrs`
      : `lifepath.${formatAddrCount(count)}addrs`
  );

  const serialRaw = Number(snap.serial);
  const serial = Number.isFinite(serialRaw) && serialRaw > 0 ? Math.floor(serialRaw) : Math.max(0, fallbackIndex + 1);

  const viewLat = Number(snap?.view?.lat);
  const viewLng = Number(snap?.view?.lng);
  const viewZoom = Number(snap?.view?.zoom);
  const view = {
    lat: Number.isFinite(viewLat) ? viewLat : 0,
    lng: Number.isFinite(viewLng) ? viewLng : 0,
    zoom: Number.isFinite(viewZoom) ? viewZoom : 2,
  };

  const savedAt = String(snap.savedAt || "").trim() || new Date().toISOString();
  const updatedAt = String(snap.updatedAt || "").trim() || savedAt;

  const normalized = {
    version: 1,
    id: ensureSnapshotId(snap),
    label,
    serial,
    fullName,
    count,
    savedAt,
    updatedAt,
    view,
    geoLayerEnabled: Boolean(snap.geoLayerEnabled),
    addresses: migrated,
  };

  return normalized;
}

function restoreSavedMapsFromArchivePayload(payload) {
  const listRaw = payload && typeof payload === "object" ? payload.savedMaps : null;
  if (!Array.isArray(listRaw)) return { ok: false, error: "missing_saved_maps" };

  const normalized = [];
  for (let i = 0; i < listRaw.length; i++) {
    const snap = listRaw[i];
    if (!snap || typeof snap !== "object") continue;
    normalized.push(normalizeImportedSavedMapSnapshot(snap, i));
  }

  setSavedMaps(normalized);

  const maxSerial = inferMaxSavedMapSerialFromList(normalized);
  setSavedMapSerialCounter(maxSerial);

  // Ensure back-compat fixes + missing serials are repaired immediately.
  try {
    ensureSavedMapsHaveSerials(normalized);
  } catch {
    // ignore
  }

  return { ok: true, count: normalized.length };
}

function ensureSavedMapsHaveSerials(list) {
  const items = Array.isArray(list) ? list.slice() : [];
  if (items.length <= 0) return [];

  const normalized = items.map((snap) => (snap && typeof snap === "object" ? snap : null));

  // Targeted label fix for a known saved map.
  // Requirement: saved map label should be FullNameWithoutSpaces.XXaddrs
  // (but keep archive serial lifemapNN separate).
  let needsPersist = false;
  for (const snap of normalized) {
    if (!snap) continue;
    const fullName = String(snap.fullName || "").trim();
    if (!/^(shaked)\s+(hogi)$/i.test(fullName)) continue;

    const count = formatAddrCount(
      Number.isFinite(Number(snap.count)) ? Number(snap.count) : (Array.isArray(snap.addresses) ? snap.addresses.length : 0)
    );
    const desired = `${normalizeNameForMapLabel(fullName)}.${count}addrs`;
    if (String(snap.label || "") !== desired) {
      snap.label = desired;
      needsPersist = true;
    }
  }

  // Assign serials to any snapshot missing one, based on chronological save time.
  // Keep existing serials when present.
  const used = new Set();
  let maxSerial = 0;
  let needsWork = false;

  for (const snap of normalized) {
    if (!snap) continue;
    const s = Number(snap.serial);
    if (Number.isFinite(s) && s > 0) {
      const n = Math.floor(s);
      used.add(n);
      if (n > maxSerial) maxSerial = n;
    } else {
      needsWork = true;
    }
  }

  if (!needsWork) {
    // Ensure counter doesn't lag behind.
    const current = getSavedMapSerialCounter();
    if (current === null || current < maxSerial) setSavedMapSerialCounter(maxSerial);
    if (needsPersist) {
      try {
        setSavedMaps(items);
      } catch {
        // ignore
      }
    }
    return items;
  }

  const order = normalized
    .map((snap, idx) => ({ snap, idx }))
    .filter((x) => x.snap)
    .sort((a, b) => {
      const ta = Date.parse(String(a.snap?.savedAt || ""));
      const tb = Date.parse(String(b.snap?.savedAt || ""));
      if (isFinite(ta) && isFinite(tb)) return ta - tb;
      if (isFinite(ta) && !isFinite(tb)) return -1;
      if (!isFinite(ta) && isFinite(tb)) return 1;
      return a.idx - b.idx;
    });

  let next = 1;
  for (const { snap } of order) {
    const s = Number(snap.serial);
    if (Number.isFinite(s) && s > 0) continue;
    while (used.has(next)) next++;
    snap.serial = next;
    used.add(next);
    if (next > maxSerial) maxSerial = next;
    next++;
  }

  // Persist back so archive serials remain stable (even after deletions).
  try {
    setSavedMaps(items);
  } catch {
    // ignore
  }
  setSavedMapSerialCounter(maxSerial);

  return items;
}

function setSavedMaps(list) {
  localStorage.setItem(SAVED_MAPS_KEY, JSON.stringify(Array.isArray(list) ? list : []));
}

function getSavedMapSerialCounter() {
  try {
    const raw = localStorage.getItem(SAVED_MAP_SERIAL_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

function setSavedMapSerialCounter(n) {
  try {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    localStorage.setItem(SAVED_MAP_SERIAL_KEY, String(v));
  } catch {
    // ignore
  }
}

function inferMaxSavedMapSerialFromList(list) {
  const items = Array.isArray(list) ? list : [];
  let maxSerial = 0;
  for (const snap of items) {
    if (!snap || typeof snap !== "object") continue;
    const s = Number(snap.serial);
    if (Number.isFinite(s) && s > maxSerial) maxSerial = Math.floor(s);
  }

  // Fallback: if there is no serial info at all, assume existing items represent saved maps.
  // This avoids starting back at lifemap01 on an already-used device.
  if (maxSerial <= 0) maxSerial = items.length;

  return Math.max(0, maxSerial);
}

function allocateNextSavedMapSerial(existingList) {
  const inferred = inferMaxSavedMapSerialFromList(existingList);
  const current = getSavedMapSerialCounter();
  const base = current === null ? inferred : Math.max(inferred, current);
  const next = base + 1;
  setSavedMapSerialCounter(next);
  return next;
}

function formatLifeMapLabel(serial) {
  const n = Math.max(0, Math.floor(Number(serial) || 0));
  return `lifemap${String(n).padStart(2, "0")}`;
}

function normalizeNameForMapLabel(text) {
  // Keep the user's casing, just remove whitespace.
  return String(text || "").trim().replace(/\s+/g, "");
}

function getCurrentMapLabel() {
  const name = normalizeNameForMapLabel(elStudentName?.value || "");
  const count = formatAddrCount(addresses.length);
  if (!name) return "";
  return `${name}.${count}addrs`;
}

function saveCurrentMapSnapshot() {
  const label = getCurrentMapLabel();
  if (!label) return false;

  const center = map.getCenter();
  const zoom = map.getZoom();

  // If we opened a map from the Archive, update that same snapshot in place
  // instead of creating a new archive entry.
  try {
    if (currentEditingSnapshot) {
      const list = getSavedMaps();
      const editId = String(currentEditingSnapshot.id || "").trim();
      const editSavedAt = String(currentEditingSnapshot.savedAt || "").trim();
      const editLabel = String(currentEditingSnapshot.label || "").trim();

      let idx = -1;
      if (editId) {
        idx = (Array.isArray(list) ? list : []).findIndex((x) => x && String(x.id || "") === editId);
      }
      if (idx < 0 && editSavedAt) {
        idx = (Array.isArray(list) ? list : []).findIndex((x) => x && String(x.savedAt || "") === editSavedAt);
      }
      if (idx < 0 && editLabel) {
        idx = (Array.isArray(list) ? list : []).findIndex((x) => x && String(x.label || "") === editLabel);
      }

      if (idx >= 0) {
        const next = Array.isArray(list) ? list.slice() : [];
        const prev = next[idx] && typeof next[idx] === "object" ? next[idx] : {};

        next[idx] = {
          ...prev,
          version: 1,
          id: String(prev.id || editId || ""),
          label,
          fullName: String(elStudentName?.value || ""),
          count: addresses.length,
          updatedAt: new Date().toISOString(),
          view: { lat: center.lat, lng: center.lng, zoom },
          geoLayerEnabled: Boolean(geoLayerEnabled),
          addresses: Array.isArray(addresses) ? JSON.parse(JSON.stringify(addresses)) : [],
        };

        setSavedMaps(next.slice(0, 100));
        currentEditingSnapshot = { ...currentEditingSnapshot, id: String(next[idx].id || ""), label };
        noteCreateFlowSnapshotSaved();
        return true;
      }

      // If we can't locate the original snapshot, fall back to creating a new one.
      // Clear the editing pointer so future saves don't try to overwrite a missing entry.
      currentEditingSnapshot = null;
    }
  } catch {
    // ignore and fall back to create-new behavior
  }

  // Always create a NEW saved snapshot.
  // (Do not overwrite an existing Archive tile even if we opened from Archive.)
  const snapshotId = ensureSnapshotId(null);

  const list = getSavedMaps();
  const nextSerial = allocateNextSavedMapSerial(list);

  const snapshot = {
    version: 1,
    id: snapshotId,
    label,
    serial: nextSerial,
    fullName: String(elStudentName?.value || ""),
    count: addresses.length,
    savedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    view: { lat: center.lat, lng: center.lng, zoom },
    geoLayerEnabled: Boolean(geoLayerEnabled),
    addresses: Array.isArray(addresses) ? JSON.parse(JSON.stringify(addresses)) : [],
  };

  const next = Array.isArray(list) ? list.slice() : [];
  // Chronological storage: oldest -> newest.
  next.push(snapshot);
  setSavedMaps(next.slice(0, 100));

  // After saving, do not keep an "editing" pointer that could cause future overwrites.
  currentEditingSnapshot = null;

  noteCreateFlowSnapshotSaved();
  return true;
}

function getSavedMapKey(snap) {
  if (!snap || typeof snap !== "object") return "";
  const id = String(snap.id || "").trim();
  if (id) return id;
  return String(snap.label || "").trim();
}

// New flow (Welcome -> Step 1 -> Step 2)
const elPageWelcome = document.getElementById("pageWelcome");
const elPageStep1 = document.getElementById("pageStep1");
const elPageStep2 = document.getElementById("pageStep2");
const elPageEmotion = document.getElementById("pageEmotion");
const elPageAllMaps = document.getElementById("pageAllMaps");
const elPageArchive = document.getElementById("pageArchive");
const elAllMapsBtn = document.getElementById("allMapsBtn");
const elArchiveBtn = document.getElementById("archiveBtn");
const elBackToWelcomeBtn = document.getElementById("backToWelcomeBtn");
const elCreateLifePathBtn = document.getElementById("createLifePathBtn");
const elBackToStep1Btn = document.getElementById("backToStep1Btn");
const elEmotionMapBtn = document.getElementById("emotionMapBtn");
const elBackToMapBtn = document.getElementById("backToMapBtn");
const elEmotionEditBtn = document.getElementById("emotionEditBtn");
const elEmotionSaveBtn = document.getElementById("emotionSaveBtn");
const elStudentName = document.getElementById("studentName");
const elHomeNumberTitle = document.getElementById("homeNumberTitle");
const elHomeSummary = document.getElementById("homeSummary");

const elEmotionTitle = document.getElementById("emotionTitle");

const elEmotionSvg = document.getElementById("emotionSvg");

const elCreateLifePathTransition = document.getElementById("createLifePathTransition");

const elToast = document.getElementById("toast");

let toastHideTimer = 0;

// Auto-save: prevent creating duplicate archive entries when the user redraws
// the same map multiple times.
let lastAutoSavedAddressesSignature = "";

// When closing Step 2 (X), return to the right page.
// Default is Welcome; opening a snapshot from Archive switches this to Archive.
let step2CloseReturnPage = "welcome";
let step2OpenedFromArchive = false;

function setStep2CloseReturnPage(page) {
  step2CloseReturnPage = page === "archive" ? "archive" : "welcome";
}

// Requirement: after clicking "Create life path" and the map is saved, reset
// the Step 1 houses list on the data entry page.
//
// We defer clearing `addresses` until we return to the home flow, because Step 2
// rendering/drawing relies on the `addresses` array.
let resetStep1AfterCreateSaveArmed = false;
let resetStep1AfterCreateSavePending = false;

function armResetStep1AfterCreateSave() {
  resetStep1AfterCreateSaveArmed = true;
}

function noteCreateFlowSnapshotSaved() {
  if (!resetStep1AfterCreateSaveArmed) return;
  resetStep1AfterCreateSaveArmed = false;
  resetStep1AfterCreateSavePending = true;
}

function resetStep1HouseList() {
  addresses = [];
  saveJson(STORAGE_KEY, addresses);

  // Reset the form fields, including "Full name".
  if (elForm && typeof elForm.reset === "function") elForm.reset();
  if (elStudentName) elStudentName.value = "";

  currentAddressVerified = false;
  belongingLabelShown = false;
  setAddressStatus("");
  setStatus("");
  updateAddButtonState();
  updateBelongingValueLabel();

  renderList();
  updateStep1Headers();

  if (addToListMsgTimeoutId) window.clearTimeout(addToListMsgTimeoutId);
  addToListMsgTimeoutId = 0;
  if (elAddToListMsg) {
    elAddToListMsg.classList.add("hidden");
    elAddToListMsg.textContent = "";
  }
}

function maybeResetStep1AfterCreateSave() {
  if (!resetStep1AfterCreateSavePending) return;
  resetStep1AfterCreateSavePending = false;
  resetStep1HouseList();
}

function getAddressesSignatureForAutoSave() {
  try {
    const parts = [];
    for (const a of Array.isArray(addresses) ? addresses : []) {
      if (!a) continue;
      const id = String(a.id || "");
      const valid = a.valid === false ? "0" : "1";
      const lat = isFinite(a.lat) ? Number(a.lat).toFixed(5) : "";
      const lon = isFinite(a.lon) ? Number(a.lon).toFixed(5) : "";
      const rate = String(normalizeBelongingRate(a.belonging_rate, stableBelongingRateFromId(a.id))).padStart(2, "0");
      parts.push([id, valid, lat, lon, rate].join("~"));
    }
    return parts.join("|");
  } catch {
    return "";
  }
}

function maybeAutoSaveCurrentMapSnapshot() {
  const label = getCurrentMapLabel();
  if (!label) return false;
  const sig = getAddressesSignatureForAutoSave();
  if (!sig) return false;

  // Only auto-save when the address content has changed.
  if (sig === lastAutoSavedAddressesSignature) return false;

  const ok = saveCurrentMapSnapshot();
  if (ok) {
    lastAutoSavedAddressesSignature = sig;
    return true;
  }
  return false;
}

function showToast(text, ms = 1800) {
  if (!elToast) return;
  const message = String(text || "").trim();
  if (!message) return;
  elToast.textContent = message;
  elToast.classList.remove("hidden");
  if (toastHideTimer) window.clearTimeout(toastHideTimer);
  toastHideTimer = window.setTimeout(() => {
    elToast.classList.add("hidden");
  }, Math.max(300, Number(ms) || 0));
}

// In the Create flow, save as soon as Step 2 settles to the 100% baseline.
// This ensures the user doesn't have to wait for the drawing animation to finish
// (or click Save) before the map appears in the Archive.
let autoSaveAfterStep2OpenAt100 = false;

let createLifePathTransitionActive = false;

function showCreateLifePathTransition(show) {
  if (!elCreateLifePathTransition) return;
  const on = Boolean(show);
  elCreateLifePathTransition.classList.toggle("hidden", !on);
  elCreateLifePathTransition.setAttribute("aria-hidden", on ? "false" : "true");
}

const elSavedMapsList = document.getElementById("savedMapsList");
const elSavedMapsEmpty = document.getElementById("savedMapsEmpty");

const elArchiveGrid = document.getElementById("archiveGrid");
const elArchiveEmpty = document.getElementById("archiveEmpty");

const elAllMapsMap = document.getElementById("allMapsMap");
const elAllMapsHideMapBtn = document.getElementById("allMapsHideMapBtn");
const elAllMapsEditBtn = document.getElementById("allMapsEditBtn");
const elAllMapsCountLabel = document.getElementById("allMapsCountLabel");
const elAllMapsZoomLabel = document.getElementById("allMapsZoomLabel");

const elCountry = document.getElementById("country");
const elCity = document.getElementById("city");
const elStreet = document.getElementById("street");
const elNumber = document.getElementById("number");
const elBelongingRate = document.getElementById("belonging_rate");
const elBelongingValueLabel = document.getElementById("belongingValueLabel");

function sanitizeEnglishOnlyName(raw) {
  return String(raw || "").replace(/[^A-Za-z .'-]+/g, "");
}

function isStep1FormComplete() {
  const country = String(elCountry?.value || "").trim();
  const city = String(elCity?.value || "").trim();
  const street = String(elStreet?.value || "").trim();
  const number = String(elNumber?.value || "").trim();
  return Boolean(country && city && street && number && currentAddressVerified);
}

function updateAddButtonState() {
  if (!elAddBtn) return;
  elAddBtn.disabled = !isStep1FormComplete();
}

function updateBelongingValueLabel() {
  if (!elBelongingRate || !elBelongingValueLabel) return;
  const rate = normalizeBelongingRate(elBelongingRate.value, 1);
  if (!belongingLabelShown) {
    elBelongingValueLabel.textContent = "";
    elBelongingValueLabel.style.visibility = "hidden";
    return;
  }

  elBelongingValueLabel.style.visibility = "visible";
  elBelongingValueLabel.textContent = String(rate);

  // Position label above the thumb (centered).
  const min = Number(elBelongingRate.min || 1);
  const max = Number(elBelongingRate.max || 10);
  const t = max > min ? (rate - min) / (max - min) : 0;

  const trackWidth = elBelongingRate.clientWidth;
  const thumbSize = 17; // matches CSS ::-webkit-slider-thumb / ::-moz-range-thumb
  const x = t * Math.max(0, trackWidth - thumbSize) + thumbSize / 2;
  const left = elBelongingRate.offsetLeft + x;
  elBelongingValueLabel.style.left = `${left}px`;
}

function updateCreateLifePathButtonState() {
  if (!elCreateLifePathBtn) return;
  elCreateLifePathBtn.disabled = addresses.length === 0;
}

function updateStep1Scale() {
  const DESIGN_W = 1920;
  const DESIGN_H = 1080;
  const vw = Math.max(1, window.innerWidth || DESIGN_W);
  const vh = Math.max(1, window.innerHeight || DESIGN_H);
  const scale = Math.min(1, vw / DESIGN_W, vh / DESIGN_H);
  document.documentElement.style.setProperty("--step1-scale", String(scale));
  scheduleWelcomeBottomButtonsAlignment();
}

const elWelcomeTopbar = elPageWelcome ? elPageWelcome.querySelector(".topbar") : null;
const elWelcomeWordmark = elPageWelcome ? elPageWelcome.querySelector(".welcomeWordmark") : null;
const elWelcomeBody = elPageWelcome ? elPageWelcome.querySelector(".welcomeBody") : null;
const elWelcomeBottomButtons = elPageWelcome ? elPageWelcome.querySelector(".welcomeBottomButtons") : null;
const elWelcomeScrollHint = elPageWelcome ? elPageWelcome.querySelector(".welcomeScrollHint") : null;
const elWelcomeLifeWord = elWelcomeWordmark ? elWelcomeWordmark.querySelector(".welcomeWord") : null;

let welcomeBottomButtonsRaf = 0;

function updateWelcomeBottomButtonsAlignment() {
  if (!elWelcomeBottomButtons || !elWelcomeBody) return;

  const inHomeFlow = document.body.classList.contains("homeFlow");
  const step1Hidden = Boolean(elPageStep1 && elPageStep1.classList.contains("hidden"));
  if (!inHomeFlow || step1Hidden || !elCreateLifePathBtn) {
    document.documentElement.style.removeProperty("--welcome-bottom-buttons-mr");
    return;
  }

  try {
    const createRect = elCreateLifePathBtn.getBoundingClientRect();
    if (!createRect || !Number.isFinite(createRect.right) || createRect.width <= 0) return;

    const bodyRect = elWelcomeBody.getBoundingClientRect();
    if (!bodyRect || !Number.isFinite(bodyRect.right) || bodyRect.width <= 0) return;

    // In a flex column with align-self:flex-end, the element's border-box right edge is:
    //   right = parentRight - marginRight
    // So to align to createRect.right: marginRight = parentRight - createRect.right
    const mr = Math.round(bodyRect.right - createRect.right);
    document.documentElement.style.setProperty("--welcome-bottom-buttons-mr", `${mr}px`);
  } catch {
    // ignore
  }
}

function scheduleWelcomeBottomButtonsAlignment() {
  if (welcomeBottomButtonsRaf) return;
  welcomeBottomButtonsRaf = window.requestAnimationFrame(() => {
    welcomeBottomButtonsRaf = 0;
    updateWelcomeBottomButtonsAlignment();
  });
}

let welcomeLogoUpdateRaf = 0;
let welcomeScrollHintRaf = 0;

function updateWelcomeScrollHintAlignment() {
  if (!elWelcomeScrollHint || !elWelcomeLifeWord) return;

  const inHomeFlow = document.body.classList.contains("homeFlow");
  if (!inHomeFlow) {
    document.documentElement.style.removeProperty("--welcome-hint-left");
    return;
  }

  try {
    const r = elWelcomeLifeWord.getBoundingClientRect();
    if (!r || !Number.isFinite(r.left)) return;
    document.documentElement.style.setProperty("--welcome-hint-left", `${Math.round(r.left)}px`);
  } catch {
    // ignore
  }
}

function scheduleWelcomeScrollHintAlignment() {
  if (welcomeScrollHintRaf) return;
  welcomeScrollHintRaf = window.requestAnimationFrame(() => {
    welcomeScrollHintRaf = 0;
    updateWelcomeScrollHintAlignment();
  });
}

function updateWelcomeLogoOnScroll() {
  if (!elWelcomeTopbar || !elWelcomeWordmark) return;

  const inHomeFlow = document.body.classList.contains("homeFlow");
  if (!inHomeFlow) {
    document.body.classList.remove("homeFlowScrolled");
    document.documentElement.style.removeProperty("--welcome-hint-left");
    document.documentElement.style.removeProperty("--welcome-logo-scale");
    document.documentElement.style.removeProperty("--welcome-logo-ty");
    document.documentElement.style.removeProperty("--welcome-logo-tx");
    return;
  }

  const scrollY = Math.max(0, Number(window.scrollY || 0));
  document.body.classList.toggle("homeFlowScrolled", scrollY > 0);
  const vh = Math.max(1, Number(window.innerHeight || 1));

  // How quickly the logo shrinks and moves to the top.
  const shrinkDistance = Math.max(180, Math.min(420, vh * 0.6));
  const t = Math.max(0, Math.min(1, scrollY / shrinkDistance));

  // Final (small) size tuning:
  // Previously: 93px * 0.254 ~= 23.62px. Then: 93px * 0.146 ~= 13.58px (~10px smaller).
  // Now: 93px * 0.200 ~= 18.60px (~+5px zoom in for the small state).
  const minScale = 0.2;
  const scale = 1 - t * (1 - minScale);

  const paddingTop = parseFloat(getComputedStyle(elWelcomeTopbar).paddingTop || "0") || 0;
  const wordmarkH = Math.max(0, Number(elWelcomeWordmark.offsetHeight || 0));

  // Move from vertically centered (t=0) to top (t=1).
  const desiredTop = Math.max(0, (vh - wordmarkH) / 2);
  const ty0 = desiredTop - paddingTop;
  const ty = (1 - t) * ty0;

  // When the logo is small and stuck at the top, align its left edge with
  // the left edge of the Step 1 “Full name” label.
  const baseTx = 10;
  let targetLeft = null;
  try {
    const labelEl = elStudentName && typeof elStudentName.closest === "function"
      ? elStudentName.closest(".group")?.querySelector(".text-wrapper-2")
      : null;
    if (labelEl && typeof labelEl.getBoundingClientRect === "function") {
      const r = labelEl.getBoundingClientRect();
      if (r && Number.isFinite(r.left)) targetLeft = r.left;
    }
  } catch {
    // ignore
  }

  const vw = Math.max(1, Number(window.innerWidth || 1));
  const wordmarkW = Math.max(0, Number(elWelcomeWordmark.offsetWidth || 0)) * scale;
  const centeredLeft = (vw - wordmarkW) / 2;
  const desiredLeft = Number.isFinite(targetLeft) ? targetLeft : centeredLeft;
  const targetTx = desiredLeft - centeredLeft;

  // Requirement: align only at the end of the scroll.
  // So: keep the logo centered (baseTx) while it shrinks, and only slide it
  // horizontally into alignment close to the moment Step 1 reaches the top.
  const step1TopY = elPageStep1 ? Number(elPageStep1.offsetTop || 0) : 0;
  const alignEndY = Number.isFinite(step1TopY) && step1TopY > 0 ? step1TopY : shrinkDistance;
  const alignSlideDistance = Math.max(120, Math.min(260, vh * 0.35));
  const alignStartY = Math.max(shrinkDistance, alignEndY - alignSlideDistance);


  let tx = baseTx;
  if (scrollY >= alignStartY) {
    const denom = Math.max(1, alignEndY - alignStartY);
    const u = Math.max(0, Math.min(1, (scrollY - alignStartY) / denom));
    // Shift final position 10px further left
    tx = baseTx + u * (targetTx - baseTx - 5);
  }

  document.documentElement.style.setProperty("--welcome-logo-scale", scale.toFixed(4));
  document.documentElement.style.setProperty("--welcome-logo-ty", `${Math.round(ty)}px`);
  document.documentElement.style.setProperty("--welcome-logo-tx", `${Math.round(tx)}px`);
}

function scheduleWelcomeLogoUpdate() {
  if (welcomeLogoUpdateRaf) return;
  welcomeLogoUpdateRaf = window.requestAnimationFrame(() => {
    welcomeLogoUpdateRaf = 0;
    updateWelcomeLogoOnScroll();
    scheduleWelcomeBottomButtonsAlignment();
    scheduleWelcomeScrollHintAlignment();
  });
}

window.addEventListener("scroll", scheduleWelcomeLogoUpdate, { passive: true });
window.addEventListener("resize", scheduleWelcomeLogoUpdate);

// 100% zoom label baseline:
// Requirement: "100%" should correspond to a view where all of Israel is visible in the viewport.

function showPage(which, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const scrollTarget = options.scroll === "step1" || options.scroll === "welcome" ? options.scroll : null;
  const scrollBehavior = options.behavior === "smooth" ? "smooth" : "auto";

  const pages = [
    { key: "welcome", el: elPageWelcome },
    { key: "step1", el: elPageStep1 },
    { key: "step2", el: elPageStep2 },
    { key: "emotion", el: elPageEmotion },
    { key: "allmaps", el: elPageAllMaps },
    { key: "archive", el: elPageArchive },
  ];

  const isHomeFlow = which === "welcome" || which === "step1";

  document.body.classList.toggle("homeFlow", isHomeFlow);

  pages.forEach((p) => {
    if (!p.el) return;
    const shouldShow = isHomeFlow ? p.key === "welcome" || p.key === "step1" : p.key === which;
    p.el.classList.toggle("hidden", !shouldShow);
  });
  
  if (isHomeFlow) {
    // Apply any pending Step 1 reset after a successful Create+Save.
    maybeResetStep1AfterCreateSave();
  }

  if (isHomeFlow) {
    updateStep1Scale();
    scheduleWelcomeLogoUpdate();
  }

  // When the app becomes a scrollable flow, ensure we always land at a sane
  // scroll position when switching between full-screen pages.
  if (!isHomeFlow) {
    try {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } catch {
      // ignore
    }
  } else if (scrollTarget) {
    const targetEl = scrollTarget === "welcome" ? elPageWelcome : elPageStep1;
    if (targetEl && typeof targetEl.scrollIntoView === "function") {
      // Defer until after layout updates so the section exists in flow.
      requestAnimationFrame(() => {
        try {
          targetEl.scrollIntoView({ behavior: scrollBehavior, block: "start" });
        } catch {
          // ignore
        }
      });
    }
  }

  // Leaflet needs a size recalculation when its container becomes visible.
  if (which === "step2") {
    setTimeout(() => {
      // Default behavior: open with all Israel visible.
      step2OpenExtraZoomStops = 0;

      // Default: tiles hidden until user clicks "Show map".
      setGeoLayerEnabled(false);

      map.invalidateSize();
      resizeSplashCanvas();
      if (splashEnabled) redrawSplash();

      enforceMinZoomToAvoidBlankViewport(map);

      // Avoid showing a bogus percentage (e.g. 3%) while Leaflet is still
      // settling its size and before we snap to the Israel baseline.
      resetStep2ZoomLabelBase();

      syncGeoUi();
      updateStep2SignatureLabel();

      // When Step 2 opens, mark the saved addresses and draw their dots/line.
      clearStep2LifePath();
      renderStep2AddressDots();
      renderStep2AddressLine();

      // Requirement: the LifePath map page should open showing all Israel.
      pendingStep2View = null;
      requestStep2OpenFitToAddresses();
      forceStep2OpenFitToAddressesSoon(200);
      updateStep2ZoomLabel();
      return;
    }, 0);
  }

  if (which === "emotion") {
    setTimeout(() => {
      updateEmotionTitle();
      renderEmotionMap(pendingEmotionStart);
      pendingEmotionStart = null;
    }, 0);
  }

  if (which === "allmaps") {
    setTimeout(() => {
      ensureAllMapsMap();
      // Default: tiles hidden until user clicks "Show map".
      setAllMapsTilesVisible(false);
      if (allMapsMap) allMapsMap.invalidateSize();
      if (allMapsMap) enforceMinZoomToAvoidBlankViewport(allMapsMap);

      // Avoid showing a bogus percentage while Leaflet is still settling its size.
      allMapsZoomBase = null;
      if (allMapsMap) updateAllMapsZoomLabel();

      // Default behavior (match Step 2): open snapped to the tightest bounds
      // that still include all visible points inside Israel (fallback: Israel rectangle).
      allMapsHasAutoFitOnThisEntry = true;
      requestAllMapsOpenResetToBase();
      forceAllMapsOpenResetToBaseSoon(200);

      renderAllMapsCombinedMap();
      if (allMapsMap) updateAllMapsZoomLabel();
      alignAllMapsPanelToEditButton();
    }, 0);
  }

  if (which === "archive") {
    setTimeout(() => {
      renderArchiveGrid();
    }, 0);
  }
}

function createArchiveMiniMapSvg(snapshot) {
  const isNastyaFaybish = (() => {
    try {
      const full = String(snapshot?.fullName || "").trim().toLowerCase();
      const compact = full.replace(/\s+/g, "");
      if (compact === "nastyafaybish") return true;

      // Fallback: some older snapshots may only have label like "NastyaFaybish.08addrs".
      const label = String(snapshot?.label || "").trim().toLowerCase();
      const labelCompact = label.replace(/\s+/g, "");
      return labelCompact.startsWith("nastyafaybish.") || labelCompact.startsWith("nastyafaybish");
    } catch {
      return false;
    }
  })();

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  // Keep uniform scaling so circles stay circles (not ellipses).
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.classList.add("archiveThumb");

  // Requirement: zoom the archived thumbnails in by 10%.
  // This is done by shrinking the viewBox, which does NOT change marker sizes
  // in screen pixels because marker radii/strokes are stored as base px values
  // and converted to viewBox units at runtime (see attachArchiveThumbInteractions).
  const ARCHIVE_INITIAL_ZOOM_FACTOR = 1.21;

  // Archive thumbnails should visually match the Leaflet LifePath maps.
  // Leaflet circleMarker styling is defined in *pixels*:
  // - circle radius ~= 5
  // - circle stroke weight ~= belonging rate
  // - path line weight ~= 1
  // Because our thumbnails are SVG with a viewBox, we store these as
  // "base px" values on elements and convert them to viewBox units at runtime
  // (see attachArchiveThumbInteractions).
  const ARCHIVE_LINE_PX = 1;
  // Match Leaflet styling used elsewhere in the app:
  // radius = innerRadius + rate/2, stroke weight = rate.
  const ARCHIVE_CIRCLE_INNER_RADIUS_PX = 3;

  const addrs = Array.isArray(snapshot?.addresses) ? snapshot.addresses : [];
  const countries = new Set(
    addrs
      .map((a) => (a && a.valid !== false ? String(a.country || "").trim() : ""))
      .map((c) => toEnglishLike(c).trim().toLowerCase())
      .filter(Boolean)
  );
  // Some specific archive thumbnails need to render against the Israel baseline
  // even if country parsing collapses to a single value.
  const useIsraelViewport = countries.size > 1 || isNastyaFaybish;

  const pts = [];
  for (const a of addrs) {
    const ok = a && a.valid !== false && isFinite(a.lat) && isFinite(a.lon);
    if (!ok) continue;
    const rate = normalizeBelongingRate(a.belonging_rate, stableBelongingRateFromId(a.id));
    pts.push({ lat: Number(a.lat), lon: Number(a.lon), rate });
  }

  if (pts.length === 0) {
    return svg;
  }
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  /** @type {{lat:number, lon:number, rate:number}[]} */
  let israelPts = [];

  if (useIsraelViewport && typeof ISRAEL_BOUNDS !== "undefined" && ISRAEL_BOUNDS) {
    // Focus on Israel locations: when there are points inside Israel, fit to
    // their tight bounds (max zoom-in), otherwise fall back to the Israel frame.
    try {
      israelPts = pts.filter((p) => {
        try {
          return ISRAEL_BOUNDS.contains(L.latLng(Number(p.lat), Number(p.lon)));
        } catch {
          return false;
        }
      });
    } catch {
      israelPts = [];
    }

    if (israelPts.length > 0) {
      for (const p of israelPts) {
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
      }
    } else {
      const sw = ISRAEL_BOUNDS.getSouthWest();
      const ne = ISRAEL_BOUNDS.getNorthEast();
      minLon = sw.lng;
      maxLon = ne.lng;
      minLat = sw.lat;
      maxLat = ne.lat;
    }
  } else {
    for (const p of pts) {
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
    }
  }

  const xRange = Math.max(0, maxLon - minLon);
  const yRange = Math.max(0, maxLat - minLat);
  const span = Math.max(xRange, yRange, 1e-9);
  const extraLon = (span - xRange) / 2;
  const extraLat = (span - yRange) / 2;

  // Padding inside the thumbnail frame.
  // Markers keep constant *pixel* size (Leaflet-like), so after layout insets
  // the SVG can become smaller and markers become larger in viewBox units.
  // Use a larger padding to ensure Israel locations are never clipped.
  const pad = 18;
  const inner = 100 - pad * 2;

  const proj = (lon, lat) => {
    const nx = (lon - minLon + extraLon) / span;
    const ny = (maxLat - lat + extraLat) / span;
    const x = pad + nx * inner;
    const y = pad + ny * inner;
    return { x, y };
  };

  const projected = pts.map((p) => ({ ...proj(p.lon, p.lat), rate: p.rate }));

  // Precompute a tighter viewBox for optional zoom-in.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of projected) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const clampToView = !useIsraelViewport;
  const clamp = (v) => (clampToView ? Math.max(0, Math.min(100, v)) : v);

  const poly = document.createElementNS(NS, "polyline");
  poly.setAttribute(
    "points",
    projected
      .map((p) => `${clamp(p.x).toFixed(2)},${clamp(p.y).toFixed(2)}`)
      .join(" ")
  );
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "#000000");
  poly.dataset.baseStrokePx = String(ARCHIVE_LINE_PX);
  poly.setAttribute("stroke-width", "1");
  poly.setAttribute("stroke-linecap", "round");
  poly.setAttribute("stroke-linejoin", "round");
  svg.appendChild(poly);

  for (const p of projected) {
    const rate = normalizeBelongingRate(p.rate, 5);

    const baseRadiusPx = ARCHIVE_CIRCLE_INNER_RADIUS_PX + rate / 2;

    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", String(clamp(p.x)));
    c.setAttribute("cy", String(clamp(p.y)));
    c.dataset.baseRPx = String(baseRadiusPx);
    c.dataset.baseStrokePx = String(rate);
    c.setAttribute("r", "1");
    c.setAttribute("fill", "none");
    c.setAttribute("stroke", "#000000");
    c.setAttribute("stroke-width", "1");
    svg.appendChild(c);
  }

  try {
    if (useIsraelViewport) {
      svg.dataset.fullViewBox = "0 0 100 100";
      svg.dataset.zoomViewBox = "0 0 100 100";

      // Nastya Faybish: show the saved map framing (center/zoom) like the reference.
      // We map the saved Leaflet view into our Israel-projected 0..100 space and
      // derive a viewBox span using Leaflet zoom stops (each stop halves/doubles scale).
      if (isNastyaFaybish && snapshot?.view && isFinite(snapshot.view.lat) && isFinite(snapshot.view.lng) && isFinite(snapshot.view.zoom)) {
        // Prefer centering on the Israel cluster (so we don't crop to blank),
        // but still keep the abroad direction line (points outside viewBox).
        let israelBox = null;
        try {
          if (Array.isArray(israelPts) && israelPts.length > 0) {
            let bx0 = Infinity;
            let bx1 = -Infinity;
            let by0 = Infinity;
            let by1 = -Infinity;
            for (const p of israelPts) {
              const q = proj(Number(p.lon), Number(p.lat));
              if (q.x < bx0) bx0 = q.x;
              if (q.x > bx1) bx1 = q.x;
              if (q.y < by0) by0 = q.y;
              if (q.y > by1) by1 = q.y;
            }
            if (isFinite(bx0) && isFinite(bx1) && isFinite(by0) && isFinite(by1)) {
              israelBox = { x0: bx0, x1: bx1, y0: by0, y1: by1 };
            }
          }
        } catch {
          israelBox = null;
        }

        const center = (() => {
          if (israelBox) return { x: (israelBox.x0 + israelBox.x1) / 2, y: (israelBox.y0 + israelBox.y1) / 2 };
          try {
            if (ISRAEL_BOUNDS.contains(L.latLng(Number(snapshot.view.lat), Number(snapshot.view.lng)))) {
              return proj(Number(snapshot.view.lng), Number(snapshot.view.lat));
            }
          } catch {
            // ignore
          }
          return { x: 50, y: 50 };
        })();

        let referenceZoom = null;
        try {
          referenceZoom = typeof getIsraelReferenceZoom === "function" ? getIsraelReferenceZoom() : null;
        } catch {
          referenceZoom = null;
        }
        const dz = (Number(snapshot.view.zoom) || 0) - (Number(referenceZoom) || 0);
        const scale = Math.pow(2, dz);
        // User request: zoom in 5× compared to the current thumbnail framing.
        const extraZoomFactor = 5;
        const desiredSpan = (100 / (isFinite(scale) && scale > 0 ? scale : 1)) / extraZoomFactor;
        // Never zoom so far that the Israel cluster disappears entirely.
        const israelSpan = israelBox ? Math.max(israelBox.x1 - israelBox.x0, israelBox.y1 - israelBox.y0) : 0;

        // Add padding so circles/strokes don't get clipped by the viewBox edges.
        const markerPadUnits = 10;
        const baseSpan = Math.max(desiredSpan, israelSpan > 0 ? israelSpan + markerPadUnits * 2 : 0);
        const span = Math.max(3, Math.min(100, baseSpan + markerPadUnits * 2));

        const rawX = (Number(center?.x) || 50) - span / 2;
        const rawY = (Number(center?.y) || 50) - span / 2;
        const x = Math.max(0, Math.min(100 - span, rawX));
        const y = Math.max(0, Math.min(100 - span, rawY));
        svg.setAttribute("viewBox", `${x.toFixed(2)} ${y.toFixed(2)} ${span.toFixed(2)} ${span.toFixed(2)}`);
        svg.classList.toggle("isZoomed", span < 99.99);
      }

      // Apply the requested 10% zoom-in to the current viewBox.
      try {
        const fullVb = parseSvgViewBox(svg.dataset.fullViewBox || "0 0 100 100");
        const curVb = parseSvgViewBox(svg.getAttribute("viewBox") || svg.dataset.fullViewBox || "0 0 100 100");
        const nextW = Math.max(1, curVb.w / ARCHIVE_INITIAL_ZOOM_FACTOR);
        const nextH = Math.max(1, curVb.h / ARCHIVE_INITIAL_ZOOM_FACTOR);
        const cx = curVb.x + curVb.w / 2;
        const cy = curVb.y + curVb.h / 2;
        const next = clampSvgViewBoxToBounds({ x: cx - nextW / 2, y: cy - nextH / 2, w: nextW, h: nextH }, fullVb);
        svg.setAttribute("viewBox", formatSvgViewBox(next));
      } catch {
        // ignore
      }

      return svg;
    }

    const maxRate = Math.max(1, ...projected.map((p) => normalizeBelongingRate(p.rate, 5)));
    // Outer edge in pixels ~= (innerRadius + rate/2) + rate/2 = innerRadius + rate
    const maxOuterPx = ARCHIVE_CIRCLE_INNER_RADIUS_PX + maxRate;
    const margin = 6 + maxOuterPx;
    const x0 = Math.max(0, minX - margin);
    const y0 = Math.max(0, minY - margin);
    const x1 = Math.min(100, maxX + margin);
    const y1 = Math.min(100, maxY + margin);
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const span = Math.max(w, h);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const sx0 = Math.max(0, Math.min(100 - span, cx - span / 2));
    const sy0 = Math.max(0, Math.min(100 - span, cy - span / 2));
    svg.dataset.fullViewBox = "0 0 100 100";
    svg.dataset.zoomViewBox = `${sx0.toFixed(2)} ${sy0.toFixed(2)} ${span.toFixed(2)} ${span.toFixed(2)}`;

    // Apply the requested 10% zoom-in to the default framing.
    try {
      const fullVb = parseSvgViewBox(svg.dataset.fullViewBox || "0 0 100 100");
      const curVb = parseSvgViewBox(svg.getAttribute("viewBox") || svg.dataset.fullViewBox || "0 0 100 100");
      const nextW = Math.max(1, curVb.w / ARCHIVE_INITIAL_ZOOM_FACTOR);
      const nextH = Math.max(1, curVb.h / ARCHIVE_INITIAL_ZOOM_FACTOR);
      const cx = curVb.x + curVb.w / 2;
      const cy = curVb.y + curVb.h / 2;
      const next = clampSvgViewBoxToBounds({ x: cx - nextW / 2, y: cy - nextH / 2, w: nextW, h: nextH }, fullVb);
      svg.setAttribute("viewBox", formatSvgViewBox(next));
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }

  return svg;
}

function createArchiveEmotionSvg(snapshot) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.classList.add("archiveEmotionThumb");

  const addrs = Array.isArray(snapshot?.addresses) ? snapshot.addresses : [];
  const points = [];
  for (const a of addrs) {
    const ok = a && a.valid !== false;
    if (!ok) continue;
    const strokeWidth = normalizeBelongingRate(a?.belonging_rate, stableBelongingRateFromId(a?.id));
    points.push({ strokeWidth });
  }

  const n = points.length;
  if (n <= 0) return svg;

  const maxStroke = Math.max(1, ...points.map((p) => Number(p.strokeWidth) || 1));
  const cx = 1000 / 2;
  const cy = 1000 / 2;
  const padding = 14 + maxStroke;
  const manyRingsScale = n > 12 ? 0.5 : 1;
  const maxR = Math.max(1, (1000 / 2 - padding) * manyRingsScale);
  const radii = computeEmotionRingRadii(maxR, points.map((p) => p.strokeWidth));

  for (let i = 0; i < n; i++) {
    // Always use the affiliation-based stroke width, regardless of radius
    const strokeWidth = Math.max(1, Number(points[i].strokeWidth) || 1) + EMOTION_STROKE_BOOST;
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", String(cy));
    c.setAttribute("r", String(radii[i] || 1));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke", "#000000");
    c.setAttribute("stroke-width", String(strokeWidth));
    svg.appendChild(c);
  }

  return svg;
}

function parseSvgViewBox(str) {
  const parts = String(str || "").trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !isFinite(n))) return { x: 0, y: 0, w: 100, h: 100 };
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function formatSvgViewBox(vb) {
  const x = Number(vb?.x) || 0;
  const y = Number(vb?.y) || 0;
  const w = Math.max(1, Number(vb?.w) || 100);
  const h = Math.max(1, Number(vb?.h) || 100);
  return `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`;
}

function clampSvgViewBoxToBounds(vb, bounds) {
  const bx = Number(bounds?.x) || 0;
  const by = Number(bounds?.y) || 0;
  const bw = Math.max(1, Number(bounds?.w) || 100);
  const bh = Math.max(1, Number(bounds?.h) || 100);

  let x = Number(vb?.x) || 0;
  let y = Number(vb?.y) || 0;
  let w = Math.max(1, Number(vb?.w) || 100);
  let h = Math.max(1, Number(vb?.h) || 100);

  w = Math.min(w, bw);
  h = Math.min(h, bh);

  x = Math.max(bx, Math.min(x, bx + bw - w));
  y = Math.max(by, Math.min(y, by + bh - h));

  return { x, y, w, h };
}

function attachArchiveThumbInteractions(thumb, onActivate) {
  if (!thumb) return;

  let drag = null;
  let didMove = false;

  const updateMarkerSizesForViewBox = () => {
    // Convert stored "base px" sizes into viewBox units so the thumbnail
    // behaves like Leaflet (marker radius/weights stay constant in screen px).
    const rect = thumb.getBoundingClientRect();
    const pxW = Math.max(1, Number(rect?.width) || 0);
    if (!(pxW > 0)) return;

    const vb = parseSvgViewBox(thumb.getAttribute("viewBox"));
    const unitsPerPx = vb.w / pxW;
    if (!isFinite(unitsPerPx) || unitsPerPx <= 0) return;

    const polylines = thumb.querySelectorAll("polyline[data-base-stroke-px]");
    for (const p of polylines) {
      const baseStrokePx = Number(p.dataset.baseStrokePx);
      if (!isFinite(baseStrokePx)) continue;
      // Do not clamp aggressively: when viewBox is very small (heavy zoom-in),
      // a large minimum in viewBox units turns into *thick* pixels.
      p.setAttribute("stroke-width", String(Math.max(0.001, baseStrokePx * unitsPerPx)));
    }

    const circles = thumb.querySelectorAll("circle[data-base-r-px]");
    for (const c of circles) {
      const baseRPx = Number(c.dataset.baseRPx);
      const baseStrokePx = Number(c.dataset.baseStrokePx);
      if (!isFinite(baseRPx) || !isFinite(baseStrokePx)) continue;
      c.setAttribute("r", String(Math.max(0.001, baseRPx * unitsPerPx)));
      c.setAttribute("stroke-width", String(Math.max(0.001, baseStrokePx * unitsPerPx)));
    }
  };

  thumb.addEventListener(
    "wheel",
    (e) => {
      const full = thumb.dataset.fullViewBox || "0 0 100 100";
      const hasZoom = Boolean(thumb.dataset.zoomViewBox);
      if (!hasZoom) return;

      // Let the page scroll normally when hovering an archive tile.
      // Only zoom/pan the thumbnail when the user explicitly holds a modifier.
      if (!(e.ctrlKey || e.metaKey || e.altKey)) return;

      e.preventDefault();
      e.stopPropagation();

      const rect = thumb.getBoundingClientRect();
      const px = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
      const py = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
      const ux = Math.max(0, Math.min(1, px));
      const uy = Math.max(0, Math.min(1, py));

      const current = parseSvgViewBox(thumb.getAttribute("viewBox"));
      const fullVb = parseSvgViewBox(full);

      const direction = e.deltaY > 0 ? 1 : -1;
      const factor = direction > 0 ? 1.12 : 1 / 1.12;

      const minSize = 10;
      const nextW = Math.max(minSize, Math.min(fullVb.w, current.w * factor));
      const nextH = Math.max(minSize, Math.min(fullVb.h, current.h * factor));

      const mx = current.x + ux * current.w;
      const my = current.y + uy * current.h;

      const nextX = mx - ux * nextW;
      const nextY = my - uy * nextH;

      const next = clampSvgViewBoxToBounds({ x: nextX, y: nextY, w: nextW, h: nextH }, fullVb);
      thumb.setAttribute("viewBox", formatSvgViewBox(next));
      updateMarkerSizesForViewBox();

      const isFull = Math.abs(next.w - fullVb.w) < 0.01 && Math.abs(next.h - fullVb.h) < 0.01;
      thumb.classList.toggle("isZoomed", !isFull);
    },
    { passive: false }
  );

  // For thumbnails that are not zoomable/pannable, use a plain click to open.
  thumb.addEventListener("click", (e) => {
    const hasZoom = Boolean(thumb.dataset.zoomViewBox);
    if (hasZoom) return;
    if (typeof onActivate !== "function") return;
    e.preventDefault();
    e.stopPropagation();
    onActivate();
  });

  thumb.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const full = thumb.dataset.fullViewBox || "0 0 100 100";
    const hasZoom = Boolean(thumb.dataset.zoomViewBox);
    if (!hasZoom) return;

    e.preventDefault();
    e.stopPropagation();

    try {
      thumb.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const rect = thumb.getBoundingClientRect();
    didMove = false;
    drag = {
      id: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      rectW: Math.max(1, rect.width),
      rectH: Math.max(1, rect.height),
      startVb: parseSvgViewBox(thumb.getAttribute("viewBox")),
      bounds: parseSvgViewBox(full),
    };
    thumb.classList.add("isDragging");
  });

  thumb.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;

    if (!didMove && Math.hypot(dx, dy) > 5) didMove = true;

    const unitsPerPxX = drag.startVb.w / drag.rectW;
    const unitsPerPxY = drag.startVb.h / drag.rectH;

    const nextX = drag.startVb.x - dx * unitsPerPxX;
    const nextY = drag.startVb.y - dy * unitsPerPxY;

    const next = clampSvgViewBoxToBounds({ x: nextX, y: nextY, w: drag.startVb.w, h: drag.startVb.h }, drag.bounds);
    thumb.setAttribute("viewBox", formatSvgViewBox(next));
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    e.stopPropagation();

    const shouldActivate = !didMove;
    drag = null;
    thumb.classList.remove("isDragging");
    try {
      thumb.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    if (shouldActivate && typeof onActivate === "function") {
      onActivate();
    }
  };

  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);

  // Ensure correct sizing once inserted into the DOM.
  requestAnimationFrame(() => updateMarkerSizesForViewBox());
}

function renderArchiveGrid() {
  if (!elArchiveGrid || !elArchiveEmpty) return;

  const list = getSavedMaps();
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  elArchiveEmpty.classList.toggle("hidden", items.length !== 0);

  // Order tiles by save time (oldest first), filling left-to-right.
  // Prefer the saved serial when present so lifemap06 is always the 6th save.
  const ordered = items
    .map((snap, idx) => ({ snap, idx }))
    .sort((a, b) => {
      const sa = Number(a.snap?.serial);
      const sb = Number(b.snap?.serial);
      const hasSa = Number.isFinite(sa) && sa > 0;
      const hasSb = Number.isFinite(sb) && sb > 0;
      if (hasSa && hasSb) return sa - sb;
      if (hasSa && !hasSb) return -1;
      if (!hasSa && hasSb) return 1;

      const ta = Date.parse(String(a.snap?.savedAt || ""));
      const tb = Date.parse(String(b.snap?.savedAt || ""));
      if (isFinite(ta) && isFinite(tb)) return ta - tb;
      if (isFinite(ta) && !isFinite(tb)) return -1;
      if (!isFinite(ta) && isFinite(tb)) return 1;
      return a.idx - b.idx;
    })
    .map((x) => x.snap);

  elArchiveGrid.innerHTML = "";
  for (let i = 0; i < ordered.length; i++) {
    const snap = ordered[i];
    const item = document.createElement("div");
    item.className = "archiveItem";

    const serial = Number.isFinite(Number(snap?.serial)) && Number(snap?.serial) > 0 ? Number(snap.serial) : i + 1;
    const serialEl = document.createElement("div");
    serialEl.className = "archiveSerial";
    // Archive tile title should be the map name (e.g. HilaLustig.08addrs), not lifemapNN.
    serialEl.textContent = String(snap?.label || formatLifeMapLabel(serial));

    const preview = document.createElement("div");
    preview.className = "archivePreview";

    const thumb = createArchiveMiniMapSvg(snap);

    const emotion = createArchiveEmotionSvg(snap);

    const footer = document.createElement("div");
    footer.className = "archiveFooter";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "archiveRemoveBtn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteSavedMapSnapshot(getSavedMapKey(snap) || snap?.label);
      renderArchiveGrid();
    });

    // The map name is shown at the top of the tile. Keep the footer for Remove only.
    footer.appendChild(removeBtn);

    item.addEventListener("mouseenter", () => item.classList.add("showEmotion"));
    item.addEventListener("mouseleave", () => item.classList.remove("showEmotion"));

    item.appendChild(serialEl);
    preview.appendChild(thumb);
    attachArchiveThumbInteractions(thumb, () => openSavedMapSnapshotFromArchive(snap));
    preview.appendChild(emotion);
    item.appendChild(preview);
    item.appendChild(footer);
    elArchiveGrid.appendChild(item);
  }
}

function openSavedMapSnapshotFromArchive(snapshot) {
  if (!snapshot) return;

  // If the user opens a map from Archive, closing (X) should return to Archive.
  step2OpenedFromArchive = true;
  setStep2CloseReturnPage("archive");

  // Requirement: after clicking an Archive tile, show the pulsing-circle
  // transition for 1.5 seconds, then display the selected map.
  if (createLifePathTransitionActive) return;
  createLifePathTransitionActive = true;
  showCreateLifePathTransition(true);

  setTimeout(() => {
    try {
      showCreateLifePathTransition(false);
      openSavedMapSnapshot(snapshot);
    } finally {
      createLifePathTransitionActive = false;
    }
  }, 1500);
}

/** @type {{lat:number, lng:number, zoom:number} | null} */
let pendingStep2View = null;

// When entering Step 2 from specific entry points (Create / Archive), fit the view
// to the Israel baseline after Leaflet has a real size.
let step2OpenShouldFitToAddresses = false;

// In the Create flow we auto-run Draw right after opening Step 2.
// The draw completion handler used to auto-fit to addresses, which can override
// the requested "open at Israel baseline" behavior. This flag keeps the opening
// view stable until the first auto-draw completes.
// the first auto-draw completes.
let step2HoldFitAfterNextDraw = false;

// In the Create flow we want the Step 2 page to *visibly* open at 100% first,
// then start the auto-draw. This flag delays the draw click until after the
// snap-to-100 has completed.
let autoDrawAfterStep2OpenAt100 = false;

// Extra zoom (in Leaflet zoom stops) applied to the Step 2 "100%" baseline.
// Default is 0; Archive can temporarily override this for clearer graphics.
let step2OpenExtraZoomStops = 0;

function requestStep2OpenFitToAddresses() {
  step2OpenShouldFitToAddresses = true;
}

function forceStep2OpenFitToAddressesSoon(triesLeft = 200) {
  if (!step2OpenShouldFitToAddresses) return;
  if (!elPageStep2 || elPageStep2.classList.contains("hidden")) return;
  if (!elMap) return;
  if (elMap.classList.contains("hidden")) {
    if (triesLeft > 0) window.setTimeout(() => forceStep2OpenFitToAddressesSoon(triesLeft - 1), 120);
    return;
  }

  // Leaflet can temporarily report a 0x0 size right after a page switch.
  // Force a size recalculation before we decide whether the map is ready.
  try {
    map.invalidateSize(true);
  } catch {
    // ignore
  }

  const rect = elMap.getBoundingClientRect();
  const okSize = (Number(rect?.width) || 0) > 20 && (Number(rect?.height) || 0) > 20;
  let mapSizeOk = false;
  try {
    const s = map.getSize();
    mapSizeOk = (Number(s?.x) || 0) > 20 && (Number(s?.y) || 0) > 20;
  } catch {
    mapSizeOk = false;
  }

  if (!okSize || !mapSizeOk) {
    if (triesLeft > 0) window.setTimeout(() => forceStep2OpenFitToAddressesSoon(triesLeft - 1), 80);
    return;
  }

  // Apply the snap on the next frame, after Leaflet recalculates its size.
  requestAnimationFrame(() => {
    try {
      // Snap to a view that zooms in as much as possible while still including
      // all Israel-located points.
      focusMapOnIsraelLocationsMax();
      setStep2ZoomLabelBaseToCurrentView();
      updateStep2ZoomLabel();
      step2OpenShouldFitToAddresses = false;

      // If we entered Step 2 via the Create flow, save immediately after the
      // opening 100% view has settled (before auto-draw starts).
      if (autoSaveAfterStep2OpenAt100) {
        autoSaveAfterStep2OpenAt100 = false;
        maybeAutoSaveCurrentMapSnapshot();
      }

      // If we entered Step 2 via the Create flow, start the auto-draw only
      // after the 100% view has settled.
      if (autoDrawAfterStep2OpenAt100) {
        autoDrawAfterStep2OpenAt100 = false;
        if (elDrawBtn) {
          // Defer to avoid running inside this rAF.
          setTimeout(() => elDrawBtn.click(), 0);
        }
      }
    } catch {
      // ignore
    }
  });
}

function openSavedMapSnapshot(snapshot) {
  if (!snapshot) return;

  // Track which saved map is being edited so re-saving updates in place.
  try {
    const id = String(snapshot.id || "");
    const label = String(snapshot.label || "");
    const savedAt = String(snapshot.savedAt || "");
    currentEditingSnapshot = { id, label, savedAt };

    // If this snapshot doesn't have an id yet, assign one in storage.
    if (!id && label) {
      const list = getSavedMaps();
      const idx = (Array.isArray(list) ? list : []).findIndex((x) => x && String(x.label || "") === label && String(x.savedAt || "") === savedAt);
      if (idx >= 0) {
        const copy = list.slice();
        const next = { ...(copy[idx] || {}) };
        next.id = ensureSnapshotId(next);
        copy[idx] = next;
        setSavedMaps(copy);
        currentEditingSnapshot = { id: String(next.id || ""), label, savedAt };
      }
    }
  } catch {
    // ignore
  }

  const nextName = sanitizeEnglishOnlyName(String(snapshot.fullName || ""));
  if (elStudentName) elStudentName.value = nextName;

  const nextAddressesRaw = Array.isArray(snapshot.addresses) ? snapshot.addresses : [];
  try {
    addresses = migrateAddresses(JSON.parse(JSON.stringify(nextAddressesRaw)));
  } catch {
    addresses = migrateAddresses(nextAddressesRaw);
  }

  // Seed auto-save dedupe with the opened map so re-drawing without changes
  // doesn't immediately update/save the snapshot.
  lastAutoSavedAddressesSignature = getAddressesSignatureForAutoSave();

  saveJson(STORAGE_KEY, addresses);
  renderList();
  updateStep1Headers();
  updateCreateLifePathButtonState();
  currentAddressVerified = false;
  updateAddButtonState();

  if (typeof setGeoLayerEnabled === "function") {
    const hasSetting = snapshot && typeof snapshot === "object" && Object.prototype.hasOwnProperty.call(snapshot, "geoLayerEnabled");
    setGeoLayerEnabled(hasSetting ? Boolean(snapshot.geoLayerEnabled) : true);
  }

  // Requirement: opening a LifePath map should start with all Israel visible.
  // (Ignore the stored view when entering Step 2 from the Archive.)
  pendingStep2View = null;

  // Note: showPage('step2') schedules its opening fit on a timer, so setting
  // this immediately after the page switch still affects the fit.
  showPage("step2");
  step2OpenExtraZoomStops = 0;
  requestStep2OpenFitToAddresses();
  forceStep2OpenFitToAddressesSoon(200);
}

/** @type {L.Map | null} */
let allMapsMap = null;
/** @type {L.TileLayer | null} */
let allMapsTileLayer = null;
/** @type {L.LayerGroup | null} */
let allMapsLineArtLayer = null;
/** @type {L.LayerGroup | null} */
let allMapsVectorLayer = null;

const allMapsLineArtState = {
  lastKey: "",
  /** @type {AbortController | null} */
  abort: null,
  /** @type {number | null} */
  timer: null,
  /** @type {any} */
  renderer: null,
};

let allMapsTilesVisible = false;

/** @type {string | null} */
let allMapsHighlightedKey = null;

// Keep the All Maps view stable when the user interacts with the list.
// We only auto-fit once when entering the All Maps page.
let allMapsHasAutoFitOnThisEntry = false;

/** @type {number | null} */
let allMapsZoomBase = null;

// When entering All Maps, snap to the same default bounds logic as Step 2,
// but only after Leaflet has a real, non-zero size.
let allMapsOpenShouldResetToBase = false;

function requestAllMapsOpenResetToBase() {
  allMapsOpenShouldResetToBase = true;
}

function forceAllMapsOpenResetToBaseSoon(triesLeft = 200) {
  if (!allMapsOpenShouldResetToBase) return;
  if (!elPageAllMaps || elPageAllMaps.classList.contains("hidden")) return;
  if (!elAllMapsMap || !allMapsMap) return;

  // Leaflet can temporarily report a 0x0 size right after a page switch.
  try {
    allMapsMap.invalidateSize(true);
  } catch {
    // ignore
  }

  const rect = elAllMapsMap.getBoundingClientRect();
  const okSize = (Number(rect?.width) || 0) > 20 && (Number(rect?.height) || 0) > 20;
  let mapSizeOk = false;
  try {
    const s = allMapsMap.getSize();
    mapSizeOk = (Number(s?.x) || 0) > 20 && (Number(s?.y) || 0) > 20;
  } catch {
    mapSizeOk = false;
  }

  if (!okSize || !mapSizeOk) {
    if (triesLeft > 0) window.setTimeout(() => forceAllMapsOpenResetToBaseSoon(triesLeft - 1), 80);
    return;
  }

  requestAnimationFrame(() => {
    try {
      resetAllMapsZoomToBase();
      allMapsOpenShouldResetToBase = false;
    } catch {
      // ignore
    }
  });
}

// Zoom label calibration: 3200% = 32x = 2^5.
// Requirement: show 100% at the zoom level that is ~3200% relative to the "world" framing.
const ZOOM_LABEL_WORLD_OFFSET_STOPS = 5;

// Requirement: make the "100%" label correspond to a more zoomed-in level.
// Each +1 stop is 2x closer (without forcing the map to auto-zoom).
const ZOOM_LABEL_DEFAULT_100_EXTRA_ZOOM_STOPS = 5;

function getMapMaxZoom(targetMap) {
  if (!targetMap) return null;
  try {
    if (typeof targetMap.getMaxZoom === "function") {
      const z = targetMap.getMaxZoom();
      return isFinite(z) ? z : null;
    }
  } catch {
    // ignore
  }

  const opt = targetMap && targetMap.options ? Number(targetMap.options.maxZoom) : NaN;
  return isFinite(opt) ? opt : null;
}

function bumpMapZoomForDefault100Percent(targetMap, extraStops) {
  if (!targetMap || typeof targetMap.getZoom !== "function" || typeof targetMap.setZoom !== "function") return false;
  const stops = Math.max(0, Math.round(Number(extraStops) || 0));
  if (stops <= 0) return false;

  const current = targetMap.getZoom();
  if (!isFinite(current)) return false;

  const maxZ = getMapMaxZoom(targetMap);
  const desired = isFinite(maxZ) ? Math.min(maxZ, current + stops) : current + stops;
  if (!isFinite(desired) || desired === current) return false;

  try {
    targetMap.setZoom(desired, { animate: false });
    return true;
  } catch {
    return false;
  }
}

function getAllMapsIsraelReferenceZoom() {
  if (!allMapsMap) return 0;
  try {
    const bounds = ISRAEL_BOUNDS.pad(ISRAEL_FIT_PADDING);
    return allMapsMap.getBoundsZoom(bounds, false) + ZOOM_LABEL_ISRAEL_OFFSET_STOPS;
  } catch {
    return allMapsMap.getZoom();
  }
}

const WORLD_BOUNDS = L.latLngBounds(
  // Avoid the poles for nicer framing.
  [-60, -170],
  [80, 170]
);

function getWorldReferenceZoom(targetMap) {
  if (!targetMap) return 0;
  try {
    const bounds = WORLD_BOUNDS.pad(0.02);
    return targetMap.getBoundsZoom(bounds, false);
  } catch {
    return targetMap.getZoom ? targetMap.getZoom() : 0;
  }
}

function setAllMapsZoomLabelBaseToIsrael() {
  allMapsZoomBase = getAllMapsIsraelReferenceZoom();
  updateAllMapsZoomLabel();
}

function setAllMapsZoomLabelBaseToWorld() {
  // Define 100% as the view that is ~3200% relative to the world framing.
  // (i.e. shift the world reference by +5 zoom levels).
  allMapsZoomBase = allMapsMap
    ? getWorldReferenceZoom(allMapsMap) + ZOOM_LABEL_WORLD_OFFSET_STOPS
    : getWorldReferenceZoom(allMapsMap);
  updateAllMapsZoomLabel();
}

function setAllMapsZoomLabelBaseToCurrentView() {
  if (!allMapsMap) return;
  allMapsZoomBase = allMapsMap.getZoom();
  updateAllMapsZoomLabel();
}

function updateAllMapsZoomLabel() {
  if (!elAllMapsZoomLabel || !allMapsMap) return;
  if (allMapsZoomBase === null || !isFinite(allMapsZoomBase)) {
    elAllMapsZoomLabel.textContent = "";
    return;
  }
  const dz = allMapsMap.getZoom() - allMapsZoomBase;
  const pct = Math.max(1, Math.round(100 * Math.pow(2, dz)));
  elAllMapsZoomLabel.textContent = `${pct}%`;
}

function resetAllMapsZoomToBase() {
  if (!allMapsMap) return;
  try {
    // Match Step 2: zoom in as much as possible while still including all
    // visible locations inside Israel. If none are inside Israel, fall back
    // to the default Israel rectangle.
    focusAllMapsOnIsraelLocationsMax();
    setAllMapsZoomLabelBaseToCurrentView();
    updateAllMapsZoomLabel();
  } catch {
    // ignore
  }
}

function focusAllMapsOnIsraelLocationsMax() {
  if (!allMapsMap) return;

  // If Leaflet hasn't measured a real size yet, avoid computing a bogus fit.
  try {
    const size = allMapsMap.getSize();
    const w = Number(size?.x) || 0;
    const h = Number(size?.y) || 0;
    if (w < 40 || h < 40) return;
  } catch {
    return;
  }

  const list = getSavedMaps();
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  const hidden = getAllMapsHiddenLabels();
  const visibleItems = items.filter((x) => {
    if (!x) return false;
    const label = String(x.label || "");
    const key = String(getSavedMapKey(x) || "");
    return !((key && hidden.has(key)) || (label && hidden.has(label)));
  });

  const pts = [];
  for (const snap of visibleItems) {
    const addrs = Array.isArray(snap?.addresses) ? snap.addresses : [];
    for (const a of addrs) {
      const ok = a && a.valid !== false && isFinite(a.lat) && isFinite(a.lon);
      if (!ok) continue;
      const ll = L.latLng(Number(a.lat), Number(a.lon));
      if (ISRAEL_BOUNDS.contains(ll)) pts.push(ll);
    }
  }

  const bounds = pts.length > 0 ? L.latLngBounds(pts) : ISRAEL_BOUNDS;
  if (!bounds.isValid()) return;

  const pad = pts.length > 0 ? 0.06 : ISRAEL_FIT_PADDING;
  allMapsMap.fitBounds(bounds.pad(pad), {
    animate: false,
    maxZoom: getMapMaxZoom(allMapsMap) ?? undefined,
  });
  enforceMinZoomToAvoidBlankViewport(allMapsMap);
}

function updateAllMapsCountLabel(visibleCount) {
  if (!elAllMapsCountLabel) return;
  const n = Math.max(0, Number(visibleCount) || 0);
  const two = n < 100 ? String(n).padStart(2, "0") : String(n);
  elAllMapsCountLabel.textContent = `${two}lifepathe.maps`;
}

function updateAllMapsHideMapLabel() {
  if (!elAllMapsHideMapBtn) return;
  elAllMapsHideMapBtn.textContent = allMapsTilesVisible ? "Hide map" : "Show map";
}

function setAllMapsTilesVisible(enabled) {
  if (!allMapsMap) return;
  const want = Boolean(enabled);
  if (want === Boolean(allMapsTilesVisible)) {
    updateAllMapsHideMapLabel();
    if (elPageAllMaps) {
      elPageAllMaps.classList.toggle("dark-map-ui", Boolean(allMapsTilesVisible) && isDarkBasemap(basemapStyleId));
    }
    restyleAllMapsOverlaysForBasemap();
    return;
  }

  allMapsTilesVisible = want;
  const isLineArt = isLineArtBasemap(basemapStyleId);

  if (isLineArt) {
    if (!allMapsLineArtLayer) allMapsLineArtLayer = L.layerGroup();
    if (allMapsTilesVisible) {
      allMapsLineArtLayer.addTo(allMapsMap);
      scheduleLineArtUpdate(allMapsMap, allMapsLineArtLayer, allMapsLineArtState);
    } else {
      if (allMapsMap.hasLayer(allMapsLineArtLayer)) allMapsMap.removeLayer(allMapsLineArtLayer);
    }
  } else {
    if (!allMapsTileLayer) allMapsTileLayer = createBasemapTileLayer(basemapStyleId);
    if (!allMapsTileLayer) return;
    if (allMapsTilesVisible) {
      allMapsTileLayer.addTo(allMapsMap);
    } else {
      if (allMapsMap.hasLayer(allMapsTileLayer)) allMapsMap.removeLayer(allMapsTileLayer);
    }
  }

  updateAllMapsHideMapLabel();

  if (elPageAllMaps) {
    elPageAllMaps.classList.toggle("dark-map-ui", Boolean(allMapsTilesVisible) && isDarkBasemap(basemapStyleId));
  }

  // Keep overlays readable when toggling tiles.
  restyleAllMapsOverlaysForBasemap();
}

function toggleAllMapsTiles() {
  setAllMapsTilesVisible(!allMapsTilesVisible);
}

function ensureAllMapsMap() {
  if (!elAllMapsMap || allMapsMap) return;

  allMapsMap = L.map(elAllMapsMap, {
    zoomControl: false,
    attributionControl: false,
    // Smoother zoom on trackpads / high-res wheels.
    zoomSnap: 0.3,
    zoomDelta: 0.3,
    wheelPxPerZoomLevel: 50,
    wheelDebounceTime: 15,
  });

  allMapsTileLayer = createBasemapTileLayer(basemapStyleId);
  updateAllMapsHideMapLabel();
  applyBasemapStyleClasses();

  // Default: tiles hidden until user clicks "Show map".
  allMapsTilesVisible = false;
  updateAllMapsHideMapLabel();
  if (elPageAllMaps) {
    elPageAllMaps.classList.toggle("dark-map-ui", false);
  }

  if (allMapsTilesVisible) {
    if (isLineArtBasemap(basemapStyleId)) {
      if (!allMapsLineArtLayer) allMapsLineArtLayer = L.layerGroup();
      allMapsLineArtLayer.addTo(allMapsMap);
      scheduleLineArtUpdate(allMapsMap, allMapsLineArtLayer, allMapsLineArtState);
    } else if (allMapsTileLayer) {
      allMapsTileLayer.addTo(allMapsMap);
    }
  }

  allMapsVectorLayer = L.layerGroup().addTo(allMapsMap);

  allMapsMap.on("zoomend", () => {
    updateAllMapsZoomLabel();
    if (allMapsTilesVisible && isLineArtBasemap(basemapStyleId) && allMapsLineArtLayer) {
      scheduleLineArtUpdate(allMapsMap, allMapsLineArtLayer, allMapsLineArtState);
    }
  });

  allMapsMap.on("moveend", () => {
    if (allMapsTilesVisible && isLineArtBasemap(basemapStyleId) && allMapsLineArtLayer) {
      scheduleLineArtUpdate(allMapsMap, allMapsLineArtLayer, allMapsLineArtState);
    }
  });

  // Use a sane default view near Israel (match Step 2; avoid world view).
  allMapsMap.setView([31.5, 35.1], 7, { animate: false });
  enforceMinZoomToAvoidBlankViewport(allMapsMap);

  // Leave the label blank until the page-open finalizes the baseline.
  allMapsZoomBase = null;
  updateAllMapsZoomLabel();
}

function alignAllMapsPanelToEditButton() {
  if (!elAllMapsEditBtn) return;
  const panel = document.querySelector("#pageAllMaps .allMapsPanel");
  if (!panel) return;
  try {
    const rect = elAllMapsEditBtn.getBoundingClientRect();
    const right = Math.max(0, Math.round((window.innerWidth || 0) - rect.right));
    panel.style.right = `${right}px`;
  } catch {
    // ignore
  }
}

function deleteSavedMapSnapshot(keyOrLabel) {
  const key = String(keyOrLabel || "");
  if (!key) return;

  if (
    currentEditingSnapshot &&
    (String(currentEditingSnapshot.id || "") === key || String(currentEditingSnapshot.label || "") === key)
  ) {
    currentEditingSnapshot = null;
  }

  const list = getSavedMaps();
  const next = (Array.isArray(list) ? list : []).filter((x) => {
    if (!x || typeof x !== "object") return false;
    const xid = String(x.id || "");
    const xl = String(x.label || "");
    return xid ? xid !== key : xl !== key;
  });
  setSavedMaps(next);

  const hidden = getAllMapsHiddenLabels();
  // Back-compat: old hidden entries may be stored by label.
  if (hidden.has(key)) hidden.delete(key);
  // Also remove a label-based entry if we deleted by id.
  const deletedLabel = (Array.isArray(list) ? list : []).find((x) => x && typeof x === "object" && String(x.id || "") === key)?.label;
  if (deletedLabel && hidden.has(String(deletedLabel))) hidden.delete(String(deletedLabel));
  setAllMapsHiddenLabels(hidden);

  renderAllMapsCombinedMap();
}

function toggleHiddenSavedMapSnapshot(keyOrLabel) {
  const key = String(keyOrLabel || "");
  if (!key) return;
  const hidden = getAllMapsHiddenLabels();
  // Back-compat: if an old label-based key exists, remove it when toggling.
  if (hidden.has(key)) {
    hidden.delete(key);
  } else {
    hidden.add(key);
  }
  setAllMapsHiddenLabels(hidden);
  renderAllMapsCombinedMap();
}

function renderAllMapsCombinedMap() {
  if (!allMapsMap || !allMapsVectorLayer || !elSavedMapsEmpty) return;

  const preservedCenter = allMapsMap.getCenter();
  const preservedZoom = allMapsMap.getZoom();

  allMapsVectorLayer.clearLayers();

  const list = getSavedMaps();
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  elSavedMapsEmpty.classList.toggle("hidden", items.length !== 0);

  const hidden = getAllMapsHiddenLabels();
  const visibleItems = items.filter((x) => {
    if (!x) return false;
    const label = String(x.label || "");
    const key = String(getSavedMapKey(x) || "");
    return !((key && hidden.has(key)) || (label && hidden.has(label)));
  });

  // Rendering order: keep the highlighted map on top so it can't be hidden
  // by other maps.
  const renderOrder = (() => {
    if (!allMapsHighlightedKey) return visibleItems;
    const highlighted = [];
    const others = [];
    for (const snap of visibleItems) {
      const snapKey = String(getSavedMapKey(snap) || "");
      const snapLabel = String(snap?.label || "");
      const effectiveKey = snapKey || snapLabel;
      if (effectiveKey && effectiveKey === allMapsHighlightedKey) highlighted.push(snap);
      else others.push(snap);
    }
    return others.concat(highlighted);
  })();

  updateAllMapsCountLabel(visibleItems.length);

  const tooltipIndex = buildAllMapsTooltipIndex(visibleItems);

  if (elSavedMapsList) {
    elSavedMapsList.innerHTML = "";
    for (const snap of items) {
      const li = document.createElement("li");
      li.className = "allMapsListItem";

      const snapKey = String(getSavedMapKey(snap) || "");
      const snapLabel = String(snap?.label || "");
      const effectiveKey = snapKey || snapLabel;

      const nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "allMapsListName";
      nameBtn.textContent = snapLabel;
      const isNameHighlighted = Boolean(allMapsHighlightedKey) && Boolean(effectiveKey) && effectiveKey === allMapsHighlightedKey;
      if (isNameHighlighted) nameBtn.classList.add("isHighlighted");
      const isHidden = (snapKey && hidden.has(snapKey)) || (snapLabel && hidden.has(snapLabel));
      if (isHidden) nameBtn.classList.add("isHidden");
      nameBtn.addEventListener("click", () => {
        if (allMapsHighlightedKey && effectiveKey && allMapsHighlightedKey === effectiveKey) {
          allMapsHighlightedKey = null;
        } else {
          allMapsHighlightedKey = effectiveKey || null;
        }
        renderAllMapsCombinedMap();
      });

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "allMapsListToggle";
      toggleBtn.textContent = isHidden ? "Show" : "Hide";
      toggleBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleHiddenSavedMapSnapshot(effectiveKey);
      });

      li.appendChild(nameBtn);
      li.appendChild(toggleBtn);
      elSavedMapsList.appendChild(li);
    }
  }

  /** @type {L.LatLng[]} */
  const allLatLngs = [];

  for (const snap of renderOrder) {
    const addrs = Array.isArray(snap?.addresses) ? snap.addresses : [];

    const snapKey = String(getSavedMapKey(snap) || "");
    const snapLabel = String(snap?.label || "");
    const effectiveKey = snapKey || snapLabel;
    const isHighlighted = Boolean(allMapsHighlightedKey) && Boolean(effectiveKey) && effectiveKey === allMapsHighlightedKey;
    const highlightColor = "#ff4800";

    /** @type {L.CircleMarker[]} */
    const highlightedDots = [];
    /** @type {L.Polyline | null} */
    let highlightedLine = null;

    /** @type {L.LatLng[][]} */
    const segments = [];
    /** @type {L.LatLng[]} */
    let current = [];

    for (const a of addrs) {
      const ok = a && a.valid !== false && isFinite(a.lat) && isFinite(a.lon);
      if (!ok) {
        if (current.length >= 2) segments.push(current);
        current = [];
        continue;
      }

      const lat = Number(a.lat);
      const lon = Number(a.lon);
      const ll = L.latLng(lat, lon);
      allLatLngs.push(ll);
      current.push(ll);

      const rate = normalizeBelongingRate(a.belonging_rate, stableBelongingRateFromId(a.id));
      const innerRadius = 4;
      const radius = innerRadius + rate / 2;
      const baseColor = getAllMapsOverlayStrokeColor();
      const overlayColor = isHighlighted ? highlightColor : baseColor;
      const dot = L.circleMarker([lat, lon], {
        radius,
        weight: rate,
        opacity: 1,
        color: overlayColor,
        fillOpacity: 0,
        lifepathAllMapsKey: effectiveKey,
      });
      const key = allMapsCoordKey(lat, lon);
      const hoverHtml = tooltipIndex.get(key) || "";
      if (hoverHtml) {
        dot.bindTooltip(hoverHtml, {
          direction: "right",
          offset: [12, 0],
          sticky: false,
          className: "lifepathAllMapsTooltip",
        });
      }
      allMapsVectorLayer.addLayer(dot);
      if (isHighlighted && typeof dot.bringToFront === "function") highlightedDots.push(dot);
    }

    if (current.length >= 2) segments.push(current);

    if (segments.length) {
      const baseColor = getAllMapsOverlayStrokeColor();
      const overlayColor = isHighlighted ? highlightColor : baseColor;
      const line = L.polyline(segments, {
        weight: 1,
        opacity: 1,
        color: overlayColor,
        lineCap: "round",
        lineJoin: "round",
        lifepathAllMapsKey: effectiveKey,
      });
      allMapsVectorLayer.addLayer(line);
      if (isHighlighted && typeof line.bringToFront === "function") highlightedLine = line;
    }

    // Force the highlighted map to the top of the stack.
    if (isHighlighted) {
      try {
        if (highlightedLine) highlightedLine.bringToFront();
        for (const d of highlightedDots) d.bringToFront();
      } catch {
        // ignore
      }
    }
  }

  if (!allMapsHasAutoFitOnThisEntry) {
    allMapsHasAutoFitOnThisEntry = true;

    if (allLatLngs.length) {
      const bounds = L.latLngBounds(allLatLngs);
      if (bounds.isValid()) allMapsMap.fitBounds(bounds.pad(0.08), { animate: false });
      return;
    }

    // No points: default view should be the 100% baseline (Israel fits screen).
    try {
      const bounds = ISRAEL_BOUNDS.pad(ISRAEL_FIT_PADDING);
      allMapsMap.fitBounds(bounds, { animate: false });
    } catch {
      // ignore
    }
    return;
  }

  // Preserve the current zoom/center when the user interacts with the list.
  if (isFinite(preservedCenter?.lat) && isFinite(preservedCenter?.lng) && isFinite(preservedZoom)) {
    try {
      allMapsMap.setView(preservedCenter, preservedZoom, { animate: false });
      enforceMinZoomToAvoidBlankViewport(allMapsMap);
    } catch {
      // ignore
    }
  }
}

function allMapsCoordKey(lat, lon) {
  const a = Number(lat);
  const b = Number(lon);
  // 6 decimals ~ 0.1m-0.2m at these latitudes; good enough for stable grouping.
  return `${a.toFixed(6)},${b.toFixed(6)}`;
}

function connectedFullNameForHover(raw) {
  const s = sanitizeEnglishOnlyName(String(raw || "").trim());
  // Keep casing, remove spaces/punctuation.
  return s.replace(/[^A-Za-z]+/g, "");
}

function buildAllMapsTooltipIndex(items) {
  /** @type {Map<string, Set<string>>} */
  const byCoord = new Map();

  for (const snap of items) {
    const fullConnected = connectedFullNameForHover(snap?.fullName || "");
    const addrs = Array.isArray(snap?.addresses) ? snap.addresses : [];
    for (const a of addrs) {
      if (!a || a.valid === false) continue;
      const lat = Number(a.lat);
      const lon = Number(a.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;

      const rate = normalizeBelongingRate(a.belonging_rate, stableBelongingRateFromId(a.id));
      const rate2 = String(Math.max(0, Math.floor(Number(rate) || 0))).padStart(2, "0");

      const namePart = fullConnected || String(snap?.label || "");
      const line = `${namePart}.belonging${rate2}`;

      const key = allMapsCoordKey(lat, lon);
      const set = byCoord.get(key) || new Set();
      set.add(line);
      byCoord.set(key, set);
    }
  }

  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [k, set] of byCoord.entries()) {
    const lines = Array.from(set);
    lines.sort((a, b) => a.localeCompare(b));
    out.set(k, lines.join("<br>"));
  }
  return out;
}

if (elAllMapsHideMapBtn) {
  elAllMapsHideMapBtn.addEventListener("click", () => {
    ensureAllMapsMap();
    toggleAllMapsTiles();
  });
}

if (elAllMapsEditBtn) {
  elAllMapsEditBtn.addEventListener("click", () => {
    const panel = document.querySelector("#pageAllMaps .allMapsPanel");
    if (!panel) return;
    const willOpen = panel.classList.contains("hidden");
    if (willOpen) {
      alignAllMapsPanelToEditButton();
    }
    panel.classList.toggle("hidden");
    if (willOpen) {
      setTimeout(() => alignAllMapsPanelToEditButton(), 0);
    }
  });
}

window.addEventListener("resize", () => {
  if (elPageAllMaps && !elPageAllMaps.classList.contains("hidden")) {
    alignAllMapsPanelToEditButton();
  }
});

function updateEmotionTitle() {
  if (!elEmotionTitle) return;
  const full = normalizeNameForSignature(String(elStudentName?.value || ""));
  const count = formatAddrCount(addresses.length);
  if (!full) {
    elEmotionTitle.textContent = "";
    return;
  }
  elEmotionTitle.textContent = `${full}.${count}addrs`;
}

/**
 * @typedef {Object} EmotionStart
 * @property {{x:number,y:number,strokeWidth:number,startR:number}[]} points
 * @property {number} mapW
 * @property {number} mapH
 */

/** @type {EmotionStart | null} */
let pendingEmotionStart = null;

/** @type {EmotionStart | null} */
let lastEmotionStart = null;

const EMOTION_ANIM_MS = 1500;
const EMOTION_VB = 1000;
// Global proportional tighten factor for the Emotion Map.
// < 1.0 => tighter/denser while preserving proportions.
const EMOTION_TIGHTEN = 0.92;
// Geometry-only scale for the Emotion Map (rings + spacing).
// This should NOT affect stroke thickness.
const EMOTION_GEOMETRY_SCALE = 1.12;
// Keep consistent spacing between ring *edges* across sentiment maps.
// Smaller value => smaller overall rings.
const EMOTION_RING_GAP = 11 * EMOTION_TIGHTEN * EMOTION_GEOMETRY_SCALE;
// Extra thickness applied to all emotion-map strokes.
// Increase to make rings/connector bolder everywhere (main + archive previews).
const EMOTION_STROKE_BOOST = 5;

function computeEmotionRingRadii(maxR, strokeWidths) {
  const n = Array.isArray(strokeWidths) ? strokeWidths.length : 0;
  if (n <= 0) return [];

  const strokes = strokeWidths.map((s) => Math.max(1, Number(s) || 1));
  const sumStrokes = strokes.reduce((a, b) => a + b, 0);

  // With constant edge gap G, outer edge of last ring is:
  // outerEdge_n = n*G + sum(strokes)
  // Choose the largest G that fits, capped by EMOTION_RING_GAP.
  const maxGap = Math.max(1, (Math.max(1, Number(maxR) || 1) - sumStrokes) / n);
  const gap = Math.max(1, Math.min(EMOTION_RING_GAP, maxGap));

  const radii = [];
  for (let i = 0; i < n; i++) {
    const si = strokes[i];
    if (i === 0) {
      radii.push(gap + si / 2);
      continue;
    }
    const sp = strokes[i - 1];
    radii.push(radii[i - 1] + gap + (sp + si) / 2);
  }

  return radii;
}

function mapRectToEmotionVB(mapW, mapH) {
  const w = Math.max(1, Number(mapW) || 1);
  const h = Math.max(1, Number(mapH) || 1);
  const scale = EMOTION_VB / Math.max(w, h);
  const offsetX = (EMOTION_VB - w * scale) / 2;
  const offsetY = (EMOTION_VB - h * scale) / 2;
  return { scale, offsetX, offsetY };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function renderEmotionMap(start) {
  if (!elEmotionSvg) return;

  // Clear previous content.
  while (elEmotionSvg.firstChild) elEmotionSvg.removeChild(elEmotionSvg.firstChild);

  // Use the Step 2 map's pixel coordinate system when available so the emotion
  // view matches the previous step's zoom/scale.
  const vbW = start && isFinite(start.mapW) && start.mapW > 0 ? Number(start.mapW) : EMOTION_VB;
  const vbH = start && isFinite(start.mapH) && start.mapH > 0 ? Number(start.mapH) : EMOTION_VB;
  elEmotionSvg.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);

  /** @type {{strokeWidth:number,startR:number,startX:number,startY:number}[]} */
  let points = [];

  if (start && Array.isArray(start.points) && start.points.length > 0 && isFinite(start.mapW) && isFinite(start.mapH) && start.mapW > 0 && start.mapH > 0) {
    // Start exactly from the Leaflet container pixel positions.
    points = start.points.map((p) => ({
      strokeWidth: Number(p.strokeWidth) || 1,
      startR: Number(p.startR) || 1,
      startX: Number(p.x) || 0,
      startY: Number(p.y) || 0,
    }));
  } else {
    // Static render (no animation source): use current addresses.
    const nAll = Array.isArray(addresses) ? addresses.length : 0;
    if (nAll <= 0) return;
    points = addresses.map((a) => {
      const strokeWidth = normalizeBelongingRate(a?.belonging_rate, stableBelongingRateFromId(a?.id));
      return {
        strokeWidth,
        startR: 4,
        startX: vbW / 2,
        startY: vbH / 2,
      };
    });
  }

  const n = points.length;
  if (n <= 0) return;

  const groupScaleBase = n > 15 ? 0.8 : (n < 12 ? 1.08 : 1);
  const paulinaScale = isCurrentMapPaulinaRozga22(n) ? 0.72 : 1;
  const groupScale = Math.max(0.4, Math.min(1.3, groupScaleBase * paulinaScale));

  const maxStroke = Math.max(1, ...points.map((p) => Number(p.strokeWidth) || 1));
  const cx = vbW / 2;
  const cy = vbH / 2;
  const padding = 14 + maxStroke;
  const manyRingsScale = n > 12 ? 0.5 : 1;
  const maxR = Math.max(1, (Math.min(vbW, vbH) / 2 - padding) * manyRingsScale);
  const targetRadii = computeEmotionRingRadii(maxR, points.map((p) => p.strokeWidth));

  const circles = [];
  const finalCircleStrokes = [];
  const startCircleStrokes = [];

  const ringsGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  ringsGroup.setAttribute("data-layer", "emotion-rings");
  if (groupScale !== 1) {
    ringsGroup.setAttribute(
      "transform",
      `translate(${cx} ${cy}) scale(${groupScale}) translate(${-cx} ${-cy})`
    );
  }
  elEmotionSvg.appendChild(ringsGroup);

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", String(p.startX));
    c.setAttribute("cy", String(p.startY));
    c.setAttribute("r", String(Math.max(1, p.startR)));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke", "#111827");
    c.setAttribute("vector-effect", "non-scaling-stroke");

    // Always use the affiliation-based stroke width, regardless of animation or radius
    const strokeWidth = Math.max(1, Number(p.strokeWidth) || 1) + EMOTION_STROKE_BOOST;
    c.setAttribute("stroke-width", String(strokeWidth));

    finalCircleStrokes.push(strokeWidth);
    startCircleStrokes.push(strokeWidth);
    ringsGroup.appendChild(c);
    circles.push(c);
  }

  // Connecting line that will “cross” while circles move.
  let connector = null;
  let connectorFinalStroke = 1 + EMOTION_STROKE_BOOST;
  let connectorStartStroke = connectorFinalStroke;
  if (n >= 2) {
    connector = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    connector.setAttribute("fill", "none");
    connector.setAttribute("stroke", "#111827");
    connector.setAttribute("vector-effect", "non-scaling-stroke");
    connectorFinalStroke = 1 + EMOTION_STROKE_BOOST;
    // Match the Step 2 map path thickness at animation start.
    connectorStartStroke = (start && start.points && start.points.length) ? 1 : connectorFinalStroke;
    connector.setAttribute("stroke-width", String(connectorStartStroke));
    connector.setAttribute("stroke-linecap", "round");
    connector.setAttribute("stroke-linejoin", "round");
    connector.style.opacity = "1";
    ringsGroup.insertBefore(connector, circles[0]);
  }

  const targets = points.map((p, i) => ({
    x: cx,
    y: cy,
    r: targetRadii[i] || 1,
  }));

  // If we don't have a start source, skip animation.
  if (!(start && start.points && start.points.length)) {
    for (let i = 0; i < circles.length; i++) {
      circles[i].setAttribute("cx", String(targets[i].x));
      circles[i].setAttribute("cy", String(targets[i].y));
      circles[i].setAttribute("r", String(targets[i].r));
    }
    return;
  }

  const starts = points.map((p) => ({ x: p.startX, y: p.startY, r: Math.max(1, p.startR) }));
  const durationMs = EMOTION_ANIM_MS;
  const startTs = performance.now();

  function setConnector(pointsXY) {
    if (!connector) return;
    connector.setAttribute(
      "points",
      pointsXY
        .map((pt) => `${Math.round(pt.x * 1000) / 1000},${Math.round(pt.y * 1000) / 1000}`)
        .join(" ")
    );
  }

  function frame(now) {
    const tRaw = (now - startTs) / durationMs;
    const t = Math.max(0, Math.min(1, tRaw));
    const e = easeInOutCubic(t);

    /** @type {{x:number,y:number}[]} */
    const linePts = [];
    for (let i = 0; i < circles.length; i++) {
      const sx = starts[i].x;
      const sy = starts[i].y;
      const sr = starts[i].r;
      const tx = targets[i].x;
      const ty = targets[i].y;
      const tr = targets[i].r;

      const x = lerp(sx, tx, e);
      const y = lerp(sy, ty, e);
      const r = lerp(sr, tr, e);
      circles[i].setAttribute("cx", String(x));
      circles[i].setAttribute("cy", String(y));
      circles[i].setAttribute("r", String(r));

      // Ramp stroke width during the animation.
      const sw0 = startCircleStrokes[i] ?? 1;
      const sw1 = finalCircleStrokes[i] ?? sw0;
      circles[i].setAttribute("stroke-width", String(lerp(sw0, sw1, e)));
      linePts.push({ x, y });
    }

    setConnector(linePts);

    if (connector) {
      connector.setAttribute("stroke-width", String(lerp(connectorStartStroke, connectorFinalStroke, e)));
    }

    if (connector) {
      const fadeStart = 0.75;
      const fadeT = t <= fadeStart ? 0 : (t - fadeStart) / (1 - fadeStart);
      connector.style.opacity = String(1 - Math.max(0, Math.min(1, fadeT)));
    }

    if (t < 1) {
      requestAnimationFrame(frame);
    } else if (connector && connector.parentNode) {
      connector.parentNode.removeChild(connector);
    }
  }

  requestAnimationFrame(frame);
}

function animateEmotionBackToMap(start) {
  if (!elEmotionSvg) {
    showPage("step2");
    return;
  }
  if (!start || !Array.isArray(start.points) || start.points.length <= 0) {
    showPage("step2");
    return;
  }

  // Clear and rebuild circles at ring positions.
  while (elEmotionSvg.firstChild) elEmotionSvg.removeChild(elEmotionSvg.firstChild);

  const vbW = start && isFinite(start.mapW) && start.mapW > 0 ? Number(start.mapW) : EMOTION_VB;
  const vbH = start && isFinite(start.mapH) && start.mapH > 0 ? Number(start.mapH) : EMOTION_VB;
  elEmotionSvg.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);

  const targets = start.points.map((p) => ({
    strokeWidth: Number(p.strokeWidth) || 1,
    r: Math.max(1, Number(p.startR) || 1),
    x: Number(p.x) || 0,
    y: Number(p.y) || 0,
  }));

  const n = targets.length;
  const maxStroke = Math.max(1, ...targets.map((p) => Number(p.strokeWidth) || 1));
  const cx = vbW / 2;
  const cy = vbH / 2;
  const padding = 14 + maxStroke;
  const manyRingsScale = n > 12 ? 0.5 : 1;
  const maxR = Math.max(1, (Math.min(vbW, vbH) / 2 - padding) * manyRingsScale);
  const ringRadii = computeEmotionRingRadii(maxR, targets.map((t) => t.strokeWidth));

  const groupScaleBase = n > 15 ? 0.8 : (n < 12 ? 1.08 : 1);
  const paulinaScale = isCurrentMapPaulinaRozga22(n) ? 0.72 : 1;
  const groupScale = Math.max(0.4, Math.min(1.3, groupScaleBase * paulinaScale));
  const ringsGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  ringsGroup.setAttribute("data-layer", "emotion-rings");
  if (groupScale !== 1) {
    ringsGroup.setAttribute(
      "transform",
      `translate(${cx} ${cy}) scale(${groupScale}) translate(${-cx} ${-cy})`
    );
  }
  elEmotionSvg.appendChild(ringsGroup);

  const circles = [];
  const circleStartStrokes = [];
  const circleEndStrokes = [];
  for (let i = 0; i < n; i++) {
    const t = targets[i];
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", String(cy));
    c.setAttribute("r", String(ringRadii[i] || 1));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke", "#111827");
    c.setAttribute("vector-effect", "non-scaling-stroke");

    const baseStroke = Math.max(1, Number(t.strokeWidth) || 1);
    const startStroke = baseStroke + EMOTION_STROKE_BOOST;
    const endStroke = baseStroke;
    c.setAttribute("stroke-width", String(startStroke));
    circleStartStrokes.push(startStroke);
    circleEndStrokes.push(endStroke);

    ringsGroup.appendChild(c);
    circles.push(c);
  }

  let connector = null;
  let connectorStartStroke = 1 + EMOTION_STROKE_BOOST;
  let connectorEndStroke = 1;
  if (n >= 2) {
    connector = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    connector.setAttribute("fill", "none");
    connector.setAttribute("stroke", "#111827");
    connector.setAttribute("vector-effect", "non-scaling-stroke");
    connectorStartStroke = 1 + EMOTION_STROKE_BOOST;
    connectorEndStroke = 1;
    connector.setAttribute("stroke-width", String(connectorStartStroke));
    connector.setAttribute("stroke-linecap", "round");
    connector.setAttribute("stroke-linejoin", "round");
    connector.style.opacity = "1";
    ringsGroup.insertBefore(connector, circles[0]);
  }

  const starts = targets.map((t, i) => ({ x: cx, y: cy, r: ringRadii[i] || 1, strokeWidth: t.strokeWidth }));
  const durationMs = EMOTION_ANIM_MS;
  const startTs = performance.now();

  function setConnector(pointsXY) {
    if (!connector) return;
    connector.setAttribute(
      "points",
      pointsXY
        .map((pt) => `${Math.round(pt.x * 1000) / 1000},${Math.round(pt.y * 1000) / 1000}`)
        .join(" ")
    );
  }

  function frame(now) {
    const tRaw = (now - startTs) / durationMs;
    const t = Math.max(0, Math.min(1, tRaw));
    const e = easeInOutCubic(t);

    /** @type {{x:number,y:number}[]} */
    const linePts = [];
    for (let i = 0; i < circles.length; i++) {
      const s = starts[i];
      const to = targets[i];

      const x = lerp(s.x, to.x, e);
      const y = lerp(s.y, to.y, e);
      const r = lerp(s.r, to.r, e);
      circles[i].setAttribute("cx", String(x));
      circles[i].setAttribute("cy", String(y));
      circles[i].setAttribute("r", String(r));

      // While returning to the LifePath map, ramp stroke widths back to their
      // original map values (rate) during the animation.
      const sw0 = circleStartStrokes[i] ?? 1;
      const sw1 = circleEndStrokes[i] ?? sw0;
      circles[i].setAttribute("stroke-width", String(lerp(sw0, sw1, e)));
      linePts.push({ x, y });
    }

    setConnector(linePts);

    if (connector) {
      connector.setAttribute("stroke-width", String(lerp(connectorStartStroke, connectorEndStroke, e)));
    }

    if (connector) {
      const fadeStart = 0.75;
      const fadeT = t <= fadeStart ? 0 : (t - fadeStart) / (1 - fadeStart);
      connector.style.opacity = String(1 - Math.max(0, Math.min(1, fadeT)));
    }

    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      showPage("step2");
    }
  }

  requestAnimationFrame(frame);
}

function captureEmotionStartFromStep2() {
  try {
    const size = map.getSize();
    const mapW = Number(size?.x) || 0;
    const mapH = Number(size?.y) || 0;
    if (mapW <= 0 || mapH <= 0) return null;

    /** @type {{x:number,y:number,strokeWidth:number,startR:number}[]} */
    const pts = [];
    for (let i = 0; i < addresses.length; i++) {
      const a = addresses[i];
      if (!a || a.valid === false) continue;
      if (!isFinite(a.lat) || !isFinite(a.lon)) continue;

      const rate = normalizeBelongingRate(a.belonging_rate, stableBelongingRateFromId(a.id));
      const innerRadius = 5;
      const startR = innerRadius + rate / 2;
      const p = map.latLngToContainerPoint([Number(a.lat), Number(a.lon)]);
      pts.push({ x: Number(p?.x) || 0, y: Number(p?.y) || 0, strokeWidth: rate, startR });
    }

    if (pts.length <= 0) return null;
    return { points: pts, mapW, mapH };
  } catch {
    return null;
  }
}

function clearStep2LifePath() {
  if (polyline) {
    map.removeLayer(polyline);
    polyline = null;
  }
  if (markerLayer) {
    map.removeLayer(markerLayer);
    markerLayer = null;
  }
}

function formatAddrCount(n) {
  const count = Math.max(0, Number(n) || 0);
  return String(Math.floor(count)).padStart(2, "0");
}

function normalizeNameForSignature(text) {
  const s = toEnglishLike(String(text || "").trim()).toLowerCase();
  // Remove spaces and punctuation; keep letters and numbers.
  return s.replace(/[^a-z0-9]+/g, "");
}

function isCurrentMapPaulinaRozga22(addrCount) {
  const n = Math.max(0, Number(addrCount) || 0);
  if (n !== 22) return false;

  try {
    const full = String(elStudentName?.value || "").trim();
    const n1 = normalizeNameForSignature(full);
    if (n1 === "paulinarozga") return true;
    if (n1.startsWith("paulinarozga")) return true;
  } catch {
    // ignore
  }

  try {
    const sig = String(elSignatureLabel?.textContent || "").trim().toLowerCase();
    const compact = sig.replace(/\s+/g, "");
    if (compact.includes("paulinarozga") && compact.includes("22addrs")) return true;
  } catch {
    // ignore
  }

  try {
    const sig = String(elEmotionTitle?.textContent || "").trim().toLowerCase();
    const compact = sig.replace(/\s+/g, "");
    if (compact.startsWith("paulinarozga.22addrs")) return true;
    if (compact.includes("paulinarozga") && compact.includes("22addrs")) return true;
  } catch {
    // ignore
  }

  return false;
}

function updateStep2SignatureLabel() {
  if (!elSignatureLabel) return;
  const name = normalizeNameForMapLabel(elStudentName?.value || "");
  const count = formatAddrCount(addresses.length);
  if (!name) {
    elSignatureLabel.textContent = "";
    if (elPostcardCardMapName) elPostcardCardMapName.textContent = "";
    return;
  }
  elSignatureLabel.textContent = `${name}.${count}addrs`;
  if (elPostcardCardMapName) elPostcardCardMapName.textContent = elSignatureLabel.textContent;
}

function updatePostcardCardMapName() {
  if (!elPostcardCardMapName) return;
  const name = normalizeNameForMapLabel(elStudentName?.value || "");
  const count = formatAddrCount(addresses.length);
  elPostcardCardMapName.textContent = name ? `${name}.${count}addrs` : "";
}

/** @type {number | null} */
let step2ZoomBase = null;

const ISRAEL_BOUNDS = L.latLngBounds(
  // Requested default rectangle (southwest -> northeast)
  [29.2018, 34.01202],
  [33.359948, 35.83459]
);

// Controls how much margin we keep around Israel when defining the 100% view.
// Use 0 to match the requested rectangle exactly.
const ISRAEL_FIT_PADDING = 0;

// Zoom label calibration: keep 100% as the fitted Israel view.
const ZOOM_LABEL_ISRAEL_OFFSET_STOPS = 0;

// Opening behavior: when entering the LifePath map (Step 2), open at the
// Israel-fit 100% baseline.

function getIsraelReferenceZoom() {
  try {
    // If Leaflet hasn't measured a real size yet, avoid computing a bogus
    // reference zoom (can produce extreme values like ~3%).
    const size = map.getSize();
    const w = Number(size?.x) || 0;
    const h = Number(size?.y) || 0;
    if (w < 40 || h < 40) return map.getZoom();

    // "100%" baseline: fit all of Israel, but fairly tight.
    const bounds = ISRAEL_BOUNDS.pad(ISRAEL_FIT_PADDING);
    return map.getBoundsZoom(bounds, false) + ZOOM_LABEL_ISRAEL_OFFSET_STOPS + (Math.max(0, Math.round(Number(step2OpenExtraZoomStops) || 0)));
  } catch {
    return map.getZoom();
  }
}

function getStep2WorldReferenceZoom() {
  return getWorldReferenceZoom(map);
}

function updateStep2ZoomLabel() {
  if (!elZoomLabel) return;
  if (step2ZoomBase === null || !isFinite(step2ZoomBase)) {
    elZoomLabel.textContent = "";
    return;
  }

  const dz = map.getZoom() - step2ZoomBase;
  const pct = Math.max(1, Math.round(100 * Math.pow(2, dz)));
  elZoomLabel.textContent = `${pct}%`;
}

function resetStep2ZoomLabelBase() {
  step2ZoomBase = null;
  updateStep2ZoomLabel();
}

function setStep2ZoomLabelBaseToIsrael() {
  step2ZoomBase = getIsraelReferenceZoom();
  updateStep2ZoomLabel();
}

function setStep2ZoomLabelBaseToWorld() {
  // Define 100% as the view that is ~3200% relative to the world framing.
  // (i.e. shift the world reference by +5 zoom levels).
  step2ZoomBase = getStep2WorldReferenceZoom() + ZOOM_LABEL_WORLD_OFFSET_STOPS;
  updateStep2ZoomLabel();
}

function setStep2ZoomLabelBaseSoCurrentIs3200() {
  // Zoom label: pct = 100 * 2^(zoom - base).
  // To show 3200% at the current zoom, we want 2^(zoom-base) = 32 -> (zoom-base)=5.
  step2ZoomBase = map.getZoom() - ZOOM_LABEL_WORLD_OFFSET_STOPS;
  updateStep2ZoomLabel();
}

function setStep2ZoomLabelBaseToCurrentView() {
  step2ZoomBase = map.getZoom();
  updateStep2ZoomLabel();
}

function resetStep2ZoomToBase() {
  if (step2ZoomBase === null || !isFinite(step2ZoomBase)) return;
  try {
    const bounds = ISRAEL_BOUNDS.pad(ISRAEL_FIT_PADDING);
    map.fitBounds(bounds, { animate: false });
    enforceMinZoomToAvoidBlankViewport(map);
    // Keep the label aligned to the fitted view.
    setStep2ZoomLabelBaseToCurrentView();
  } catch {
    // ignore
  }
}

function focusMapOnIsraelLocationsMax() {
  // Goal: zoom in as much as possible while still including all relevant
  // locations inside Israel. If no points are inside Israel, fall back to
  // the default Israel rectangle.
  const pts = (Array.isArray(addresses) ? addresses : [])
    .filter((a) => a && isFinite(a.lat) && isFinite(a.lon))
    .map((a) => L.latLng(Number(a.lat), Number(a.lon)))
    .filter((ll) => ISRAEL_BOUNDS.contains(ll));

  const bounds = pts.length > 0 ? L.latLngBounds(pts) : ISRAEL_BOUNDS;
  if (!bounds.isValid()) return;

  // Tiny padding so markers/lines are not clipped.
  const pad = pts.length > 0 ? 0.06 : ISRAEL_FIT_PADDING;
  map.fitBounds(bounds.pad(pad), {
    animate: false,
    maxZoom: getMapMaxZoom(map) ?? undefined,
  });
  enforceMinZoomToAvoidBlankViewport(map);
}

function captureStep2ZoomLabelBaseIfNeeded() {
  // Kept for backward compatibility; no longer used.
  if (step2ZoomBase !== null && isFinite(step2ZoomBase)) return;
  step2ZoomBase = getIsraelReferenceZoom();
  updateStep2ZoomLabel();
}

function syncGeoUi() {
  if (elToggleGeoBtn) {
    elToggleGeoBtn.textContent = geoLayerEnabled ? "Hide geographic layer" : "Show geographic layer";
  }
  if (elHideMapBtn) {
    elHideMapBtn.textContent = geoLayerEnabled ? "Hide map" : "Show map";
  }
}

function setGeoLayerEnabled(enabled) {
  geoLayerEnabled = Boolean(enabled);

  const isLineArt = isLineArtBasemap(basemapStyleId);
  if (isLineArt) {
    if (geoTileLayer && map.hasLayer(geoTileLayer)) map.removeLayer(geoTileLayer);
    if (!geoLineArtLayer) geoLineArtLayer = L.layerGroup();
    if (geoLayerEnabled) {
      geoLineArtLayer.addTo(map);
      if (elMap) elMap.classList.add("geo-on");
      scheduleLineArtUpdate(map, geoLineArtLayer, geoLineArtState);
    } else {
      if (geoLineArtLayer && map.hasLayer(geoLineArtLayer)) map.removeLayer(geoLineArtLayer);
      if (elMap) elMap.classList.remove("geo-on");
    }
    syncGeoUi();
    applyBasemapStyleClasses();
    restyleStep2OverlaysForBasemap();
    restyleAllMapsOverlaysForBasemap();
    return;
  }

  if (geoLineArtLayer && map.hasLayer(geoLineArtLayer)) map.removeLayer(geoLineArtLayer);

  if (!geoTileLayer) {
    geoTileLayer = createBasemapTileLayer(basemapStyleId);
  }

  if (geoLayerEnabled) {
    if (geoTileLayer) geoTileLayer.addTo(map);
    if (elMap) elMap.classList.add("geo-on");
  } else {
    if (geoTileLayer && map.hasLayer(geoTileLayer)) map.removeLayer(geoTileLayer);
    if (elMap) elMap.classList.remove("geo-on");
  }

  syncGeoUi();
  applyBasemapStyleClasses();
  restyleStep2OverlaysForBasemap();
  restyleAllMapsOverlaysForBasemap();
}

function replaceGeoTileLayer() {
  const wasEnabled = Boolean(geoLayerEnabled);
  if (geoTileLayer && map.hasLayer(geoTileLayer)) map.removeLayer(geoTileLayer);
  if (geoLineArtLayer && map.hasLayer(geoLineArtLayer)) map.removeLayer(geoLineArtLayer);

  const isLineArt = isLineArtBasemap(basemapStyleId);
  geoTileLayer = createBasemapTileLayer(basemapStyleId);

  if (!isLineArt) {
    if (wasEnabled && geoTileLayer) {
      geoTileLayer.addTo(map);
      if (elMap) elMap.classList.add("geo-on");
    }
    return;
  }

  if (!geoLineArtLayer) geoLineArtLayer = L.layerGroup();
  if (wasEnabled) {
    geoLineArtLayer.addTo(map);
    if (elMap) elMap.classList.add("geo-on");
    scheduleLineArtUpdate(map, geoLineArtLayer, geoLineArtState);
  }
}

function replaceAllMapsTileLayerIfReady() {
  if (!allMapsMap) return;
  const wasVisible = Boolean(allMapsTilesVisible);
  if (allMapsTileLayer && allMapsMap.hasLayer(allMapsTileLayer)) allMapsMap.removeLayer(allMapsTileLayer);
  if (allMapsLineArtLayer && allMapsMap.hasLayer(allMapsLineArtLayer)) allMapsMap.removeLayer(allMapsLineArtLayer);

  allMapsTileLayer = createBasemapTileLayer(basemapStyleId);
  const isLineArt = isLineArtBasemap(basemapStyleId);

  if (wasVisible) {
    if (isLineArt) {
      if (!allMapsLineArtLayer) allMapsLineArtLayer = L.layerGroup();
      allMapsLineArtLayer.addTo(allMapsMap);
      scheduleLineArtUpdate(allMapsMap, allMapsLineArtLayer, allMapsLineArtState);
    } else if (allMapsTileLayer) {
      allMapsTileLayer.addTo(allMapsMap);
    }
  }

  updateAllMapsHideMapLabel();
}

function setBasemapStyle(styleId) {
  basemapStyleId = normalizeBasemapStyleId(styleId);
  setBasemapStyleIdToStorage(basemapStyleId);
  applyBasemapStyleClasses();
  replaceGeoTileLayer();
  replaceAllMapsTileLayerIfReady();
  restyleStep2OverlaysForBasemap();
  restyleAllMapsOverlaysForBasemap();
}

function getValidAddressLatLngs() {
  /** @type {L.LatLng[]} */
  const latLngs = [];
  for (let i = 0; i < addresses.length; i++) {
    const a = addresses[i];
    if (a && a.valid === false) continue;
    if (isFinite(a?.lat) && isFinite(a?.lon)) {
      latLngs.push(L.latLng(Number(a.lat), Number(a.lon)));
    }
  }
  return latLngs;
}

function focusMapOnAddresses() {
  const latLngs = getValidAddressLatLngs();
  if (latLngs.length === 0) return false;

  if (latLngs.length === 1) {
    map.setView(latLngs[0], 14, { animate: false });
    return true;
  }

  const bounds = L.latLngBounds(latLngs);
  if (bounds.isValid()) {
    // Keep the view fairly tight so the map feels "closer".
    map.fitBounds(bounds.pad(0.08), { animate: false });
    return true;
  }
  return false;
}

function renderStep2AddressDots() {
  // If a path is already drawn, don't override its markers.
  if (polyline || markerLayer) return;

  const latLngs = getValidAddressLatLngs();
  if (latLngs.length === 0) return;

  markerLayer = L.layerGroup();
  const overlayColor = getOverlayStrokeColor();
  for (let i = 0; i < addresses.length; i++) {
    const a = addresses[i];
    if (!a || a.valid === false) continue;
    if (!isFinite(a.lat) || !isFinite(a.lon)) continue;

    const rate = normalizeBelongingRate(a.belonging_rate, stableBelongingRateFromId(a.id));
    const label = formatAddressAsInList(a);
    const innerRadius = 5;
    const radius = innerRadius + rate / 2;
    const dot = L.circleMarker([Number(a.lat), Number(a.lon)], {
      radius,
      weight: rate,
      opacity: 1,
      color: overlayColor,
      fillOpacity: 0,
    });
    dot.bindTooltip(formatAddressForHoverLabel(label), { direction: "right", offset: [12, 0], sticky: false, className: "lifepathAddressTooltip" });
    markerLayer.addLayer(dot);
  }

  markerLayer.addTo(map);
}

function renderStep2AddressLine() {
  // If a path is already drawn, don't override it.
  if (polyline) return;

  /** @type {L.LatLng[][]} */
  const segments = [];
  /** @type {L.LatLng[]} */
  let current = [];

  for (let i = 0; i < addresses.length; i++) {
    const a = addresses[i];
    const ok = a && a.valid !== false && isFinite(a.lat) && isFinite(a.lon);
    if (!ok) {
      if (current.length >= 2) segments.push(current);
      current = [];
      continue;
    }
    current.push(L.latLng(Number(a.lat), Number(a.lon)));
  }
  if (current.length >= 2) segments.push(current);

  if (segments.length === 0) return;

  const overlayColor = getOverlayStrokeColor();
  polyline = L.polyline(segments, {
    weight: 1,
    opacity: 1,
    color: overlayColor,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(map);
}

function formatHomeNumber(n) {
  const num = Math.max(1, Number(n) || 1);
  return String(num).padStart(2, "0");
}

function updateStep1Headers() {
  if (elHomeNumberTitle) {
    elHomeNumberTitle.textContent = `Home no.${formatHomeNumber(addresses.length + 1)}`;
  }

  if (elHomeSummary) {
    const last = addresses.length ? addresses[addresses.length - 1] : null;
    if (!last) {
      elHomeSummary.textContent = "";
    } else {
      const homeNo = formatHomeNumber(addresses.length);
      const label = last.displayName || formatAddress(last);
      const rate = normalizeBelongingRate(last.belonging_rate, stableBelongingRateFromId(last.id));
      elHomeSummary.textContent = `[home no.${homeNo}]\n${label}\nBelonging ${rate}/10`;
    }
  }
}

const map = L.map("map", {
  // Intentionally no basemap/tiles; use Leaflet only as a blank
  // vector canvas + projection.
  zoomControl: false,
  attributionControl: false,
  preferCanvas: true,
  dragging: true,
  // Smoother zoom on trackpads / high-res wheels.
  zoomSnap: 0.3,
  zoomDelta: 0.3,
  wheelPxPerZoomLevel: 50,
  wheelDebounceTime: 15,
  scrollWheelZoom: true,
  doubleClickZoom: false,
  boxZoom: false,
  keyboard: false,
  tap: false,
  touchZoom: false,
});

// No tile layer on purpose (no basemap).
// Use a sane default view near Israel (avoids opening at a very zoomed-out world view).
map.setView([31.5, 35.1], 7);

// Printing: browsers (especially Chrome) may not render Leaflet canvases/SVGs
// correctly in print preview unless we trigger a resize/invalidate after the
// print media styles are applied. For postcards, we also want the map framed
// so all Israel locations are visible.

function invalidateMapForPrint() {
  try {
    map.invalidateSize(true);
  } catch {
    // ignore
  }
}

// For postcards we want to focus on Israel-only points.
// (If you ever want to visualize abroad connections, flip this to true.)
const PRINT_INCLUDE_ABROAD_LINES = false;

/** @type {{center:L.LatLng, zoom:number} | null} */
let preservedMapViewForPrint = null;

/** @type {number | null} */
let preservedMapMinZoomForPrint = null;

/**
 * Preserve only the inline properties we mutate for print rotation.
 * Restoring via `cssText` can be brittle if the rotated styles get captured.
 * @type {{position:string,left:string,top:string,width:string,height:string,transform:string,transformOrigin:string} | null}
 */
let preservedMapInlineStylesForPrint = null;

function forceClearPrintRotationInlineStyles() {
  const el = document.getElementById("map");
  if (!el) return;
  try {
    el.style.removeProperty("position");
    el.style.removeProperty("left");
    el.style.removeProperty("top");
    el.style.removeProperty("width");
    el.style.removeProperty("height");
    el.style.removeProperty("transform");
    el.style.removeProperty("transform-origin");
  } catch {
    // ignore
  }
}

function forceUnrotateMapAfterPrintIfNeeded() {
  // Only run cleanup when we're back in normal (non-print) UI.
  try {
    if (document.body.classList.contains("postcardPrintMode")) return;
    if (!isStep2VisibleForPrint()) return;
  } catch {
    // ignore
  }

  const el = document.getElementById("map");
  if (!el) return;

  const isRotated = (() => {
    try {
      const t = String(el.style.transform || "");
      if (t.includes("rotate(90deg)")) return true;
    } catch {
      // ignore
    }
    try {
      const ct = String(window.getComputedStyle(el).transform || "");
      // If some UA converts to matrix(), we can't reliably detect angle here,
      // but the observed bug is an inline rotate(90deg), which the check above catches.
      return ct === "matrix(0, 1, -1, 0, 0, 0)";
    } catch {
      return false;
    }
  })();

  if (!isRotated) return;

  // Force strip and re-measure Leaflet.
  forceClearPrintRotationInlineStyles();
  try {
    map.invalidateSize(true);
  } catch {
    // ignore
  }
}

/** @type {boolean} */
let printMapRotated = false;

// Chrome can run delayed print-layout passes *after* the print dialog closes.
// Guard those timeouts with a session token so we never re-apply rotation.
let printModeSessionToken = 0;
let printModeActive = false;

// Postcard printing must not mutate the live Step 2 map at all.
// We set this flag around `window.print()` so the global print handlers can no-op.
let postcardPrintInProgress = false;

/** @type {L.LayerGroup | null} */
let printAbroadLinesLayer = null;

function forceStep2OverlaysToBlackForPrint() {
  const color = "#000000";
  try {
    if (polyline && typeof polyline.setStyle === "function") {
      polyline.setStyle({ color });
    }
  } catch {
    // ignore
  }

  try {
    if (markerLayer && typeof markerLayer.eachLayer === "function") {
      markerLayer.eachLayer((layer) => {
        if (layer && typeof layer.setStyle === "function") layer.setStyle({ color, fillColor: color });
      });
    }
  } catch {
    // ignore
  }

  try {
    if (belongingCirclesLayer && typeof belongingCirclesLayer.eachLayer === "function") {
      belongingCirclesLayer.eachLayer((layer) => {
        if (layer && typeof layer.setStyle === "function") layer.setStyle({ color, fillColor: color });
      });
    }
  } catch {
    // ignore
  }

  try {
    if (cityDotsLayer && typeof cityDotsLayer.eachLayer === "function") {
      cityDotsLayer.eachLayer((layer) => {
        if (layer && typeof layer.setStyle === "function") layer.setStyle({ color, fillColor: color });
      });
    }
  } catch {
    // ignore
  }
}

function isStep2VisibleForPrint() {
  try {
    const el = document.getElementById("pageStep2");
    return Boolean(el && !el.classList.contains("hidden"));
  } catch {
    return false;
  }
}

function getPrintIsraelBoundsAndPad() {
  try {
    if (typeof ISRAEL_BOUNDS === "undefined" || !ISRAEL_BOUNDS) return { bounds: null, pad: 0 };

    const printIsraelBounds = (() => {
      try {
        return ISRAEL_BOUNDS.pad(0.25);
      } catch {
        return ISRAEL_BOUNDS;
      }
    })();

    const isIsraelForPrint = (addr, ll) => {
      try {
        const c = toEnglishLike(String(addr?.country || "")).trim().toLowerCase();
        if (c.includes("israel") || c.includes("ישראל")) return true;
      } catch {
        // ignore
      }
      try {
        return Boolean(printIsraelBounds && typeof printIsraelBounds.contains === "function" && printIsraelBounds.contains(ll));
      } catch {
        return false;
      }
    };

    const israelPts = (Array.isArray(addresses) ? addresses : [])
      .filter((a) => a && isFinite(a.lat) && isFinite(a.lon))
      .map((a) => ({ a, ll: L.latLng(Number(a.lat), Number(a.lon)) }))
      .filter(({ a, ll }) => isIsraelForPrint(a, ll))
      .map(({ ll }) => ll);

    const bounds = israelPts.length > 0 ? L.latLngBounds(israelPts) : ISRAEL_BOUNDS;
    if (!bounds || !bounds.isValid()) return { bounds: null, pad: 0 };

    // Print needs a touch more breathing room than interactive Step 2 to avoid
    // clipping circle markers/strokes against the postcard frame.
    const pad = israelPts.length > 0 ? 0.08 : ISRAEL_FIT_PADDING;
    return { bounds, pad };
  } catch {
    return { bounds: null, pad: 0 };
  }
}

function shouldRotatePrintMap(bounds) {
  try {
    if (!bounds || !bounds.isValid()) return false;
    // Determine if the Israel-bounds footprint is landscape-ish in projected space.
    // Use a fixed zoom so this is stable.
    const z = 8;
    const sw = map.project(bounds.getSouthWest(), z);
    const ne = map.project(bounds.getNorthEast(), z);
    const dx = Math.abs(ne.x - sw.x);
    const dy = Math.abs(ne.y - sw.y);
    if (!(dx > 0) || !(dy > 0)) return false;
    return dx > dy * 1.25;
  } catch {
    return false;
  }
}

function applyPrintMapRotation(rotate) {
  const el = document.getElementById("map");
  const wrap = document.querySelector("#pageStep2 .mapWrap");
  if (!el || !wrap) return;

  if (!rotate) {
    if (preservedMapInlineStylesForPrint) {
      const prev = preservedMapInlineStylesForPrint;
      preservedMapInlineStylesForPrint = null;

      const restore = (prop, value) => {
        if (value) el.style.setProperty(prop, value);
        else el.style.removeProperty(prop);
      };

      restore("position", prev.position);
      restore("left", prev.left);
      restore("top", prev.top);
      restore("width", prev.width);
      restore("height", prev.height);
      // Never restore a lingering print rotation.
      restore("transform", prev.transform && String(prev.transform).includes("rotate(90deg)") ? "" : prev.transform);
      restore("transform-origin", prev.transformOrigin);
    } else {
      // Best-effort cleanup even if we never captured state.
      el.style.removeProperty("position");
      el.style.removeProperty("left");
      el.style.removeProperty("top");
      el.style.removeProperty("width");
      el.style.removeProperty("height");
      el.style.removeProperty("transform");
      el.style.removeProperty("transform-origin");
    }
    printMapRotated = false;
    return;
  }

  // Save original inline styles once (only the properties we mutate).
  if (!preservedMapInlineStylesForPrint) {
    const get = (prop) => el.style.getPropertyValue(prop) || "";
    preservedMapInlineStylesForPrint = {
      position: get("position"),
      left: get("left"),
      top: get("top"),
      width: get("width"),
      height: get("height"),
      transform: get("transform"),
      transformOrigin: get("transform-origin"),
    };
  }

  const r = wrap.getBoundingClientRect();
  const w = Math.max(1, Number(r?.width) || 0);
  const h = Math.max(1, Number(r?.height) || 0);

  // Swap the container's logical size so Leaflet fitBounds uses the rotated aspect.
  // Then rotate the rendered map back into the postcard box.
  el.style.position = "absolute";
  el.style.left = "50%";
  el.style.top = "50%";
  el.style.width = `${Math.round(h)}px`;
  el.style.height = `${Math.round(w)}px`;
  el.style.transformOrigin = "center center";
  el.style.transform = "translate(-50%, -50%) rotate(90deg)";
  printMapRotated = true;
}

function fitMapToIsraelForPostcardPrint() {
  try {
    if (typeof ISRAEL_BOUNDS === "undefined" || !ISRAEL_BOUNDS) return;

    const { bounds, pad } = getPrintIsraelBoundsAndPad();
    if (!bounds) return;

    // Compute pixel padding from the *current* (print-sized) map.
    // Leaflet fitBounds does not account for circleMarker radius/stroke, so we
    // intentionally use a generous padding to avoid any clipping.
    // Keep it symmetric so the print framing stays centered.
    let basePx = 84;
    try {
      const size = map.getSize();
      const minSide = Math.max(1, Math.min(Number(size?.x) || 0, Number(size?.y) || 0));
      basePx = Math.max(60, Math.min(130, Math.round(minSide * 0.12)));
    } catch {
      // ignore
    }

    map.fitBounds(bounds.pad(pad), {
      animate: false,
      maxZoom: getMapMaxZoom(map) ?? undefined,
      padding: [basePx, basePx],
    });
  } catch {
    // ignore
  }
}

function removePrintAbroadLinesOverlay() {
  try {
    if (printAbroadLinesLayer && map.hasLayer(printAbroadLinesLayer)) {
      map.removeLayer(printAbroadLinesLayer);
    }
  } catch {
    // ignore
  }
  printAbroadLinesLayer = null;
}

function ensurePrintAbroadLinesOverlay() {
  // Draw lines that connect to out-of-Israel locations ABOVE the Israel locations.
  // This is print-only and is removed after printing.
  try {
    removePrintAbroadLinesOverlay();
    if (!isStep2VisibleForPrint()) return;
    if (typeof ISRAEL_BOUNDS === "undefined" || !ISRAEL_BOUNDS) return;

    // Print should always be visible on white paper.
    const overlayColor = "#000000";
    const group = L.layerGroup();

    const addrs = Array.isArray(addresses) ? addresses : [];

    const printIsraelBounds = (() => {
      try {
        return ISRAEL_BOUNDS.pad(0.25);
      } catch {
        return ISRAEL_BOUNDS;
      }
    })();

    const isIsraelForPrint = (addr, ll) => {
      try {
        const c = toEnglishLike(String(addr?.country || "")).trim().toLowerCase();
        if (c.includes("israel") || c.includes("ישראל")) return true;
      } catch {
        // ignore
      }
      try {
        return Boolean(printIsraelBounds && typeof printIsraelBounds.contains === "function" && printIsraelBounds.contains(ll));
      } catch {
        return false;
      }
    };
    /** @type {{ll:L.LatLng, inIsrael:boolean} | null} */
    let prev = null;
    for (const a of addrs) {
      const ok = a && a.valid !== false && isFinite(a.lat) && isFinite(a.lon);
      if (!ok) {
        prev = null;
        continue;
      }

      const ll = L.latLng(Number(a.lat), Number(a.lon));
      const inIsrael = isIsraelForPrint(a, ll);

      // Only draw segments that cross the Israel boundary (Israel <-> abroad).
      if (prev && ((prev.inIsrael && !inIsrael) || (!prev.inIsrael && inIsrael))) {
        const seg = L.polyline([prev.ll, ll], {
          weight: 1,
          opacity: 1,
          color: overlayColor,
          lineCap: "round",
          lineJoin: "round",
          interactive: false,
          bubblingMouseEvents: false,
        }).addTo(group);

        try {
          if (seg && typeof seg.bringToFront === "function") seg.bringToFront();
        } catch {
          // ignore
        }
      }

      prev = { ll, inIsrael };
    }

    group.addTo(map);
    printAbroadLinesLayer = group;

    // Ensure the group draws after other vectors (esp. in SVG renderer).
    try {
      if (group && typeof group.eachLayer === "function") {
        group.eachLayer((layer) => {
          if (layer && typeof layer.bringToFront === "function") layer.bringToFront();
        });
      }
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

function enterPrintModeForPostcard() {
  // If we're printing the postcard snapshot, never touch the live map.
  if (postcardPrintInProgress) return;
  try {
    if (document.body.classList.contains("postcardPrintMode")) return;
  } catch {
    // ignore
  }
  if (!isStep2VisibleForPrint()) return;

  printModeActive = true;
  const sessionToken = ++printModeSessionToken;

  try {
    if (!preservedMapViewForPrint) {
      preservedMapViewForPrint = { center: map.getCenter(), zoom: map.getZoom() };
    }
  } catch {
    preservedMapViewForPrint = null;
  }

  // First force Leaflet to measure the print-sized container, then fit bounds.
  // Run multiple times because print preview applies layout asynchronously.
  removePrintAbroadLinesOverlay();

  // In print mode we must allow Leaflet to zoom OUT enough to fit wide / mostly-horizontal
  // Israel point sets inside the 10x15 canvas. The runtime minZoom clamp that helps prevent
  // blank viewports on-screen can cut off points during print.
  try {
    if (preservedMapMinZoomForPrint === null && typeof map.getMinZoom === "function") {
      preservedMapMinZoomForPrint = map.getMinZoom();
    }
    if (typeof map.setMinZoom === "function") map.setMinZoom(0);
  } catch {
    // ignore
  }

  // Ensure dots are present for printing even if the marker layer was detached.
  try {
    if (markerLayer && typeof map.hasLayer === "function" && !map.hasLayer(markerLayer)) {
      markerLayer.addTo(map);
    }
  } catch {
    // ignore
  }

  forceStep2OverlaysToBlackForPrint();
  invalidateMapForPrint();

  const runPrintLayoutPass = (withAbroad) => {
    if (!printModeActive) return;
    if (sessionToken !== printModeSessionToken) return;
    if (!isStep2VisibleForPrint()) return;

    // Apply rotation only when the print layout has real dimensions.
    try {
      const wrap = document.querySelector("#pageStep2 .mapWrap");
      const r = wrap ? wrap.getBoundingClientRect() : null;
      const ok = (Number(r?.width) || 0) > 20 && (Number(r?.height) || 0) > 20;
      if (ok) {
        const { bounds } = getPrintIsraelBoundsAndPad();
        const rotate = Boolean(bounds) && shouldRotatePrintMap(bounds);
        applyPrintMapRotation(rotate);
      }
    } catch {
      // If anything fails, fall back to no rotation.
      try {
        applyPrintMapRotation(false);
      } catch {
        // ignore
      }
    }

    invalidateMapForPrint();
    fitMapToIsraelForPostcardPrint();
    forceStep2OverlaysToBlackForPrint();
    invalidateMapForPrint();
    if (PRINT_INCLUDE_ABROAD_LINES && withAbroad) ensurePrintAbroadLinesOverlay();
  };

  setTimeout(() => runPrintLayoutPass(false), 0);
  setTimeout(() => runPrintLayoutPass(true), 150);
  setTimeout(() => runPrintLayoutPass(true), 450);
}

function isPostcardPreviewOpen() {
  return document.body.classList.contains("postcardPreviewOpen");
}

/** @type {{center:L.LatLng, zoom:number} | null} */
let preservedMapViewBeforePostcardPreview = null;

/** @type {{parent: Element, nextSibling: ChildNode | null} | null} */
let preservedMapDomHomeForPostcard = null;

let postcardRotate90 = false;

// Mouse-wheel zoom in postcard view: make it less sensitive.
// Leaflet uses wheelPxPerZoomLevel: higher = slower zoom.
const POSTCARD_WHEEL_PX_PER_ZOOM_LEVEL = 220;

/** @type {number | null} */
let preservedWheelPxPerZoomLevelForPostcard = null;

/** @type {boolean | null} */
let preservedDraggingEnabledForPostcard = null;

/** @type {boolean} */
let postcardRotatedPanWired = false;

/** @type {number | null} */
let postcardPanPointerId = null;

/** @type {{x:number,y:number} | null} */
let postcardPanLast = null;

function ensurePostcardRotatedPanWired() {
  if (postcardRotatedPanWired) return;
  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  postcardRotatedPanWired = true;

  const endPan = (e) => {
    if (postcardPanPointerId === null) return;
    if (!e || e.pointerId !== postcardPanPointerId) return;
    postcardPanPointerId = null;
    postcardPanLast = null;
    try {
      mapEl.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  mapEl.addEventListener("pointerdown", (e) => {
    if (!isPostcardPreviewOpen() || !postcardRotate90) return;
    if (!e || e.button !== 0) return;
    // Prevent text selection / default dragging.
    try {
      e.preventDefault();
    } catch {
      // ignore
    }

    postcardPanPointerId = e.pointerId;
    postcardPanLast = { x: Number(e.clientX) || 0, y: Number(e.clientY) || 0 };
    try {
      mapEl.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  });

  mapEl.addEventListener("pointermove", (e) => {
    if (!isPostcardPreviewOpen() || !postcardRotate90) return;
    if (postcardPanPointerId === null || !postcardPanLast) return;
    if (!e || e.pointerId !== postcardPanPointerId) return;

    try {
      e.preventDefault();
    } catch {
      // ignore
    }

    const x = Number(e.clientX) || 0;
    const y = Number(e.clientY) || 0;
    const dx = x - postcardPanLast.x;
    const dy = y - postcardPanLast.y;
    postcardPanLast = { x, y };

    // The map element is visually rotated +90° (CSS). Leaflet's internal panning
    // is applied in the unrotated coordinate system, so we rotate the delta by -90°:
    // local = (dy, -dx)
    const panX = dy;
    const panY = -dx;
    try {
      map.panBy([panX, panY], { animate: false });
    } catch {
      // ignore
    }
  });

  mapEl.addEventListener("pointerup", endPan);
  mapEl.addEventListener("pointercancel", endPan);
  mapEl.addEventListener("lostpointercapture", endPan);
}

function applyPostcardInteractionMode() {
  try {
    if (!map || !map.dragging) return;

    if (!isPostcardPreviewOpen()) {
      if (preservedDraggingEnabledForPostcard !== null) {
        if (preservedDraggingEnabledForPostcard) map.dragging.enable();
        else map.dragging.disable();
        preservedDraggingEnabledForPostcard = null;
      }
      postcardPanPointerId = null;
      postcardPanLast = null;
      return;
    }

    if (preservedDraggingEnabledForPostcard === null) {
      preservedDraggingEnabledForPostcard = typeof map.dragging.enabled === "function" ? Boolean(map.dragging.enabled()) : true;
    }

    if (postcardRotate90) {
      map.dragging.disable();
    } else {
      if (preservedDraggingEnabledForPostcard) map.dragging.enable();
      else map.dragging.disable();
    }
  } catch {
    // ignore
  }
}

function enablePostcardWheelZoomTuning() {
  try {
    if (!map) return;

    if (preservedWheelPxPerZoomLevelForPostcard === null) {
      const prev = Number(map?.options?.wheelPxPerZoomLevel);
      preservedWheelPxPerZoomLevelForPostcard = Number.isFinite(prev) ? prev : null;
    }

    map.options.wheelPxPerZoomLevel = POSTCARD_WHEEL_PX_PER_ZOOM_LEVEL;

    // Some Leaflet versions cache handler state; quick re-enable is a safe nudge.
    if (map.scrollWheelZoom && typeof map.scrollWheelZoom.disable === "function" && typeof map.scrollWheelZoom.enable === "function") {
      map.scrollWheelZoom.disable();
      map.scrollWheelZoom.enable();
    }
  } catch {
    // ignore
  }
}

function restoreWheelZoomAfterPostcard() {
  try {
    if (!map) return;
    if (preservedWheelPxPerZoomLevelForPostcard === null) return;

    map.options.wheelPxPerZoomLevel = preservedWheelPxPerZoomLevelForPostcard;
    preservedWheelPxPerZoomLevelForPostcard = null;

    if (map.scrollWheelZoom && typeof map.scrollWheelZoom.disable === "function" && typeof map.scrollWheelZoom.enable === "function") {
      map.scrollWheelZoom.disable();
      map.scrollWheelZoom.enable();
    }
  } catch {
    // ignore
  }
}

function applyPostcardRotationLayout() {
  try {
    const card = document.querySelector(".postcardCard");
    if (!card) return;

    // Use layout pixels (not getBoundingClientRect) so Leaflet sees stable dimensions.
    const cardW = Math.max(1, Number(card.clientWidth) || 0);
    const cardH = Math.max(1, Number(card.clientHeight) || 0);

    const innerW = postcardRotate90 ? cardH : cardW;
    const innerH = postcardRotate90 ? cardW : cardH;

    // Set CSS vars on the card so rotation/layout is self-contained.
    card.style.setProperty("--postcardMapRotate", postcardRotate90 ? "90deg" : "0deg");
    card.style.setProperty("--postcardMapInnerWpx", `${Math.round(innerW)}px`);
    card.style.setProperty("--postcardMapInnerHpx", `${Math.round(innerH)}px`);
  } catch {
    // ignore
  }
}

function syncPostcardRotateUi() {
  if (!elPostcardRotateBtn) return;
  elPostcardRotateBtn.textContent = postcardRotate90 ? "Rotate 0°" : "Rotate 90°";
}

function setPostcardPreviewScaleToFit() {
  try {
    const card = document.querySelector(".postcardCard");
    if (!card) return;

    // Reset to measure at scale=1.
    document.documentElement.style.setProperty("--postcardPreviewScale", "1");

    const r = card.getBoundingClientRect();
    const cardW = Math.max(1, Number(r?.width) || 0);
    const cardH = Math.max(1, Number(r?.height) || 0);

    // Leave room for toolbar and some breathing space.
    const availW = Math.max(1, (window.innerWidth || 0) - 28);
    const availH = Math.max(1, (window.innerHeight || 0) - 130);

    const s = Math.min(1, availW / cardW, availH / cardH);
    document.documentElement.style.setProperty("--postcardPreviewScale", String(s));
  } catch {
    // ignore
  }
}

function moveLiveMapIntoPostcardCard() {
  const mapEl = document.getElementById("map");
  if (!mapEl || !elPostcardCardMapInner) return false;

  // Preserve the original DOM location once.
  if (!preservedMapDomHomeForPostcard) {
    preservedMapDomHomeForPostcard = { parent: mapEl.parentElement, nextSibling: mapEl.nextSibling };
  }

  try {
    elPostcardCardMapInner.appendChild(mapEl);
  } catch {
    return false;
  }

  return true;
}

function restoreLiveMapFromPostcardCard() {
  const mapEl = document.getElementById("map");
  if (!mapEl || !preservedMapDomHomeForPostcard) return;
  const home = preservedMapDomHomeForPostcard;
  try {
    if (home.nextSibling) home.parent.insertBefore(mapEl, home.nextSibling);
    else home.parent.appendChild(mapEl);
  } catch {
    // ignore
  }
  preservedMapDomHomeForPostcard = null;
}

function clearPostcardSnapshotFromCard() {
  try {
    if (elPostcardCardMapInner) elPostcardCardMapInner.innerHTML = "";
  } catch {
    // ignore
  }
}

function setPostcardPrintSnapshotScaleVar() {
  // Keep horizontal (landscape-ish) maps exactly as-is, but enlarge the rest.
  // We infer "horizontal" from the Israel bounds aspect heuristic used previously for print rotation.
  let scale = 1;
  try {
    const { bounds } = getPrintIsraelBoundsAndPad();
    const isHorizontal = Boolean(bounds) && shouldRotatePrintMap(bounds);
    scale = isHorizontal ? 1 : 2.25;
  } catch {
    // ignore
  }

  try {
    document.documentElement.style.setProperty("--postcardPrintSnapshotScale", String(scale));
  } catch {
    // ignore
  }
}

function clearPostcardPrintSnapshotScaleVar() {
  try {
    document.documentElement.style.removeProperty("--postcardPrintSnapshotScale");
  } catch {
    // ignore
  }
}

function renderPostcardSnapshotIntoCard() {
  const mapEl = document.getElementById("map");
  if (!mapEl || !elPostcardCardMapInner) return false;

  const rect = mapEl.getBoundingClientRect();
  const w = Math.max(1, Math.round(Number(rect?.width) || 0));
  const h = Math.max(1, Math.round(Number(rect?.height) || 0));
  if (w < 10 || h < 10) return false;

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * dpr));
  out.height = Math.max(1, Math.round(h * dpr));

  // @ts-ignore
  const ctx = out.getContext("2d");
  if (!ctx) return false;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  const canvases = Array.from(mapEl.querySelectorAll("canvas"));
  for (const c of canvases) {
    try {
      const cr = c.getBoundingClientRect();
      const x = cr.left - rect.left;
      const y = cr.top - rect.top;
      const cw = cr.width;
      const ch = cr.height;
      if (!(cw > 0) || !(ch > 0)) continue;

      const opacity = (() => {
        try {
          const o = Number(window.getComputedStyle(c).opacity);
          return isFinite(o) ? Math.max(0, Math.min(1, o)) : 1;
        } catch {
          return 1;
        }
      })();

      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.drawImage(c, x, y, cw, ch);
      ctx.restore();
    } catch {
      // ignore
    }
  }

  let dataUrl = "";
  try {
    dataUrl = out.toDataURL("image/png");
  } catch {
    return false;
  }

  clearPostcardSnapshotFromCard();
  const img = document.createElement("img");
  img.className = "postcardSnapshotImg";
  img.alt = "";
  img.decoding = "async";
  img.loading = "eager";
  img.src = dataUrl;
  try {
    elPostcardCardMapInner.appendChild(img);
  } catch {
    return false;
  }

  // Print-only: if a segment connects Israel <-> abroad, extend the visible line
  // into the postcard margin so it reaches the postcard edge.
  try {
    renderPostcardAbroadLineExtensionsOverlay({ mapW: w, mapH: h });
  } catch {
    // ignore
  }

  return true;
}

/** @type {SVGSVGElement | null} */
let postcardOverlaySvg = null;

function ensurePostcardOverlaySvg() {
  if (!elPostcardCardMapInner) return null;
  try {
    if (!postcardOverlaySvg) {
      // @ts-ignore
      postcardOverlaySvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      postcardOverlaySvg.classList.add("postcardOverlaySvg");
      postcardOverlaySvg.setAttribute("aria-hidden", "true");
      postcardOverlaySvg.setAttribute("focusable", "false");
      postcardOverlaySvg.setAttribute("preserveAspectRatio", "none");
    }
    if (postcardOverlaySvg.parentElement !== elPostcardCardMapInner) {
      elPostcardCardMapInner.appendChild(postcardOverlaySvg);
    }
    return postcardOverlaySvg;
  } catch {
    return null;
  }
}

function clearPostcardOverlaySvg() {
  try {
    if (!postcardOverlaySvg) return;
    postcardOverlaySvg.innerHTML = "";
  } catch {
    // ignore
  }
}

function renderPostcardAbroadLineExtensionsOverlay({ mapW, mapH }) {
  // Only relevant for the printed postcard.
  try {
    if (!document.body.classList.contains("postcardPrintMode")) {
      clearPostcardOverlaySvg();
      return;
    }
  } catch {
    clearPostcardOverlaySvg();
    return;
  }

  // Nastya: remove the abroad extension line in the printed postcard.
  try {
    const n = normalizeNameForSignature(elStudentName?.value || "");
    if (n === "nastyafaybish") {
      clearPostcardOverlaySvg();
      return;
    }
  } catch {
    // ignore
  }

  if (!map || !elPostcardCardMapInner) return;
  const svg = ensurePostcardOverlaySvg();
  if (!svg) return;

  const innerW = Math.max(1, Number(elPostcardCardMapInner.clientWidth) || 0);
  const innerH = Math.max(1, Number(elPostcardCardMapInner.clientHeight) || 0);
  svg.setAttribute("viewBox", `0 0 ${innerW} ${innerH}`);
  svg.setAttribute("width", String(innerW));
  svg.setAttribute("height", String(innerH));
  svg.style.width = `${innerW}px`;
  svg.style.height = `${innerH}px`;
  clearPostcardOverlaySvg();

  const clipRayToRect = (p0, p1, w, h) => {
    const dx = Number(p1.x) - Number(p0.x);
    const dy = Number(p1.y) - Number(p0.y);
    /** @type {Array<{t:number,x:number,y:number}>} */
    const hits = [];

    const pushHit = (t, x, y) => {
      if (!(t > 0)) return;
      if (!(x >= -0.001 && x <= w + 0.001 && y >= -0.001 && y <= h + 0.001)) return;
      hits.push({ t, x, y });
    };

    if (dx !== 0) {
      let t = (0 - Number(p0.x)) / dx;
      pushHit(t, 0, Number(p0.y) + t * dy);
      t = (w - Number(p0.x)) / dx;
      pushHit(t, w, Number(p0.y) + t * dy);
    }
    if (dy !== 0) {
      let t = (0 - Number(p0.y)) / dy;
      pushHit(t, Number(p0.x) + t * dx, 0);
      t = (h - Number(p0.y)) / dy;
      pushHit(t, Number(p0.x) + t * dx, h);
    }

    if (hits.length === 0) return null;
    hits.sort((a, b) => a.t - b.t);
    return { x: hits[0].x, y: hits[0].y };
  };

  const isOutOfRect = (p, w, h) => Number(p.x) < 0 || Number(p.x) > w || Number(p.y) < 0 || Number(p.y) > h;
  const isInRect = (p, w, h) => Number(p.x) >= 0 && Number(p.x) <= w && Number(p.y) >= 0 && Number(p.y) <= h;

  const printIsraelBounds = (() => {
    try {
      if (typeof ISRAEL_BOUNDS === "undefined" || !ISRAEL_BOUNDS) return null;
      try {
        return ISRAEL_BOUNDS.pad(0.25);
      } catch {
        return ISRAEL_BOUNDS;
      }
    } catch {
      return null;
    }
  })();

  const isIsraelForPrint = (addr, ll) => {
    try {
      const c = toEnglishLike(String(addr?.country || "")).trim().toLowerCase();
      if (c.includes("israel") || c.includes("ישראל")) return true;
    } catch {
      // ignore
    }
    try {
      return Boolean(printIsraelBounds && typeof printIsraelBounds.contains === "function" && printIsraelBounds.contains(ll));
    } catch {
      return false;
    }
  };

  // Object-fit: contain mapping from the captured map image (mapW/mapH)
  // to the postcard inner box (innerW/innerH).
  const s = Math.min(innerW / Math.max(1, mapW), innerH / Math.max(1, mapH));
  const dw = mapW * s;
  const dh = mapH * s;
  const ox = (innerW - dw) / 2;
  const oy = (innerH - dh) / 2;

  // Match the line thickness inside the snapshot image.
  // The snapshot is scaled by `s` (contain), so a 1px map line becomes `1*s` px on the postcard.
  const baseWeight = (() => {
    try {
      const w = Number(polyline?.options?.weight);
      return Number.isFinite(w) && w > 0 ? w : 1;
    } catch {
      return 1;
    }
  })();

  const dpr = window.devicePixelRatio || 1;
  const strokeW = Math.max(0.5, baseWeight * s * dpr);

  const addrs = Array.isArray(addresses) ? addresses : [];
  /** @type {{ll:any,inIsrael:boolean,addr:any} | null} */
  let prev = null;
  for (const a of addrs) {
    const ok = a && a.valid !== false && isFinite(a.lat) && isFinite(a.lon);
    if (!ok) {
      prev = null;
      continue;
    }

    const ll = L.latLng(Number(a.lat), Number(a.lon));
    const inIsrael = isIsraelForPrint(a, ll);

    if (prev && ((prev.inIsrael && !inIsrael) || (!prev.inIsrael && inIsrael))) {
      const inPtLL = prev.inIsrael ? prev.ll : ll;
      const outPtLL = prev.inIsrael ? ll : prev.ll;

      const pIn = map.latLngToContainerPoint(inPtLL);
      const pOut = map.latLngToContainerPoint(outPtLL);
      if (!isInRect(pIn, mapW, mapH)) {
        prev = { ll, inIsrael, addr: a };
        continue;
      }

      if (!isOutOfRect(pOut, mapW, mapH)) {
        // Abroad point is visible; no need to extend.
        prev = { ll, inIsrael, addr: a };
        continue;
      }

      const imgEdge = clipRayToRect(pIn, pOut, mapW, mapH);
      if (!imgEdge) {
        prev = { ll, inIsrael, addr: a };
        continue;
      }

      const pIn2 = { x: ox + Number(pIn.x) * s, y: oy + Number(pIn.y) * s };
      const pOut2 = { x: ox + Number(pOut.x) * s, y: oy + Number(pOut.y) * s };
      const imgEdge2 = { x: ox + Number(imgEdge.x) * s, y: oy + Number(imgEdge.y) * s };

      if (!isOutOfRect(pOut2, innerW, innerH)) {
        prev = { ll, inIsrael, addr: a };
        continue;
      }

      const cardEdge = clipRayToRect(pIn2, pOut2, innerW, innerH);
      if (!cardEdge) {
        prev = { ll, inIsrael, addr: a };
        continue;
      }

      const dx = Number(cardEdge.x) - Number(imgEdge2.x);
      const dy = Number(cardEdge.y) - Number(imgEdge2.y);
      if (dx * dx + dy * dy < 0.5) {
        prev = { ll, inIsrael, addr: a };
        continue;
      }

      // Vector line overlay for crisp printing.
      // @ts-ignore
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(imgEdge2.x));
      line.setAttribute("y1", String(imgEdge2.y));
      line.setAttribute("x2", String(cardEdge.x));
      line.setAttribute("y2", String(cardEdge.y));
      line.setAttribute("stroke", "#000000");
      line.setAttribute("stroke-width", String(strokeW));
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("stroke-linejoin", "round");
      try {
        svg.appendChild(line);
      } catch {
        // ignore
      }
    }

    prev = { ll, inIsrael, addr: a };
  }
}

function openPostcardPreview({ silent = false } = {}) {
  if (elPostcardPreviewOverlay) {
    elPostcardPreviewOverlay.classList.remove("hidden");
    elPostcardPreviewOverlay.setAttribute("aria-hidden", "false");
  }
  document.body.classList.add("postcardPreviewOpen");
  document.body.classList.toggle("postcardPreviewSilent", Boolean(silent));

  // Use a static snapshot in the postcard card so printing never mutates the live map.
  // Reset rotation each time we open, but keep it easy to toggle.
  postcardRotate90 = false;
  syncPostcardRotateUi();

  updatePostcardCardMapName();

  // Scale the 10x15cm card to fit the viewport.
  requestAnimationFrame(() => {
    if (silent) {
      // For direct printing we don't need to fit-to-viewport; keep stable layout.
      document.documentElement.style.setProperty("--postcardPreviewScale", "1");
    } else {
      setPostcardPreviewScaleToFit();
    }
    applyPostcardRotationLayout();

    // Render once after layout is applied.
    try {
      renderPostcardSnapshotIntoCard();
    } catch {
      // ignore
    }
  });
}

function closePostcardPreview() {
  document.body.classList.remove("postcardPreviewOpen");
  document.body.classList.remove("postcardPreviewSilent");
  document.body.classList.remove("postcardPrintMode");
  if (elPostcardPreviewOverlay) {
    elPostcardPreviewOverlay.classList.add("hidden");
    elPostcardPreviewOverlay.setAttribute("aria-hidden", "true");
  }

  clearPostcardSnapshotFromCard();
  clearPostcardOverlaySvg();
  clearPostcardPrintSnapshotScaleVar();

  // Clean up inline CSS vars.
  try {
    const card = document.querySelector(".postcardCard");
    if (card) {
      card.style.removeProperty("--postcardMapRotate");
      card.style.removeProperty("--postcardMapInnerWpx");
      card.style.removeProperty("--postcardMapInnerHpx");
    }
  } catch {
    // ignore
  }
}

function downloadPngFromPostcardPreview() {
  if (!isPostcardPreviewOpen()) openPostcardPreview();

  // Export the live Leaflet render by compositing the canvases inside #map.
  // Note: if you enable basemap tiles, canvas export may fail due to CORS.
  setTimeout(() => {
    const mapEl = document.getElementById("map");
    if (!mapEl) {
      showToast("Map is not ready yet.");
      return;
    }

    const rect = mapEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(Number(rect?.width) || 0));
    const h = Math.max(1, Math.round(Number(rect?.height) || 0));
    if (w < 10 || h < 10) {
      showToast("Map is not ready yet.");
      return;
    }

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(w * dpr));
    out.height = Math.max(1, Math.round(h * dpr));

    // @ts-ignore
    const ctx = out.getContext("2d");
    if (!ctx) {
      showToast("Export failed: no canvas context.");
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    const canvases = Array.from(mapEl.querySelectorAll("canvas"));
    for (const c of canvases) {
      try {
        const cr = c.getBoundingClientRect();
        const x = cr.left - rect.left;
        const y = cr.top - rect.top;
        const cw = cr.width;
        const ch = cr.height;
        if (!(cw > 0) || !(ch > 0)) continue;

        const opacity = (() => {
          try {
            const o = Number(window.getComputedStyle(c).opacity);
            return isFinite(o) ? Math.max(0, Math.min(1, o)) : 1;
          } catch {
            return 1;
          }
        })();

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.drawImage(c, x, y, cw, ch);
        ctx.restore();
      } catch {
        // ignore
      }
    }

    // Optional postcard border in the exported image.
    try {
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    } catch {
      // ignore
    }

    const filename = `lifepath-postcard-${new Date().toISOString().slice(0, 10)}.png`;
    try {
      out.toBlob(
        (blob) => {
          if (!blob) {
            showToast("Export failed (likely due to basemap tiles). Hide the basemap and try again.");
            return;
          }
          downloadBlob(blob, filename);
          showToast("Downloaded PNG.");
        },
        "image/png",
        1.0,
      );
    } catch {
      showToast("Export failed.");
    }
  }, 80);
}

function printPostcardFromPreview() {
  if (!isPostcardPreviewOpen()) openPostcardPreview();

  // Force print CSS to only print the postcard card.
  document.body.classList.add("postcardPrintMode");

  // Give the browser a moment to apply layout changes before printing.
  requestAnimationFrame(() => {
    try {
      setPostcardPreviewScaleToFit();
      applyPostcardRotationLayout();
      setPostcardPrintSnapshotScaleVar();
      renderPostcardSnapshotIntoCard();
    } catch {
      // ignore
    }

    setTimeout(() => {
      postcardPrintInProgress = true;
      try {
        window.print();
      } catch {
        // ignore
      }

      // Some browsers (and some print flows) do not reliably fire `afterprint`.
      // If we initiated printing via our UI, run a best-effort cleanup once the
      // print dialog returns control to JS.
      try {
        document.body.classList.remove("postcardPrintMode");
        exitPrintModeForPostcard();
        if (document.body.classList.contains("postcardPreviewSilent")) {
          closePostcardPreview();
        }
      } catch {
        // ignore
      }

      clearPostcardPrintSnapshotScaleVar();

      postcardPrintInProgress = false;
    }, 80);
  });
}

function printPostcardImmediatelyFromStep2() {
  // Do not show the modal UI; stage the postcard off-screen (in layout) and print.
  openPostcardPreview({ silent: true });
  document.body.classList.add("postcardPrintMode");

  // Wait for layout + Leaflet invalidation before printing.
  requestAnimationFrame(() => {
    try {
      applyPostcardRotationLayout();
      setPostcardPrintSnapshotScaleVar();
      renderPostcardSnapshotIntoCard();
    } catch {
      // ignore
    }

    setTimeout(() => {
      postcardPrintInProgress = true;
      try {
        window.print();
      } catch {
        // ignore
      }

      // Ensure we always restore the interactive UI after printing.
      try {
        document.body.classList.remove("postcardPrintMode");
        exitPrintModeForPostcard();
        if (document.body.classList.contains("postcardPreviewSilent")) {
          closePostcardPreview();
        }
      } catch {
        // ignore
      }

      clearPostcardPrintSnapshotScaleVar();

      postcardPrintInProgress = false;
    }, 80);
  });
}

// Ensure print-mode styling doesn't get "stuck" after the dialog closes.
if (!window.__lifepathPostcardAfterPrintWired) {
  // @ts-ignore
  window.__lifepathPostcardAfterPrintWired = true;

  const cleanupPostPrintUi = () => {
    try {
      document.body.classList.remove("postcardPrintMode");
    } catch {
      // ignore
    }

    // Restore Step 2 map rotation/sizing if it was modified for printing.
    try {
      exitPrintModeForPostcard();
    } catch {
      // ignore
    }

    // If we printed via the Step 2 direct-print flow, fully close and restore.
    try {
      if (document.body.classList.contains("postcardPreviewSilent")) {
        closePostcardPreview();
      }
    } catch {
      // ignore
    }

    // Re-measure Leaflet after returning from print.
    if (!postcardPrintInProgress) {
      // Avoid touching the live map for postcard printing.
      try {
        map.invalidateSize(true);
      } catch {
        // ignore
      }

      // If the browser leaves a print rotation inline on the map, force-clear it.
      try {
        forceUnrotateMapAfterPrintIfNeeded();
        setTimeout(forceUnrotateMapAfterPrintIfNeeded, 50);
        setTimeout(forceUnrotateMapAfterPrintIfNeeded, 250);
        setTimeout(forceUnrotateMapAfterPrintIfNeeded, 900);
      } catch {
        // ignore
      }
    }
  };

  window.addEventListener("afterprint", () => {
    cleanupPostPrintUi();
  });

  // Safari/macOS can be flaky with `afterprint`; regaining focus is a good
  // signal that the dialog closed.
  window.addEventListener("focus", () => {
    try {
      const mapEl = document.getElementById("map");
      const stuckRotated = (() => {
        try {
          const t = String(mapEl?.style?.transform || "");
          return t.includes("rotate(90deg)");
        } catch {
          return false;
        }
      })();

      if (document.body.classList.contains("postcardPrintMode") || printMapRotated || stuckRotated || preservedMapInlineStylesForPrint) {
        cleanupPostPrintUi();
      }
    } catch {
      // ignore
    }
  });

  document.addEventListener("visibilitychange", () => {
    try {
      const mapEl = document.getElementById("map");
      const stuckRotated = (() => {
        try {
          const t = String(mapEl?.style?.transform || "");
          return t.includes("rotate(90deg)");
        } catch {
          return false;
        }
      })();

      if (!document.hidden && (document.body.classList.contains("postcardPrintMode") || printMapRotated || stuckRotated || preservedMapInlineStylesForPrint)) {
        cleanupPostPrintUi();
      }
    } catch {
      // ignore
    }
  });
}

function exitPrintModeForPostcard() {
  // Invalidate any delayed layout passes scheduled during enterPrintModeForPostcard.
  printModeActive = false;
  printModeSessionToken++;

  // If we're printing the postcard snapshot, never touch the live map.
  if (postcardPrintInProgress) return;
  try {
    if (document.body.classList.contains("postcardPrintMode")) return;
  } catch {
    // ignore
  }

  removePrintAbroadLinesOverlay();

  // Restore map element sizing/rotation.
  try {
    applyPrintMapRotation(false);
  } catch {
    // ignore
  }
  preservedMapInlineStylesForPrint = null;
  printMapRotated = false;

  // Restore minZoom behavior from interactive mode.
  try {
    if (preservedMapMinZoomForPrint !== null && typeof map.setMinZoom === "function") {
      map.setMinZoom(preservedMapMinZoomForPrint);
    }
  } catch {
    // ignore
  }
  preservedMapMinZoomForPrint = null;

  // Restore normal dynamic coloring.
  try {
    restyleStep2OverlaysForBasemap();
  } catch {
    // ignore
  }
  if (!preservedMapViewForPrint) {
    invalidateMapForPrint();
    setTimeout(invalidateMapForPrint, 50);
    return;
  }

  try {
    map.setView(preservedMapViewForPrint.center, preservedMapViewForPrint.zoom, { animate: false });
  } catch {
    // ignore
  }
  preservedMapViewForPrint = null;
  invalidateMapForPrint();
  setTimeout(invalidateMapForPrint, 50);
}

window.addEventListener("beforeprint", enterPrintModeForPostcard);
window.addEventListener("afterprint", exitPrintModeForPostcard);

try {
  const mq = window.matchMedia ? window.matchMedia("print") : null;
  if (mq) {
    const onChange = (e) => {
      if (e && e.matches) enterPrintModeForPostcard();
      else exitPrintModeForPostcard();
    };
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
    else if (typeof mq.addListener === "function") mq.addListener(onChange);
  }
} catch {
  // ignore
}

enforceMinZoomToAvoidBlankViewport(map);

let polyline = null;
let markerLayer = null;

let geoTileLayer = null;

/** @type {L.LayerGroup | null} */
let geoLineArtLayer = null;

const geoLineArtState = {
  lastKey: "",
  /** @type {AbortController | null} */
  abort: null,
  /** @type {number | null} */
  timer: null,
  /** @type {any} */
  renderer: null,
};

let allSignaturesLayer = L.layerGroup().addTo(map);
let cityDotsLayer = L.layerGroup().addTo(map);
let belongingCirclesLayer = L.layerGroup().addTo(map);

// Paint splash overlay.
let splashEnabled = false;
let splashSources = null;

const splashCanvas = document.createElement("canvas");
splashCanvas.className = "splashCanvas";
elMap.appendChild(splashCanvas);

/** @type {CanvasRenderingContext2D} */
// @ts-ignore
const splashCtx = splashCanvas.getContext("2d");

function resizeSplashCanvas() {
  const rect = elMap.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  splashCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  splashCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  splashCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

resizeSplashCanvas();
window.addEventListener("resize", () => {
  updateStep1Scale();
  updateBelongingValueLabel();
  resizeSplashCanvas();
  if (splashEnabled) redrawSplash();

  if (isPostcardPreviewOpen && typeof isPostcardPreviewOpen === "function" && isPostcardPreviewOpen()) {
    setPostcardPreviewScaleToFit();
    applyPostcardRotationLayout();
    try {
      renderPostcardSnapshotIntoCard();
    } catch {
      // ignore
    }
  }

  enforceMinZoomToAvoidBlankViewport(map);
  if (allMapsMap) enforceMinZoomToAvoidBlankViewport(allMapsMap);
});

map.on("move", () => {
  if (splashEnabled) redrawSplash();
});
map.on("zoom", () => {
  if (splashEnabled) redrawSplash();
});

map.on("zoomend", () => {
  updateStep2ZoomLabel();
});

if (elZoomLabel) {
  elZoomLabel.title = "Reset zoom";
  elZoomLabel.addEventListener("click", () => {
    focusMapOnIsraelLocationsMax();
    setStep2ZoomLabelBaseToCurrentView();
    updateStep2ZoomLabel();
  });
}

if (elAllMapsZoomLabel) {
  elAllMapsZoomLabel.title = "Reset zoom";
  elAllMapsZoomLabel.addEventListener("click", () => resetAllMapsZoomToBase());
}

if (elToggleSplashBtn) {
  elToggleSplashBtn.addEventListener("click", () => {
    splashEnabled = !splashEnabled;
    elToggleSplashBtn.textContent = splashEnabled ? "Hide paint" : "Paint colors";
    if (splashEnabled) {
      if (!splashSources) {
        setStatus("Draw something first, then enable paint.");
      }
      redrawSplash();
    } else {
      clearSplash();
    }
  });
}

function populateBasemapStyleSelect() {
  if (!elBasemapStyleSelect) return;
  elBasemapStyleSelect.innerHTML = "";

  for (const style of BASEMAP_STYLES) {
    const opt = document.createElement("option");
    opt.value = style.id;
    opt.textContent = style.label;
    elBasemapStyleSelect.appendChild(opt);
  }

  elBasemapStyleSelect.value = basemapStyleId;
  applyBasemapStyleClasses();
  elBasemapStyleSelect.addEventListener("change", () => {
    setBasemapStyle(elBasemapStyleSelect.value);
  });
}

populateBasemapStyleSelect();

let dragFromId = null;

renderList();
updateStep1Headers();
updateAddButtonState();
updateBelongingValueLabel();

// Default to welcome page.
showPage("welcome", { scroll: "welcome", behavior: "auto" });

// Postcard preview + print (10x15cm)
if (elPrintPostcardBtn) {
  elPrintPostcardBtn.addEventListener("click", () => {
    printPostcardImmediatelyFromStep2();
  });
}

if (elPostcardPreviewCloseBtn) {
  elPostcardPreviewCloseBtn.addEventListener("click", () => {
    closePostcardPreview();
  });
}

if (elPostcardPreviewPrintBtn) {
  elPostcardPreviewPrintBtn.addEventListener("click", () => {
    downloadPngFromPostcardPreview();
  });
}

if (elPostcardPreviewNativePrintBtn) {
  elPostcardPreviewNativePrintBtn.addEventListener("click", () => {
    printPostcardFromPreview();
  });
}

if (elPostcardRotateBtn) {
  elPostcardRotateBtn.addEventListener("click", () => {
    postcardRotate90 = !postcardRotate90;
    syncPostcardRotateUi();
    applyPostcardRotationLayout();
  });
}

if (elPostcardPreviewOverlay) {
  elPostcardPreviewOverlay.addEventListener("click", (e) => {
    // Only close when clicking the backdrop area, not the toolbar buttons.
    const t = e.target;
    if (t && t.classList && t.classList.contains("postcardPreviewBackdrop")) {
      closePostcardPreview();
    }
  });
}

function wireHomeLogoNavigation() {
  const els = Array.from(document.querySelectorAll(".brand, .life-path"));
  for (const el of els) {
    // Avoid double-wiring.
    if (el.dataset && el.dataset.homeWired === "1") continue;
    if (el.dataset) el.dataset.homeWired = "1";

    try {
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", "Back to main page");
    } catch {
      // ignore
    }

    el.addEventListener("click", () => {
      const fromStep2 = (() => {
        try {
          return Boolean(el && typeof el.closest === "function" && el.closest("#pageStep2"));
        } catch {
          return false;
        }
      })();

      if (fromStep2 && step2OpenedFromArchive) {
        try {
          resetForNextStudent();
          setStatus("");
          setAddressStatus("");
        } catch {
          // ignore
        }
        step2OpenedFromArchive = false;
        setStep2CloseReturnPage("welcome");
      }

      showPage("welcome", { scroll: "welcome", behavior: "auto" });
    });

    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const fromStep2 = (() => {
          try {
            return Boolean(el && typeof el.closest === "function" && el.closest("#pageStep2"));
          } catch {
            return false;
          }
        })();

        if (fromStep2 && step2OpenedFromArchive) {
          try {
            resetForNextStudent();
            setStatus("");
            setAddressStatus("");
          } catch {
            // ignore
          }
          step2OpenedFromArchive = false;
          setStep2CloseReturnPage("welcome");
        }

        showPage("welcome", { scroll: "welcome", behavior: "auto" });
      }
    });
  }
}

wireHomeLogoNavigation();

function wireCloseToHomeButtons() {
  const els = Array.from(document.querySelectorAll(".closeToHomeBtn"));
  for (const el of els) {
    if (el.dataset && el.dataset.closeWired === "1") continue;
    if (el.dataset) el.dataset.closeWired = "1";

    try {
      el.setAttribute("aria-label", "Close");
    } catch {
      // ignore
    }

    el.addEventListener("click", () => {
      const fromStep2 = (() => {
        try {
          return Boolean(el && typeof el.closest === "function" && el.closest("#pageStep2"));
        } catch {
          return false;
        }
      })();

      if (fromStep2 && step2CloseReturnPage === "archive") {
        // After viewing an archived map, reset Step 1 so the data entry page starts fresh.
        try {
          resetForNextStudent();
          setStatus("");
          setAddressStatus("");
        } catch {
          // ignore
        }
        step2OpenedFromArchive = false;
        setStep2CloseReturnPage("welcome");
        showPage("archive");
        return;
      }

      // Default: close to Welcome.
      // Requirement: After closing the Life Path map (Step 2), clear Step 1 so the next student starts fresh.
      if (fromStep2) {
        try {
          resetForNextStudent();
          setStatus("");
          setAddressStatus("");
        } catch {
          // ignore
        }
      }
      setStep2CloseReturnPage("welcome");
      showPage("welcome", { scroll: "welcome", behavior: "auto" });
    });
  }
}

wireCloseToHomeButtons();

if (elStudentName) {
  elStudentName.addEventListener("input", () => {
    const before = String(elStudentName.value || "");
    const after = sanitizeEnglishOnlyName(before);
    if (after !== before) elStudentName.value = after;

    // Keep postcard/Step 2 labels in sync while editing.
    try {
      updateStep2SignatureLabel();
      updatePostcardCardMapName();
    } catch {
      // ignore
    }
  });
}

if (elAllMapsBtn) {
  elAllMapsBtn.addEventListener("click", () => {
    showPage("allmaps");
  });
}

if (elArchiveBtn) {
  elArchiveBtn.addEventListener("click", () => {
    showPage("archive");
  });
}

// Back button removed; the LifePath logo acts as home navigation.

if (elSaveMapBtn) {
  elSaveMapBtn.addEventListener("click", () => {
    const ok = saveCurrentMapSnapshot();
  });
}

if (elBackToStep1Btn) {
  elBackToStep1Btn.addEventListener("click", () => {
    showPage("step1", { scroll: "step1", behavior: "auto" });
    setAddressStatus("");
    currentAddressVerified = false;
    updateStep1Headers();
    updateAddButtonState();
    updateBelongingValueLabel();
  });
}

if (elEmotionMapBtn) {
  elEmotionMapBtn.addEventListener("click", () => {
    pendingEmotionStart = captureEmotionStartFromStep2();
    lastEmotionStart = pendingEmotionStart;
    showPage("emotion");
  });
}

if (elBackToMapBtn) {
  elBackToMapBtn.addEventListener("click", () => {
    if (lastEmotionStart) {
      animateEmotionBackToMap(lastEmotionStart);
      return;
    }
    showPage("step2");
  });
}

if (elEmotionEditBtn) {
  elEmotionEditBtn.addEventListener("click", () => {
    showPage("step1", { scroll: "step1", behavior: "auto" });
    setAddressStatus("");
    currentAddressVerified = false;
    updateStep1Headers();
    updateAddButtonState();
    updateBelongingValueLabel();
  });
}

if (elEmotionSaveBtn) {
  elEmotionSaveBtn.addEventListener("click", () => {
    const ok = saveCurrentMapSnapshot();
  });
}

function verifyCurrentAddress() {
  const country = String(elCountry?.value || "").trim();
  const city = String(elCity?.value || "").trim();
  const street = String(elStreet?.value || "").trim();
  const number = String(elNumber?.value || "").trim();

  if (!country || !city || !street || !number) {
    currentAddressVerified = false;
    setAddressStatus("");
    updateAddButtonState();
    return;
  }

  setAddressStatus("Verifying…");

  const address = {
    country,
    city,
    state: getValue("state"),
    street,
    number,
  };

  verifyCurrentAddressWithDiagnosis(address);
}

let verifyAddressRequestSeq = 0;

async function nominatimSearchExistsStructured({ country, city, streetLine }) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("accept-language", "en");
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("namedetails", "0");
  url.searchParams.set("extratags", "0");

  const ctry = tidyToken(country);
  const cty = tidyToken(city);
  const street = tidyToken(streetLine);

  if (street) url.searchParams.set("street", street);
  if (cty) url.searchParams.set("city", cty);
  if (ctry) url.searchParams.set("country", ctry);

  const res = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json",
      "Accept-Language": "en",
    },
  });

  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

async function diagnoseAddressNotFound(address) {
  const country = tidyToken(address.country);
  const city = tidyToken(address.city);
  const street = tidyToken(address.street);

  // 1) If the city itself can't be found in this country, likely the city.
  const cityOk = await nominatimSearchExistsStructured({ country, city, streetLine: "" });
  if (!cityOk) return "City";

  // 2) If the street can't be found in this city/country, likely the street.
  const streetOk = await nominatimSearchExistsStructured({ country, city, streetLine: street });
  if (!streetOk) return "Street";

  // 3) City+street exist, but full address failed — likely the home number.
  return "Home number";
}

function verifyCurrentAddressWithDiagnosis(address) {
  const requestSeq = ++verifyAddressRequestSeq;

  geocodeAddress(address)
    .then((geo) => {
      if (requestSeq !== verifyAddressRequestSeq) return;
      currentAddressVerified = true;
      const level = String(geo && geo.matchLevel ? geo.matchLevel : "");
      if (level === "place") {
        setAddressStatus("✓ Location found (street/number not found)");
      } else {
        setAddressStatus("✓ Address verified");
      }
      updateAddButtonState();
    })
    .catch(async () => {
      if (requestSeq !== verifyAddressRequestSeq) return;
      currentAddressVerified = false;

      let detail = "";
      try {
        detail = await diagnoseAddressNotFound(address);
      } catch {
        detail = "";
      }

      if (requestSeq !== verifyAddressRequestSeq) return;
      if (detail) {
        setAddressStatus(`✗ Address not found (check ${detail})`);
      } else {
        setAddressStatus("✗ Address could not be verified");
      }
      updateAddButtonState();
    });
}

let verifyAddressDebounceId = 0;

function scheduleVerifyCurrentAddress(delayMs = 550) {
  if (verifyAddressDebounceId) window.clearTimeout(verifyAddressDebounceId);
  verifyAddressDebounceId = window.setTimeout(() => {
    verifyAddressDebounceId = 0;
    verifyCurrentAddress();
  }, delayMs);
}

function handleAddressFieldInput() {
  currentAddressVerified = false;
  setAddressStatus("");
  updateAddButtonState();
}

function handleAddressFieldKeydown(e) {
  if (e.key === "Enter") {
    verifyCurrentAddress();
  }
}

function handleAddressFieldBlur() {
  verifyCurrentAddress();
}

if (elCountry) {
  elCountry.addEventListener("input", handleAddressFieldInput);
  elCountry.addEventListener("keydown", handleAddressFieldKeydown);
  elCountry.addEventListener("blur", handleAddressFieldBlur);
}
if (elCity) {
  elCity.addEventListener("input", handleAddressFieldInput);
  elCity.addEventListener("keydown", handleAddressFieldKeydown);
  elCity.addEventListener("blur", handleAddressFieldBlur);
}
if (elStreet) {
  elStreet.addEventListener("input", handleAddressFieldInput);
  elStreet.addEventListener("keydown", handleAddressFieldKeydown);
  elStreet.addEventListener("blur", handleAddressFieldBlur);
}
if (elNumber) {
  elNumber.addEventListener("input", () => {
    handleAddressFieldInput();
    // Auto-verify shortly after the home number is entered (no extra click needed).
    scheduleVerifyCurrentAddress();
  });
  elNumber.addEventListener("keydown", handleAddressFieldKeydown);
  elNumber.addEventListener("blur", handleAddressFieldBlur);
}
if (elBelongingRate) {
  elBelongingRate.addEventListener("input", () => {
    belongingLabelShown = true;
    updateBelongingValueLabel();
  });
}

elToggleMapBtn.addEventListener("click", () => {
  const hidden = elMap.classList.toggle("hidden");
  elToggleMapBtn.textContent = hidden ? "Show canvas" : "Hide canvas";

  // Leaflet needs a size recalculation when the container becomes visible.
  if (!hidden) {
    setTimeout(() => {
      map.invalidateSize();
      resizeSplashCanvas();
      if (splashEnabled) redrawSplash();

      // If Step 2 was opened while the canvas was hidden, apply the fit now.
      if (step2OpenShouldFitToAddresses) resetStep2ZoomLabelBase();
      forceStep2OpenFitToAddressesSoon();
      // If no snap is pending, keep the label aligned to the current view.
      if (!step2OpenShouldFitToAddresses) setStep2ZoomLabelBaseToCurrentView();
    }, 0);
  }
});

elToggleGeoBtn.addEventListener("click", () => {
  setGeoLayerEnabled(!geoLayerEnabled);

  // If the map is currently hidden, defer UI updates until shown.
  if (!elMap.classList.contains("hidden")) {
    setTimeout(() => map.invalidateSize(), 0);
  }
});

if (elHideMapBtn) {
  elHideMapBtn.addEventListener("click", () => {
    setGeoLayerEnabled(!geoLayerEnabled);
    if (!elMap.classList.contains("hidden")) {
      setTimeout(() => map.invalidateSize(), 0);
    }
  });
}

elForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!currentAddressVerified) {
    setAddressStatus("Please wait for address verification.");
    return;
  }

  /** @type {Address} */
  const address = {
    id: cryptoId(),
    country: getValue("country"),
    state: getValue("state"),
    city: getValue("city"),
    street: getValue("street"),
    number: getValue("number"),
    belonging_rate: normalizeBelongingRate(getValue("belonging_rate")),
    valid: true,
  };

  // Get the geocoded data from cache or re-geocode (should be cached)
  try {
    const geo = await geocodeAddress(address);
    address.lat = geo.lat;
    address.lon = geo.lon;
    address.displayName = geo.displayName;

    // Requested: store only country/city/street/number in a standard English/Latin form.
    if (geo.normalized) {
      address.country = geo.normalized.country || address.country;
      address.city = geo.normalized.city || address.city;
      address.street = geo.normalized.street || address.street;
      address.number = geo.normalized.number || address.number;
    }
  } catch {
    // This shouldn't happen since we already verified
    setAddressStatus("Unexpected error. Please try again.");
    return;
  }

  addresses.push(address);
  saveJson(STORAGE_KEY, addresses);
  showAddToListMessage(addresses.length);

  const keepName = String(elStudentName?.value || "");
  elForm.reset();
  if (elStudentName) elStudentName.value = keepName;

  currentAddressVerified = false;
  setAddressStatus("");
  updateAddButtonState();
  belongingLabelShown = false;
  updateBelongingValueLabel();
  renderList();
  updateStep1Headers();
});

if (elCreateLifePathBtn) {
  elCreateLifePathBtn.addEventListener("click", async () => {
    const name = String(elStudentName?.value || "").trim();
    if (!name) {
      setStatus("Please enter your full name.");
      if (elStudentName && typeof elStudentName.focus === "function") elStudentName.focus();
      return;
    }

    if (addresses.length < 2) {
      setStatus("Add at least 2 homes to create your life path.");
      return;
    }

    // Default: graphics only (tiles hidden). User can click "Show map".
    setGeoLayerEnabled(false);

    // Ensure the signature label is computed before showing Step 2.
    updateStep2SignatureLabel();

    if (createLifePathTransitionActive) return;
    createLifePathTransitionActive = true;
    armResetStep1AfterCreateSave();
    if (elCreateLifePathBtn) elCreateLifePathBtn.disabled = true;
    showCreateLifePathTransition(true);

    // After 3 seconds, show the Life Path map page.
    setTimeout(() => {
      showCreateLifePathTransition(false);
      createLifePathTransitionActive = false;
      if (elCreateLifePathBtn) elCreateLifePathBtn.disabled = false;

      // Navigate so the map is visible for drawing.
      requestStep2OpenFitToAddresses();
      step2HoldFitAfterNextDraw = true;
      setStep2CloseReturnPage("welcome");
      showPage("step2");

      // Reuse existing draw handler, but only after we have snapped to 100%.
      autoSaveAfterStep2OpenAt100 = true;
      autoDrawAfterStep2OpenAt100 = true;
    }, 3000);
  });
}

if (elDrawBelongingBtn) elDrawBelongingBtn.addEventListener("click", async () => {
  if (addresses.length === 0) {
    setStatus("Add at least 1 address to draw belonging.");
    return;
  }

  disableUi(true);
  try {
    setStatus("Preparing belonging…");

    /** @type {Array<{ lat:number, lon:number, rate:number, label:string }>} */
    const circlePoints = [];
    /** @type {Array<{ lat:number, lon:number, weight:number, color:string }>} */
    const paintPoints = [];
    let skippedInvalid = 0;

    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];

      if (addr.valid === false) {
        skippedInvalid++;
        continue;
      }

      const rate = normalizeBelongingRate(addr.belonging_rate, stableBelongingRateFromId(addr.id));
      const paintColor = belongingColor(rate);
      const label = addr.displayName || formatAddress(addr);

      if (isFinite(addr.lat) && isFinite(addr.lon)) {
        circlePoints.push({ lat: addr.lat, lon: addr.lon, rate, label });
        paintPoints.push({ lat: addr.lat, lon: addr.lon, weight: rate, color: paintColor });
        continue;
      }

      setStatus(`Geocoding ${i + 1}/${addresses.length}…`);
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await geocodeAddress(addr);
        addr.valid = true;
        addr.lat = result.lat;
        addr.lon = result.lon;
        addr.displayName = result.displayName;
        circlePoints.push({ lat: result.lat, lon: result.lon, rate, label: result.displayName });
        paintPoints.push({ lat: result.lat, lon: result.lon, weight: rate, color: paintColor });
      } catch {
        addr.valid = false;
        skippedInvalid++;
      }

      // eslint-disable-next-line no-await-in-loop
      await sleep(900);
    }

    saveJson(STORAGE_KEY, addresses);
    renderList();

    clearMap();
    clearAllSignatures();
    clearCityDots();

    // Prep paint sources (color encodes belonging), but only render when user toggles Paint colors.
    splashSources = { type: "belonging", points: paintPoints };
    if (splashEnabled) {
      redrawSplash();
    } else {
      clearSplash();
      if (elToggleSplashBtn) elToggleSplashBtn.textContent = "Paint colors";
    }

    clearBelongingCircles();

    if (circlePoints.length === 0) {
      setStatus("No valid addresses to draw.");
      return;
    }

    // Fit view to points.
    const bounds = L.latLngBounds(circlePoints.map((p) => L.latLng(p.lat, p.lon)));
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.25));

    // Draw circles: stroke width equals belonging rate (1 => 1px, 2 => 2px, ...).
    // Keep inner circle size constant by increasing radius with stroke width.
    circlePoints.forEach((p) => {
      const weight = clamp(p.rate, 1, 10);
      const innerRadius = 11;
      const radius = innerRadius + weight / 2;
      const circle = L.circleMarker([p.lat, p.lon], {
        radius,
        weight,
        opacity: 0.95,
        color: "#111827",
        fillOpacity: 0,
      });
      circle.bindTooltip(formatAddressForHoverLabel(p.label), { direction: "right", offset: [12, 0], sticky: false, className: "lifepathAddressTooltip" });
      belongingCirclesLayer.addLayer(circle);
    });

    setStatus(`Drew ${circlePoints.length} belonging circle(s) • Skipped ${skippedInvalid} invalid`);
  } catch (err) {
    setStatus(`Draw belonging error: ${String(err?.message || err)}`);
  } finally {
    disableUi(false);
  }
});

elClearBtn.addEventListener("click", () => {
  if (addresses.length === 0) return;
  const ok = confirm("Clear the timeline?");
  if (!ok) return;

  addresses = [];
  saveJson(STORAGE_KEY, addresses);
  renderList();
  clearMap();
  setStatus("Cleared.");
});

elDrawBtn.addEventListener("click", async () => {
  if (addresses.length < 2) {
    setStatus("Add at least 2 addresses to draw a path.");
    return;
  }

  disableUi(true);
  try {
    setStatus("Preparing…");

    const points = [];
    let skippedInvalid = 0;
    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];

      const rate = normalizeBelongingRate(addr.belonging_rate, stableBelongingRateFromId(addr.id));

      // Ignore explicitly invalid addresses.
      if (addr.valid === false) {
        skippedInvalid++;
        continue;
      }

      // Use stored coordinates if present.
      if (isFinite(addr.lat) && isFinite(addr.lon)) {
        points.push({
          lat: addr.lat,
          lon: addr.lon,
          label: formatAddressAsInList(addr),
          rate,
        });
        continue;
      }

      // If not yet verified (e.g., imported), attempt geocode now.
      setStatus(`Geocoding ${i + 1}/${addresses.length}…`);
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await geocodeAddress(addr);
        addr.valid = true;
        addr.lat = result.lat;
        addr.lon = result.lon;
        addr.displayName = result.displayName;
        points.push({ lat: result.lat, lon: result.lon, label: formatAddressAsInList(addr), rate });
      } catch {
        addr.valid = false;
        skippedInvalid++;
      }

      // eslint-disable-next-line no-await-in-loop
      await sleep(900);
    }

    saveJson(STORAGE_KEY, addresses);
    renderList();

    if (points.length < 2) {
      clearMap();
      setStatus("Need at least 2 valid addresses to draw a path.");
      return;
    }

    setStatus("Writing your path…");
    drawPath(points, {
      onComplete: () => {
        // After the locations/path are drawn, zoom in to include all
        // Israel-located points.
        focusMapOnIsraelLocationsMax();
        setStep2ZoomLabelBaseToCurrentView();
        updateStep2ZoomLabel();
        step2HoldFitAfterNextDraw = false;
        step2OpenShouldFitToAddresses = false;
        setStatus(`Drew ${points.length} stop(s) • Skipped ${skippedInvalid} invalid`);

        // Default behavior: after a map is created (draw completes), save it
        // automatically so users don't need to click Save.
        maybeAutoSaveCurrentMapSnapshot();
      },
    });
  } catch (err) {
    setStatus(`Error: ${String(err?.message || err)}`);
  } finally {
    disableUi(false);
  }
});

if (elDrawAllBtn) elDrawAllBtn.addEventListener("click", async () => {
  disableUi(true);
  try {
    setStatus("Loading saved signatures…");
    const records = await fetchSavedSignatures();

    const drawn = drawAllSignatures(records);
    if (drawn.total === 0) {
      setStatus("No saved signatures to draw.");
      return;
    }

    setStatus(`Drew ${drawn.total} signature(s) • Skipped ${drawn.skipped} (not enough points)`);
  } catch (err) {
    setStatus(`Draw-all error: ${String(err?.message || err)}`);
  } finally {
    disableUi(false);
  }
});

// Kiosk API detection (helps when the wrong server is running).
let kioskApiOk = null;

checkKioskApi();

if (elSaveBtn) elSaveBtn.addEventListener("click", async () => {
  if (addresses.length === 0) {
    setStatus("Add at least 1 address to save.");
    return;
  }

  const studentName = String(prompt("Student name:", "") || "").trim();
  if (!studentName) {
    setStatus("Name is required to save.");
    return;
  }

  disableUi(true);
  try {
    setStatus("Preparing signature…");
    const signature = await buildSignature(studentName);

    setStatus("Saving…");
    const res = await fetch("/api/signatures", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: cryptoId(),
        studentName,
        signature,
      }),
    });

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("Kiosk API not found. Run `python server.py` (not `python -m http.server`).");
      }
      throw new Error(`Save failed (${res.status})`);
    }

    const data = await res.json();
    resetForNextStudent();
    if (signature.points.length >= 2) {
      setStatus(`Saved. Total signatures: ${data.count ?? "?"}. Next student.`);
    } else if (signature.points.length === 1) {
      setStatus(`Saved (1 verified stop). Total signatures: ${data.count ?? "?"}. Next student.`);
    } else {
      setStatus(`Saved (no verified stops). Total signatures: ${data.count ?? "?"}. Next student.`);
    }
  } catch (err) {
    setStatus(`Save error: ${String(err?.message || err)}`);
  } finally {
    disableUi(false);
  }
});

if (elLoadBtn) elLoadBtn.addEventListener("click", async () => {
  const query = String(prompt("Load signature by student name or id:", "") || "").trim();
  if (!query) return;

  disableUi(true);
  try {
    setStatus("Loading saved signatures…");
    const records = await fetchSavedSignatures();

    const record = findSignatureRecord(records, query);
    if (!record) {
      setStatus("No matching signature found.");
      return;
    }

    applyLoadedRecord(record);

    const name = String(record.studentName || record.signature?.studentName || "").trim();
    const stops = Array.isArray(record.signature?.points) ? record.signature.points.length : 0;
    setStatus(`Loaded ${name ? name : record.id} • ${stops} stop(s)`);
  } catch (err) {
    setStatus(`Load error: ${String(err?.message || err)}`);
  } finally {
    disableUi(false);
  }
});

async function fetchSavedSignatures() {
  const res = await fetch("/api/signatures", { cache: "no-store" });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("Kiosk API not found. Run `python server.py` (not `python -m http.server`).");
    }
    throw new Error(`Failed to load (${res.status})`);
  }

  const data = await res.json();
  const list = Array.isArray(data?.signatures) ? data.signatures : [];
  return list;
}

function findSignatureRecord(records, query) {
  if (!Array.isArray(records) || records.length === 0) return null;

  const q = String(query || "").trim();
  if (!q) return null;

  const qLower = q.toLowerCase();

  // Prefer most recent match.
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (!r || typeof r !== "object") continue;

    const id = String(r.id || "").trim();
    if (id && id.toLowerCase() === qLower) return r;

    const name = String(r.studentName || r.signature?.studentName || "").trim();
    if (name && name.toLowerCase() === qLower) return r;
  }

  return null;
}

function applyLoadedRecord(record) {
  const sig = record && record.signature;
  if (!sig || typeof sig !== "object") throw new Error("Invalid record (missing signature)");

  // Restore options (geo layer).
  const hasGeo = sig.options && typeof sig.options === "object" && Object.prototype.hasOwnProperty.call(sig.options, "geoLayerEnabled");
  const wantGeo = hasGeo ? Boolean(sig.options.geoLayerEnabled) : true;
  if (typeof setGeoLayerEnabled === "function") setGeoLayerEnabled(wantGeo);

  // Restore timeline addresses when present.
  if (Array.isArray(sig.addresses) && sig.addresses.length > 0) {
    addresses = migrateAddresses(sig.addresses);
    saveJson(STORAGE_KEY, addresses);
    renderList();
  } else {
    addresses = [];
    saveJson(STORAGE_KEY, addresses);
    renderList();
  }

  // Ensure the canvas is visible.
  if (elMap.classList.contains("hidden")) {
    elMap.classList.remove("hidden");
    elToggleMapBtn.textContent = "Hide canvas";
    setTimeout(() => map.invalidateSize(), 0);
  }

  // Redraw.
  const points = Array.isArray(sig.points) ? sig.points : [];
  if (points.length === 0) {
    clearMap();
    return;
  }

  drawPath(points, {
    onComplete: () => {
      // no-op; status updated by caller
    },
  });
}

async function checkKioskApi() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) {
      kioskApiOk = false;
      return;
    }
    const data = await res.json();
    kioskApiOk = Boolean(data && data.ok);
  } catch {
    kioskApiOk = false;
  }

  // If the kiosk API is not available, do not show the offline saving message.
  // (Message removed as requested)
}

elExportBtn.addEventListener("click", () => {
  const exportedAddresses = addresses.map((a) => {
    // Ensure exported items include coordinates when available.
    const withCoords = { ...a };
    if (!(isFinite(withCoords.lat) && isFinite(withCoords.lon))) {
      const cached = geocodeCache[canonicalKey(a)];
      if (cached && isFinite(cached.lat) && isFinite(cached.lon)) {
        withCoords.lat = cached.lat;
        withCoords.lon = cached.lon;
        withCoords.displayName = withCoords.displayName || cached.displayName;
        if (typeof withCoords.valid !== "boolean") withCoords.valid = true;
      }
    }
    return withCoords;
  });

  const exportPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    addresses: exportedAddresses,
  };

  const json = JSON.stringify(exportPayload, null, 2);
  downloadJson(json, `lifepath-${new Date().toISOString().slice(0, 10)}.json`);
  setStatus("Exported." );
});

if (elImportBtn && elImportFile) elImportBtn.addEventListener("click", () => {
  elImportFile.value = "";
  elImportFile.click();
});

if (elImportFile) elImportFile.addEventListener("change", async () => {
  const file = elImportFile.files && elImportFile.files[0];
  if (!file) return;

  disableUi(true);
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

    // Support restoring the Archive (saved maps) from a lifepath archive export.
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.savedMaps)) {
      const res = restoreSavedMapsFromArchivePayload(parsed);
      if (res.ok) {
        try {
          renderArchiveGrid();
          renderAllMapsCombinedMap();
        } catch {
          // ignore
        }
        setStatus(`Restored ${res.count} saved map(s).`);
      } else {
        setStatus("Invalid archive JSON: expected { savedMaps: [...] }.");
      }
      return;
    }

    const imported = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.addresses)
        ? parsed.addresses
        : null;

    if (!imported) {
      setStatus("Invalid JSON: expected an array or { addresses: [...] }.");
      return;
    }

    addresses = migrateAddresses(imported);
    saveJson(STORAGE_KEY, addresses);
    renderList();
    clearMap();
    setStatus(`Imported ${addresses.length} address(es).`);
  } catch (err) {
    setStatus(`Import failed: ${String(err?.message || err)}`);
  } finally {
    disableUi(false);
  }
});

function renderList() {
  elList.innerHTML = "";

  updateCreateLifePathButtonState();

  if (addresses.length === 0) {
    // Keep empty list truly empty in the Step 1 layout.
    return;
  }

  addresses.forEach((addr, index) => {
    const li = document.createElement("li");
    li.className = "step1ListItem";

    if (addr.valid === false) {
      li.style.borderLeft = "4px solid red";
      li.style.paddingLeft = "8px";
    }

    const row1 = document.createElement("div");
    row1.className = "step1ListRow";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "step1DeleteBtn";
    deleteBtn.dataset.id = String(addr.id);
    deleteBtn.setAttribute("aria-label", "Delete");
    deleteBtn.textContent = "X";

    // Direct handler (in addition to delegated handler) so clicks always delete
    // even if layout/CSS changes affect event delegation in some browsers.
    deleteBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteAddressById(String(addr.id));
    });

    const homeNo = document.createElement("div");
    homeNo.className = "step1ListHome";
    homeNo.textContent = `[home no.${formatHomeNumber(index + 1)}]`;

    const addressText = document.createElement("div");
    addressText.className = "step1ListAddress";
    addressText.textContent = formatAddressAsInList(addr);

    row1.appendChild(deleteBtn);
    row1.appendChild(homeNo);
    row1.appendChild(addressText);

    const row2 = document.createElement("div");
    row2.className = "step1ListBelonging";
    const rate = normalizeBelongingRate(addr.belonging_rate, stableBelongingRateFromId(addr.id));
    row2.textContent = `Belonging ${rate}/10`;

    li.appendChild(row1);
    li.appendChild(row2);
    elList.appendChild(li);
  });
}

function deleteAddressById(id) {
  const wanted = String(id || "");
  if (!wanted) return;

  const idx = addresses.findIndex((a) => String(a.id) === wanted);
  if (idx < 0) return;

  addresses.splice(idx, 1);
  saveJson(STORAGE_KEY, addresses);
  renderList();
  updateStep1Headers();
}

elList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const deleteBtn = target.closest(".step1DeleteBtn");
  if (!deleteBtn) return;

  const id = deleteBtn.getAttribute("data-id");
  if (!id) return;

  deleteAddressById(id);
});

function openInlineEditor(li, addr) {
  li.innerHTML = "";

  const handle = document.createElement("div");
  handle.className = "dragHandle";
  handle.title = "Drag to reorder";
  handle.textContent = "⋮⋮";

  const main = document.createElement("div");

  const fields = [
    { key: "country", label: "Country*", type: "input" },
    { key: "state", label: "State", type: "input" },
    { key: "city", label: "City*", type: "input" },
    { key: "street", label: "Street", type: "input" },
    { key: "number", label: "Number", type: "input" },
    { key: "belonging_rate", label: "Belonging (1–10)", type: "number" },
  ];

  const editor = document.createElement("div");
  editor.style.display = "grid";
  editor.style.gap = "6px";

  /** @type {Record<string, HTMLInputElement | HTMLSelectElement>} */
  const inputs = {};
  fields.forEach((f) => {
    const row = document.createElement("div");
    if (f.type === "number") {
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = "10";
      input.step = "1";
      input.value = String(normalizeBelongingRate(addr.belonging_rate, 5));
      input.placeholder = f.label;
      inputs[f.key] = input;
      row.appendChild(input);
    } else {
      const input = document.createElement("input");
      input.value = String(addr[f.key] || "");
      input.placeholder = f.label;
      inputs[f.key] = input;
      row.appendChild(input);
    }
    editor.appendChild(row);
  });

  main.appendChild(editor);

  const actions = document.createElement("div");
  actions.className = "actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", async () => {
    const updated = {
      ...addr,
      country: String(inputs.country.value || "").trim(),
      state: String(inputs.state.value || "").trim(),
      city: String(inputs.city.value || "").trim(),
      street: String(inputs.street.value || "").trim(),
      number: String(inputs.number.value || "").trim(),
      belonging_rate: normalizeBelongingRate(inputs.belonging_rate.value, addr.belonging_rate),
      // reset validation; will be re-verified
      valid: undefined,
      lat: undefined,
      lon: undefined,
      displayName: undefined,
    };

    if (!updated.country || !updated.city) {
      setStatus("Please fill all required fields.");
      return;
    }

    disableUi(true);
    try {
      setStatus("Verifying edited address…");
      try {
        const geo = await geocodeAddress(updated);
        updated.valid = true;
        updated.lat = geo.lat;
        updated.lon = geo.lon;
        updated.displayName = geo.displayName;
      } catch {
        updated.valid = false;
      }

      const idx = addresses.findIndex((a) => a.id === addr.id);
      if (idx >= 0) addresses[idx] = updated;
      saveJson(STORAGE_KEY, addresses);
      renderList();
      clearMap();
      setStatus(updated.valid ? "Saved (valid)." : "Saved (invalid address).");
    } finally {
      disableUi(false);
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    renderList();
    setStatus("Edit cancelled.");
  });

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);

  li.appendChild(handle);
  li.appendChild(main);
  li.appendChild(actions);
}

function drawPath(points, opts = {}) {
  clearMap();
  clearAllSignatures();
  clearCityDots();

  const latLngs = points.map((p) => L.latLng(p.lat, p.lon));

  splashSources = {
    type: "single",
    points: points.map((p) => {
      const rate = normalizeBelongingRate(p.rate, 5);
      return {
        lat: p.lat,
        lon: p.lon,
        weight: rate,
        color: belongingColor(rate),
      };
    }),
  };
  if (splashEnabled) redrawSplash();

  // Fit the view first so the drawing animation happens in a stable projection.
  // But: when opening Step 2 (Create/Archive), we keep the opening fitted view stable.
  const holdOpeningFit = step2HoldFitAfterNextDraw || step2OpenShouldFitToAddresses;
  if (!holdOpeningFit) {
    const bounds = L.latLngBounds(latLngs);
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.25));
  }

  // Create layers.
  markerLayer = L.layerGroup();
  const overlayColor = getOverlayStrokeColor();
  const markers = points.map((p) => {
    const rate = normalizeBelongingRate(p.rate, 1);
    const innerRadius = 4;
    const radius = innerRadius + rate / 2;
    const m = L.circleMarker([p.lat, p.lon], {
      radius,
      weight: rate,
      opacity: 1,
      color: overlayColor,
      fillOpacity: 0,
    });
    m.bindTooltip(formatAddressForHoverLabel(p.label), { direction: "right", offset: [12, 0], sticky: false, className: "lifepathAddressTooltip" });
    return m;
  });

  polyline = L.polyline([], {
    weight: 1,
    opacity: 1,
    color: overlayColor,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(map);

  // Animate the path like handwriting.
  // Densify in projected pixel space for a smoother stroke.
  const dense = densifyLatLngs(latLngs, map, 8);
  if (dense.length === 0) return;

  const ANIMATION_MS = 3600;
  const start = performance.now();
  const current = [dense[0]];
  let lastIndex = 0;
  polyline.setLatLngs(current);

  function tick(now) {
    const t = Math.min(1, (now - start) / ANIMATION_MS);
    const targetIndex = Math.floor(t * (dense.length - 1));

    if (targetIndex > lastIndex) {
      for (let i = lastIndex + 1; i <= targetIndex; i++) {
        current.push(dense[i]);
      }
      polyline.setLatLngs(current);
      lastIndex = targetIndex;
    }

    if (t < 1) {
      requestAnimationFrame(tick);
      return;
    }

    // Reveal markers after the stroke completes.
    markers.forEach((m) => markerLayer.addLayer(m));
    markerLayer.addTo(map);

    if (typeof opts.onComplete === "function") {
      opts.onComplete();
    }
  }

  requestAnimationFrame(tick);
}

function drawAllSignatures(records) {
  clearAllSignatures();
  clearCityDots();
  clearMap();

  clearSplash();

  if (!Array.isArray(records) || records.length === 0) {
    return { total: 0, skipped: 0 };
  }

  /** @type {L.LatLng[]} */
  const allLatLngs = [];
  let total = 0;
  let skipped = 0;

  /** @type {Record<string, { label: string, students: Set<string>, samples: Array<{lat:number, lon:number}> }>} */
  const cityAgg = {};

  /** @type {Array<{ lat: number, lon: number, weight: number, color: string }>} */
  const splashPoints = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const sig = rec && rec.signature;
    const pts = Array.isArray(sig?.points) ? sig.points : [];
    if (pts.length < 2) {
      skipped++;
      continue;
    }

    const color = signatureColor(total);
    const latLngs = pts
      .map((p) => L.latLng(Number(p.lat), Number(p.lon)))
      .filter((ll) => isFinite(ll.lat) && isFinite(ll.lng));

    if (latLngs.length < 2) {
      skipped++;
      continue;
    }

    allLatLngs.push(...latLngs);

    const name = String(rec.studentName || sig.studentName || rec.id || "").trim();
    const line = L.polyline(latLngs, {
      weight: 3,
      opacity: 0.9,
      color,
      lineCap: "round",
      lineJoin: "round",
    });

    if (name) {
      line.bindTooltip(name, { sticky: true });
    }

    allSignaturesLayer.addLayer(line);

    // Use the signature points as splash sources too.
    for (let j = 0; j < pts.length; j++) {
      const lat = Number(pts[j].lat);
      const lon = Number(pts[j].lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      splashPoints.push({ lat, lon, weight: 1, color });
    }

    // Aggregate unique students per city using signature.addresses when present.
    const studentId = String(rec.id || name || "").trim() || `rec-${i}`;
    const addrList = Array.isArray(sig?.addresses) ? sig.addresses : [];
    if (addrList.length > 0) {
      /** @type {Set<string>} */
      const seenCitiesForStudent = new Set();
      for (let a = 0; a < addrList.length; a++) {
        const addr = addrList[a];
        const city = String(addr?.city || "").trim();
        if (!city) continue;
        const cityKey = city.toLowerCase();

        // Only count a student once per city.
        if (seenCitiesForStudent.has(cityKey)) continue;
        seenCitiesForStudent.add(cityKey);

        const lat = Number(addr?.lat);
        const lon = Number(addr?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;

        if (!cityAgg[cityKey]) {
          cityAgg[cityKey] = {
            label: city,
            students: new Set(),
            samples: [],
          };
        }

        cityAgg[cityKey].students.add(studentId);
        cityAgg[cityKey].samples.push({ lat, lon });
      }
    }

    total++;
  }

  // Draw city dots: size represents unique students per city.
  Object.values(cityAgg).forEach((c) => {
    const n = c.students.size;
    if (!n || c.samples.length === 0) return;

    // Use average of sample coordinates.
    let latSum = 0;
    let lonSum = 0;
    for (let i = 0; i < c.samples.length; i++) {
      latSum += c.samples[i].lat;
      lonSum += c.samples[i].lon;
    }
    const lat = latSum / c.samples.length;
    const lon = lonSum / c.samples.length;
    if (!isFinite(lat) || !isFinite(lon)) return;

    const radius = clamp(4 + Math.sqrt(n) * 3, 5, 18);
    const dotColor = getOverlayStrokeColor();
    const dot = L.circleMarker([lat, lon], {
      radius,
      weight: 1,
      opacity: 1,
      color: dotColor,
      fillOpacity: 0.18,
      fillColor: dotColor,
    });
    dot.bindTooltip(`${c.label} • ${n} student(s)`, { direction: "top", sticky: true });
    cityDotsLayer.addLayer(dot);

    allLatLngs.push(L.latLng(lat, lon));

    // Add a stronger splash source for city centers.
    splashPoints.push({ lat, lon, weight: clamp(n, 1, 12), color: dotColor });
  });

  splashSources = { type: "all", points: splashPoints };
  if (splashEnabled) redrawSplash();

  const bounds = L.latLngBounds(allLatLngs);
  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.15));
  }

  return { total, skipped };
}

function clearAllSignatures() {
  if (allSignaturesLayer) {
    allSignaturesLayer.clearLayers();
  }
}

function clearCityDots() {
  if (cityDotsLayer) {
    cityDotsLayer.clearLayers();
  }
}

function clearSplash() {
  splashCtx.clearRect(0, 0, splashCanvas.width, splashCanvas.height);
}

function redrawSplash() {
  clearSplash();
  if (!splashSources || !Array.isArray(splashSources.points) || splashSources.points.length === 0) return;
  drawSplashEffect(splashSources.points);
}

function drawSplashEffect(points) {
  // Amorphic color clouds: soft blobs only (no splatter / brush strokes).
  // Keep it deterministic-ish per redraw by not using Math.random directly.
  const baseSeed = points.length * 997;

  splashCtx.save();
  splashCtx.globalCompositeOperation = "source-over";

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;

    const pt = map.latLngToContainerPoint([lat, lon]);
    const seed = hashSeed(baseSeed + i * 17 + Math.round(lat * 1000) + Math.round(lon * 1000));
    const weight = Number(p.weight || 1);
    const r = clamp(18 + Math.sqrt(weight) * 16, 18, 78);

    // Prefer provided color (belonging/signature). Otherwise choose a vivid palette.
    const hueBase = (i * 47 + (seed % 67)) % 360;
    const color = p.color ? String(p.color) : `hsl(${hueBase} 88% 52%)`;

    // Main soft core.
    paintSoftBlob(pt.x, pt.y, r, color, 0.46);

    // A few secondary “cloud lobes” to make it amorphic.
    const lobes = 3 + (seed % 3); // 3..5
    for (let k = 0; k < lobes; k++) {
      const a = (((seed + k * 73) % 360) * Math.PI) / 180;
      const dist = r * (0.25 + (((seed + k * 19) % 100) / 100) * 0.75);
      const rr = r * (0.45 + (((seed + k * 41) % 100) / 100) * 0.55);
      const x = pt.x + Math.cos(a) * dist;
      const y = pt.y + Math.sin(a) * dist;
      paintSoftBlob(x, y, rr, color, 0.22);
    }
  }

  splashCtx.restore();
}

function paintSoftBlob(x, y, radius, color, alpha) {
  const r = clamp(radius, 6, 120);
  const g = splashCtx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");

  splashCtx.save();
  splashCtx.globalAlpha = clamp(alpha, 0, 1);
  splashCtx.fillStyle = g;
  splashCtx.beginPath();
  splashCtx.arc(x, y, r, 0, Math.PI * 2);
  splashCtx.fill();
  splashCtx.restore();
}

function hashSeed(n) {
  // Small integer hash.
  let x = n | 0;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return x >>> 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function signatureColor(index) {
  // Distinct-ish colors while keeping a slightly muted look.
  // Uses HSL to avoid needing a long hardcoded palette.
  const hue = (index * 47) % 360;
  return `hsl(${hue} 55% 38%)`;
}

function makeStatusPill(addr) {
  const pill = document.createElement("span");
  pill.className = "pill";

  if (addr.valid === true) {
    pill.classList.add("verified");
    pill.textContent = "✓ Verified";
    pill.setAttribute("aria-label", "Verified address");
    return pill;
  }

  if (addr.valid === false) {
    pill.classList.add("invalid");
    pill.textContent = "! Invalid";
    pill.setAttribute("aria-label", "Invalid address (ignored)");
    return pill;
  }

  pill.classList.add("unverified");
  pill.textContent = "• Unverified";
  pill.setAttribute("aria-label", "Unverified address");
  return pill;
}

function densifyLatLngs(latLngs, mapRef, stepPx) {
  if (!Array.isArray(latLngs) || latLngs.length < 2) return latLngs || [];

  const zoom = mapRef.getZoom();
  const out = [];

  for (let i = 0; i < latLngs.length - 1; i++) {
    const a = latLngs[i];
    const b = latLngs[i + 1];

    const pa = mapRef.project(a, zoom);
    const pb = mapRef.project(b, zoom);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(dist / stepPx));

    for (let s = 0; s < steps; s++) {
      const k = s / steps;
      const p = L.point(pa.x + dx * k, pa.y + dy * k);
      out.push(mapRef.unproject(p, zoom));
    }
  }

  // Ensure final point is included.
  out.push(latLngs[latLngs.length - 1]);
  return out;
}

function clearMap() {
  if (polyline) {
    map.removeLayer(polyline);
    polyline = null;
  }

  if (markerLayer) {
    map.removeLayer(markerLayer);
    markerLayer = null;
  }

  clearBelongingCircles();
}

function clearBelongingCircles() {
  if (belongingCirclesLayer) {
    belongingCirclesLayer.clearLayers();
  }
}

async function geocodeAddress(addr) {
  const key = canonicalKey(addr);
  const cached = geocodeCache[key];
  if (cached && isFinite(cached.lat) && isFinite(cached.lon)) {
    return cached;
  }

  const queryOriginal = buildQuery(addr);
  const queryLatin = buildQueryLatin(addr);

  const fetchNominatim = async (query, mode) => {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    // Prefer English display names for the UI list.
    url.searchParams.set("accept-language", "en");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("namedetails", "1");
    url.searchParams.set("extratags", "1");

    if (mode === "structured") {
      // Nominatim structured search: tends to be more precise for full addresses.
      const streetLine = tidyToken([addr.number, addr.street].filter(Boolean).join(" "));
      const city = tidyToken(addr.city);
      const country = tidyToken(addr.country);
      url.searchParams.set("street", streetLine);
      url.searchParams.set("city", city);
      url.searchParams.set("country", country);
    } else {
      // Freeform query.
      url.searchParams.set("q", query);
    }

    const res = await fetch(url.toString(), {
      headers: {
        // Nominatim expects an identifying UA in server-side usage.
        // From browsers you can’t set User-Agent; so keep requests low.
        "Accept": "application/json",
        "Accept-Language": "en",
      },
    });

    if (!res.ok) {
      throw new Error(`Geocoding failed (${res.status})`);
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return data[0];
  };

  // 1) Try the original (possibly Hebrew) user input — this is most likely to match.
  // 2) Fall back to Latin transliteration if needed.
  // 3) Last resort: if a place exists but street/house-number aren't mapped, fall back to city-level.
  let matchLevel = "address";
  let item = await fetchNominatim(queryOriginal, "structured");
  if (!item) item = await fetchNominatim(queryOriginal, "freeform");
  if (!item && queryLatin && queryLatin !== queryOriginal) {
    // Try transliterated structured search too.
    const saved = { country: addr.country, city: addr.city, street: addr.street, number: addr.number };
    addr.country = toEnglishLike(addr.country);
    addr.city = toEnglishLike(addr.city);
    addr.street = toEnglishLike(addr.street);
    addr.number = toEnglishLike(addr.number);
    try {
      item = await fetchNominatim(queryLatin, "structured");
      if (!item) item = await fetchNominatim(queryLatin, "freeform");
    } finally {
      addr.country = saved.country;
      addr.city = saved.city;
      addr.street = saved.street;
      addr.number = saved.number;
    }
  }

  if (!item) {
    // Some places (e.g., kibbutzim) resolve fine by settlement name, but not by internal street/house number.
    const cityOnlyOriginal = [String(addr.city || "").trim(), String(addr.country || "").trim()].filter(Boolean).join(", ");
    const cityOnlyLatin = [toEnglishLike(String(addr.city || "").trim()), toEnglishLike(String(addr.country || "").trim())]
      .filter(Boolean)
      .join(", ");

    if (cityOnlyOriginal) item = await fetchNominatim(cityOnlyOriginal, "freeform");
    if (!item && cityOnlyLatin && cityOnlyLatin !== cityOnlyOriginal) item = await fetchNominatim(cityOnlyLatin, "freeform");
    if (item) matchLevel = "place";
  }
  if (!item) {
    throw new Error(`No results for: ${queryOriginal}`);
  }

  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (!isFinite(lat) || !isFinite(lon)) {
    throw new Error(`Invalid coordinates for: ${queryOriginal}`);
  }

  const displayFromNominatim = String(item.display_name || "").trim();
  let displayName = displayFromNominatim;

  // Normalize to the requested 4 fields (country, city, street, number).
  const addressDetails = item.address || {};
  const normStreet = tidyToken(addressDetails.road || addressDetails.pedestrian || addressDetails.footway || addressDetails.path || addr.street || "");
  const normNumber = tidyToken(addressDetails.house_number || addr.number || "");
  const normCity = tidyToken(addressDetails.city || addressDetails.town || addressDetails.village || addressDetails.municipality || addr.city || "");
  const normCountry = tidyToken(addressDetails.country || addr.country || "");
  const normalized = {
    street: toEnglishLike(normStreet),
    number: toEnglishLike(normNumber),
    city: toEnglishLike(normCity),
    country: toEnglishLike(normCountry),
  };

  // If street is still Hebrew, try reverse-geocoding (sometimes yields better English road names).
  if (containsHebrew(normalized.street)) {
    const reverse = await reverseGeocodeEnglish(lat, lon);
    const revAddr = reverse && reverse.address ? reverse.address : null;
    if (revAddr) {
      const revStreet = tidyToken(revAddr.road || revAddr.pedestrian || revAddr.footway || revAddr.path || normalized.street);
      const revNumber = tidyToken(revAddr.house_number || normalized.number);
      const revCity = tidyToken(revAddr.city || revAddr.town || revAddr.village || revAddr.municipality || normalized.city);
      const revCountry = tidyToken(revAddr.country || normalized.country);

      normalized.street = toEnglishLike(revStreet);
      normalized.number = toEnglishLike(revNumber);
      normalized.city = toEnglishLike(revCity);
      normalized.country = toEnglishLike(revCountry);
    }
  }

  // If Nominatim still returns Hebrew, try building from address parts.
  if (!displayName || containsHebrew(displayName)) {
    const a = item.address || {};
    const road = a.road || a.pedestrian || a.footway || a.path || "";
    const houseNumber = a.house_number || "";
    const city = a.city || a.town || a.village || a.municipality || "";
    const country = a.country || "";

    const line1 = [road, houseNumber].filter(Boolean).join(" ").trim();
    // Requested: only country, city, street, number (no province/region/state).
    const parts = [line1, city, country].filter(Boolean);
    displayName = parts.join(", ") || displayFromNominatim || queryOriginal;
  }

  // Standardize the display name from normalized fields (fallback to transliteration).
  displayName = formatStandardAddress(normalized) || toEnglishLike(displayName || queryOriginal);

  const record = {
    lat,
    lon,
    displayName,
    normalized,
    matchLevel,
    ts: Date.now(),
  };

  geocodeCache[key] = record;
  saveJson(GEOCODE_CACHE_KEY, geocodeCache);
  return record;
}

function buildQuery(a) {
  // Requested: only country, city, street, number (no province/region/state).
  const parts = [a.number, a.street, a.city, a.country]
    .map((p) => String(p || "").trim())
    .filter(Boolean);
  return parts.join(", ");
}

function buildQueryLatin(a) {
  // Requested: only country, city, street, number (no province/region/state).
  const parts = [a.number, a.street, a.city, a.country]
    .map((p) => toEnglishLike(String(p || "").trim()))
    .filter(Boolean);
  return parts.join(", ");
}

function canonicalKey(a) {
  return buildQuery(a).toLowerCase();
}

function formatAddress(a) {
  const left = [a.street, a.number].filter(Boolean).join(" ");
  const right = [a.city, a.state, a.country].filter(Boolean).join(", ");
  return [left, right].filter(Boolean).join(" — ");
}

function getValue(id) {
  const el = document.getElementById(id);
  return String(el.value || "").trim();
}

function setStatus(msg) {
  elStatus.textContent = msg;
}

function setAddressStatus(msg) {
  if (elAddressStatus) {
    elAddressStatus.textContent = msg;
  }
}

function disableUi(disabled) {
  if (disabled) {
    elAddBtn.disabled = true;
  } else {
    updateAddButtonState();
  }
  elDrawBtn.disabled = disabled;
  if (elDrawBelongingBtn) elDrawBelongingBtn.disabled = disabled;
  if (elDrawAllBtn) elDrawAllBtn.disabled = disabled;
  elClearBtn.disabled = disabled;
  elSaveBtn.disabled = disabled;
  if (elLoadBtn) elLoadBtn.disabled = disabled;
  if (elToggleSplashBtn) elToggleSplashBtn.disabled = disabled;
  elExportBtn.disabled = disabled;
  elImportBtn.disabled = disabled;
}

async function buildSignature(studentName) {
  const points = [];
  let skippedInvalid = 0;

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];

    if (addr.valid === false) {
      skippedInvalid++;
      continue;
    }

    if (isFinite(addr.lat) && isFinite(addr.lon)) {
      points.push({
        lat: addr.lat,
        lon: addr.lon,
        label: addr.displayName || formatAddress(addr),
      });
      continue;
    }

    // Try to verify missing coords (e.g., imported or older records).
    setStatus(`Verifying ${i + 1}/${addresses.length}…`);
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await geocodeAddress(addr);
      addr.valid = true;
      addr.lat = result.lat;
      addr.lon = result.lon;
      addr.displayName = result.displayName;
      points.push({ lat: result.lat, lon: result.lon, label: result.displayName });
    } catch {
      addr.valid = false;
      skippedInvalid++;
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(900);
  }

  // Persist updated validations/coords locally too.
  saveJson(STORAGE_KEY, addresses);
  renderList();

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    studentName: String(studentName || "").trim(),
    points,
    skippedInvalid,
    addresses: addresses.map((a) => ({ ...a })),
    options: {
      geoLayerEnabled,
    },
  };
}

function resetForNextStudent() {
  // Clear timeline and canvas.
  addresses = [];
  saveJson(STORAGE_KEY, addresses);
  renderList();
  clearMap();

  // Clear Step 1 name + editing pointers.
  try {
    if (elStudentName) elStudentName.value = "";
  } catch {
    // ignore
  }
  currentEditingSnapshot = null;
  lastAutoSavedAddressesSignature = "";
  pendingStep2View = null;

  // Reset add form.
  elForm.reset();
  const countryEl = document.getElementById("country");
  if (countryEl && !countryEl.value) countryEl.value = "ישראל";

  currentAddressVerified = false;
  belongingLabelShown = false;
  try {
    updateBelongingValueLabel();
  } catch {
    // ignore
  }

  // Reset optional layers/toggles to the default (tiles hidden).
  if (typeof setGeoLayerEnabled === "function") setGeoLayerEnabled(false);

  if (elMap.classList.contains("hidden")) {
    elMap.classList.remove("hidden");
    elToggleMapBtn.textContent = "Hide canvas";
    setTimeout(() => map.invalidateSize(), 0);
  }

  // Reset view.
  map.setView([20, 0], 2);

  try {
    updateStep1Headers();
    updateCreateLifePathButtonState();
    updateAddButtonState();
  } catch {
    // ignore
  }
}

// Default: tiles hidden until user clicks "Show map".
if (typeof setGeoLayerEnabled === "function") setGeoLayerEnabled(false);

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  if (!PERSIST_DRAFT_ADDRESSES && key === STORAGE_KEY) return;
  localStorage.setItem(key, JSON.stringify(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function migrateAddresses(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((a) => {
      if (!a || typeof a !== "object") return null;
      const out = {
        id: typeof a.id === "string" && a.id ? a.id : cryptoId(),
        country: String(a.country || "").trim(),
        state: String(a.state || "").trim(),
        city: String(a.city || "").trim(),
        street: String(a.street || "").trim(),
        number: String(a.number || "").trim(),
        belonging_rate: undefined,
        valid: typeof a.valid === "boolean" ? a.valid : undefined,
        lat: isFinite(a.lat) ? Number(a.lat) : undefined,
        lon: isFinite(a.lon) ? Number(a.lon) : undefined,
        displayName: typeof a.displayName === "string" ? a.displayName : undefined,
      };

      // Back-compat: if `belonging_rate` is missing (older data), assign a stable
      // pseudo-random value per address id so it doesn't change on reload.
      if (typeof a.belonging_rate !== "undefined") {
        out.belonging_rate = normalizeBelongingRate(a.belonging_rate);
      } else {
        out.belonging_rate = stableBelongingRateFromId(out.id);
      }

      if (!out.country || !out.city) return null;
      return out;
    })
    .filter(Boolean);
}

function cryptoId() {
  // Prefer crypto.randomUUID when available.
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function downloadJson(text, filename) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
