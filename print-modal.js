const elPrintModalOverlay = document.getElementById("printModalOverlay");
const elPrintModalCloseBtn = document.getElementById("printModalCloseBtn");
const elPrintOption1Btn = document.getElementById("printOption1Btn");
const elPrintOption2Btn = document.getElementById("printOption2Btn");
const elPrintOption3Btn = document.getElementById("printOption3Btn");
const elPrintOption1ThumbStage = document.getElementById("printOption1ThumbStage");
const elPrintOption2ThumbStage = document.getElementById("printOption2ThumbStage");
const elPrintOption3ThumbStage = document.getElementById("printOption3ThumbStage");
const elPrintOption1Preview = document.getElementById("printOption1Preview");
const elPrintOption1BackBtn = document.getElementById("printOption1BackBtn");
const elPrintOption1NativePrintBtn = document.getElementById("printOption1NativePrintBtn");
const elPrintOption1PreviewViewport = document.getElementById("printOption1PreviewViewport");
const elPrintOption1PreviewStageWrap = document.getElementById("printOption1PreviewStageWrap");
const elPrintOption1PreviewStage = document.getElementById("printOption1PreviewStage");
const elPrintMapOptionPreview = document.getElementById("printMapOptionPreview");
const elPrintMapOptionBackBtn = document.getElementById("printMapOptionBackBtn");
const elPrintMapOptionNativePrintBtn = document.getElementById("printMapOptionNativePrintBtn");
const elPrintMapOptionPreviewViewport = document.getElementById("printMapOptionPreviewViewport");
const elPrintMapOptionPreviewStageWrap = document.getElementById("printMapOptionPreviewStageWrap");
const elPrintMapOptionPreviewStage = document.getElementById("printMapOptionPreviewStage");
const elPrintMapOptionCard = document.getElementById("printMapOptionCard");
const elPrintMapOptionMapHost = document.getElementById("printMapOptionMapHost");
const elPrintMapOptionName = document.getElementById("printMapOptionName");

function openPrintModal() {
  if (!elPrintModalOverlay) return;
  showPrintModalOptions();
  syncPrintOption1Availability();
  document.body.classList.add("printModalOpen");
  elPrintModalOverlay.classList.remove("hidden");
  elPrintModalOverlay.setAttribute("aria-hidden", "false");
  if (elPrintModalCloseBtn) {
    elPrintModalCloseBtn.focus({ preventScroll: true });
  }
}

function closePrintModal() {
  document.body.classList.remove("printModalOpen");
  if (elPrintModalOverlay) {
    elPrintModalOverlay.classList.add("hidden");
    elPrintModalOverlay.setAttribute("aria-hidden", "true");
  }
  clearPrintOptionThumbnails();
  clearPrintOption1Statistics();
  clearPrintMovementRouteLinesForRoot();
  clearPrintOption1Preview();
  clearPrintMapOptionPreview();
}

let printOption1PreviewPageHome = null;
let printOption1MoveFrequencyLabelHome = null;
let printOption1OriginalStep1GeoTileLayer = null;
let printOption1LightStep1GeoTileLayer = null;
let printOption1OriginalRoutePreserveAspectRatio = null;
const PRINT_MAP_OPTION_STAGE_WIDTH = 1027;
const PRINT_MAP_OPTION_STAGE_HEIGHT = 1540;
const PRINT_EMOTIONAL_STROKE_SCALE = 1.45;
let printMapOptionKind = null;

function getPrintOption1AddressCount() {
  return (Array.isArray(addresses) ? addresses : []).filter((a) => a && a.valid !== false).length;
}

function isPrintOption1Available() {
  return getPrintOption1AddressCount() >= 5;
}

function syncPrintOption1AddressCountClass() {
  const many = isPrintOption1Available();
  document.documentElement.classList.toggle("printOption1ManyAddresses", many);
  document.body.classList.toggle("printOption1ManyAddresses", many);
}

function syncPrintOption1Availability() {
  if (!elPrintOption1Btn) return;
  const available = isPrintOption1Available();
  elPrintOption1Btn.disabled = !available;
  elPrintOption1Btn.setAttribute("aria-hidden", available ? "false" : "true");
}

function setPrintOption1SingleAddressColumn(enabled) {
  document.documentElement.classList.toggle("printOption1SingleAddressColumn", Boolean(enabled));
  document.body.classList.toggle("printOption1SingleAddressColumn", Boolean(enabled));
}

