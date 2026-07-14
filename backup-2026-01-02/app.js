/* global L */

const STORAGE_KEY = "lifepath.addresses.v1";
const GEOCODE_CACHE_KEY = "lifepath.geocodeCache.v1";

/**
 * @typedef {Object} Address
 * @property {string} id
 * @property {string} country
 * @property {string} state
 * @property {string} city
 * @property {string} street
 * @property {string} number
 * @property {boolean=} valid
 * @property {number=} lat
 * @property {number=} lon
 * @property {string=} displayName
 */

/** @type {Address[]} */
let addresses = migrateAddresses(loadJson(STORAGE_KEY, []));

/** @type {Record<string, { lat: number, lon: number, displayName: string, ts: number }>} */
let geocodeCache = loadJson(GEOCODE_CACHE_KEY, {});

const elForm = document.getElementById("addressForm");
const elList = document.getElementById("addressList");
const elStatus = document.getElementById("status");

const elAddBtn = document.getElementById("addBtn");
const elDrawBtn = document.getElementById("drawBtn");
const elClearBtn = document.getElementById("clearBtn");
const elExportBtn = document.getElementById("exportBtn");
const elImportBtn = document.getElementById("importBtn");
const elImportFile = document.getElementById("importFile");
const elToggleMapBtn = document.getElementById("toggleMapBtn");
const elMap = document.getElementById("map");
const elToggleGeoBtn = document.getElementById("toggleGeoBtn");

const map = L.map("map", {
  // Intentionally no basemap/tiles; use Leaflet only as a blank
  // vector canvas + projection.
  zoomControl: true,
  attributionControl: true,
  preferCanvas: true,
  dragging: true,
  scrollWheelZoom: true,
  doubleClickZoom: false,
  boxZoom: false,
  keyboard: false,
  tap: false,
  touchZoom: false,
});

// No tile layer on purpose (no basemap).
// Use a sane default view.
map.setView([20, 0], 2);

let polyline = null;
let markerLayer = null;
let geoLayerEnabled = false;

const geoTileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors",
});

let dragFromId = null;

renderList();

elToggleMapBtn.addEventListener("click", () => {
  const hidden = elMap.classList.toggle("hidden");
  elToggleMapBtn.textContent = hidden ? "Show map" : "Hide map";

  // Leaflet needs a size recalculation when the container becomes visible.
  if (!hidden) {
    setTimeout(() => {
      map.invalidateSize();
    }, 0);
  }
});

elToggleGeoBtn.addEventListener("click", () => {
  geoLayerEnabled = !geoLayerEnabled;

  if (geoLayerEnabled) {
    geoTileLayer.addTo(map);
    elMap.classList.add("geo-on");
    elToggleGeoBtn.textContent = "Hide geographic layer";
  } else {
    map.removeLayer(geoTileLayer);
    elMap.classList.remove("geo-on");
    elToggleGeoBtn.textContent = "Show geographic layer";
  }

  // If the map is currently hidden, defer UI updates until shown.
  if (!elMap.classList.contains("hidden")) {
    setTimeout(() => map.invalidateSize(), 0);
  }
});

elForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  /** @type {Address} */
  const address = {
    id: cryptoId(),
    country: getValue("country"),
    state: getValue("state"),
    city: getValue("city"),
    street: getValue("street"),
    number: getValue("number"),
  };

  if (!address.country || !address.city || !address.street) {
    setStatus("Please fill all required fields.");
    return;
  }

  disableUi(true);
  try {
    setStatus("Verifying address…");
    try {
      const geo = await geocodeAddress(address);
      address.valid = true;
      address.lat = geo.lat;
      address.lon = geo.lon;
      address.displayName = geo.displayName;
    } catch {
      address.valid = false;
    }

    addresses.push(address);
    saveJson(STORAGE_KEY, addresses);
    elForm.reset();
    renderList();
    setStatus(address.valid ? "Added (valid)." : "Added (invalid address).");
  } finally {
    disableUi(false);
  }
});

elClearBtn.addEventListener("click", () => {
  if (addresses.length === 0) return;
  const ok = confirm("Clear all addresses?");
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
    setStatus("Preparing points…");

    const points = [];
    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];

      // Ignore explicitly invalid addresses.
      if (addr.valid === false) continue;

      // Use stored coordinates if present.
      if (isFinite(addr.lat) && isFinite(addr.lon)) {
        points.push({
          lat: addr.lat,
          lon: addr.lon,
          label: addr.displayName || formatAddress(addr),
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
        points.push({ lat: result.lat, lon: result.lon, label: result.displayName });
      } catch {
        addr.valid = false;
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

    drawPath(points);
    setStatus(`Done. Drew ${points.length} valid point(s).`);
  } catch (err) {
    setStatus(`Error: ${String(err?.message || err)}`);
  } finally {
    disableUi(false);
  }
});

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
  setStatus("Exported JSON file.");
});

elImportBtn.addEventListener("click", () => {
  elImportFile.value = "";
  elImportFile.click();
});

