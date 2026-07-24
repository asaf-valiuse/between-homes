const elArchiveGrid = document.getElementById("archiveGrid");
const elArchiveEmpty = document.getElementById("archiveEmpty");
const elArchiveSearchInput = document.getElementById("archiveSearchInput");

let archiveSearchQuery = "";

if (elArchiveSearchInput) {
  elArchiveSearchInput.addEventListener("input", () => {
    archiveSearchQuery = String(elArchiveSearchInput.value || "").trim().toLowerCase();
    try {
      renderArchiveGrid();
    } catch {
      // ignore
    }
  });
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
  const ARCHIVE_CIRCLE_STROKE_SCALE = 0.62;

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

  // Single-home maps should always show one marker centered in the thumbnail.
  if (projected.length === 1) {
    projected[0].x = 50;
    projected[0].y = 50;
  }

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
    const strokePx = Math.max(0.001, rate * ARCHIVE_CIRCLE_STROKE_SCALE);

    const baseRadiusPx = ARCHIVE_CIRCLE_INNER_RADIUS_PX + 0.5 + strokePx / 2;

    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", String(clamp(p.x)));
    c.setAttribute("cy", String(clamp(p.y)));
    c.dataset.baseRPx = String(baseRadiusPx);
    c.dataset.baseStrokePx = String(strokePx);
    c.setAttribute("r", "1");
    c.setAttribute("fill", "#f4f2ea");
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
        // User request: zoom in 5x compared to the current thumbnail framing.
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

    const maxRate = Math.max(1, ...projected.map((p) => normalizeBelongingRate(p.rate, 5))) * ARCHIVE_CIRCLE_STROKE_SCALE;
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

function attachArchiveThumbInteractions(thumb, onActivate) {
  if (!thumb) return;

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

  thumb.addEventListener("click", (e) => {
    if (typeof onActivate !== "function") return;
    e.preventDefault();
    e.stopPropagation();
    onActivate();
  });

  // Ensure correct sizing once inserted into the DOM.
  requestAnimationFrame(() => updateMarkerSizesForViewBox());
}

// Builds a label + value pair for an archive stat line (e.g. "avg. belonging
// :  3.5") as separate spans so the label and its answer can carry different
// fonts (see .archiveStatLabel/.archiveStatValue in styles.css).
function setArchiveStatRow(el, labelText, valueText) {
  if (!el) return;
  el.textContent = "";
  if (!valueText) return;
  const label = document.createElement("span");
  label.className = "archiveStatLabel";
  label.textContent = labelText;
  const value = document.createElement("span");
  value.className = "archiveStatValue";
  value.textContent = valueText;
  el.append(label, value);
}

function renderArchiveGrid() {
  if (!elArchiveGrid || !elArchiveEmpty) return;

  const list = getSavedMaps();
  const items = Array.isArray(list) ? list.filter(Boolean) : [];

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

  const filtered = ordered.filter((snap) => {
    if (!archiveSearchQuery) return true;
    const fullName = String(snap?.fullName || "").trim().toLowerCase();
    const label = String(snap?.label || "").trim().toLowerCase();
    return fullName.includes(archiveSearchQuery) || label.includes(archiveSearchQuery);
  });

  elArchiveEmpty.classList.toggle("hidden", filtered.length !== 0);

  elArchiveGrid.innerHTML = "";
  for (let i = 0; i < filtered.length; i++) {
    const snap = filtered[i];
    const item = document.createElement("div");
    item.className = "archiveItem";

    const serialEl = document.createElement("div");
    serialEl.className = "archiveSerial";
    // Archive tile title is just the map name, exactly as typed on the
    // address-entry page -- no title-casing, no address count.
    const archiveDisplayName = String(snap?.fullName || "").trim() || formatLifeMapLabel(
      Number.isFinite(Number(snap?.serial)) && Number(snap?.serial) > 0 ? Number(snap.serial) : i + 1
    );
    serialEl.textContent = archiveDisplayName;

    const averageEl = document.createElement("div");
    averageEl.className = "archiveAverageBelonging";
    const averageBelonging = formatAverageBelongingForAddresses(snap?.addresses);
    setArchiveStatRow(averageEl, "avg. belonging :\u00a0\u00a0\u00a0\u00a0\u00a0", averageBelonging);

    const cumulativeEl = document.createElement("div");
    cumulativeEl.className = "archiveCumulativeDistance";
    setArchiveStatRow(cumulativeEl, "cumulative distance :\u00a0\u00a0\u00a0\u00a0\u00a0", formatCumulativeDistanceForAddresses(snap?.addresses));

    const preview = document.createElement("div");
    preview.className = "archivePreview";

    const thumb = createArchiveMiniMapSvg(snap);

    const footer = document.createElement("div");
    footer.className = "archiveFooter";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "archiveShowBtn";
    openBtn.textContent = "open";
    openBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSavedMapSnapshotFromArchive(snap, archiveDisplayName);
    });
    footer.appendChild(openBtn);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "archiveRemoveBtn";
    removeBtn.textContent = "remove map";
    removeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      confirmArchiveMapRemoval(snap);
    });
    footer.appendChild(removeBtn);

    item.addEventListener("click", () => {
      openSavedMapSnapshotFromArchive(snap, archiveDisplayName);
    });

    item.appendChild(serialEl);
    item.appendChild(averageEl);
    item.appendChild(cumulativeEl);
    preview.appendChild(thumb);
    attachArchiveThumbInteractions(thumb, () => openSavedMapSnapshotFromArchive(snap, archiveDisplayName));
    item.appendChild(preview);
    item.appendChild(footer);
    elArchiveGrid.appendChild(item);
  }
}

function openSavedMapSnapshotFromArchive(snapshot, archiveDisplayName = "") {
  if (!snapshot) return;

  // Requirement: after clicking an Archive tile, show the pulsing-circle
  // transition for 1.5 seconds, then display the selected map in its
  // finished editing state.
  if (createLifePathTransitionActive) return;
  createLifePathTransitionActive = true;
  showCreateLifePathTransition(true);

  setTimeout(() => {
    try {
      showCreateLifePathTransition(false);
      openSavedMapSnapshotFinishedFromArchive(snapshot, archiveDisplayName);
    } finally {
      createLifePathTransitionActive = false;
    }
  }, 1500);
}