function syncPrintOption1AddressLayoutClass() {
  if (!isPrintOption1Available()) {
    setPrintOption1SingleAddressColumn(false);
    return false;
  }

  const singleColumn = getPrintOption1AddressCount() <= 7;
  setPrintOption1SingleAddressColumn(singleColumn);
  return singleColumn;
}

function setPrintOption1NameLabel() {
  const page = document.querySelector("#pageStep1");
  if (!page) return;
  const name = String(elStudentName?.value || currentLoadedMapDisplayName || "").trim();
  if (name) page.setAttribute("data-print-name", name);
  else page.removeAttribute("data-print-name");
}

function getPrintOption1DisplayAddresses() {
  return (Array.isArray(addresses) ? addresses : []).filter((a) => a && a.valid !== false);
}

function formatPrintStatNumber(value, digits = 1) {
  if (value === null || value === undefined || value === "") return "--";
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

function getPrintOption1AddressDurations(items) {
  const list = Array.isArray(items) ? items : [];
  const currentYear = new Date().getFullYear();
  const durations = [];
  for (let i = 0; i < list.length; i++) {
    const startYear = Math.floor(Number(list[i]?.startYear));
    const nextStartYear = Math.floor(Number(list[i + 1]?.startYear));
    const endYear = Number.isFinite(nextStartYear) && nextStartYear > startYear ? nextStartYear : currentYear;
    if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) continue;
    durations.push(Math.max(0, endYear - startYear));
  }
  return durations;
}

function getPrintOption1Statistics() {
  const items = getPrintOption1DisplayAddresses();
  const mapName = String(elStudentName?.value || currentLoadedMapDisplayName || "").trim() || "LifePath";
  const count = items.length;
  const belongingValues = items.map((item) => normalizeBelongingRate(item.belonging_rate, stableBelongingRateFromId(item.id)));
  const averageBelonging = belongingValues.length > 0
    ? belongingValues.reduce((sum, value) => sum + value, 0) / belongingValues.length
    : null;
  const durations = getPrintOption1AddressDurations(items);
  const averageYears = durations.length > 0
    ? durations.reduce((sum, value) => sum + value, 0) / durations.length
    : null;
  let weightedAverage = null;
  if (durations.length > 0 && belongingValues.length > 0) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < Math.min(durations.length, belongingValues.length); i++) {
      weightedSum += belongingValues[i] * durations[i];
      weightTotal += durations[i];
    }
    if (weightTotal > 0) weightedAverage = weightedSum / weightTotal;
  }

  return [
    { label: "", value: mapName, name: true },
    { label: "Count of homes", value: String(count) },
    { label: "Avarag belonging", value: formatPrintStatNumber(averageBelonging) },
    { label: "Avarage years in address", value: formatPrintStatNumber(averageYears) },
    { label: "weighted avarage", value: formatPrintStatNumber(weightedAverage) },
    { label: "total distance", value: typeof formatCumulativeDistanceForAddresses === "function" ? formatCumulativeDistanceForAddresses(items) : "--" },
  ];
}

function clearPrintOption1Statistics(root = document) {
  try {
    root.querySelectorAll(".printOption1Stats").forEach((node) => node.remove());
  } catch {
    // ignore
  }
}

function renderPrintOption1Statistics(root) {
  if (!root) return;
  clearPrintOption1Statistics(root);
  const host = root.matches && root.matches("#pageStep1") ? root : root.querySelector("#pageStep1, .printOption1PreviewPage");
  if (!host) return;
  const stats = document.createElement("div");
  stats.className = "printOption1Stats";
  for (const item of getPrintOption1Statistics()) {
    const row = document.createElement("div");
    row.className = "printOption1StatsRow";
    if (item.name) row.classList.add("printOption1StatsNameRow");
    const labelEl = document.createElement("span");
    labelEl.className = "printOption1StatsLabel";
    labelEl.textContent = item.label;
    const valueEl = document.createElement("span");
    valueEl.className = "printOption1StatsValue";
    valueEl.textContent = item.value;
    if (!item.name) row.appendChild(labelEl);
    row.appendChild(valueEl);
    stats.appendChild(row);
  }
  host.appendChild(stats);
  alignPrintOption1TimelineToStats(host);
}

function alignPrintOption1TimelineToStats(root) {
  if (!root) return;
  try {
    const host = root.matches && root.matches("#pageStep1") ? root : root.querySelector("#pageStep1, .printOption1PreviewPage");
    if (!host) return;
    const timeline = host.querySelector(".step1JourneyTimeline");
    if (!timeline) return;
    const rawAnchor = getComputedStyle(host).getPropertyValue("--print-option1-timeline-left").trim();
    const timelineLeft = Number.parseFloat(rawAnchor) || 206;
    timeline.style.left = `${timelineLeft}px`;
    timeline.style.width = `calc(1540px - ${timelineLeft}px)`;
    host.style.setProperty("--print-option1-timeline-left", `${timelineLeft}px`);
  } catch {
    // ignore
  }
}