elImportFile.addEventListener("change", async () => {
  const file = elImportFile.files && elImportFile.files[0];
  if (!file) return;

  disableUi(true);
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

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

  if (addresses.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No addresses yet.";
    elList.appendChild(li);
    return;
  }

  addresses.forEach((addr, index) => {
    const li = document.createElement("li");
    li.className = "listItem";
    li.draggable = true;
    li.dataset.id = addr.id;

    li.addEventListener("dragstart", (e) => {
      dragFromId = addr.id;
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });

    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
    });

    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const toId = addr.id;
      if (!dragFromId || dragFromId === toId) return;

      const fromIndex = addresses.findIndex((a) => a.id === dragFromId);
      const toIndex = addresses.findIndex((a) => a.id === toId);
      if (fromIndex < 0 || toIndex < 0) return;

      const [moved] = addresses.splice(fromIndex, 1);
      addresses.splice(toIndex, 0, moved);
      saveJson(STORAGE_KEY, addresses);
      renderList();
      clearMap();
      setStatus("Reordered.");
    });

    const handle = document.createElement("div");
    handle.className = "dragHandle";
    handle.title = "Drag to reorder";
    handle.textContent = "⋮⋮";

    const main = document.createElement("div");
    const title = document.createElement("div");
    const badge = document.createElement("span");
    badge.className = "badge";
    if (addr.valid === true) {
      badge.classList.add("valid");
      badge.textContent = "✓";
      badge.setAttribute("aria-label", "Valid address");
    } else if (addr.valid === false) {
      badge.classList.add("invalid");
      badge.textContent = "";
      badge.setAttribute("aria-label", "Invalid address");
    } else {
      badge.textContent = "";
    }

    title.appendChild(badge);
    title.appendChild(document.createTextNode(formatAddress(addr)));

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = addr.valid === false ? "Invalid address (will be ignored)." : "Order matters: connected by entry order.";

    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "secondary";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      openInlineEditor(li, addr);
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "secondary";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", () => {
      addresses.splice(index, 1);
      saveJson(STORAGE_KEY, addresses);
      renderList();
      clearMap();
      setStatus("Removed.");
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    li.appendChild(handle);
    li.appendChild(main);
    li.appendChild(actions);
    elList.appendChild(li);
  });
}

function openInlineEditor(li, addr) {
  li.innerHTML = "";

  const handle = document.createElement("div");
  handle.className = "dragHandle";
  handle.title = "Drag to reorder";
  handle.textContent = "⋮⋮";

  const main = document.createElement("div");

  const fields = [
    { key: "country", label: "Country*" },
    { key: "state", label: "State" },
    { key: "city", label: "City*" },
    { key: "street", label: "Street*" },
    { key: "number", label: "Number" },
  ];

  const editor = document.createElement("div");
  editor.style.display = "grid";
  editor.style.gap = "6px";

  /** @type {Record<string, HTMLInputElement>} */
  const inputs = {};
  fields.forEach((f) => {
    const row = document.createElement("div");
    const input = document.createElement("input");
    input.value = String(addr[f.key] || "");
    input.placeholder = f.label;
    inputs[f.key] = input;
    row.appendChild(input);
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
      // reset validation; will be re-verified
      valid: undefined,
      lat: undefined,
      lon: undefined,
      displayName: undefined,
    };

    if (!updated.country || !updated.city || !updated.street) {
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

function drawPath(points) {
  clearMap();

  const latLngs = points.map((p) => [p.lat, p.lon]);

  markerLayer = L.layerGroup();
  points.forEach((p) => {
    const m = L.circleMarker([p.lat, p.lon], {
      radius: 5,
      weight: 2,
      opacity: 1,
      fillOpacity: 0.9,
    });
    m.bindTooltip(p.label, { direction: "top" });
    markerLayer.addLayer(m);
  });

  polyline = L.polyline(latLngs, {
    weight: 4,
    opacity: 1,
  });

  polyline.addTo(map);
  markerLayer.addTo(map);

  const bounds = polyline.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.25));
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
}

async function geocodeAddress(addr) {
  const key = canonicalKey(addr);
  const cached = geocodeCache[key];
  if (cached && isFinite(cached.lat) && isFinite(cached.lon)) {
    return cached;
  }

  const query = buildQuery(addr);
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", query);

  const res = await fetch(url.toString(), {
    headers: {
      // Nominatim expects an identifying UA in server-side usage.
      // From browsers you can’t set User-Agent; so keep requests low.
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Geocoding failed (${res.status})`);
  }

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No results for: ${query}`);
  }

  const item = data[0];
  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (!isFinite(lat) || !isFinite(lon)) {
    throw new Error(`Invalid coordinates for: ${query}`);
  }

  const record = {
    lat,
    lon,
    displayName: String(item.display_name || query),
    ts: Date.now(),
  };

  geocodeCache[key] = record;
  saveJson(GEOCODE_CACHE_KEY, geocodeCache);
  return record;
}

function buildQuery(a) {
  const parts = [a.number, a.street, a.city, a.state, a.country]
    .map((p) => String(p || "").trim())
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

function disableUi(disabled) {
  elAddBtn.disabled = disabled;
  elDrawBtn.disabled = disabled;
  elClearBtn.disabled = disabled;
  elExportBtn.disabled = disabled;
  elImportBtn.disabled = disabled;
}

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
        valid: typeof a.valid === "boolean" ? a.valid : undefined,
        lat: isFinite(a.lat) ? Number(a.lat) : undefined,
        lon: isFinite(a.lon) ? Number(a.lon) : undefined,
        displayName: typeof a.displayName === "string" ? a.displayName : undefined,
      };
      if (!out.country || !out.city || !out.street) return null;
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