function setPrintOption1EmotionScale(root, enabled) {
  const scope = root || document;
  const groups = scope.matches && scope.matches('[data-layer="step1-emotion-rings"]')
    ? [scope]
    : Array.from(scope.querySelectorAll('[data-layer="step1-emotion-rings"]'));
  for (const group of groups) {
    if (!group) continue;
    if (enabled) {
      if (!group.dataset.printOption1OriginalTransform) {
        group.dataset.printOption1OriginalTransform = group.getAttribute("transform") || "";
      }
      const original = group.dataset.printOption1OriginalTransform || "";
      group.setAttribute("transform", `translate(500 310) scale(1.3) translate(-500 -310) ${original}`.trim());
    } else if (Object.prototype.hasOwnProperty.call(group.dataset, "printOption1OriginalTransform")) {
      const original = group.dataset.printOption1OriginalTransform || "";
      if (original) group.setAttribute("transform", original);
      else group.removeAttribute("transform");
      delete group.dataset.printOption1OriginalTransform;
    }
  }
}

function setStep1GeoPrintBasemap(enabled) {
  if (!step1GeoMap) return;
  if (enabled) {
    if (printOption1LightStep1GeoTileLayer) return;
    printOption1OriginalStep1GeoTileLayer = step1GeoTileLayer || null;
    try {
      if (printOption1OriginalStep1GeoTileLayer && step1GeoMap.hasLayer(printOption1OriginalStep1GeoTileLayer)) {
        step1GeoMap.removeLayer(printOption1OriginalStep1GeoTileLayer);
      }
    } catch {
      // ignore
    }
    printOption1LightStep1GeoTileLayer = createBasemapTileLayer("toner-lite");
    step1GeoTileLayer = printOption1LightStep1GeoTileLayer;
    try {
      if (printOption1LightStep1GeoTileLayer) printOption1LightStep1GeoTileLayer.addTo(step1GeoMap);
    } catch {
      // ignore
    }
  } else {
    try {
      if (printOption1LightStep1GeoTileLayer && step1GeoMap.hasLayer(printOption1LightStep1GeoTileLayer)) {
        step1GeoMap.removeLayer(printOption1LightStep1GeoTileLayer);
      }
    } catch {
      // ignore
    }
    step1GeoTileLayer = printOption1OriginalStep1GeoTileLayer || step1GeoTileLayer;
    try {
      if (printOption1OriginalStep1GeoTileLayer && !step1GeoMap.hasLayer(printOption1OriginalStep1GeoTileLayer)) {
        printOption1OriginalStep1GeoTileLayer.addTo(step1GeoMap);
      }
    } catch {
      // ignore
    }
    printOption1OriginalStep1GeoTileLayer = null;
    printOption1LightStep1GeoTileLayer = null;
  }

  try {
    updateStep1GeoMapMarkers();
    step1GeoMap.invalidateSize(true);
  } catch {
    // ignore
  }
}

function restorePrintOption1PreviewPage() {
  if (!printOption1PreviewPageHome) return;
  const page = document.querySelector("#pageStep1");
  const home = printOption1PreviewPageHome;
  if (page && home.parent) {
    page.classList.remove("printOption1PreviewPage");
    page.removeAttribute("data-print-name");
    const frame = page.querySelector(".frame");
    if (frame) frame.classList.remove("printOption1PreviewFrame");
    try {
      if (home.nextSibling) home.parent.insertBefore(page, home.nextSibling);
      else home.parent.appendChild(page);
    } catch {
      // ignore
    }
  }
  printOption1PreviewPageHome = null;
  if (!document.body.classList.contains("printOption1Mode")) {
    document.documentElement.classList.remove("printOption1ManyAddresses");
    document.documentElement.classList.remove("printOption1SingleAddressColumn");
    document.body.classList.remove("printOption1ManyAddresses");
    document.body.classList.remove("printOption1SingleAddressColumn");
    setStep1GeoPrintBasemap(false);
    restorePrintOption1MoveFrequencyLabel();
    setPrintOption1EmotionScale(page, false);
    if (typeof updateStep1JourneyTimeline === "function") updateStep1JourneyTimeline();
  }
}

function clearPrintOption1Preview() {
  restorePrintOption1PreviewPage();
  if (elPrintOption1PreviewStage) elPrintOption1PreviewStage.innerHTML = "";
}

function setPrintOption1PreviewScale() {
  if (!elPrintOption1PreviewViewport || !elPrintOption1PreviewStage || !elPrintOption1PreviewStageWrap) return;
  const viewportW = Math.max(1, Number(elPrintOption1PreviewViewport.clientWidth) || 0);
  const viewportH = Math.max(1, Number(elPrintOption1PreviewViewport.clientHeight) || 0);
  const scale = Math.min(viewportW / 1540, viewportH / 1027);
  elPrintOption1PreviewStage.style.setProperty("--print-option1-preview-scale", String(scale));
  elPrintOption1PreviewStageWrap.style.width = `${Math.round(1540 * scale)}px`;
  elPrintOption1PreviewStageWrap.style.height = `${Math.round(1027 * scale)}px`;
}

function setPrintMapOptionPreviewScale() {
  if (!elPrintMapOptionPreviewViewport || !elPrintMapOptionPreviewStage || !elPrintMapOptionPreviewStageWrap) return;
  const viewportW = Math.max(1, Number(elPrintMapOptionPreviewViewport.clientWidth) || 0);
  const viewportH = Math.max(1, Number(elPrintMapOptionPreviewViewport.clientHeight) || 0);
  const scale = Math.min(viewportW / PRINT_MAP_OPTION_STAGE_WIDTH, viewportH / PRINT_MAP_OPTION_STAGE_HEIGHT);
  elPrintMapOptionPreviewStage.style.setProperty("--print-map-option-preview-scale", String(scale));
  elPrintMapOptionPreviewStageWrap.style.width = `${Math.round(PRINT_MAP_OPTION_STAGE_WIDTH * scale)}px`;
  elPrintMapOptionPreviewStageWrap.style.height = `${Math.round(PRINT_MAP_OPTION_STAGE_HEIGHT * scale)}px`;
}

function getPrintMapOptionDisplayName() {
  const name = String(elStudentName?.value || currentLoadedMapDisplayName || "").trim();
  return name || "LifePath";
}

function normalizePrintMapOptionSvg(svg) {
  const clone = svg.cloneNode(true);
  clone.removeAttribute("id");
  clone.removeAttribute("style");
  clone.classList.add("printMapOptionSvg");
  clone.setAttribute("aria-hidden", "true");
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));

  const rect = svg.getBoundingClientRect();
  const width = Number(clone.getAttribute("width")) || svg.viewBox?.baseVal?.width || rect.width || 1;
  const height = Number(clone.getAttribute("height")) || svg.viewBox?.baseVal?.height || rect.height || 1;
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clone.setAttribute("preserveAspectRatio", "xMidYMid meet");
  clone.setAttribute("width", "100%");
  clone.setAttribute("height", "100%");
  return clone;
}

function addPrintMovementRouteLines(svg) {
  if (!svg) return;
  svg.querySelectorAll("line[data-print-route-line='1']").forEach((line) => line.remove());
  const dots = Array.from(svg.querySelectorAll("circle[data-step1-route-dot='1']"));
  if (dots.length < 2) return;

  const svgNamespace = "http://www.w3.org/2000/svg";
  const firstDot = dots[0];
  const makeLine = (a, b, lineWidth, opacity) => {
    const line = document.createElementNS(svgNamespace, "line");
    line.setAttribute("x1", a.getAttribute("cx") || "0");
    line.setAttribute("y1", a.getAttribute("cy") || "0");
    line.setAttribute("x2", b.getAttribute("cx") || "0");
    line.setAttribute("y2", b.getAttribute("cy") || "0");
    line.setAttribute("stroke", "#000000");
    line.setAttribute("stroke-width", String(lineWidth));
    line.setAttribute("stroke-opacity", String(opacity));
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("shape-rendering", "geometricPrecision");
    line.setAttribute("data-print-route-line", "1");
    return line;
  };

  for (let i = 1; i < dots.length; i++) {
    svg.insertBefore(makeLine(dots[i - 1], dots[i], ROUTE_PREVIEW_LINE_SOFT_STROKE_WIDTH, ROUTE_PREVIEW_LINE_SOFT_OPACITY), firstDot);
    svg.insertBefore(makeLine(dots[i - 1], dots[i], ROUTE_PREVIEW_LINE_STROKE_WIDTH, ROUTE_PREVIEW_LINE_OPACITY), firstDot);
  }
}

function addPrintMovementRouteLinesForRoot(root) {
  if (!root) return;
  const routeSvgs = root.matches && root.matches(".step1RoutePreview svg")
    ? [root]
    : Array.from(root.querySelectorAll(".step1RoutePreview svg"));
  for (const svg of routeSvgs) addPrintMovementRouteLines(svg);
}

function clearPrintMovementRouteLinesForRoot(root = document) {
  try {
    root.querySelectorAll(".step1RoutePreview svg line[data-print-route-line='1']").forEach((line) => line.remove());
  } catch {
    // ignore
  }
}

function removePrintOption1MoveFrequencyLabels(root) {
  if (!root) return;
  try {
    const labels = root.matches && root.matches(".step1MoveFrequencyLabel")
      ? [root]
      : Array.from(root.querySelectorAll(".step1MoveFrequencyLabel"));
    labels.forEach((label) => {
      if (label.ownerDocument === document && label.closest("#pageStep1")) {
        if (!printOption1MoveFrequencyLabelHome) {
          const placeholder = document.createComment("print option 1 move frequency label");
          printOption1MoveFrequencyLabelHome = { label, placeholder };
          label.parentNode.insertBefore(placeholder, label);
        }
        label.remove();
      } else {
        label.remove();
      }
    });
  } catch {
    // ignore
  }
}

function restorePrintOption1MoveFrequencyLabel() {
  const home = printOption1MoveFrequencyLabelHome;
  if (!home) return;
  try {
    if (home.placeholder.parentNode) home.placeholder.parentNode.insertBefore(home.label, home.placeholder);
    if (home.placeholder.parentNode) home.placeholder.remove();
  } catch {
    // ignore
  }
  printOption1MoveFrequencyLabelHome = null;
}

function adjustPrintOption1TimelineYearLabels(root) {
  if (!root) return;
  const timelines = root.matches && root.matches(".step1JourneyTimeline")
    ? [root]
    : Array.from(root.querySelectorAll(".step1JourneyTimeline"));
  for (const timeline of timelines) {
    const svg = timeline.querySelector("svg");
    const line = svg ? svg.querySelector("line") : null;
    if (!svg || !line) continue;
    const lineY = Number(line.getAttribute("y1"));
    if (!Number.isFinite(lineY)) continue;
    svg.querySelectorAll("text").forEach((text) => {
      text.setAttribute("y", String(lineY));
      text.setAttribute("dominant-baseline", "middle");
    });
  }
}

function forcePrintWhiteCircleFills(root) {
  if (!root) return;
  const circles = root.querySelectorAll("circle[data-step1-route-dot='1'], .step1RoutePreview circle, .step1MoveFrequency svg circle");
  for (const circle of circles) {
    circle.setAttribute("fill", "#ffffff");
  }
}

function createPrintMovementMapSvg() {
  updateStep1RoutePreview();
  const sourceSvg = elStep1RoutePreview ? elStep1RoutePreview.querySelector("svg") : null;
  if (!sourceSvg) return null;
  const clone = normalizePrintMapOptionSvg(sourceSvg);
  forcePrintWhiteCircleFills(clone);
  addPrintMovementRouteLines(clone);
  return clone;
}

function createPrintEmotionalMapSvg(sourceSvg) {
  if (!sourceSvg) return null;
  const clone = normalizePrintMapOptionSvg(sourceSvg);
  const rings = clone.querySelectorAll("[data-emotion-ring-visible='1']");
  for (const ring of rings) {
    const sw = Number(ring.getAttribute("stroke-width"));
    if (!isFinite(sw) || sw <= 0) continue;
    ring.setAttribute("stroke-width", String(sw * PRINT_EMOTIONAL_STROKE_SCALE));
    ring.setAttribute("data-print-emotional-thickened", "1");
  }
  return clone;
}

function getPrintMapOptionSourceSvg(kind) {
  if (kind === "movement") {
    updateStep1RoutePreview();
    return elStep1RoutePreview ? elStep1RoutePreview.querySelector("svg") : null;
  }
  return document.getElementById("step1EmotionSvg");
}

function clearPrintMapOptionPreview() {
  if (elPrintMapOptionMapHost) elPrintMapOptionMapHost.replaceChildren();
  if (elPrintMapOptionCard) elPrintMapOptionCard.classList.remove("printMapOptionEmotional", "printMapOptionMovement");
  printMapOptionKind = null;
}

function setPrintOption1RouteAspectMode(enabled) {
  const svg = elStep1RoutePreview ? elStep1RoutePreview.querySelector("svg") : null;
  if (!svg) return;
  if (enabled) {
    if (printOption1OriginalRoutePreserveAspectRatio === null) {
      printOption1OriginalRoutePreserveAspectRatio = svg.getAttribute("preserveAspectRatio") || "";
    }
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  } else if (printOption1OriginalRoutePreserveAspectRatio !== null) {
    if (printOption1OriginalRoutePreserveAspectRatio) svg.setAttribute("preserveAspectRatio", printOption1OriginalRoutePreserveAspectRatio);
    else svg.removeAttribute("preserveAspectRatio");
    printOption1OriginalRoutePreserveAspectRatio = null;
  }
}

function setCloneRouteAspectMode(root) {
  const svg = root ? root.querySelector(".step1RoutePreview svg") : null;
  if (svg) svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
}

function renderPrintMapOptionPreview(kind) {
  if (!elPrintMapOptionMapHost || !elPrintMapOptionCard || !elPrintMapOptionName) return false;
  const sourceSvg = kind === "movement" ? null : getPrintMapOptionSourceSvg(kind);
  const printSvg = kind === "movement"
    ? createPrintMovementMapSvg()
    : createPrintEmotionalMapSvg(sourceSvg);
  if (!printSvg) return false;

  elPrintMapOptionMapHost.replaceChildren(printSvg);
  elPrintMapOptionName.textContent = getPrintMapOptionDisplayName();
  elPrintMapOptionCard.classList.toggle("printMapOptionEmotional", kind === "emotional");
  elPrintMapOptionCard.classList.toggle("printMapOptionMovement", kind === "movement");
  printMapOptionKind = kind;
  setPrintMapOptionPreviewScale();
  return true;
}

function clearPrintOptionThumbnails() {
  if (elPrintOption1ThumbStage) elPrintOption1ThumbStage.replaceChildren();
  if (elPrintOption2ThumbStage) elPrintOption2ThumbStage.replaceChildren();
  if (elPrintOption3ThumbStage) elPrintOption3ThumbStage.replaceChildren();
}

function renderPrintOption1Thumbnail() {
  if (!elPrintOption1ThumbStage) return false;
  elPrintOption1ThumbStage.replaceChildren();
  if (!isPrintOption1Available()) return false;
  const page = document.querySelector("#pageStep1");
  if (!page) return false;

  syncPrintOption1AddressCountClass();
  syncPrintOption1AddressLayoutClass();
  setPrintOption1NameLabel();
  updateStep1RingReading();
  if (typeof updateStep1JourneyTimeline === "function") updateStep1JourneyTimeline();
  _tbSvg = null;
  updateStep1TimeBelonging();
  setPrintOption1RouteAspectMode(true);
  if (typeof updateStep1RoutePreview === "function") updateStep1RoutePreview();
  forcePrintWhiteCircleFills(page);
  setPrintOption1EmotionScale(page, true);

  const clone = page.cloneNode(true);
  setCloneRouteAspectMode(clone);
  forcePrintWhiteCircleFills(clone);
  setPrintOption1EmotionScale(clone, true);
  addPrintMovementRouteLinesForRoot(clone);
  adjustPrintOption1TimelineYearLabels(clone);
  removePrintOption1MoveFrequencyLabels(clone);
  renderPrintOption1Statistics(clone);
  clone.classList.add("printOption1PreviewPage", "active");
  clone.classList.remove("hidden", "step1-edit-mode");
  const frame = clone.querySelector(".frame");
  if (frame) frame.classList.add("printOption1PreviewFrame");

  const name = String(elStudentName?.value || currentLoadedMapDisplayName || "").trim();
  if (name) clone.setAttribute("data-print-name", name);
  else clone.removeAttribute("data-print-name");

  setPrintOption1EmotionScale(page, false);
  elPrintOption1ThumbStage.appendChild(clone);
  return true;
}

function createPrintMapOptionThumbnailCard(kind) {
  const sourceSvg = kind === "movement" ? null : getPrintMapOptionSourceSvg(kind);
  const printSvg = kind === "movement"
    ? createPrintMovementMapSvg()
    : createPrintEmotionalMapSvg(sourceSvg);
  if (!printSvg) return null;

  const card = document.createElement("div");
  card.className = `printMapOptionCard ${kind === "movement" ? "printMapOptionMovement" : "printMapOptionEmotional"}`;

  const logo = document.createElement("img");
  logo.className = "printMapOptionLogo";
  logo.src = "logo.png";
  logo.alt = "";

  const mapHost = document.createElement("div");
  mapHost.className = "printMapOptionMapHost";
  mapHost.setAttribute("aria-hidden", "true");
  mapHost.appendChild(printSvg);

  const name = document.createElement("div");
  name.className = "printMapOptionName";
  name.textContent = getPrintMapOptionDisplayName();

  card.appendChild(logo);
  card.appendChild(mapHost);
  card.appendChild(name);
  return card;
}

function renderPrintMapOptionThumbnail(kind, stage) {
  if (!stage) return false;
  stage.replaceChildren();
  const card = createPrintMapOptionThumbnailCard(kind);
  if (!card) return false;
  stage.appendChild(card);
  return true;
}

function renderPrintOptionThumbnails() {
  const option1Ready = renderPrintOption1Thumbnail();
  const option2Ready = renderPrintMapOptionThumbnail("emotional", elPrintOption2ThumbStage);
  const option3Ready = renderPrintMapOptionThumbnail("movement", elPrintOption3ThumbStage);
  if (elPrintOption1Btn) elPrintOption1Btn.disabled = !option1Ready;
  if (elPrintOption2Btn) elPrintOption2Btn.disabled = !option2Ready;
  if (elPrintOption3Btn) elPrintOption3Btn.disabled = !option3Ready;
}

function renderPrintOption1Preview() {
  if (!elPrintOption1PreviewStage) return;
  if (!isPrintOption1Available()) return;
  clearPrintOption1Preview();
  hideStep1RingReadingTooltip();
  const page = document.querySelector("#pageStep1");
  if (!page) return;
  syncPrintOption1AddressCountClass();
  setStep1GeoPrintBasemap(true);
  printOption1PreviewPageHome = { parent: page.parentElement, nextSibling: page.nextSibling };
  page.classList.add("printOption1PreviewPage", "active");
  page.classList.remove("hidden", "step1-edit-mode");
  const frame = page.querySelector(".frame");
  if (frame) frame.classList.add("printOption1PreviewFrame");
  elPrintOption1PreviewStage.appendChild(page);
  setPrintOption1NameLabel();
  syncPrintOption1AddressLayoutClass();
  updateStep1RingReading();
  if (typeof updateStep1JourneyTimeline === "function") updateStep1JourneyTimeline();
  _tbSvg = null;
  updateStep1TimeBelonging();
  setPrintOption1RouteAspectMode(true);
  if (typeof updateStep1RoutePreview === "function") updateStep1RoutePreview();
  forcePrintWhiteCircleFills(page);
  setPrintOption1EmotionScale(page, true);
  addPrintMovementRouteLinesForRoot(page);
  adjustPrintOption1TimelineYearLabels(page);
  removePrintOption1MoveFrequencyLabels(page);
  renderPrintOption1Statistics(page);
  setPrintOption1PreviewScale();
}

function showPrintModalOptions() {
  if (elPrintModalOverlay) elPrintModalOverlay.classList.remove("printModalShowingPreview");
  if (elPrintOption1Preview) elPrintOption1Preview.classList.add("hidden");
  if (elPrintMapOptionPreview) elPrintMapOptionPreview.classList.add("hidden");
  clearPrintOption1Preview();
  clearPrintMapOptionPreview();
  renderPrintOptionThumbnails();
}

function showPrintOption1Preview() {
  if (!isPrintOption1Available()) return;
  if (elPrintModalOverlay) elPrintModalOverlay.classList.add("printModalShowingPreview");
  if (elPrintOption1Preview) elPrintOption1Preview.classList.remove("hidden");
  if (elPrintMapOptionPreview) elPrintMapOptionPreview.classList.add("hidden");
  clearPrintMapOptionPreview();
  renderPrintOption1Preview();
  requestAnimationFrame(setPrintOption1PreviewScale);
}

function showPrintMapOptionPreview(kind) {
  clearPrintOption1Preview();
  if (!renderPrintMapOptionPreview(kind)) return;
  if (elPrintModalOverlay) elPrintModalOverlay.classList.add("printModalShowingPreview");
  if (elPrintOption1Preview) elPrintOption1Preview.classList.add("hidden");
  if (elPrintMapOptionPreview) elPrintMapOptionPreview.classList.remove("hidden");
  requestAnimationFrame(setPrintMapOptionPreviewScale);
}

let printOption1InProgress = false;

function cleanupPrintOption1Mode() {
  printOption1InProgress = false;
  document.documentElement.classList.remove("printOption1Mode");
  document.documentElement.classList.remove("printOption1ManyAddresses");
  document.documentElement.classList.remove("printOption1SingleAddressColumn");
  const page = document.querySelector("#pageStep1");
  if (page) page.removeAttribute("data-print-name");
  restorePrintOption1MoveFrequencyLabel();
  clearPrintOption1Statistics();
  clearPrintMovementRouteLinesForRoot();
  setPrintOption1EmotionScale(document, false);
  document.body.classList.remove("printOption1Mode");
  document.body.classList.remove("printOption1ManyAddresses");
  document.body.classList.remove("printOption1SingleAddressColumn");
  setPrintOption1RouteAspectMode(false);
  setStep1GeoPrintBasemap(false);
  if (typeof updateStep1JourneyTimeline === "function") updateStep1JourneyTimeline();
}

function cleanupPrintMapOptionMode() {
  document.documentElement.classList.remove("printMapOptionMode");
  document.body.classList.remove("printMapOptionMode");
}

function printReviewOption1() {
  if (!isPrintOption1Available()) return;
  closePrintModal();
  printOption1InProgress = true;
  document.documentElement.classList.add("printOption1Mode");
  document.body.classList.add("printOption1Mode");
  syncPrintOption1AddressCountClass();
  setPrintOption1NameLabel();
  syncPrintOption1AddressLayoutClass();
  updateStep1RingReading();
  setStep1GeoPrintBasemap(true);
  if (typeof updateStep1JourneyTimeline === "function") updateStep1JourneyTimeline();
  _tbSvg = null;
  updateStep1TimeBelonging();
  setPrintOption1RouteAspectMode(true);
  if (typeof updateStep1RoutePreview === "function") updateStep1RoutePreview();
  forcePrintWhiteCircleFills(document.querySelector("#pageStep1"));
  setPrintOption1EmotionScale(document.querySelector("#pageStep1"), true);
  addPrintMovementRouteLinesForRoot(document.querySelector("#pageStep1"));
  adjustPrintOption1TimelineYearLabels(document.querySelector("#pageStep1"));
  removePrintOption1MoveFrequencyLabels(document.querySelector("#pageStep1"));
  renderPrintOption1Statistics(document.querySelector("#pageStep1"));

  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        window.print();
      } catch {
        // ignore
      }
      setTimeout(cleanupPrintOption1Mode, 250);
    }, 60);
  });
}

function printMapOption(kind) {
  const resolvedKind = kind || printMapOptionKind;
  clearPrintOptionThumbnails();
  if (!resolvedKind || !renderPrintMapOptionPreview(resolvedKind)) return;
  document.documentElement.classList.add("printMapOptionMode");
  document.body.classList.add("printMapOptionMode");

  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        window.print();
      } catch {
        // ignore
      }
      setTimeout(cleanupPrintMapOptionMode, 250);
    }, 60);
  });
}

if (elPrintModalCloseBtn) {
  elPrintModalCloseBtn.addEventListener("click", () => {
    closePrintModal();
  });
}

if (elPrintOption1Btn) {
  elPrintOption1Btn.addEventListener("click", () => {
    printReviewOption1();
  });
}

if (elPrintOption2Btn) {
  elPrintOption2Btn.addEventListener("click", () => {
    printMapOption("emotional");
  });
}

if (elPrintOption3Btn) {
  elPrintOption3Btn.addEventListener("click", () => {
    printMapOption("movement");
  });
}

if (elPrintOption1BackBtn) {
  elPrintOption1BackBtn.addEventListener("click", () => {
    showPrintModalOptions();
  });
}

if (elPrintMapOptionBackBtn) {
  elPrintMapOptionBackBtn.addEventListener("click", () => {
    showPrintModalOptions();
  });
}

if (elPrintOption1NativePrintBtn) {
  elPrintOption1NativePrintBtn.addEventListener("click", () => {
    printReviewOption1();
  });
}

if (elPrintMapOptionNativePrintBtn) {
  elPrintMapOptionNativePrintBtn.addEventListener("click", () => {
    printMapOption(printMapOptionKind);
  });
}

window.addEventListener("resize", () => {
  if (document.body.classList.contains("printModalOpen") && elPrintModalOverlay && elPrintModalOverlay.classList.contains("printModalShowingPreview")) {
    setPrintOption1PreviewScale();
    setPrintMapOptionPreviewScale();
  }
});

if (elPrintModalOverlay) {
  elPrintModalOverlay.addEventListener("click", (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains("printModalBackdrop")) {
      closePrintModal();
    }
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("printModalOpen")) {
    closePrintModal();
  }
});
