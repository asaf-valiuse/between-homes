/* global L */

const STORAGE_KEY = "lifepath.addresses.v1";
// Bump cache key so older cached results don't persist (also refreshes coords after geocode improvements).
const GEOCODE_CACHE_KEY = "lifepath.geocodeCache.v8.en";

// Sound assets (served from project root).
// Note: filenames include spaces; use a URL-encoded path.
const WATER_SOUND_SRC = "mp3/water%2001.mp3";
const WATER02_SOUND_SRC = "mp3/water%2002.mp3";
const WATER03_SOUND_SRC = "mp3/water%2003.mp3";
const TICK_SOUND_SRC = "mp3/tick%2001.mp3";

// New sound set lives under mp3/new/ and may include non-ASCII filenames (Hebrew, spaces, etc.).
// Use this helper so we never have to manually URL-encode anything.
const MP3_NEW_DIR = "mp3/new/";
function mp3NewSrc(fileName) {
  return MP3_NEW_DIR + encodeURIComponent(String(fileName || ""));
}

const MP3_MANIFEST_URL = "/api/mp3_manifest";
let _mp3NewManifest = null;
let _mp3NewManifestLoadedAtMs = 0;
let _mp3NewManifestPromise = null;

function primeMp3NewManifest(options) {
  const opts = options && typeof options === "object" ? options : {};
  const force = Boolean(opts.force);
  const now = Date.now();
  if (!force && _mp3NewManifest && (now - _mp3NewManifestLoadedAtMs) < 30_000) return Promise.resolve(_mp3NewManifest);
  if (!force && _mp3NewManifestPromise) return _mp3NewManifestPromise;

  const url = `${MP3_MANIFEST_URL}?t=${now}`;
  const p = fetch(url, { cache: "no-store" })
    .then((r) => (r && r.ok ? r.json() : null))
    .then((j) => {
      if (!j || j.ok !== true) return null;
      _mp3NewManifest = j;
      _mp3NewManifestLoadedAtMs = Date.now();
      return j;
    })
    .catch(() => null)
    .finally(() => {
      _mp3NewManifestPromise = null;
    });

  _mp3NewManifestPromise = p;
}

function hashString32(s) {
  const str = String(s || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededShuffle(arr, seed) {
  const out = Array.isArray(arr) ? arr.slice() : [];
  let x = (Number(seed) || 0) >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    const j = x % (i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function matchManifestRange(ranges, rate) {
  const list = Array.isArray(ranges) ? ranges : [];
  if (!list.length) return null;
  const r = Math.round(Number(rate) || 0);

  /** Prefer the match with the highest lo (handles overlaps like 5-7 and 7-10 for r=7). */
  let best = null;
  for (const it of list) {
    const lo = Number(it && it.lo);
    const hi = Number(it && it.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    if (r < lo || r > hi) continue;
    if (!best) best = it;
    else {
      const blo = Number(best && best.lo);
      const bhi = Number(best && best.hi);
      if (lo > blo) best = it;
      else if (lo === blo && hi < bhi) best = it;
    }
  }

  if (best) return best;

  // Out of range: clamp to closest bucket by endpoints.
  const first = list[0];
  const last = list[list.length - 1];
  const lo0 = Number(first && first.lo);
  const hiN = Number(last && last.hi);
  if (Number.isFinite(lo0) && r < lo0) return first;
  if (Number.isFinite(hiN) && r > hiN) return last;
  return last;
}

function pickManifestRangeFile(ranges, rate, seed) {
  const match = matchManifestRange(ranges, rate);
  if (!match) return null;
  const files = Array.isArray(match && match.files) ? match.files.filter(Boolean) : [];
  if (!files.length) return null;
  const s = Math.abs(Math.floor(Number(seed) || 0));
  return String(files[s % files.length]);
}

function computeEmotionLoopSrcAssignmentsForMap({ n, rates, ringHomeNums, innerCount, seedFloats }) {
  const srcByIndex = new Array(Math.max(0, Number(n) || 0)).fill(null);
  const ringCount = srcByIndex.length;
  if (ringCount <= 0) return srcByIndex;

  const clampInt = (v, lo, hi) => {
    const x = Math.round(Number(v) || 0);
    return Math.max(lo, Math.min(hi, x));
  };

  const m = _mp3NewManifest;
  const inRanges = m && m.ok === true && m.loops && Array.isArray(m.loops.in) ? m.loops.in : null;
  const outRanges = m && m.ok === true && m.loops && Array.isArray(m.loops.out) ? m.loops.out : null;

  // If manifest isn't ready, fall back to per-ring selection.
  if (!inRanges || !outRanges) {
    for (let i = 0; i < ringCount; i++) {
      const homeNum = clampInt(ringHomeNums[i] ?? (i + 1), 1, ringCount);
      const pos = homeNum - 1;
      const isInner = pos < Math.max(1, Number(innerCount) || 1);
      const rate = rates[i] ?? 5;
      srcByIndex[i] = emotionLoopSrcByRingAndRate(isInner, rate, homeNum);
    }
    return srcByIndex;
  }

  let mapSeed = 0;
  for (let i = 0; i < ringCount; i++) {
    const homeNum = clampInt(ringHomeNums[i] ?? (i + 1), 1, ringCount);
    const rate = clampInt(rates[i] ?? 5, 1, 10);
    mapSeed = (Math.imul(mapSeed, 131) + Math.imul(homeNum, 7) + rate) >>> 0;
    if (Array.isArray(seedFloats)) {
      const f = Number(seedFloats[i]) || 0;
      // Quantize float to keep it stable across minor FP noise.
      const q = (Math.round(f * 1000) | 0) >>> 0;
      mapSeed = (Math.imul(mapSeed, 167) + q) >>> 0;
    }
  }

  const groups = new Map();

  for (let i = 0; i < ringCount; i++) {
    const homeNum = clampInt(ringHomeNums[i] ?? (i + 1), 1, ringCount);
    const pos = homeNum - 1;
    const isInner = pos < Math.max(1, Number(innerCount) || 1);
    const rate = clampInt(rates[i] ?? 5, 1, 10);

    const kind = isInner ? "in" : "out";
    const bucket = matchManifestRange(isInner ? inRanges : outRanges, rate);
    const files = bucket && Array.isArray(bucket.files) ? bucket.files.filter(Boolean) : [];
    if (!bucket || !files.length) {
      srcByIndex[i] = emotionLoopSrcByRingAndRate(isInner, rate, homeNum);
      continue;
    }
    const key = `${kind}:${Number(bucket.lo)}-${Number(bucket.hi)}`;
    const g = groups.get(key) || { kind, bucket, files, rings: [] };
    g.rings.push({ i, homeNum });
    groups.set(key, g);
  }

  for (const [key, g] of groups.entries()) {
    const rings = Array.isArray(g.rings) ? g.rings.slice() : [];
    const files = Array.isArray(g.files) ? g.files.slice() : [];
    if (!rings.length || !files.length) continue;

    rings.sort((a, b) => (a.homeNum - b.homeNum) || (a.i - b.i));

    const groupSeed = (hashString32(key) ^ mapSeed) >>> 0;
    const stableFiles = seededShuffle(files, groupSeed);

    if (rings.length <= 2 || stableFiles.length <= 1) {
      const idx = stableFiles.length ? (groupSeed % stableFiles.length) : 0;
      const f = stableFiles[idx] || stableFiles[0];
      const src = mp3NewSrc(f);
      for (const r of rings) srcByIndex[r.i] = src;
      continue;
    }

    // 3+ rings: ensure we use multiple variants when available.
    const k = Math.max(2, Math.min(stableFiles.length, rings.length));
    for (let j = 0; j < rings.length; j++) {
      const f = stableFiles[j % k];
      srcByIndex[rings[j].i] = mp3NewSrc(f);
    }
  }

  // Fill any gaps defensively.
  for (let i = 0; i < ringCount; i++) {
    if (!srcByIndex[i]) {
      const homeNum = clampInt(ringHomeNums[i] ?? (i + 1), 1, ringCount);
      const pos = homeNum - 1;
      const isInner = pos < Math.max(1, Number(innerCount) || 1);
      const rate = rates[i] ?? 5;
      srcByIndex[i] = emotionLoopSrcByRingAndRate(isInner, rate, homeNum);
    }
  }

  return srcByIndex;
}

function emotionLoopSrcByRingAndRate(isInner, rate, seed) {
  try {
    const m = _mp3NewManifest;
    const kind = isInner ? "in" : "out";
    const ranges = m && m.ok === true && m.loops && m.loops[kind];
    const file = pickManifestRangeFile(ranges, rate, seed);
    if (file) return mp3NewSrc(file);
  } catch {
    // ignore
  }

  // Fallback mapping (kept as a stable baseline if manifest is unavailable).
  const r = Math.max(1, Math.min(10, Math.round(Number(rate) || 5)));
  if (isInner) {
    if (r <= 4) return MP3_NEW_SOUNDS.inner_1_5;
    if (r <= 7) return MP3_NEW_SOUNDS.inner_5_6;
    return MP3_NEW_SOUNDS.inner_7_10;
  }
  if (r <= 2) return MP3_NEW_SOUNDS.outer_1_3;
  if (r <= 4) return MP3_NEW_SOUNDS.outer_3_4;
  if (r <= 7) return MP3_NEW_SOUNDS.outer_5_6;
  const variants = [MP3_NEW_SOUNDS.outer_7_10, MP3_NEW_SOUNDS.outer_7_10_new, MP3_NEW_SOUNDS.outer_7_10_neww].filter(Boolean);
  const s = Math.abs(Math.floor(Number(seed) || 0));
  return variants.length ? variants[s % variants.length] : MP3_NEW_SOUNDS.outer_7_10;
}

function tickSrcByRate(rate, seed) {
  try {
    const m = _mp3NewManifest;
    const ticks = m && m.ok === true ? m.ticks : null;
    const r = Math.round(Number(rate) || 1);
    if (ticks && typeof ticks === "object") {
      const direct = ticks[String(r)];
      const fallback = ticks[String(Math.max(1, Math.min(4, r)))];
      const files = Array.isArray(direct) ? direct : (Array.isArray(fallback) ? fallback : null);
      if (files && files.length) {
        const s = Math.abs(Math.floor(Number(seed ?? r) || 0));
        return mp3NewSrc(String(files[s % files.length]));
      }
    }
  } catch {
    // ignore
  }
  const rr = Math.max(1, Math.min(4, Math.round(Number(rate) || 1)));
  if (rr === 1) return MP3_NEW_SOUNDS.tick_1;
  if (rr === 2) return MP3_NEW_SOUNDS.tick_2;
  if (rr === 3) return MP3_NEW_SOUNDS.tick_3;
  return MP3_NEW_SOUNDS.tick_4;
}

// Start manifest fetch early so it's ready by first user gesture.
void primeMp3NewManifest();

// Files currently present under mp3/new/ (on disk they are named in/out ...).
// We keep semantic keys so rules can be expressed as "inner/outer" + ranges.
const MP3_NEW_SOUNDS = {
  inner_1_5: mp3NewSrc("in 1-4.mp3"),
  inner_5_6: mp3NewSrc("in 5-7.mp3"),
  inner_7_10: mp3NewSrc("in 8-10.mp3"),
  outer_1_3: mp3NewSrc("out 1-2.mp3"),
  outer_3_4: mp3NewSrc("out 3-4.mp3"),
  outer_5_6: mp3NewSrc("out 5-7.mp3"),
  outer_7_10: mp3NewSrc("out 7-10.mp3"),
  outer_7_10_new: mp3NewSrc("out 7-10 (2).mp3"),
  outer_7_10_neww: mp3NewSrc("out 7-10 (3).mp3"),

  // Tick layer (per-ring one-shots)
  tick_1: mp3NewSrc("tick 1.mp3"),
  tick_2: mp3NewSrc("tick 2.mp3"),
  tick_3: mp3NewSrc("tick 3.mp3"),
  tick_4: mp3NewSrc("tick 4.mp3"),
};

// ============================================================================
// Emotion sound — OCCURRENCE rules (when sound plays, how loud, for which
// ring). Which mp3 FILE plays for a given ring is a separate, untouched
// concern — see computeEmotionLoopSrcAssignmentsForMap(),
// emotionLoopSrcByRingAndRate() and tickSrcByRate() above.
//
// Three independent occurrence rules exist right now:
//   1. EMOTION_ENTRY_SOUND_ENABLED — each address, the moment it's added (or
//      edited) and becomes a ring in Step 1's own map, gets its matching
//      sound and that sound keeps playing, layered on top of every
//      previously-added ring's sound. See activateEmotionRing().
//   2. EMOTION_SOLO_SOUND_ENABLED — opening a ring in solo (from ring
//      reading) plays *only* that ring's own matching sound — nothing else.
//      See startEmotionSoundForSoloRing()/stopEmotionSoundForSoloRing().
//   3. EMOTION_SOUND_ENABLED — the ambient "whole map" system (Step 1's
//      finished summary view, the fullscreen page) and the tick layer. Off
//      until those rules are specified.
// ============================================================================
const EMOTION_ENTRY_SOUND_ENABLED = true;
// Per-ring loop volume for the entry-phase sound above (see activateEmotionRing()) —
// applies only to those "mp3/new/" ring-loop files, not the tick layer.
const EMOTION_ENTRY_RING_VOLUME = 0.95;
const EMOTION_SOLO_SOUND_ENABLED = true;
const EMOTION_SOUND_ENABLED = false;

const EMOTION_SOUND_CONFIG = {
  innerFraction: 0.30,
  // Overall loudness target; per-ring volume is scaled down by 1/sqrt(ringCount).
  baseVolume: 0.94,
  // Map-level loudness shaping: higher average belonging => louder overall map.
  loudnessByAvgBelonging: {
    pivot: 5,       // rates are 1..10; pivot is the "neutral" midpoint
    lowMult: 0.85,  // at avg=1  => baseVolume * lowMult
    highMult: 1.25, // at avg=10 => baseVolume * highMult
  },
  // When focusing a single ring (solo page), how its loudness compares to
  // its normal place in the full mix.
  solo: {
    // Play the focused ring at the *original* file loudness (volume=1)
    // rather than its mix-normalized volume.
    useOriginalVolume: true,
    boostMult: 1.6, // only used when useOriginalVolume is false
  },
  // Breathing-driven volume modulation per ring: quieter while a ring is
  // shrunk in, louder while it's pushed out.
  breathDuck: {
    shrinkMinMult: 0.45,
    expandMaxMult: 1.60,
    smoothTauMs: 90,
  },
  // Tick layer: one-shots for belonging 1..4 only, timing jittered around a
  // per-rate mean so it doesn't read as a strict beat.
  tick: {
    enabled: true,
    volumeMult: 2,
    meanIntervalMsByRate: { 1: 3600, 2: 5200, 3: 7000, 4: 9500 },
    jitterMinMult: 0.55,
    jitterMaxMult: 1.55,
    firstEventMaxDelayMs: 1400, // cap first tick's delay so it's heard promptly
  },
};

let _emotionTickCtx = null;
let _emotionTickBuffers = null;
let _emotionTickBufferPromises = null;
let _emotionTickTimeouts = null;

let _emotionLoopBuffers = null;
let _emotionLoopBufferPromises = null;

let _emotionRingFocusIndex = null;
let pendingEmotionSoloRingSnapshot = null;
let pendingEmotionSoloTargetRingSizePx = null;
let pendingEmotionSoloShapeParams = null;

// Viewport rect (+ color/stroke) of the ring-reading path the user clicked to
// enter solo, captured while Step 1 is still on screen. Reused as the landing
// target when leaving solo, so the ring "flies" directly between the two
// pages instead of animating in place on whichever page is currently shown.
let _emotionSoloOriginRect = null;
let _emotionSoloOriginColor = null;
let _emotionSoloOriginStrokeWidthPx = null;
// The ring-reading path's own `d` + a viewBox fit to its local bounding box,
// so the fly overlay can render the ring's true (distorted) shape instead of
// approximating it as a circle.
let _emotionSoloOriginPathD = null;
let _emotionSoloOriginViewBox = null;

// Solo alignment anchor: derived fraction of the emotion SVG width.
// This keeps the focused ring's right-edge alignment consistent across maps/layouts.
let _emotionSoloRightEdgeTargetFrac = null;

// Set right before entering solo from the fullscreen emotion map's ring
// spread, so the solo page's "back" button can return there (re-entering
// spread) instead of always landing on Step 1 -- see
// elEmotionSoloBackBtn's click handler.
let _emotionSoloReturnToStep1FullscreenSpread = false;

// Same idea as _emotionSoloReturnToStep1FullscreenSpread, but for entering
// solo by clicking a point on the route/movement map (Step 2) -- see
// renderStep2AddressDots()'s click handler.
let _emotionSoloReturnToStep2 = false;

// Builds an _emotionSoloOriginRect-shaped origin (+ shape params) directly
// from a currently-rendered fullscreen-emotion-map ring element, so the fly
// animation into the solo page starts from wherever that ring actually is on
// screen right now (e.g. its spread-out position) instead of always
// re-measuring Step 1's own (separate, often hidden) ring-reading panel --
// see openEmotionMapSoloFromStep1RingReading()'s originOverride parameter.
function buildEmotionSoloOriginFromRingEl(ring, idx) {
  if (!ring) return null;
  try {
    const rect = ring.getBoundingClientRect();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    const strokeWidthPx = Number(ring.getAttribute("stroke-width")) || 2;
    const r0 = Number(ring.getAttribute("data-emotion-r0")) || 1;
    const amp = Number(ring.getAttribute("data-emotion-amp")) || 0;
    const ringSize = Math.max(rect.width, rect.height);

    let pathD = null;
    let viewBox = null;
    try {
      const d = ring.getAttribute("d");
      const bbox = typeof ring.getBBox === "function" ? ring.getBBox() : null;
      if (d && bbox && bbox.width > 0 && bbox.height > 0) {
        const pad = strokeWidthPx / 2;
        pathD = d;
        viewBox = `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`;
      }
    } catch {
      // ignore -- falls back to the plain-circle overlay
    }

    return {
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      color: ring.getAttribute("stroke") || "#111827",
      strokeWidthPx,
      pathD,
      viewBox,
      targetRingSizePx: ringSize > 0 ? ringSize * 1.5 : null,
      shapeParams: {
        index: Math.max(0, Math.floor(Number(idx) || 0)),
        phi: Number(ring.getAttribute("data-emotion-phi")) || 0,
        ampRatio: r0 > 0 ? amp / r0 : 0,
        strokeRatio: null,
        strokeWidth: strokeWidthPx,
        strokeWidthPx,
      },
    };
  } catch {
    return null;
  }
}

function isEmotionRingFocusActive() {
  return Number.isFinite(_emotionRingFocusIndex) && _emotionRingFocusIndex !== null;
}

function getEmotionRingsStateFromSvg() {
  if (!elEmotionSvg) return null;
  const rings = Array.isArray(elEmotionSvg.__lpEmotionRings) ? elEmotionSvg.__lpEmotionRings : null;
  const rates = Array.isArray(elEmotionSvg.__lpEmotionRates) ? elEmotionSvg.__lpEmotionRates : null;
  if (!rings || !rings.length) return null;
  return {
    rings,
    rates: rates && rates.length === rings.length ? rates : new Array(rings.length).fill(5),
  };
}

// A stand-in for a ring while it "flies" between Step 1's ring-reading panel
// and its solo spot on the Emotion page. The real ring/rings stay hidden for
// the duration; only this overlay moves, so the whole transition reads as one
// continuous motion bridging the two pages instead of two separate
// animations (page switch, then ring settling).
//
// It renders the ring's *actual* (mildly distorted) path — the same `d` the
// ring-reading path used — inside a small SVG sized to that path's own
// bounding box, with preserveAspectRatio="xMidYMid meet" so the shape scales
// uniformly and never distorts into a circle or an ellipse as the container
// resizes. The stroke uses vector-effect="non-scaling-stroke" so its on-screen
// width stays fixed regardless of how much the overlay grows/shrinks — only
// the overall size animates, never the shape or the stroke thickness.
function createEmotionRingFlyOverlay(rect, opts) {
  try {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    const o = opts && typeof opts === "object" ? opts : {};

    const wrap = document.createElement("div");
    wrap.className = "emotionRingFlyOverlay";
    wrap.style.position = "fixed";
    wrap.style.left = `${rect.left}px`;
    wrap.style.top = `${rect.top}px`;
    wrap.style.width = `${rect.width}px`;
    wrap.style.height = `${rect.height}px`;
    wrap.style.margin = "0";
    wrap.style.pointerEvents = "none";
    wrap.style.zIndex = "99999";
    wrap.style.overflow = "visible";

    if (o.pathD && o.viewBox) {
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", o.viewBox);
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.style.width = "100%";
      svg.style.height = "100%";
      svg.style.overflow = "visible";
      svg.style.display = "block";

      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", o.pathD);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", o.color || "#111827");
      path.setAttribute("stroke-width", String(Math.max(0.5, Number(o.strokeWidth) || 2)));
      path.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(path);
      wrap.appendChild(svg);
    } else {
      // Fallback: a plain circle, only used if we couldn't capture the real path.
      wrap.style.borderRadius = "50%";
      wrap.style.boxSizing = "border-box";
      wrap.style.border = `${Math.max(1, Number(o.strokeWidth) || 2)}px solid ${o.color || "#111827"}`;
      wrap.style.background = "transparent";
    }

    document.body.appendChild(wrap);
    return wrap;
  } catch {
    return null;
  }
}

function flyEmotionRingOverlayTo(overlay, toRect, durationMs) {
  return new Promise((resolve) => {
    if (!overlay || !toRect) {
      resolve();
      return;
    }
    try {
      void overlay.offsetWidth; // Force layout so the start rect is registered before animating.
      requestAnimationFrame(() => {
        try {
          // Deliberately no "border"/stroke-width here — stroke thickness stays constant.
          overlay.style.transition = [
            `left ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
            `top ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
            `width ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
            `height ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
          ].join(", ");
          overlay.style.left = `${toRect.left}px`;
          overlay.style.top = `${toRect.top}px`;
          overlay.style.width = `${toRect.width}px`;
          overlay.style.height = `${toRect.height}px`;
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
    setTimeout(resolve, Math.max(0, Number(durationMs) || 0) + 30);
  });
}

function removeEmotionRingFlyOverlay(overlay) {
  try {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  } catch {
    // ignore
  }
}

function applyEmotionRingFocusVisuals(focusIdx, options) {
  const opts = options && typeof options === "object" ? options : {};
  // When a fly-overlay transition is driving the visible motion (see
  // openEmotionMapSoloFromStep1RingReading / applyPendingEmotionSoloFocus),
  // the rings themselves should just snap straight to their final state with
  // no animation of their own, and the focused ring should stay invisible
  // until the overlay lands on top of it.
  const instant = Boolean(opts.instant);
  const hideFocusedInitially = Boolean(opts.hideFocusedInitially);
  const focusedRestOpacity = hideFocusedInitially ? "0" : "1";

  const state = getEmotionRingsStateFromSvg();
  if (!state) return;
  if (elPageEmotion) elPageEmotion.classList.add("emotionSoloActive");
  const { rings } = state;
  const n = rings.length;
  const idx = Math.max(0, Math.min(n - 1, Math.floor(Number(focusIdx) || 0)));

  const fadeMs = 680;
  const moveMs = 1040;
  const minSoloRingSizePx = 80;

  const targetSoloCenterXForPage = () => {
    try {
      const vw = Math.max(1, Number(window.innerWidth) || 1);
      return vw * 0.25;
    } catch {
      return 480;
    }
  };

  const targetSoloTextXForPage = () => {
    try {
      const vw = Math.max(1, Number(window.innerWidth) || 1);
      return (vw * 0.5) - 30;
    } catch {
      return 930;
    }
  };

  const soloScaleForRing = (ringEl) => {
    try {
      const targetSize = Number(pendingEmotionSoloTargetRingSizePx);
      if (!Number.isFinite(targetSize) || !(targetSize > 0)) return 1;
      if (!ringEl || typeof ringEl.getBoundingClientRect !== "function") return 1;
      const rect = ringEl.getBoundingClientRect();
      const currentSize = Math.max(Number(rect.width) || 0, Number(rect.height) || 0);
      if (!(currentSize > 0)) return 1;
      return Math.max(0.2, Math.min(8, targetSize / currentSize));
    } catch {
      return 1;
    }
  };

  // Entering focus: ensure the reading label is visible.
  // Anchor it to the fixed solo target point so it doesn't "jump" after animation/snap.
  try {
    const r0 = rings[idx];
    if (r0) {
      const rect = r0.getBoundingClientRect();
      const text = ringReadingTextForRingEl(r0, idx);
      const x = targetSoloTextXForPage();
      // Keep all the "additional" text (HOME/ADDRESS/ATTACHMENT/EMOTIONAL) anchored
      // to the previous layout baseline, even if we move RING READING itself.
      const yLayout = (rect.top + rect.height / 2) - 190;
      const yReading = yLayout + 35;

      const readingRectLayout = showEmotionRingReading(text, x, yLayout, { reveal: false });
      try {
        const homeText = homeNoTextForRingEl(r0, idx);
        const base = readingRectLayout && typeof readingRectLayout.bottom === "number" ? readingRectLayout : null;
        const homeX = base ? base.left : x;
        const homeY = base ? (base.bottom + 45) : (yLayout + 45);
        const homeRect = showEmotionRingHomeNo(homeText, homeX, homeY);

        // Attachment: 40px below HOME NO.
        try {
          const attachText = "attachment";
          const ax0 = (homeRect && typeof homeRect.left === "number") ? homeRect.left : homeX;
          const ay0 = (homeRect && typeof homeRect.bottom === "number") ? (homeRect.bottom + 40) : (homeY + 40);
          const attachRect = showEmotionRingAttachment(attachText, ax0, ay0);

          // Temporal: 60px below ATTACHMENT.
          let temporalRect = null;
          let movementRect = null;
          try {
            const tx0 = (attachRect && typeof attachRect.left === "number") ? attachRect.left : ax0;
            const ty0 = (attachRect && typeof attachRect.bottom === "number") ? (attachRect.bottom + 60) : (ay0 + 60);
            temporalRect = showEmotionRingTemporal("temporal", tx0, ty0);

            // Movment: 5px below TEMPORAL.
            try {
              if (temporalRect) {
                const mx0 = (temporalRect && typeof temporalRect.left === "number") ? temporalRect.left : tx0;
                const my0 = (temporalRect && typeof temporalRect.bottom === "number") ? (temporalRect.bottom + 105) : (ty0 + 105);
                movementRect = showEmotionRingMovement("movement", mx0, my0);
              } else {
                hideEmotionRingMovement();
              }
            } catch {
              // ignore
            }
          } catch {
            // ignore
            try { hideEmotionRingMovement(); } catch { /* ignore */ }
          }

          // Emotional connection: same height as ATTACHMENT, shifted right.
          try {
            const addrForRate = Array.isArray(addresses) ? addresses[idx] : null;
            const conn = emotionalConnectionPartsForAddress(addrForRate, idx);
            if (conn && conn.value) {
              const cx0 = ((attachRect && typeof attachRect.left === "number") ? attachRect.left : ax0) + 162;
              const cy0 = (attachRect && typeof attachRect.top === "number") ? attachRect.top : ay0;
              const connRect = showEmotionRingEmotionalConnection(conn.label, conn.value, cx0, cy0);

              // Belonging shift: directly under EMOTIONAL CONNECTION.
              try {
                const shift = belongingShiftPartsForIndex(idx);
                if (shift && (shift.value || shift.value === 0)) {
                  const sx0 = (connRect && typeof connRect.left === "number") ? connRect.left : cx0;
                  const sy0 = (connRect && typeof connRect.bottom === "number") ? (connRect.bottom + 5) : (cy0 + 5);
                  const shiftRect = showEmotionRingBelongingShift(shift.label, shift.value, sx0, sy0);

                  // Duration of Presence: same height as TEMPORAL, aligned under BELONGING SHIFT.
                  try {
                    const residence = residenceTimelinePartsForIndex(idx);
                    const dpX = (shiftRect && typeof shiftRect.left === "number") ? shiftRect.left : sx0;
                    const dpY = (temporalRect && typeof temporalRect.top === "number") ? temporalRect.top : sy0;
                    const dpRect = showEmotionRingDurationOfPresence(residence.duration.label, residence.duration.value, dpX, dpY);

                    // Timeframe: directly under DURATION OF PRESENCE.
                    try {
                      const tfX = (dpRect && typeof dpRect.left === "number") ? dpRect.left : dpX;
                      const tfY = (dpRect && typeof dpRect.bottom === "number") ? (dpRect.bottom + 5) : (dpY + 5);
                      const tfRect = showEmotionRingTimeframe(residence.years.label, residence.years.value, tfX, tfY);

                      // Life stage: directly under TIMEFRAME.
                      try {
                        const lsX = (tfRect && typeof tfRect.left === "number") ? tfRect.left : tfX;
                        const lsY = (tfRect && typeof tfRect.bottom === "number") ? (tfRect.bottom + 5) : (tfY + 5);
                        const lsRect = showEmotionRingLifeStage(residence.lifeStage.label, residence.lifeStage.value, lsX, lsY);

                        // Lifetime Presentage: 5px under LIFE STAGE.
                        try {
                          const lpX = (lsRect && typeof lsRect.left === "number") ? lsRect.left : lsX;
                          const lpY = (lsRect && typeof lsRect.bottom === "number") ? (lsRect.bottom + 5) : (lsY + 5);
                          const lpRect = showEmotionRingLifetimePresentage(residence.lifetime.label, residence.lifetime.value, lpX, lpY);

                          // Transitional Distance: 5px under LIFETIME PRESENTAGE.
                          try {
                            const td = transitionalDistancePartsForIndex(idx);
                            if (td && td.label) {
                              const tdX = (lpRect && typeof lpRect.left === "number") ? lpRect.left : lpX;
                              const tdY = (movementRect && typeof movementRect.top === "number")
                                ? movementRect.top
                                : ((lpRect && typeof lpRect.bottom === "number") ? (lpRect.bottom + 5) : (lpY + 5));
                              const tdRect = showEmotionRingTransitionalDistance(td.label, td.value, tdX, tdY);

                              // Cumulative Distance: 5px under TRANSITIONAL DISTANCE.
                              try {
                                const cd = cumulativeDistancePartsForIndex(idx);
                                if (cd && cd.label) {
                                  const cdX = (tdRect && typeof tdRect.left === "number") ? tdRect.left : tdX;
                                  const cdY = (tdRect && typeof tdRect.bottom === "number") ? (tdRect.bottom + 5) : (tdY + 5);
                                  showEmotionRingCumulativeDistance(cd.label, cd.value, cdX, cdY);
                                } else {
                                  hideEmotionRingCumulativeDistance();
                                }
                              } catch {
                                // ignore
                              }
                            } else {
                              hideEmotionRingTransitionalDistance();
                              hideEmotionRingCumulativeDistance();
                            }
                          } catch {
                            // ignore
                          }
                        } catch {
                          // ignore
                        }
                      } catch {
                        // ignore
                      }
                    } catch {
                      // ignore
                    }
                  } catch {
                    // ignore
                  }
                } else {
                  hideEmotionRingBelongingShift();
                  hideEmotionRingDurationOfPresence();
                  hideEmotionRingTimeframe();
                  hideEmotionRingLifeStage();
                  hideEmotionRingLifetimePresentage();
                  hideEmotionRingTransitionalDistance();
                  hideEmotionRingCumulativeDistance();
                }
              } catch {
                // ignore
              }
            } else {
              hideEmotionRingEmotionalConnection();
              hideEmotionRingBelongingShift();
              hideEmotionRingDurationOfPresence();
              hideEmotionRingTimeframe();
              hideEmotionRingLifeStage();
              hideEmotionRingLifetimePresentage();
              hideEmotionRingTransitionalDistance();
              hideEmotionRingCumulativeDistance();
            }
          } catch {
            // ignore
          }
        } catch {
          // ignore
        }

        // Address line: same Y as HOME NO but 40px to the right.
        try {
          const addr = Array.isArray(addresses) ? addresses[idx] : null;
          const addrValue = addressValueTextForAddress(addr);
          if (addrValue) {
            const ax = (homeRect && typeof homeRect.left === "number" ? homeRect.left : homeX) + 250;
            const ay = (homeRect && typeof homeRect.top === "number" ? homeRect.top : homeY);
            showEmotionRingAddress(addrValue, ax, ay);
          } else {
            hideEmotionRingAddress();
          }
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }

      // Finally show the RING READING line at the requested lower position.
      showEmotionRingReading(text, x, yReading);
    }
  } catch {
    // ignore
  }

  const soloTransform = (dx, scale) => {
    const s = Number(scale) || 1;
    return Math.abs(s - 1) > 0.0001 ? `translateX(${dx}px) scale(${s})` : `translateX(${dx}px)`;
  };

  const focusTranslatePxForRing = (ringEl, scale) => {
    try {
      if (!ringEl || typeof ringEl.getBoundingClientRect !== "function") return 0;
      const ringRect = ringEl.getBoundingClientRect();
      const targetCenterX = targetSoloCenterXForPage();
      if (!ringRect || !Number.isFinite(targetCenterX)) return 0;

      const ringCenterX = ringRect.left + (Math.max(0, Number(ringRect.width) || 0) / 2);
      return targetCenterX - ringCenterX;
    } catch {
      return 0;
    }
  };

  const enforceSoloBaseStrokeWidth = (ringEl, hitEl) => {
    try {
      const baseSw = Number(ringEl && ringEl.__lpSoloBaseStrokeWidth);
      if (Number.isFinite(baseSw) && baseSw > 0) ringEl.setAttribute("stroke-width", String(baseSw));
    } catch {
      // ignore
    }
    try {
      const baseHitSw = Number(hitEl && hitEl.__lpSoloBaseStrokeWidth);
      if (Number.isFinite(baseHitSw) && baseHitSw > 0) hitEl.setAttribute("stroke-width", String(baseHitSw));
    } catch {
      // ignore
    }
  };

  const snapFocusedRingToTarget = (ringEl, hitEl, scale) => {
    try {
      if (!ringEl || typeof ringEl.getBoundingClientRect !== "function") return;
      const targetCenterX = targetSoloCenterXForPage();
      if (!Number.isFinite(targetCenterX)) return;
      const rect = ringEl.getBoundingClientRect();
      const ringCenterX = rect.left + (Math.max(0, Number(rect.width) || 0) / 2);
      const err = targetCenterX - ringCenterX;
      if (!Number.isFinite(err) || Math.abs(err) < 0.25) return;

      const curTransform = (ringEl.style && ringEl.style.transform) ? String(ringEl.style.transform) : "";
      const m = curTransform.match(/translateX\(([-0-9.]+)px\)/);
      const curDx = m ? Number(m[1]) : 0;
      const nextDx = curDx + err;
      const nextTransform = soloTransform(nextDx, scale);

      try {
        ringEl.style.transform = nextTransform;
        enforceSoloBaseStrokeWidth(ringEl, hitEl);
      } catch {
        // ignore
      }
      if (hitEl && hitEl.style) {
        try {
          hitEl.style.transform = nextTransform;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  };

  let focusDx = null;
  const focusScale = soloScaleForRing(rings[idx]);

  const applySoloVisualScaleMetadata = (ringEl, hitEl, scale) => {
    const s = Math.max(0.2, Number(scale) || 1);
    if (!(s > 0)) return;
    try {
      const baseSw = Number(ringEl.__lpSoloBaseStrokeWidth || ringEl.getAttribute("stroke-width"));
      if (Number.isFinite(baseSw) && baseSw > 0) {
        ringEl.__lpSoloBaseStrokeWidth = baseSw;
        ringEl.setAttribute("stroke-width", String(baseSw));
      }
      ringEl.setAttribute("vector-effect", "non-scaling-stroke");
      ringEl.__lpSoloVisualScale = s;
    } catch {
      // ignore
    }
    try {
      const baseHitSw = Number(hitEl.__lpSoloBaseStrokeWidth || hitEl.getAttribute("stroke-width"));
      if (Number.isFinite(baseHitSw) && baseHitSw > 0) {
        hitEl.__lpSoloBaseStrokeWidth = baseHitSw;
        hitEl.setAttribute("stroke-width", String(baseHitSw));
      }
      hitEl.setAttribute("vector-effect", "non-scaling-stroke");
      hitEl.__lpSoloVisualScale = s;
    } catch {
      // ignore
    }
  };

  const animateEl = (el, from, to, ms) => {
    if (!el) return;
    try {
      if (typeof el.getAnimations === "function") {
        for (const a of el.getAnimations()) {
          try {
            a.cancel();
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    try {
      if (typeof el.animate === "function") {
        el.animate([from, to], { duration: ms, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" });
        return;
      }
    } catch {
      // fall through
    }

    // Fallback: CSS transitions (ensure SVG transform works).
    try {
      el.style.transformBox = "fill-box";
      el.style.transformOrigin = "center";
      el.style.willChange = "opacity, transform";
      el.style.transition = `opacity ${fadeMs}ms ease, transform ${moveMs}ms ease`;
      // Apply in next frame so it animates.
      requestAnimationFrame(() => {
        try {
          if (to.opacity != null) el.style.opacity = String(to.opacity);
          if (to.transform != null) el.style.transform = String(to.transform);
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  };

  for (let i = 0; i < n; i++) {
    const r = rings[i];
    const hit = r && r.__lpHitPath;
    const isFocus = i === idx;

    // Visible ring: animate fade + translate.
    if (r && r.style) {
      if (isFocus) {
        try {
          r.style.opacity = "1";
          r.style.transform = "translateX(0px)";
          r.style.transformBox = "fill-box";
          r.style.transformOrigin = "center";
          r.style.pointerEvents = "none";
        } catch {
          // ignore
        }

        if (!Number.isFinite(focusDx)) focusDx = focusTranslatePxForRing(r, focusScale);
        if (!Number.isFinite(focusDx)) focusDx = 0;
        applySoloVisualScaleMetadata(r, hit, focusScale);
        enforceSoloBaseStrokeWidth(r, hit);
        if (!instant) {
          animateEl(
            r,
            { opacity: 1, transform: "translateX(0px)" },
            { opacity: 1, transform: soloTransform(focusDx, focusScale) },
            moveMs
          );
        }
        try {
          r.style.opacity = focusedRestOpacity;
          r.style.transform = soloTransform(focusDx, focusScale);
          enforceSoloBaseStrokeWidth(r, hit);
        } catch {
          // ignore
        }

        // After animation completes, snap to the exact target point (gapless alignment).
        if (!instant) {
          try {
            const focusIndexAtCall = idx;
            const ringEl = r;
            const hitEl = hit;
            setTimeout(() => {
              try {
                if (!isEmotionRingFocusActive()) return;
                if (Math.floor(Number(_emotionRingFocusIndex) || 0) !== focusIndexAtCall) return;
                snapFocusedRingToTarget(ringEl, hitEl, focusScale);
              } catch {
                // ignore
              }
            }, moveMs + 40);
          } catch {
            // ignore
          }
        }
      } else {
        try {
          r.style.opacity = "1";
          r.style.transform = "translateX(0px)";
          r.style.pointerEvents = "none";
        } catch {
          // ignore
        }
        if (!instant) {
          animateEl(
            r,
            { opacity: 1, transform: "translateX(0px)" },
            { opacity: 0, transform: "translateX(0px)" },
            fadeMs
          );
        }
        try {
          r.style.opacity = "0";
          r.style.transform = "translateX(0px)";
        } catch {
          // ignore
        }
      }
    }

    // Hit path: NEVER fade to visible (it would look like thickness changes).
    // Only translate it to match the ring position.
    if (hit && hit.style) {
      try {
        hit.style.opacity = "0.001";
        hit.style.transform = "translateX(0px)";
      } catch {
        // ignore
      }

      if (isFocus) {
        if (!Number.isFinite(focusDx)) focusDx = focusTranslatePxForRing(r, focusScale);
        if (!Number.isFinite(focusDx)) focusDx = 0;
        try {
          hit.style.transformBox = "fill-box";
          hit.style.transformOrigin = "center";
        } catch {
          // ignore
        }
        if (!instant) {
          animateEl(
            hit,
            { transform: "translateX(0px)" },
            { transform: soloTransform(focusDx, focusScale) },
            moveMs
          );
        }
        try {
          hit.style.transform = soloTransform(focusDx, focusScale);
          hit.style.pointerEvents = "stroke";
        } catch {
          // ignore
        }
      } else {
        if (!instant) {
          animateEl(
            hit,
            { transform: "translateX(0px)" },
            { transform: "translateX(0px)" },
            fadeMs
          );
        }
        try {
          hit.style.transform = "translateX(0px)";
          hit.style.pointerEvents = "none";
        } catch {
          // ignore
        }
      }
    }
  }

  // Bring the focused ring to front so it stays visible.
  try {
    const r = rings[idx];
    const hit = r && r.__lpHitPath;
    const parent = r && r.parentNode;
    if (parent && parent.appendChild) {
      parent.appendChild(r);
      if (hit) parent.appendChild(hit);
    }
  } catch {
    // ignore
  }
}

let pendingEmotionSoloFocusIndex = null;

const EMOTION_SOLO_FLY_MS = 900;

function applyPendingEmotionSoloFocus() {
  const idx = Number(pendingEmotionSoloFocusIndex);
  pendingEmotionSoloFocusIndex = null;
  if (!Number.isFinite(idx)) return;
  pendingEmotionSoloRingSnapshot = null;
  try {
    _emotionRingFocusIndex = Math.max(0, Math.floor(idx));
    const originRect = _emotionSoloOriginRect;
    applyEmotionRingFocusVisuals(_emotionRingFocusIndex, {
      instant: Boolean(originRect),
      hideFocusedInitially: Boolean(originRect),
    });

    // Sound switches to solo-only *immediately* — not gated behind the fly
    // overlay animation below, which can run for the better part of a
    // second. setEmotionSoundFocus() only matters once the ambient "whole
    // map" system is turned on; startEmotionSoundForSoloRing() is what
    // actually plays anything right now — just this one ring's own sound.
    try {
      setEmotionSoundFocus(_emotionRingFocusIndex);
      startEmotionSoundForSoloRing(_emotionRingFocusIndex);
    } catch {
      // ignore
    }

    // Breathing (visual) still waits until the ring actually becomes
    // visible, so its continuous geometry animation can't drift the ring's
    // size away from what the fly overlay displayed while it was hidden —
    // this is purely a visual concern, decoupled from sound above.
    const startPlaybackNow = () => {
      try {
        const armed = _emotionBreathArmedOpts;
        if (armed) {
          disarmEmotionBreathing();
          startEmotionBreathing(armed);
        }
      } catch {
        // ignore
      }
    };

    if (originRect) {
      const state = getEmotionRingsStateFromSvg();
      const ringEl = state && state.rings ? state.rings[_emotionRingFocusIndex] : null;
      const destRect = ringEl && typeof ringEl.getBoundingClientRect === "function"
        ? ringEl.getBoundingClientRect()
        : null;
      const reveal = () => {
        try {
          if (ringEl && ringEl.style) ringEl.style.opacity = "1";
        } catch {
          // ignore
        }
        startPlaybackNow();
      };
      if (destRect && destRect.width > 0 && destRect.height > 0) {
        const overlay = createEmotionRingFlyOverlay(originRect, {
          color: _emotionSoloOriginColor,
          strokeWidth: _emotionSoloOriginStrokeWidthPx,
          pathD: _emotionSoloOriginPathD,
          viewBox: _emotionSoloOriginViewBox,
        });
        if (overlay) {
          flyEmotionRingOverlayTo(overlay, destRect, EMOTION_SOLO_FLY_MS).then(() => {
            reveal();
            removeEmotionRingFlyOverlay(overlay);
          });
        } else {
          reveal();
        }
      } else {
        reveal();
      }
    } else {
      startPlaybackNow();
    }
  } catch {
    // ignore
  }
}

function applyPendingEmotionSoloRingSnapshot(idx) {
  const snap = pendingEmotionSoloRingSnapshot;
  pendingEmotionSoloRingSnapshot = null;
  if (!snap || Math.floor(Number(snap.index)) !== Math.floor(Number(idx))) return;
  try {
    disarmEmotionBreathing();
    stopEmotionBreathing();
    const state = getEmotionRingsStateFromSvg();
    const rings = state && Array.isArray(state.rings) ? state.rings : [];
    const ring = rings[Math.max(0, Math.floor(Number(idx) || 0))];
    if (!ring || !snap.d) return;
    ring.setAttribute("d", snap.d);
    ring.setAttribute("stroke", snap.stroke || "#111827");
    if (snap.strokeWidth) ring.setAttribute("stroke-width", snap.strokeWidth);
    ring.setAttribute("vector-effect", "non-scaling-stroke");
    if (snap.homeLabel) ring.setAttribute("data-home-label", snap.homeLabel);
    const title = ring.querySelector ? ring.querySelector("title") : null;
    if (title && snap.homeLabel) title.textContent = snap.homeLabel;
    const hit = ring.__lpHitPath;
    if (hit && hit.setAttribute) {
      hit.setAttribute("d", snap.d);
      hit.setAttribute("vector-effect", "non-scaling-stroke");
      if (snap.homeLabel) hit.setAttribute("data-home-label", snap.homeLabel);
      const sw = Math.max(Number(snap.strokeWidth) || 1, 1);
      hit.setAttribute("stroke-width", String(Math.max(12, sw + 10)));
    }
  } catch {
    // ignore
  }
}

// Set while the user is editing homes after having already finished (via the
// "edit" top-action button). Forces isStep1DataEntryFinished() to report
// "not finished" so ring/address hover-to-edit behaves exactly like it did
// before finishing, even though every home is already saved.
let step1EditModeAfterFinishActive = false;

function isStep1DataEntryFinished() {
  if (step1EditModeAfterFinishActive) return false;
  if (step1SummaryPhaseActive) return true;
  try {
    if (elPageStep1 && elPageStep1.classList.contains("step1-summary-phase")) return true;
    const total = parseInt(String(elHomesCount?.value || ""), 10) || 0;
    const saved = Array.isArray(addresses) ? addresses.filter((a) => a && a.valid !== false).length : 0;
    return total > 0 && saved >= total;
  } catch {
    return false;
  }
}

function areStep1MapSpecificInteractionsDisabled() {
  return isStep1DataEntryFinished();
}

function hideEmotionRingSoloTextOverlays() {
  try { hideEmotionRingReading(); } catch { /* ignore */ }
  try { hideEmotionRingHomeNo(); } catch { /* ignore */ }
  try { hideEmotionRingAddress(); } catch { /* ignore */ }
  try { hideEmotionRingAttachment(); } catch { /* ignore */ }
  try { hideEmotionRingTemporal(); } catch { /* ignore */ }
  try { hideEmotionRingMovement(); } catch { /* ignore */ }
  try { hideEmotionRingEmotionalConnection(); } catch { /* ignore */ }
  try { hideEmotionRingBelongingShift(); } catch { /* ignore */ }
  try { hideEmotionRingDurationOfPresence(); } catch { /* ignore */ }
  try { hideEmotionRingTimeframe(); } catch { /* ignore */ }
  try { hideEmotionRingLifeStage(); } catch { /* ignore */ }
  try { hideEmotionRingLifetimePresentage(); } catch { /* ignore */ }
  try { hideEmotionRingTransitionalDistance(); } catch { /* ignore */ }
  try { hideEmotionRingCumulativeDistance(); } catch { /* ignore */ }
}

// ----------------------------------------------------------------------------
// Emotion sound state. One persistent set of per-ring loop players, created
// once whenever Step 1's rings are (re)built (see startEmotionSound(), called
// from renderStep1EmotionMap()). Every other page — the fullscreen mirror, the
// solo ring page — never creates or restarts audio; they only ever call
// setEmotionSoundFocus() to change which of these players is audible. That's
// what makes switching instant: there's nothing to (re)build, just a volume
// recompute.
// ----------------------------------------------------------------------------

/** @type {{ audio: any, homeNum: number, rate: number, baseVolume: number }[] | null} */
let _emotionSoundRings = null;
// null = whole map audible; a number = only that ring index is audible.
let _emotionSoundFocusIndex = null;
// Per-ring smoothed breathing volume multiplier, parallel to _emotionSoundRings.
let _emotionSoundBreathMult = null;

function stopEmotionSound() {
  stopEmotionTickSounds();
  const rings = _emotionSoundRings;
  if (rings) {
    for (const r of rings) {
      try {
        r.audio.pause();
      } catch {
        // ignore
      }
      try {
        if ("currentTime" in r.audio) r.audio.currentTime = 0;
      } catch {
        // ignore
      }
    }
  }
  _emotionSoundRings = null;
  _emotionSoundFocusIndex = null;
  _emotionSoundBreathMult = null;
}

// Map-level loudness: louder overall when the map's average belonging is
// higher, quieter when it's lower — independent of any single ring's own
// volume, which is normalized separately by 1/sqrt(ringCount).
function computeEmotionMapVolume(rates) {
  const cfg = EMOTION_SOUND_CONFIG;
  const n = Array.isArray(rates) ? rates.length : 0;
  if (!n) return cfg.baseVolume;

  const avg = rates.reduce((sum, r) => sum + Math.max(1, Math.min(10, Math.round(Number(r) || 5))), 0) / n;
  const pivot = cfg.loudnessByAvgBelonging.pivot;
  const t = clamp(
    avg > pivot ? (avg - pivot) / (10 - pivot) : -((pivot - avg) / (pivot - 1)),
    -1,
    1
  );
  const mult = t >= 0
    ? 1 + (cfg.loudnessByAvgBelonging.highMult - 1) * t
    : 1 + (cfg.loudnessByAvgBelonging.lowMult - 1) * (-t);
  return clamp(cfg.baseVolume * mult, 0, 1);
}

function createEmotionLoopAudio(src, initialVolume) {
  const buf = _emotionLoopBuffers && _emotionLoopBuffers[String(src)];
  const audio = buf
    ? createEmotionWebAudioLoopPlayer({
        src,
        buffer: buf,
        startOffsetSec: Math.random() * Math.max(0, (Number(buf.duration) || 1) - 0.1),
        initialVolume,
      })
    : new Audio(src);
  if (!audio) return null;

  if (audio instanceof HTMLAudioElement) {
    audio.preload = "auto";
    audio.loop = true;
    audio.volume = initialVolume;
    // Desync loops slightly so they don't feel phase-locked.
    audio.addEventListener("loadedmetadata", () => {
      try {
        const d = Number(audio.duration);
        if (Number.isFinite(d) && d > 0.25) audio.currentTime = Math.random() * Math.min(d - 0.05, d);
      } catch {
        // ignore
      }
    }, { once: true });
  }
  try {
    void audio.play().catch(() => {});
  } catch {
    // ignore
  }
  return audio;
}

// options: { rates, ringHomeNums, phis }, one entry per ring, in ring-index order.
function startEmotionSound(options) {
  stopEmotionSound(); // fresh session whenever the map's rings are (re)built
  if (!EMOTION_SOUND_ENABLED) return;

  const rates = Array.isArray(options && options.rates) ? options.rates : [];
  const ringHomeNums = Array.isArray(options && options.ringHomeNums) ? options.ringHomeNums : [];
  const n = Math.max(rates.length, ringHomeNums.length);
  if (n <= 0) return;

  const innerCount = Math.max(1, Math.ceil(n * EMOTION_SOUND_CONFIG.innerFraction));
  const mapVolume = computeEmotionMapVolume(rates);
  const perRingVolume = clamp(mapVolume / Math.sqrt(n), 0, 1);

  void primeMp3NewManifest({ force: false });
  const srcByIndex = computeEmotionLoopSrcAssignmentsForMap({
    n, rates, ringHomeNums, innerCount, seedFloats: options && options.phis,
  });
  try {
    const srcs = new Set();
    for (const src of srcByIndex) if (src) srcs.add(String(src));
    for (const src of srcs) void ensureEmotionLoopBuffer(src).catch(() => null);
  } catch {
    // ignore
  }

  const rings = [];
  for (let i = 0; i < n; i++) {
    const src = srcByIndex[i];
    if (!src) continue;
    const homeNum = Math.max(1, Math.round(Number(ringHomeNums[i]) || (i + 1)));
    const rate = Math.max(1, Math.min(10, Math.round(Number(rates[i]) || 5)));
    const audio = createEmotionLoopAudio(src, perRingVolume);
    if (!audio) continue;
    rings.push({ audio, homeNum, rate, baseVolume: perRingVolume });
  }

  _emotionSoundRings = rings;
  _emotionSoundFocusIndex = null;
  _emotionSoundBreathMult = new Array(rings.length).fill(1);
  applyEmotionSoundVolumes();
}

// index: null to un-focus (whole map audible again), or a ring index to make
// only that ring audible. Always instant — no fades.
function setEmotionSoundFocus(index) {
  if (!_emotionSoundRings) return;
  _emotionSoundFocusIndex = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : null;
  applyEmotionSoundVolumes();
}

// Sets each ring's .volume only (no play/pause, no tick rescheduling) — cheap
// enough to call every breathing animation frame.
function applyEmotionSoundVolumesOnly() {
  const rings = _emotionSoundRings;
  if (!rings) return;
  const focusIdx = _emotionSoundFocusIndex;
  const soloCfg = EMOTION_SOUND_CONFIG.solo;
  rings.forEach((r, i) => {
    const duck = clamp(Number(_emotionSoundBreathMult && _emotionSoundBreathMult[i]) || 1, 0, 3);
    let v;
    if (focusIdx == null) {
      v = r.baseVolume * duck;
    } else if (i === focusIdx) {
      v = (soloCfg.useOriginalVolume ? 1 : r.baseVolume * soloCfg.boostMult) * duck;
    } else {
      v = 0;
    }
    try {
      r.audio.volume = clamp(v, 0, 1);
    } catch {
      // ignore
    }
  });
}

// Full apply: volumes + play/pause each ring according to the result, and
// reschedule ticks for whatever's now audible. Call on state changes (start,
// focus change) — not every animation frame, see applyEmotionSoundVolumesOnly().
function applyEmotionSoundVolumes() {
  const rings = _emotionSoundRings;
  if (!rings) return;
  applyEmotionSoundVolumesOnly();
  for (const r of rings) {
    try {
      if (r.audio.volume > 0.0005) void r.audio.play().catch(() => {});
      else r.audio.pause();
    } catch {
      // ignore
    }
  }
  scheduleEmotionTicksForCurrentSoundState();
}

// Called once per ring per breathing frame with signed in [-1, 1] (negative =
// shrunk in, positive = pushed out) and this frame's smoothing alpha.
function updateEmotionSoundBreathDuckMult(index, signed, alpha) {
  const mults = _emotionSoundBreathMult;
  if (!mults || index < 0 || index >= mults.length) return;
  const cfg = EMOTION_SOUND_CONFIG.breathDuck;
  const desired = signed < 0
    ? 1 + (cfg.shrinkMinMult - 1) * (-signed)
    : 1 + (cfg.expandMaxMult - 1) * signed;
  const cur = Number(mults[index]) || 1;
  mults[index] = cur + (desired - cur) * alpha;
}

function scheduleEmotionTicksForCurrentSoundState() {
  const rings = _emotionSoundRings;
  if (!rings || !rings.length) {
    stopEmotionTickSounds();
    return;
  }
  const focusIdx = _emotionSoundFocusIndex;
  if (focusIdx == null) {
    scheduleEmotionTickSoundsForRings({
      n: rings.length,
      rates: rings.map((r) => r.rate),
      getRingVolume: (i) => {
        try {
          return Number(rings[i].audio.volume) || 0;
        } catch {
          return 0;
        }
      },
    });
    return;
  }
  const focused = rings[focusIdx];
  if (!focused) {
    stopEmotionTickSounds();
    return;
  }
  scheduleEmotionTickSoundsForRings({
    n: 1,
    rates: [focused.rate],
    getRingVolume: () => {
      try {
        return Number(focused.audio.volume) || 0;
      } catch {
        return 0;
      }
    },
  });
}

let _emotionSoundGestureFallbackArmed = false;

// Browsers can block audio.play() until the page has a real user gesture.
// startEmotionSound() always tries immediately regardless of what triggered
// it, so as a safety net this retries on the very next click/tap anywhere on
// the page (not just on the emotion map itself).
function armEmotionSoundGestureFallback() {
  if (_emotionSoundGestureFallbackArmed) return;
  _emotionSoundGestureFallbackArmed = true;
  document.addEventListener("pointerdown", () => {
    try {
      ensureEmotionAudioReady();
    } catch {
      // ignore
    }
    const rings = _emotionSoundRings;
    if (!rings) return;
    for (const r of rings) {
      try {
        if (r.audio.volume > 0.0005) void r.audio.play().catch(() => {});
      } catch {
        // ignore
      }
    }
  }, { passive: true });
}

armEmotionSoundGestureFallback();

function stopEmotionTickSounds() {
  const tids = Array.isArray(_emotionTickTimeouts) ? _emotionTickTimeouts : [];
  for (const id of tids) {
    try {
      clearTimeout(id);
    } catch {
      // ignore
    }
  }
  _emotionTickTimeouts = null;
}

function ensureEmotionTickContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    if (!_emotionTickCtx) _emotionTickCtx = new AC();
    if (_emotionTickCtx && _emotionTickCtx.state === "suspended") {
      void _emotionTickCtx.resume().catch(() => {});
    }
  } catch {
    return null;
  }
  return _emotionTickCtx;
}

function ensureEmotionAudioReady() {
  const ctx = ensureEmotionTickContext();
  try {
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
  } catch {
    // ignore
  }
  return ctx;
}

function ensureEmotionLoopBuffersState() {
  if (!_emotionLoopBuffers) _emotionLoopBuffers = Object.create(null);
  if (!_emotionLoopBufferPromises) _emotionLoopBufferPromises = Object.create(null);
}

function ensureEmotionLoopBuffer(src) {
  const key = String(src || "");
  if (!key) return Promise.resolve(null);

  ensureEmotionLoopBuffersState();
  const existing = _emotionLoopBuffers[key];
  if (existing) return Promise.resolve(existing);
  const inflight = _emotionLoopBufferPromises[key];
  if (inflight) return inflight;

  const ctx = ensureEmotionTickContext();
  if (!ctx) return Promise.resolve(null);

  const p = fetch(key)
    .then((resp) => (resp && resp.ok ? resp.arrayBuffer() : null))
    .then((ab) => {
      if (!ab) return null;
      return new Promise((resolve) => {
        try {
          const maybe = ctx.decodeAudioData(
            ab,
            (buf) => resolve(buf),
            () => resolve(null)
          );
          if (maybe && typeof maybe.then === "function") {
            maybe.then(resolve).catch(() => resolve(null));
          }
        } catch {
          resolve(null);
        }
      });
    })
    .then((buf) => {
      if (buf) _emotionLoopBuffers[key] = buf;
      return buf;
    })
    .catch(() => null)
    .finally(() => {
      try {
        delete _emotionLoopBufferPromises[key];
      } catch {
        // ignore
      }
    });

  _emotionLoopBufferPromises[key] = p;
  return p;
}

function createEmotionWebAudioLoopPlayer({ src, buffer, startOffsetSec, initialVolume }) {
  const ctx = ensureEmotionTickContext();
  if (!ctx || !buffer) return null;

  let nodeSource = null;
  let nodeGain = null;
  let started = false;
  let vol = clamp(Number(initialVolume) || 0, 0, 1);
  let startOffset = Math.max(0, Number(startOffsetSec) || 0);

  /** @type {any} */
  const player = {
    __lpKind: "webaudio-loop",
    __lpEmotionSrc: String(src || ""),
    play: () => {
      try {
        if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      } catch {
        // ignore
      }
      if (started) return Promise.resolve();
      started = true;
      try {
        nodeGain = ctx.createGain();
        nodeGain.gain.setValueAtTime(vol, ctx.currentTime);
        nodeSource = ctx.createBufferSource();
        nodeSource.buffer = buffer;
        nodeSource.loop = true;
        nodeSource.connect(nodeGain);
        nodeGain.connect(ctx.destination);

        const dur = Math.max(0, Number(buffer.duration) || 0);
        const off = dur > 0 ? (startOffset % dur) : 0;
        startOffset = 0;
        nodeSource.start(0, off);
      } catch {
        started = false;
        try {
          if (nodeSource) nodeSource.disconnect();
        } catch {
          // ignore
        }
        try {
          if (nodeGain) nodeGain.disconnect();
        } catch {
          // ignore
        }
        nodeSource = null;
        nodeGain = null;
      }
      return Promise.resolve();
    },
    pause: () => {
      started = false;
      try {
        if (nodeSource) nodeSource.stop(0);
      } catch {
        // ignore
      }
      try {
        if (nodeSource) nodeSource.disconnect();
      } catch {
        // ignore
      }
      try {
        if (nodeGain) nodeGain.disconnect();
      } catch {
        // ignore
      }
      nodeSource = null;
      nodeGain = null;
    },
  };

  Object.defineProperty(player, "volume", {
    get() {
      return vol;
    },
    set(v) {
      vol = clamp(Number(v) || 0, 0, 1);
      try {
        if (nodeGain) nodeGain.gain.setValueAtTime(vol, ctx.currentTime);
      } catch {
        // ignore
      }
    },
    enumerable: true,
  });

  return player;
}

function ensureEmotionTickBuffersState() {
  if (!_emotionTickBuffers) _emotionTickBuffers = Object.create(null);
  if (!_emotionTickBufferPromises) _emotionTickBufferPromises = Object.create(null);
}

function ensureTickBuffer(rate) {
  ensureEmotionTickBuffersState();
  const r = Math.max(1, Math.min(4, Math.round(Number(rate) || 1)));
  const existing = _emotionTickBuffers[r];
  if (existing) return Promise.resolve(existing);
  const inflight = _emotionTickBufferPromises[r];
  if (inflight) return inflight;

  const ctx = ensureEmotionTickContext();
  if (!ctx) return Promise.resolve(null);

  const src = tickSrcByRate(r, r);
  if (!src) return Promise.resolve(null);

  const p = fetch(src)
    .then((resp) => (resp && resp.ok ? resp.arrayBuffer() : null))
    .then((ab) => {
      if (!ab) return null;
      return new Promise((resolve) => {
        try {
          const maybe = ctx.decodeAudioData(
            ab,
            (buf) => resolve(buf),
            () => resolve(null)
          );
          if (maybe && typeof maybe.then === "function") {
            maybe.then(resolve).catch(() => resolve(null));
          }
        } catch {
          resolve(null);
        }
      });
    })
    .then((buf) => {
      if (buf) _emotionTickBuffers[r] = buf;
      return buf;
    })
    .catch(() => null)
    .finally(() => {
      try {
        delete _emotionTickBufferPromises[r];
      } catch {
        // ignore
      }
    });

  _emotionTickBufferPromises[r] = p;
  return p;
}

function playTick(rate, volume) {
  const ctx = ensureEmotionTickContext();
  if (!ctx) return;

  const r = Math.max(1, Math.min(4, Math.round(Number(rate) || 1)));
  const v = clamp(Number(volume) || 0, 0, 1);
  const buf = _emotionTickBuffers && _emotionTickBuffers[r];
  if (buf) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = v;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start();
      return;
    } catch {
      // fall through
    }
  }

  // Fallback: HTMLAudioElement.
  try {
    const a = new Audio(tickSrcByRate(r, r));
    a.preload = "auto";
    a.loop = false;
    a.volume = v;
    void a.play().catch(() => {});
  } catch {
    // ignore
  }
}

// Shared by both occurrence systems (entry-phase and ambient) — each caller
// is responsible for its own enabled-check before calling this; see
// restartStep1EmotionTickSounds() (EMOTION_ENTRY_SOUND_ENABLED) and
// scheduleEmotionTicksForCurrentSoundState() (only ever has rings to pass
// when the ambient system itself is on).
function scheduleEmotionTickSoundsForRings({ n, rates, getRingVolume }) {
  stopEmotionTickSounds();
  const tickCfg = EMOTION_SOUND_CONFIG.tick;
  if (!tickCfg.enabled) return;

  const baseMult = clamp(Number(tickCfg.volumeMult) || 0.7, 0, 2);
  const meanTable = tickCfg.meanIntervalMsByRate;
  const jMin = clamp(Number(tickCfg.jitterMinMult) || 0.55, 0.05, 5);
  const jMax = clamp(Number(tickCfg.jitterMaxMult) || 1.55, jMin, 8);
  const firstCap = Math.max(80, Number(tickCfg.firstEventMaxDelayMs) || 1400);

  _emotionTickTimeouts = [];

  const meanMsForRate = (rate) => {
    const r = Math.max(1, Math.min(4, Math.round(Number(rate) || 1)));
    const m = Number(meanTable[r]);
    if (Number.isFinite(m) && m > 80) return m;
    return 2600 + (r - 1) * 900;
  };

  const nextDelayMs = (meanMs) => {
    const mean = Math.max(120, Number(meanMs) || 400);
    const u = Math.random();
    const mult = jMin + (jMax - jMin) * u;
    return clamp(mean * mult, mean * 0.35, mean * 2.5);
  };

  for (let i = 0; i < n; i++) {
    const rate = Number(rates[i]) || 0;
    const r = Math.round(rate);
    if (!(r >= 1 && r <= 4)) continue;

    try {
      void ensureTickBuffer(r);
    } catch {
      // ignore
    }

    const mean = meanMsForRate(r);
    const tickOnce = () => {
      if (!Array.isArray(_emotionTickTimeouts)) return;
      const ringVol = typeof getRingVolume === "function" ? clamp(Number(getRingVolume(i)) || 0, 0, 1) : 0.5;
      const v = clamp(ringVol * baseMult, 0, 1);
      if (v > 0.001) playTick(r, v);
      const id = setTimeout(tickOnce, nextDelayMs(mean));
      _emotionTickTimeouts.push(id);
    };

    const first = Math.min(nextDelayMs(mean), firstCap);
    const id0 = setTimeout(tickOnce, first);
    _emotionTickTimeouts.push(id0);
  }
}

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

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000);
  let res;
  try {
    res = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: {
        "Accept": "application/json",
        "Accept-Language": "en",
      },
    });
  } finally {
    clearTimeout(tid);
  }

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

function formatAverageBelongingForAddresses(items) {
  const list = Array.isArray(items) ? items : [];
  let sum = 0;
  let count = 0;
  for (const item of list) {
    if (!item || item.valid === false || !isFinite(item.lat) || !isFinite(item.lon)) continue;
    sum += normalizeBelongingRate(item.belonging_rate, stableBelongingRateFromId(item.id));
    count += 1;
  }
  if (count <= 0) return "";
  const average = sum / count;
  return Number.isInteger(average) ? String(average) : average.toFixed(1);
}

function formatCumulativeDistanceForAddresses(items) {
  const list = Array.isArray(items) ? items.filter((item) => item && item.valid !== false) : [];
  if (list.length <= 1) return "--";
  try {
    let sumMeters = 0;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      const lat0 = Number(prev.lat);
      const lon0 = Number(prev.lon);
      const lat1 = Number(cur.lat);
      const lon1 = Number(cur.lon);
      if (!(Number.isFinite(lat0) && Number.isFinite(lon0) && Number.isFinite(lat1) && Number.isFinite(lon1))) return "--";
      const toRad = (deg) => (Number(deg) * Math.PI) / 180;
      const earthRadiusMeters = 6371000;
      const dLat = toRad(lat1 - lat0);
      const dLon = toRad(lon1 - lon0);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat0)) * Math.cos(toRad(lat1)) * Math.sin(dLon / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const meters = earthRadiusMeters * c;
      if (!Number.isFinite(meters)) return "--";
      sumMeters += meters;
    }
    const km = sumMeters / 1000;
    return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
  } catch {
    return "--";
  }
}

// Keeps the country/city exactly as the person typed it during address
// entry -- same language, same spelling, no transliteration/title-casing.
// Prefers _origCountry/_origCity (the pre-geocoding raw input) over
// country/city, since verification overwrites the latter with the
// normalized/English form -- same fallback formatAddressAsTyped() uses.
function formatRawCountriesForAddresses(items) {
  const list = Array.isArray(items) ? items : [];
  const countries = [];
  for (const item of list) {
    if (!item || item.valid === false) continue;
    const country = tidyToken(item._origCountry || item.country || "");
    if (!country) continue;
    if (countries[countries.length - 1] !== country) countries.push(country);
  }
  return countries.length ? countries.join(", ") : "--";
}

function formatRawCitiesForAddresses(items) {
  const list = Array.isArray(items) ? items : [];
  const cities = [];
  for (const item of list) {
    if (!item || item.valid === false) continue;
    const city = tidyToken(item._origCity || item.city || "");
    if (!city) continue;
    if (cities[cities.length - 1] !== city) cities.push(city);
  }
  return cities.length ? cities.join(", ") : "--";
}

function confirmArchiveMapRemoval(snapshot) {
  const existing = document.querySelector(".archiveConfirmOverlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "archiveConfirmOverlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const dialog = document.createElement("div");
  dialog.className = "archiveConfirmDialog";

  const message = document.createElement("div");
  message.className = "archiveConfirmMessage";
  message.textContent = "Are you sure you want to remove this map?";

  const actions = document.createElement("div");
  actions.className = "archiveConfirmActions";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "archiveConfirmBtn archiveConfirmRemoveBtn";
  removeBtn.textContent = "remove";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "archiveConfirmBtn archiveConfirmCancelBtn";
  cancelBtn.textContent = "cancel";

  const close = () => overlay.remove();
  cancelBtn.addEventListener("click", close);
  removeBtn.addEventListener("click", () => {
    deleteSavedMapSnapshot(getSavedMapKey(snapshot) || snapshot?.label);
    close();
    renderArchiveGrid();
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });

  actions.append(removeBtn, cancelBtn);
  dialog.append(message, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  cancelBtn.focus();
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

function belongingCircleStrokeWeight(rate) {
  // Slightly thinner at 1, slightly thicker at 10, with more contrast between them.
  // Leaflet accepts fractional stroke weights.
  // Accept continuous values (not just integers) for smooth slider transitions.
  const r = Math.max(1, Math.min(10, parseFloat(rate) || 5));
  const t = (r - 1) / 9; // 0..1

  // Tune these three values to taste.
  const minW = 0.8; // level 1
  const maxW = 7.1; // level 10
  const gamma = 1.4; // >1 increases contrast towards the high end

  const shaped = Math.pow(Math.max(0, Math.min(1, t)), gamma);
  const w = minW + (maxW - minW) * shaped;
  return Math.max(0.1, Math.min(10, w));
}

// Every address-marker circle (geo map, journey timeline) shares this one
// fixed inner radius -- belonging rate only ever changes the outline's
// stroke width, and that stroke grows outward only (the circle's own
// radius is bumped up by half the stroke so the *inner* edge stays put at
// ADDRESS_DOT_INNER_RADIUS regardless of rate). Address-entry page only --
// Step 2's own dots (renderStep2AddressDots()) use their own local radius.
const ADDRESS_DOT_INNER_RADIUS = 4.5;
function addressDotRadius(rate) {
  return ADDRESS_DOT_INNER_RADIUS + belongingCircleStrokeWeight(rate) / 2;
}

// Leaflet's geo-map SVG is rendered through a different transform than the
// movement-map SVG, so matching raw radius values makes the movement-map
// dots visibly larger. Scale the route-preview objects to match the black map
// on screen while preserving the same rate-to-size relation.
const ROUTE_PREVIEW_OBJECT_SCALE = 0.68;
const ROUTE_PREVIEW_DOT_INNER_RADIUS = ADDRESS_DOT_INNER_RADIUS * ROUTE_PREVIEW_OBJECT_SCALE;
function routePreviewStrokeWeight(rate) {
  return belongingCircleStrokeWeight(rate) * ROUTE_PREVIEW_OBJECT_SCALE;
}
function routePreviewDotRadius(rate) {
  return ROUTE_PREVIEW_DOT_INNER_RADIUS + routePreviewStrokeWeight(rate) / 2;
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

function formatAddressAsTyped(addr) {
  if (!addr) return "";
  const streetPart = tidyToken(addr._origStreetAndNumber)
    || tidyToken([addr._origStreet || addr.street, addr._origNumber || addr.number].filter(Boolean).join(" "));
  const city = tidyToken(addr._origCity || addr.city);
  const country = tidyToken(addr._origCountry || addr.country);
  return [streetPart, city, country].filter(Boolean).join(", ");
}

// For interpolating user-typed text into an HTML string (e.g. a Leaflet
// tooltip built via bindTooltip(htmlString)) instead of DOM textContent.
function escapeHtmlText(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatAddressForHoverLabel(text) {
  const s = String(text || "").trim();
  if (!s) return "";

  // Requested style: lowercase text with uppercase initials for words.
  const lower = s.toLowerCase();
  return lower.replace(/\b([a-z])/g, (m, ch) => ch.toUpperCase());
}

/** @type {boolean} */
let currentAddressVerified = false;

/** @type {boolean} */
let belongingLabelShown = false;

const elForm = document.getElementById("addressForm");
const elList = document.getElementById("addressList");
const elStep1GeoMap = document.getElementById("step1GeoMap");
const elStep1GeoMapName = document.getElementById("step1GeoMapName");
const elStep1EmotionSvg = document.getElementById("step1EmotionSvg");
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
const elCoordinateLabel = document.getElementById("coordinateLabel");
const elStep2ReadingInfoName = document.getElementById("step2ReadingInfoName");
const elStep2ReadingInfoCount = document.getElementById("step2ReadingInfoCount");
const elStep2ReadingInfoAge = document.getElementById("step2ReadingInfoAge");
const elStep2ReadingInfoAvg = document.getElementById("step2ReadingInfoAvg");
const elStep2ReadingInfoCountries = document.getElementById("step2ReadingInfoCountries");
const elStep2ReadingInfoCities = document.getElementById("step2ReadingInfoCities");
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
  if (addToListMsgTimeoutId) window.clearTimeout(addToListMsgTimeoutId);
  addToListMsgTimeoutId = 0;
  if (!elAddToListMsg) return;
  elAddToListMsg.classList.add("hidden");
  elAddToListMsg.textContent = "";
}

const SAVED_MAPS_KEY = "lifepath.savedMaps.v1";
const ALLMAPS_HIDDEN_KEY = "lifepath.allMaps.hidden.v1";

// Archive numbering: lifemap01, lifemap02, ... in save order.
const SAVED_MAP_SERIAL_KEY = "lifepath.savedMaps.serial.v1";

// Server-backed state (source of truth). We keep a local in-memory cache so
// existing synchronous code paths don't need to become async.
let serverStateLoaded = false;
/** @type {any[]} */
let savedMapsCache = null;
/** @type {number|null} */
let savedMapsSerialCache = null;
/** @type {string[]|null} */
let allMapsHiddenCache = null;

let persistServerStateTimer = 0;

function readLocalStorageSavedMaps() {
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

function readLocalStorageSavedMapsSerial() {
  try {
    const raw = localStorage.getItem(SAVED_MAP_SERIAL_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

function readLocalStorageAllMapsHidden() {
  const raw = localStorage.getItem(ALLMAPS_HIDDEN_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x || "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function applyServerState(state) {
  const s = state && typeof state === "object" ? state : {};

  if (Array.isArray(s.savedMaps)) {
    // Normalize and keep in cache.
    savedMapsCache = ensureSavedMapsHaveSerials(s.savedMaps);
  }

  if (typeof s.savedMapsSerial !== "undefined") {
    const n = Number(s.savedMapsSerial);
    savedMapsSerialCache = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  if (Array.isArray(s.allMapsHidden)) {
    allMapsHiddenCache = s.allMapsHidden.map((x) => String(x || "")).filter(Boolean);
  }
}

async function fetchServerState() {
  const res = await fetch("/api/state", { cache: "no-store" });
  if (!res.ok) return null;
  const json = await res.json();
  if (!json || typeof json !== "object" || !json.ok) return null;
  return json.state && typeof json.state === "object" ? json.state : null;
}

async function fetchServerMaps() {
  const res = await fetch("/api/maps", { cache: "no-store" });
  if (!res.ok) return null;
  const json = await res.json();
  if (!json || typeof json !== "object" || !json.ok) return null;
  return Array.isArray(json.maps) ? json.maps : [];
}

async function refreshServerMapsCache() {
  try {
    const dbMaps = await fetchServerMaps();
    if (!Array.isArray(dbMaps)) return false;
    savedMapsCache = ensureSavedMapsHaveSerials(dbMaps);
    savedMapsSerialCache = inferMaxSavedMapSerialFromList(savedMapsCache);
    refreshSavedMapsUis();
    return true;
  } catch {
    return false;
  }
}

async function postServerState(partialState) {
  const payload = partialState && typeof partialState === "object" ? partialState : {};
  const res = await fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (!json || typeof json !== "object" || !json.ok) return null;
  return json.state && typeof json.state === "object" ? json.state : null;
}

function schedulePersistServerState() {
  if (persistServerStateTimer) return;
  persistServerStateTimer = window.setTimeout(async () => {
    persistServerStateTimer = 0;
    try {
      const next = {
        savedMaps: Array.isArray(savedMapsCache) ? savedMapsCache : [],
        savedMapsSerial: Number.isFinite(Number(savedMapsSerialCache)) ? Number(savedMapsSerialCache) : 0,
        allMapsHidden: Array.isArray(allMapsHiddenCache) ? allMapsHiddenCache : [],
        basemapStyleId: String(basemapStyleId || "").trim(),
      };
      const state = await postServerState(next);
      if (state) applyServerState(state);
    } catch {
      // ignore (offline / server not reachable)
    }
  }, 250);
}

function refreshSavedMapsUis() {
  try {
    renderArchiveGrid();
  } catch {
    // ignore
  }
  try {
    renderAllMapsCombinedMap();
  } catch {
    // ignore
  }
}

async function bootstrapServerBackedState() {
  // Seed cache from localStorage so UI is usable even before server responds.
  if (savedMapsCache === null) savedMapsCache = readLocalStorageSavedMaps();
  if (savedMapsSerialCache === null) savedMapsSerialCache = readLocalStorageSavedMapsSerial();
  if (allMapsHiddenCache === null) allMapsHiddenCache = readLocalStorageAllMapsHidden();

  try {
    const state = await fetchServerState();
    const dbMaps = await fetchServerMaps();

    // One-time migration: if server has no saved maps but localStorage does, push local to server.
    const localMaps = readLocalStorageSavedMaps();
    const serverMaps = state && Array.isArray(state.savedMaps) ? state.savedMaps : [];
    const shouldMigrate = (!state || serverMaps.length === 0) && Array.isArray(localMaps) && localMaps.length > 0;

    if (shouldMigrate) {
      const localSerial = readLocalStorageSavedMapsSerial();
      const localHidden = readLocalStorageAllMapsHidden();

      const migrated = await postServerState({
        savedMaps: localMaps,
        savedMapsSerial: localSerial ?? inferMaxSavedMapSerialFromList(localMaps),
        allMapsHidden: localHidden,
        basemapStyleId: String(basemapStyleId || "").trim(),
      });

      if (migrated) applyServerState(migrated);
    } else if (state) {
      applyServerState(state);
    }

    // Source-of-truth for All Maps comes from DB-backed /api/maps.
    if (Array.isArray(dbMaps)) {
      savedMapsCache = ensureSavedMapsHaveSerials(dbMaps);
      savedMapsSerialCache = inferMaxSavedMapSerialFromList(savedMapsCache);
    }

    serverStateLoaded = true;
    refreshSavedMapsUis();

    // Once server is the source of truth, stop relying on localStorage for these keys.
    try {
      localStorage.removeItem(SAVED_MAPS_KEY);
      localStorage.removeItem(SAVED_MAP_SERIAL_KEY);
      localStorage.removeItem(ALLMAPS_HIDDEN_KEY);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

const BASEMAP_STYLE_KEY = "lifepath.basemapStyle.v1";

const BASEMAP_STYLES = [
  {
    id: "dark",
    label: "Dark (Dark Matter)",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    options: {
      maxZoom: 20,
      subdomains: "abcd",
      noWrap: true,
      detectRetina: false,
      attribution: "© OpenStreetMap contributors © CARTO",
    },
  },
  {
    id: "toner-lite",
    label: "Toner Lines + Labels",
    urls: [
      "https://tiles.stadiamaps.com/tiles/stamen_toner_lines/{z}/{x}/{y}{r}.png",
      "https://tiles.stadiamaps.com/tiles/stamen_toner_labels/{z}/{x}/{y}{r}.png",
    ],
    options: {
      maxZoom: 20,
      noWrap: true,
      detectRetina: false,
      attribution: '© <a href="https://stamen.com">Stamen</a> © <a href="https://openmaptiles.org">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
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

  // Multi-layer basemap (e.g. lines + labels).
  if (Array.isArray(style.urls) && style.urls.length > 0) {
    const group = L.layerGroup();
    for (const url of style.urls) {
      const tile = L.tileLayer(url, { ...(style.options || {}) });
      tile.on("tileerror", () => {
        showToast("Map tiles failed to load. Try another map style.");
      });
      group.addLayer(tile);
    }
    return group;
  }

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
  if (elStep1GeoMap) elStep1GeoMap.classList.toggle("basemap-bw", bw);

  const dark = isDarkBasemap(basemapStyleId);
  if (elMap) elMap.classList.toggle("basemap-dark", dark);
  if (elAllMapsMap) elAllMapsMap.classList.toggle("basemap-dark", dark);
  if (elStep1GeoMap) elStep1GeoMap.classList.toggle("basemap-dark", dark);

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
  return isDarkBasemap(basemapStyleId) ? "#f2f0e8" : "#000000";
}

function getStep2RouteDotFillStyle() {
  return {
    fillColor: "#f4f2ea",
    fillOpacity: geoLayerEnabled ? 0 : 1,
  };
}

// Tied to "show map" (allMapsTilesVisible) -- see restyleAllMapsOverlaysForBasemap()
// and the render loop in renderAllMapsCombinedMap() for how the
// highlighted/dimmed variants (getAllMapsHighlightColor()/
// getAllMapsDimmedRouteColor()) build on top of this.
function getAllMapsOverlayStrokeColor() {
  return allMapsTilesVisible ? "#f4f2eb" : "#000000";
}

function getAllMapsHighlightColor() {
  // While the map is showing, the selected/highlighted route just stays at
  // the same "shown" color as every other route -- only the *other*
  // (dimmed) routes get recolored, via getAllMapsDimmedRouteColor().
  return allMapsTilesVisible ? "#f4f2eb" : "#000000";
}

function getAllMapsDimmedRouteColor() {
  return allMapsTilesVisible ? "#77756d" : "#c8c7c1";
}

function getAllMapsRouteDotFillStyle() {
  if (allMapsTilesVisible) {
    return {
      fillColor: "transparent",
      fillOpacity: 0,
    };
  }
  return {
    fillColor: "#f4f2ea",
    fillOpacity: 1,
  };
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
        if (layer && typeof layer.setStyle === "function") layer.setStyle({ color, ...getStep2RouteDotFillStyle() });
      });
    }
  } catch {
    // ignore
  }
}

function restyleAllMapsOverlaysForBasemap() {
  if (!allMapsVectorLayer) return;
  const baseColor = getAllMapsOverlayStrokeColor();
  const highlightColor = getAllMapsHighlightColor();
  const dimmedColor = getAllMapsDimmedRouteColor();
  const someHighlighted = Boolean(allMapsHighlightedKey);
  try {
    allMapsVectorLayer.eachLayer((layer) => {
      if (!layer || typeof layer.setStyle !== "function") return;
      const key = String(layer?.options?.lifepathAllMapsKey || "");
      const isHighlighted = someHighlighted && Boolean(key) && key === allMapsHighlightedKey;
      const color = isHighlighted ? highlightColor : (someHighlighted ? dimmedColor : baseColor);
      layer.setStyle({ color, ...getAllMapsRouteDotFillStyle() });
    });
    // Bring highlighted layers to the top so they're never hidden by gray routes.
    if (someHighlighted) {
      allMapsVectorLayer.eachLayer((layer) => {
        if (!layer) return;
        const key = String(layer?.options?.lifepathAllMapsKey || "");
        if (key === allMapsHighlightedKey && typeof layer.bringToFront === "function") {
          layer.bringToFront();
        }
      });
    }
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

// Load server-backed archive state (and migrate from localStorage once).
bootstrapServerBackedState();

// Default: tiles hidden until user clicks "Show map".
let geoLayerEnabled = false;

/** @type {{id?:string,label?:string,savedAt?:string} | null} */
let currentEditingSnapshot = null;
let currentLoadedMapDisplayName = "";

function ensureSnapshotId(snapshot) {
  const existing = snapshot && typeof snapshot === "object" ? String(snapshot.id || "") : "";
  if (existing) return existing;
  const fallback = `snap_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return fallback;
}

function getAllMapsHiddenLabels() {
  if (Array.isArray(allMapsHiddenCache)) {
    return new Set(allMapsHiddenCache.map((x) => String(x || "")).filter(Boolean));
  }

  // Fallback before server state loads.
  return new Set(readLocalStorageAllMapsHidden());
}

function setAllMapsHiddenLabels(set) {
  const arr = Array.from(set || []).map((x) => String(x || "")).filter(Boolean);
  allMapsHiddenCache = arr;
  schedulePersistServerState();
}

function getSavedMaps() {
  if (Array.isArray(savedMapsCache)) {
    return ensureSavedMapsHaveSerials(savedMapsCache);
  }
  return readLocalStorageSavedMaps();
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
  savedMapsCache = Array.isArray(list) ? list : [];
  schedulePersistServerState();
}

function getSavedMapSerialCounter() {
  if (typeof savedMapsSerialCache === "number") return savedMapsSerialCache;
  return readLocalStorageSavedMapsSerial();
}

function setSavedMapSerialCounter(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  savedMapsSerialCache = v;
  schedulePersistServerState();
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

function formatArchiveMapNamePart(text) {
  return String(text || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      return lower ? lower.charAt(0).toUpperCase() + lower.slice(1) : "";
    })
    .join(" ");
}

function renderMapLabelLikeSignature(target, snapshot, fallbackLabel) {
  if (!target) return;
  const raw = String(fallbackLabel || snapshot?.label || "").trim();
  const match = raw.match(/^(.+)\.(\d+)addrs$/i);
  const name = formatStep2SignatureDisplayName(snapshot?.fullName || (match ? formatArchiveMapNamePart(match[1]) : ""));
  target.textContent = name || raw;
}

function normalizeNameForMapLabel(text) {
  return formatStep2SignatureDisplayName(text).replace(/\s+/g, "");
}

function getCurrentMapLabel() {
  const name = normalizeNameForMapLabel(elStudentName?.value || "");
  const count = formatAddrCount(addresses.length);
  if (!name) return "";
  return `${name}.${count}addrs`;
}

function buildCurrentMapSnapshotPayload(studentName, { serial = 0 } = {}) {
  const fullName = String(studentName || "").trim();
  const name = normalizeNameForMapLabel(fullName);
  const count = formatAddrCount(addresses.length);
  const label = name ? `${name}.${count}addrs` : "";
  const center = map && typeof map.getCenter === "function" ? map.getCenter() : null;
  const zoom = map && typeof map.getZoom === "function" ? map.getZoom() : 7;
  return {
    version: 1,
    id: cryptoId(),
    label,
    serial: Math.max(0, Math.floor(Number(serial) || 0)),
    fullName: fullName,
    count: addresses.length,
    savedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    view: {
      lat: isFinite(Number(center?.lat)) ? Number(center.lat) : 31.5,
      lng: isFinite(Number(center?.lng)) ? Number(center.lng) : 35.1,
      zoom: isFinite(Number(zoom)) ? Number(zoom) : 7,
    },
    geoLayerEnabled: Boolean(geoLayerEnabled),
    addresses: Array.isArray(addresses) ? JSON.parse(JSON.stringify(addresses)) : [],
  };
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
          emotionLayoutSnapshot: getStep1EmotionMapLayoutSnapshotForSave(),
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
    emotionLayoutSnapshot: getStep1EmotionMapLayoutSnapshotForSave(),
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

function getAddressesSignatureForList(list) {
  try {
    const parts = [];
    for (const a of Array.isArray(list) ? list : []) {
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

function getSavedMapKeyForCurrentMap() {
  const label = getCurrentMapLabel();
  if (!label) return "";

  const fullName = String(elStudentName?.value || "").trim();
  const addressSignature = getAddressesSignatureForList(addresses);
  const list = getSavedMaps();
  const matches = (Array.isArray(list) ? list : []).filter((snap) => {
    if (!snap || String(snap.label || "") !== label) return false;
    const sameName = !fullName || String(snap.fullName || "").trim() === fullName;
    if (!sameName) return false;
    if (!addressSignature) return true;
    return getAddressesSignatureForList(snap.addresses) === addressSignature;
  });

  const newest = matches.sort((a, b) => {
    const at = Date.parse(String(a?.updatedAt || a?.savedAt || ""));
    const bt = Date.parse(String(b?.updatedAt || b?.savedAt || ""));
    if (isFinite(at) && isFinite(bt)) return bt - at;
    if (isFinite(bt)) return 1;
    if (isFinite(at)) return -1;
    return 0;
  })[0];

  return getSavedMapKey(newest);
}

function prepareAllMapsFocusForCurrentMap() {
  const key = getSavedMapKeyForCurrentMap();
  allMapsHighlightedKey = key || null;
  allMapsPendingFocusKey = key || null;
  allMapsPendingRestoreView = null;
  allMapsViewBeforeHighlightFocus = null;
  setAllMapsListVisible(true);
  return Boolean(key);
}

// New flow (Welcome -> Step 1 -> Step 2)
const elPageWelcome = document.getElementById("pageWelcome");
const elPageAbout = document.getElementById("pageAbout");
const elPageStep1 = document.getElementById("pageStep1");
const elPageStep2 = document.getElementById("pageStep2");
const elPageEmotion = document.getElementById("pageEmotion");
const elPageStep1EmotionFullscreen = document.getElementById("pageStep1EmotionFullscreen");
const elPageAllMaps = document.getElementById("pageAllMaps");
const elPageArchive = document.getElementById("pageArchive");
const elArchiveBackBtn = document.getElementById("archiveBackBtn");
const elBackToWelcomeBtn = document.getElementById("backToWelcomeBtn");
const elCreateLifePathBtn = document.getElementById("createLifePathBtn");
const elBackToStep1Btn = document.getElementById("backToStep1Btn");
const elEmotionSoloBackBtn = document.getElementById("emotionSoloBackBtn");
const elEmotionSaveBtn = document.getElementById("emotionSaveBtn");
const elStudentName = document.getElementById("studentName");
const elHomeNumberTitle = document.getElementById("homeNumberTitle");
const elStep1TopProgressSummary = document.getElementById("step1TopProgressSummary");
const elStep1TopProgressCounter = document.getElementById("step1TopProgressCounter");
const elHomeSummary = document.getElementById("homeSummary");

const elEmotionTitle = document.getElementById("emotionTitle");

const elEmotionSvg = document.getElementById("emotionSvg");

let _emotionHomeTooltipEl = null;
let _emotionHomeTooltipCleanup = null;
let _emotionHoveredHomeLabel = "";

let _emotionRingReadingEl = null;
let _emotionRingHomeNoEl = null;
let _emotionRingAddressEl = null;
let _emotionRingAttachmentEl = null;
let _emotionRingTemporalEl = null;
let _emotionRingMovementEl = null;
let _emotionRingEmotionalConnectionEl = null;
let _emotionRingBelongingShiftEl = null;
let _emotionRingDurationOfPresenceEl = null;
let _emotionRingTimeframeEl = null;
let _emotionRingLifeStageEl = null;
let _emotionRingLifetimePresentageEl = null;
let _emotionRingTransitionalDistanceEl = null;
let _emotionRingCumulativeDistanceEl = null;

function ensureEmotionRingReadingEl() {
  if (_emotionRingReadingEl) return _emotionRingReadingEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingReading";
    el.className = "emotionRingReading hidden";
    el.textContent = "";
    document.body.appendChild(el);
    _emotionRingReadingEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingReading() {
  const el = _emotionRingReadingEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingReading(text, clientX, clientY, options) {
  const el = ensureEmotionRingReadingEl();
  if (!el) return;

  try {
    const reveal = !(options && options.reveal === false);
    // Avoid any visible "jump" due to measure+clamp: measure while hidden,
    // then reveal at the final clamped position.
    el.style.visibility = "hidden";
    el.textContent = String(text || "");
    el.classList.remove("hidden");

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    // Clamp within viewport after measuring.
    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const finalRect = el.getBoundingClientRect();

    if (!reveal) {
      // Keep it non-visible for measurement-only callers.
      el.classList.add("hidden");
    }

    el.style.visibility = "";
    return finalRect;
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingHomeNoEl() {
  if (_emotionRingHomeNoEl) return _emotionRingHomeNoEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingHomeNo";
    el.className = "emotionRingReading emotionRingHomeNo hidden";
    el.textContent = "";
    document.body.appendChild(el);
    _emotionRingHomeNoEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingHomeNo() {
  const el = _emotionRingHomeNoEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function ensureEmotionRingAddressEl() {
  if (_emotionRingAddressEl) return _emotionRingAddressEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingAddress";
    el.className = "emotionRingReading emotionRingAddress hidden";

    const label = document.createElement("span");
    label.className = "emotionRingAddressLabel";
    label.textContent = "address :\u00a0\u00a0\u00a0\u00a0\u00a0";

    const value = document.createElement("span");
    value.className = "emotionRingAddressValue";
    value.textContent = "";

    el.appendChild(label);
    el.appendChild(value);

    document.body.appendChild(el);
    _emotionRingAddressEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingAddress() {
  const el = _emotionRingAddressEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingAddress(addressValueText, clientX, clientY) {
  const el = ensureEmotionRingAddressEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.classList.remove("hidden");

    // Update value span textContent safely.
    try {
      const spans = el.querySelectorAll("span");
      for (const s of spans) {
        if (s && s.classList && s.classList.contains("emotionRingAddressValue")) {
          s.textContent = String(addressValueText || "");
        }
      }
    } catch {
      // ignore
    }

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function addressValueTextForAddress(addr) {
  try {
    if (!addr || typeof addr !== "object") return "";
    return formatAddressAsTyped(addr);
  } catch {
    return "";
  }
}

function showEmotionRingHomeNo(text, clientX, clientY) {
  const el = ensureEmotionRingHomeNoEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.textContent = String(text || "");
    el.classList.remove("hidden");

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingAttachmentEl() {
  if (_emotionRingAttachmentEl) return _emotionRingAttachmentEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingAttachment";
    el.className = "emotionRingReading emotionRingAttachment hidden";
    el.textContent = "";
    document.body.appendChild(el);
    _emotionRingAttachmentEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingAttachment() {
  const el = _emotionRingAttachmentEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingAttachment(text, clientX, clientY) {
  const el = ensureEmotionRingAttachmentEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.textContent = String(text || "");
    el.classList.remove("hidden");

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingTemporalEl() {
  if (_emotionRingTemporalEl) return _emotionRingTemporalEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingTemporal";
    el.className = "emotionRingReading emotionRingTemporal hidden";
    el.textContent = "";
    document.body.appendChild(el);
    _emotionRingTemporalEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingTemporal() {
  const el = _emotionRingTemporalEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingTemporal(text, clientX, clientY) {
  const el = ensureEmotionRingTemporalEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.textContent = String(text || "");
    el.classList.remove("hidden");

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingMovementEl() {
  if (_emotionRingMovementEl) return _emotionRingMovementEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingMovement";
    el.className = "emotionRingReading emotionRingMovement hidden";
    el.textContent = "";
    document.body.appendChild(el);
    _emotionRingMovementEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingMovement() {
  const el = _emotionRingMovementEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingMovement(text, clientX, clientY) {
  const el = ensureEmotionRingMovementEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.textContent = String(text || "");
    el.classList.remove("hidden");

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingEmotionalConnectionEl() {
  if (_emotionRingEmotionalConnectionEl) return _emotionRingEmotionalConnectionEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingEmotionalConnection";
    el.className = "emotionRingReading emotionRingEmotionalConnection hidden";

    const label = document.createElement("span");
    label.className = "emotionRingEmotionalConnectionLabel";
    label.textContent = "emotional connection :\u00a0\u00a0\u00a0\u00a0\u00a0";

    const value = document.createElement("span");
    value.className = "emotionRingEmotionalConnectionValue";
    value.textContent = "";

    el.appendChild(label);
    el.appendChild(value);

    document.body.appendChild(el);
    _emotionRingEmotionalConnectionEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingEmotionalConnection() {
  const el = _emotionRingEmotionalConnectionEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingEmotionalConnection(labelText, valueText, clientX, clientY) {
  const el = ensureEmotionRingEmotionalConnectionEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.classList.remove("hidden");

    // Update spans safely.
    try {
      const labelEl = el.querySelector(".emotionRingEmotionalConnectionLabel");
      const valueEl = el.querySelector(".emotionRingEmotionalConnectionValue");
      if (labelEl) labelEl.textContent = String(labelText || "emotional connection :\u00a0\u00a0\u00a0\u00a0\u00a0");
      if (valueEl) valueEl.textContent = String(valueText || "");
    } catch {
      // ignore
    }

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingBelongingShiftEl() {
  if (_emotionRingBelongingShiftEl) return _emotionRingBelongingShiftEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingBelongingShift";
    el.className = "emotionRingReading emotionRingBelongingShift hidden";

    const label = document.createElement("span");
    label.className = "emotionRingBelongingShiftLabel";
    label.textContent = "belonging shift :\u00a0\u00a0\u00a0\u00a0\u00a0";

    const value = document.createElement("span");
    value.className = "emotionRingBelongingShiftValue";
    value.textContent = "";

    el.appendChild(label);
    el.appendChild(value);

    document.body.appendChild(el);
    _emotionRingBelongingShiftEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingBelongingShift() {
  const el = _emotionRingBelongingShiftEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingBelongingShift(labelText, valueText, clientX, clientY) {
  const el = ensureEmotionRingBelongingShiftEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.classList.remove("hidden");

    try {
      const labelEl = el.querySelector(".emotionRingBelongingShiftLabel");
      const valueEl = el.querySelector(".emotionRingBelongingShiftValue");
      if (labelEl) labelEl.textContent = String(labelText || "belonging shift :\u00a0\u00a0\u00a0\u00a0\u00a0");
      if (valueEl) valueEl.textContent = String(valueText || "");
    } catch {
      // ignore
    }

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingDurationOfPresenceEl() {
  if (_emotionRingDurationOfPresenceEl) return _emotionRingDurationOfPresenceEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingDurationOfPresence";
    el.className = "emotionRingReading emotionRingDurationOfPresence hidden";

    const label = document.createElement("span");
    label.className = "emotionRingDurationOfPresenceLabel";
    label.textContent = "residence duration :\u00a0\u00a0\u00a0\u00a0\u00a0";

    const value = document.createElement("span");
    value.className = "emotionRingDurationOfPresenceValue";
    value.textContent = "";

    el.appendChild(label);
    el.appendChild(value);

    document.body.appendChild(el);
    _emotionRingDurationOfPresenceEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingDurationOfPresence() {
  const el = _emotionRingDurationOfPresenceEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingDurationOfPresence(labelText, valueText, clientX, clientY) {
  const el = ensureEmotionRingDurationOfPresenceEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.classList.remove("hidden");

    try {
      const labelEl = el.querySelector(".emotionRingDurationOfPresenceLabel");
      const valueEl = el.querySelector(".emotionRingDurationOfPresenceValue");
      if (labelEl) labelEl.textContent = String(labelText || "residence duration :\u00a0\u00a0\u00a0\u00a0\u00a0");
      if (valueEl) valueEl.textContent = String(valueText || "");
    } catch {
      // ignore
    }

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingTimeframeEl() {
  if (_emotionRingTimeframeEl) return _emotionRingTimeframeEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingTimeframe";
    el.className = "emotionRingReading emotionRingTimeframe hidden";

    const label = document.createElement("span");
    label.className = "emotionRingTimeframeLabel";
    label.textContent = "years :\u00a0\u00a0\u00a0\u00a0\u00a0";

    const value = document.createElement("span");
    value.className = "emotionRingTimeframeValue";
    value.textContent = "";

    el.appendChild(label);
    el.appendChild(value);

    document.body.appendChild(el);
    _emotionRingTimeframeEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingTimeframe() {
  const el = _emotionRingTimeframeEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingTimeframe(labelText, valueText, clientX, clientY) {
  const el = ensureEmotionRingTimeframeEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.classList.remove("hidden");

    try {
      const labelEl = el.querySelector(".emotionRingTimeframeLabel");
      const valueEl = el.querySelector(".emotionRingTimeframeValue");
      if (labelEl) labelEl.textContent = String(labelText || "years :\u00a0\u00a0\u00a0\u00a0\u00a0");
      if (valueEl) valueEl.textContent = String(valueText || "");
    } catch {
      // ignore
    }

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingLifeStageEl() {
  if (_emotionRingLifeStageEl) return _emotionRingLifeStageEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingLifeStage";
    el.className = "emotionRingReading emotionRingLifeStage hidden";

    const label = document.createElement("span");
    label.className = "emotionRingLifeStageLabel";
    label.textContent = "life stage :\u00a0\u00a0\u00a0\u00a0\u00a0";

    const value = document.createElement("span");
    value.className = "emotionRingLifeStageValue";
    value.textContent = "";

    el.appendChild(label);
    el.appendChild(value);

    document.body.appendChild(el);
    _emotionRingLifeStageEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingLifeStage() {
  const el = _emotionRingLifeStageEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingLifeStage(labelText, valueText, clientX, clientY) {
  const el = ensureEmotionRingLifeStageEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.classList.remove("hidden");

    try {
      const labelEl = el.querySelector(".emotionRingLifeStageLabel");
      const valueEl = el.querySelector(".emotionRingLifeStageValue");
      if (labelEl) labelEl.textContent = String(labelText || "life stage :\u00a0\u00a0\u00a0\u00a0\u00a0");
      if (valueEl) valueEl.textContent = String(valueText || "");
    } catch {
      // ignore
    }

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingLifetimePresentageEl() {
  if (_emotionRingLifetimePresentageEl) return _emotionRingLifetimePresentageEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingLifetimePresentage";
    el.className = "emotionRingReading emotionRingLifetimePresentage hidden";

    const label = document.createElement("span");
    label.className = "emotionRingLifetimePresentageLabel";
    label.textContent = "lifetime presentage :\u00a0\u00a0\u00a0\u00a0\u00a0";

    const value = document.createElement("span");
    value.className = "emotionRingLifetimePresentageValue";
    value.textContent = "";

    el.appendChild(label);
    el.appendChild(value);

    document.body.appendChild(el);
    _emotionRingLifetimePresentageEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingLifetimePresentage() {
  const el = _emotionRingLifetimePresentageEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingLifetimePresentage(labelText, valueText, clientX, clientY) {
  const el = ensureEmotionRingLifetimePresentageEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.classList.remove("hidden");

    try {
      const labelEl = el.querySelector(".emotionRingLifetimePresentageLabel");
      const valueEl = el.querySelector(".emotionRingLifetimePresentageValue");
      if (labelEl) labelEl.textContent = String(labelText || "lifetime presentage :\u00a0\u00a0\u00a0\u00a0\u00a0");
      if (valueEl) valueEl.textContent = String(valueText || "");
    } catch {
      // ignore
    }

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingTransitionalDistanceEl() {
  if (_emotionRingTransitionalDistanceEl) return _emotionRingTransitionalDistanceEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingTransitionalDistance";
    el.className = "emotionRingReading emotionRingTransitionalDistance hidden";

    const label = document.createElement("span");
    label.className = "emotionRingTransitionalDistanceLabel";
    label.textContent = "transitional distance from home -- :\u00a0\u00a0\u00a0\u00a0\u00a0";

    const value = document.createElement("span");
    value.className = "emotionRingTransitionalDistanceValue";
    value.textContent = "--";

    el.appendChild(label);
    el.appendChild(value);

    document.body.appendChild(el);
    _emotionRingTransitionalDistanceEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingTransitionalDistance() {
  const el = _emotionRingTransitionalDistanceEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingTransitionalDistance(labelText, valueText, clientX, clientY) {
  const el = ensureEmotionRingTransitionalDistanceEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.classList.remove("hidden");

    try {
      const labelEl = el.querySelector(".emotionRingTransitionalDistanceLabel");
      const valueEl = el.querySelector(".emotionRingTransitionalDistanceValue");
      if (labelEl) labelEl.textContent = String(labelText || "transitional distance from home -- :\u00a0\u00a0\u00a0\u00a0\u00a0");
      if (valueEl) valueEl.textContent = String(valueText || "--");
    } catch {
      // ignore
    }

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function ensureEmotionRingCumulativeDistanceEl() {
  if (_emotionRingCumulativeDistanceEl) return _emotionRingCumulativeDistanceEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingCumulativeDistance";
    el.className = "emotionRingReading emotionRingCumulativeDistance hidden";

    const label = document.createElement("span");
    label.className = "emotionRingCumulativeDistanceLabel";
    label.textContent = "cumulative distance :\u00a0\u00a0\u00a0\u00a0\u00a0";

    const value = document.createElement("span");
    value.className = "emotionRingCumulativeDistanceValue";
    value.textContent = "--";

    el.appendChild(label);
    el.appendChild(value);

    document.body.appendChild(el);
    _emotionRingCumulativeDistanceEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionRingCumulativeDistance() {
  const el = _emotionRingCumulativeDistanceEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionRingCumulativeDistance(labelText, valueText, clientX, clientY) {
  const el = ensureEmotionRingCumulativeDistanceEl();
  if (!el) return null;

  try {
    el.style.visibility = "hidden";
    el.classList.remove("hidden");

    try {
      const labelEl = el.querySelector(".emotionRingCumulativeDistanceLabel");
      const valueEl = el.querySelector(".emotionRingCumulativeDistanceValue");
      if (labelEl) labelEl.textContent = String(labelText || "cumulative distance :\u00a0\u00a0\u00a0\u00a0\u00a0");
      if (valueEl) valueEl.textContent = String(valueText || "--");
    } catch {
      // ignore
    }

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;

    let left = Math.round((Number(clientX) || 0));
    let top = Math.round((Number(clientY) || 0));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.left < margin) left = margin;
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    el.style.visibility = "";
    return el.getBoundingClientRect();
  } catch {
    // ignore
  }

  return null;
}

function cumulativeDistancePartsForIndex(index) {
  const i = Number(index) || 0;
  const label = "cumulative distance :\u00a0\u00a0\u00a0\u00a0\u00a0";
  if (i <= 0) return { label, value: "--" };

  try {
    let sumMeters = 0;
    for (let k = 1; k <= i; k++) {
      const prev = Array.isArray(addresses) ? addresses[k - 1] : null;
      const cur = Array.isArray(addresses) ? addresses[k] : null;
      if (!prev || !cur) return { label, value: "--" };

      const lat0 = Number(prev.lat);
      const lon0 = Number(prev.lon);
      const lat1 = Number(cur.lat);
      const lon1 = Number(cur.lon);
      if (!(Number.isFinite(lat0) && Number.isFinite(lon0) && Number.isFinite(lat1) && Number.isFinite(lon1))) {
        return { label, value: "--" };
      }

      const toRad = (deg) => (Number(deg) * Math.PI) / 180;
      const R = 6371000;
      const dLat = toRad(lat1 - lat0);
      const dLon = toRad(lon1 - lon0);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat0)) * Math.cos(toRad(lat1)) * Math.sin(dLon / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const meters = R * c;
      if (!Number.isFinite(meters)) return { label, value: "--" };
      sumMeters += meters;
    }

    if (!Number.isFinite(sumMeters)) return { label, value: "--" };
    const km = sumMeters / 1000;
    const value = km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
    return { label, value };
  } catch {
    return { label, value: "--" };
  }
}

function residenceTimelinePartsForIndex(index) {
  const empty = {
    duration: { label: "residence duration :\u00a0\u00a0\u00a0\u00a0\u00a0", value: "--" },
    years: { label: "years :\u00a0\u00a0\u00a0\u00a0\u00a0", value: "--" },
    lifeStage: { label: "life stage :\u00a0\u00a0\u00a0\u00a0\u00a0", value: "--" },
    lifetime: { label: "lifetime presentage :\u00a0\u00a0\u00a0\u00a0\u00a0", value: "--" },
  };

  try {
    const i = Math.max(0, Math.floor(Number(index) || 0));
    const list = Array.isArray(addresses) ? addresses : [];
    const current = list[i];
    const first = list[0];
    if (!current || !first) return empty;

    const startYear = Math.floor(Number(current.startYear));
    const birthYear = Math.floor(Number(first.startYear));
    const nextStartYear = Math.floor(Number(list[i + 1] && list[i + 1].startYear));
    const currentYear = new Date().getFullYear();
    const endYear = Number.isFinite(nextStartYear) && nextStartYear > startYear ? nextStartYear : currentYear;

    if (!Number.isFinite(startYear) || !Number.isFinite(birthYear) || !Number.isFinite(endYear)) return empty;

    const durationYears = Math.max(0, endYear - startYear);
    const livedWord = durationYears === 1 ? "year" : "years";
    const startAge = Math.max(0, startYear - birthYear);
    const endAge = Math.max(startAge, endYear - birthYear);
    const lifeSoFarYears = Math.max(0, currentYear - birthYear);
    const lifetimePercent = lifeSoFarYears > 0
      ? Math.max(0, Math.min(100, Math.round((durationYears / lifeSoFarYears) * 100)))
      : (durationYears > 0 ? 100 : 0);

    return {
      duration: { label: empty.duration.label, value: `${durationYears} ${livedWord}` },
      years: { label: empty.years.label, value: `${startYear}-${endYear}` },
      lifeStage: { label: empty.lifeStage.label, value: startAge === endAge ? String(startAge) : `${startAge}-${endAge}` },
      lifetime: { label: empty.lifetime.label, value: `${lifetimePercent}%` },
    };
  } catch {
    return empty;
  }
}

function transitionalDistancePartsForIndex(index) {
  const i = Number(index) || 0;
  const prevHome = i <= 0 ? "--" : formatHomeNumber(i);
  const label = `transitional distance from home ${prevHome} :\u00a0\u00a0\u00a0\u00a0\u00a0`;
  if (i <= 0) {
    return { label, value: "--" };
  }

  try {
    const cur = Array.isArray(addresses) ? addresses[i] : null;
    const prev = Array.isArray(addresses) ? addresses[i - 1] : null;
    if (!cur || !prev) return { label, value: "--" };

    const lat1 = Number(cur.lat);
    const lon1 = Number(cur.lon);
    const lat0 = Number(prev.lat);
    const lon0 = Number(prev.lon);
    if (!(Number.isFinite(lat0) && Number.isFinite(lon0) && Number.isFinite(lat1) && Number.isFinite(lon1))) {
      return { label, value: "--" };
    }

    const toRad = (deg) => (Number(deg) * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad(lat1 - lat0);
    const dLon = toRad(lon1 - lon0);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat0)) * Math.cos(toRad(lat1)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const meters = R * c;

    if (!Number.isFinite(meters)) return { label, value: "--" };

    let value = "--";
    if (meters < 1000) {
      value = `${Math.max(0, Math.round(meters))} m`;
    } else {
      const km = meters / 1000;
      value = km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
    }

    return { label, value };
  } catch {
    return { label, value: "--" };
  }
}

function belongingShiftPartsForIndex(index) {
  const i = Number(index) || 0;
  if (i <= 0) {
    return {
      label: "belonging shift :\u00a0\u00a0\u00a0\u00a0\u00a0",
      value: "--",
    };
  }

  try {
    const cur = Array.isArray(addresses) ? addresses[i] : null;
    const prev = Array.isArray(addresses) ? addresses[i - 1] : null;
    if (!cur || !prev) return null;

    const curRate = normalizeBelongingRate(cur.belonging_rate, stableBelongingRateFromId(cur.id));
    const prevRate = normalizeBelongingRate(prev.belonging_rate, stableBelongingRateFromId(prev.id));
    const diff = curRate - prevRate;
    const value = diff === 0 ? "--" : (diff > 0 ? `+${diff}` : String(diff));
    return {
      label: "belonging shift :\u00a0\u00a0\u00a0\u00a0\u00a0",
      value,
    };
  } catch {
    return null;
  }
}

function emotionalConnectionPartsForAddress(addr, fallbackIndex) {
  try {
    if (!addr || typeof addr !== "object") return null;
    const rate = normalizeBelongingRate(addr.belonging_rate, stableBelongingRateFromId(addr.id));
    const digits = String(rate).padStart(2, "0");
    return {
      label: "emotional connection :\u00a0\u00a0\u00a0\u00a0\u00a0",
      value: `${digits}/10`,
    };
  } catch {
    try {
      const rate = normalizeBelongingRate(null, (Number(fallbackIndex) || 0) + 1);
      const digits = String(rate).padStart(2, "0");
      return {
        label: "emotional connection :\u00a0\u00a0\u00a0\u00a0\u00a0",
        value: `${digits}/10`,
      };
    } catch {
      return null;
    }
  }
}

function homeNoTextForRingEl(ringEl, fallbackIndex) {
  try {
    const label = ringEl && ringEl.getAttribute ? String(ringEl.getAttribute("data-home-label") || "") : "";
    const m = label.match(/\b(\d{1,3})\b/);
    const rawDigits = m ? String(m[1]) : String((Number(fallbackIndex) || 0) + 1);
    const digits = rawDigits.length === 1 ? `0${rawDigits}` : rawDigits;
    return `home no.${digits}`;
  } catch {
    const rawDigits = String((Number(fallbackIndex) || 0) + 1);
    const digits = rawDigits.length === 1 ? `0${rawDigits}` : rawDigits;
    return `home no.${digits}`;
  }
}

function ringReadingTextForRingEl(ringEl, fallbackIndex) {
  try {
    const label = ringEl && ringEl.getAttribute ? String(ringEl.getAttribute("data-home-label") || "") : "";
    const m = label.match(/\b(\d{1,3})\b/);
    const rawDigits = m ? String(m[1]) : String((Number(fallbackIndex) || 0) + 1);
    const digits = rawDigits.length === 1 ? `0${rawDigits}` : rawDigits;
    return `ring reading ${digits}`;
  } catch {
    const rawDigits = String((Number(fallbackIndex) || 0) + 1);
    const digits = rawDigits.length === 1 ? `0${rawDigits}` : rawDigits;
    return `ring reading ${digits}`;
  }
}

function clearEmotionRingHoverHighlight() {
  const prev = String(_emotionHoveredHomeLabel || "");
  _emotionHoveredHomeLabel = "";

  try {
    if (elPageEmotion) elPageEmotion.classList.remove("emotionRingHoverActive");
  } catch {
    // ignore
  }

  try {
    const map = elEmotionSvg && elEmotionSvg.__lpHomeLabelToRingEl;
    if (prev && map && typeof map.get === "function") {
      const prevEl = map.get(prev);
      if (prevEl && prevEl.removeAttribute) prevEl.removeAttribute("data-emotion-hovered");
    }
  } catch {
    // ignore
  }
}

function setEmotionRingHoverHighlight(homeLabel) {
  const label = String(homeLabel || "");
  if (!label) {
    clearEmotionRingHoverHighlight();
    return;
  }
  if (label === _emotionHoveredHomeLabel) return;

  const prev = String(_emotionHoveredHomeLabel || "");
  _emotionHoveredHomeLabel = label;

  try {
    if (elPageEmotion) elPageEmotion.classList.add("emotionRingHoverActive");
  } catch {
    // ignore
  }

  try {
    const map = elEmotionSvg && elEmotionSvg.__lpHomeLabelToRingEl;
    if (map && typeof map.get === "function") {
      if (prev) {
        const prevEl = map.get(prev);
        if (prevEl && prevEl.removeAttribute) prevEl.removeAttribute("data-emotion-hovered");
      }
      const nextEl = map.get(label);
      if (nextEl && nextEl.setAttribute) nextEl.setAttribute("data-emotion-hovered", "1");
    }
  } catch {
    // ignore
  }
}

function ensureEmotionHomeTooltipEl() {
  if (_emotionHomeTooltipEl) return _emotionHomeTooltipEl;
  try {
    const el = document.createElement("div");
    el.id = "emotionRingHomeTooltip";
    el.className = "emotionRingHomeTooltip hidden";
    el.textContent = "";
    document.body.appendChild(el);
    _emotionHomeTooltipEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideEmotionHomeTooltip() {
  const el = _emotionHomeTooltipEl;
  if (!el) return;
  try {
    el.classList.add("hidden");
  } catch {
    // ignore
  }
}

function showEmotionHomeTooltip(label, clientX, clientY) {
  const el = ensureEmotionHomeTooltipEl();
  if (!el) return;

  try {
    el.textContent = String(label || "");
    el.classList.remove("hidden");

    const vw = Math.max(1, Number(window.innerWidth || 1));
    const vh = Math.max(1, Number(window.innerHeight || 1));
    const margin = 8;
    const offsetX = 14;
    const offsetY = -12;

    let left = Math.round((Number(clientX) || 0) + offsetX);
    let top = Math.round((Number(clientY) || 0) + offsetY);

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    // Clamp within viewport after measuring.
    const r = el.getBoundingClientRect();
    if (r.right > vw - margin) left = Math.max(margin, Math.round(vw - margin - r.width));
    if (r.bottom > vh - margin) top = Math.max(margin, Math.round(vh - margin - r.height));
    if (r.left < margin) left = margin;
    if (r.top < margin) top = margin;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  } catch {
    // ignore
  }
}

function findEmotionRingHoverTarget(node) {
  let el = node;
  for (let i = 0; i < 8 && el; i++) {
    try {
      if (el.nodeType === 1 && el.getAttribute && el.getAttribute("data-emotion-ring") === "1") return el;
    } catch {
      // ignore
    }
    el = el.parentNode;
  }
  return null;
}

function disarmEmotionHomeHoverTooltips() {
  try {
    if (typeof _emotionHomeTooltipCleanup === "function") _emotionHomeTooltipCleanup();
  } catch {
    // ignore
  }
  _emotionHomeTooltipCleanup = null;
  hideEmotionHomeTooltip();
  clearEmotionRingHoverHighlight();
}

function armEmotionHomeHoverTooltips() {
  disarmEmotionHomeHoverTooltips();
  if (!elEmotionSvg) return;

  const onMove = (ev) => {
    // When a ring is focused (solo), hovering should do nothing.
    if (isEmotionRingFocusActive()) {
      hideEmotionHomeTooltip();
      clearEmotionRingHoverHighlight();
      return;
    }
    const e = ev;
    const ringEl = findEmotionRingHoverTarget(e?.target);
    if (!ringEl) {
      hideEmotionHomeTooltip();
      clearEmotionRingHoverHighlight();
      return;
    }
    const label = (() => {
      try {
        return ringEl.getAttribute("data-home-label") || "";
      } catch {
        return "";
      }
    })();
    if (!label) {
      hideEmotionHomeTooltip();
      clearEmotionRingHoverHighlight();
      return;
    }
    setEmotionRingHoverHighlight(label);
    showEmotionHomeTooltip(label, e.clientX, e.clientY);
  };

  const onLeave = () => {
    hideEmotionHomeTooltip();
    clearEmotionRingHoverHighlight();
  };

  try {
    elEmotionSvg.addEventListener("pointermove", onMove, { passive: true });
    elEmotionSvg.addEventListener("pointerleave", onLeave, { passive: true });
    elEmotionSvg.addEventListener("pointercancel", onLeave, { passive: true });

    // Fallback for browsers/environments where Pointer Events on SVG are unreliable.
    elEmotionSvg.addEventListener("mousemove", onMove, { passive: true });
    elEmotionSvg.addEventListener("mouseleave", onLeave, { passive: true });
  } catch {
    // ignore
  }

  _emotionHomeTooltipCleanup = () => {
    try { elEmotionSvg.removeEventListener("pointermove", onMove); } catch { /* ignore */ }
    try { elEmotionSvg.removeEventListener("pointerleave", onLeave); } catch { /* ignore */ }
    try { elEmotionSvg.removeEventListener("pointercancel", onLeave); } catch { /* ignore */ }
    try { elEmotionSvg.removeEventListener("mousemove", onMove); } catch { /* ignore */ }
    try { elEmotionSvg.removeEventListener("mouseleave", onLeave); } catch { /* ignore */ }
  };
}

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
  step2CloseReturnPage = page === "archive" ? "archive" : "step1";
}

function maybeResetStep1AfterViewingArchiveMap() {
  // Requirement: if the user opens a map from Archive and then exits the map view,
  // the Step 1 address list should be cleared so the data entry page starts fresh.
  if (step2CloseReturnPage !== "archive" && !step2OpenedFromArchive) return;
  try {
    resetForNextStudent();
    setStatus("");
    setAddressStatus("");
  } catch {
    // ignore
  }
  step2OpenedFromArchive = false;
  setStep2CloseReturnPage("step1");
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
  step1SummaryPhaseActive = false;

  // Reset the form fields, including "Full name".
  if (elForm && typeof elForm.reset === "function") elForm.reset();
  if (elStudentName) elStudentName.value = "";
  // studentName/homesCount now live on the home page, outside <form
  // id="addressForm"> -- elForm.reset() above no longer reaches either of
  // them, so both need an explicit clear (homesCount used to be cleared
  // implicitly by the form reset when it was still inside the form).
  if (elHomesCount) elHomesCount.value = "";
  if (elPageStep1) elPageStep1.classList.remove("step1-finished-state");
  step1DashboardGrown = false;

  currentAddressVerified = false;
  belongingLabelShown = false;
  setAddressStatus("");
  setStatus("");
  updateAddButtonState();
  updateBelongingValueLabel();

  renderList();
  updateStep1Headers();
  renderStep1EmotionMap();

  if (addToListMsgTimeoutId) window.clearTimeout(addToListMsgTimeoutId);
  addToListMsgTimeoutId = 0;
  if (elAddToListMsg) {
    elAddToListMsg.classList.add("hidden");
    elAddToListMsg.textContent = "";
  }
}

// Top-right page actions (back / edit / share / print) — edit/share/print
// visibility toggles purely on step1-finished-state via CSS; see
// .step1FinishedOnlyBtn in styles.css. "back" has no such restriction —
// it's always visible, replacing what used to be two separate buttons
// ("go back", pre-finish only, and "start over", always visible but
// destructive) with one that's always available and never discards data.
const elStep1GoBackBtn = document.getElementById("step1GoBackBtn");
const elStep1EditFinishedBtn = document.getElementById("step1EditFinishedBtn");
const elStep1ShareBtn = document.getElementById("step1ShareBtn");
const elStep1PrintBtn = document.getElementById("step1PrintBtn");
const elStep1TopAllMapsBtn = document.getElementById("step1TopAllMapsBtn");

// "back": returns to the home page's screen 2 (name + home count) from
// wherever Step 1 currently is (any phase, finished or not) without
// touching any already-entered address data, mirroring how the per-phase
// BACK buttons elsewhere only ever change phase/page, never data.
function step1GoBackToIntro() {
  if (!elPageStep1) return;
  // The emotion map's ambient rings sound/breathing is otherwise a standing
  // session deliberately left running across ordinary Step1<->Emotion
  // navigation (see showPage()'s comment) -- showPage("welcome") below
  // already tears that down since "welcome" isn't part of that shared
  // session, but the finished-map ring-entry loop is a separate sound that
  // isn't part of that teardown, so it needs its own explicit stop here
  // (same reasoning the old "start over" button used to apply).
  try {
    stopStep1EntrySound();
  } catch {
    // ignore
  }
  // Step 1's own "no phase" intro screen no longer has the name/homes-count
  // form (moved to the home page) -- return there (screen 2) instead of
  // un-toggling phases to show what's now an empty gap. Still strip the
  // phase classes so a later re-entry via step1NextBtn (which only *adds*
  // step1-address-phase, never removes the others) doesn't land with a
  // stale step1-belonging-phase/step1-summary-phase left over from this
  // session.
  elPageStep1.classList.remove("step1-address-phase", "step1-belonging-phase", "step1-summary-phase");
  step1SummaryPhaseActive = false;
  showPage("welcome", { welcomeScroll: "screen2" });
}

// "edit" (shown only once finished): re-arms the exact ring/address
// hover-to-edit interactivity that was available before finishing — clicking
// a ring or a home in the list re-opens openStep1HomeEditMode() for it,
// which itself un-hides the address form + this button and saves in place
// (see step1EditModeAfterFinishActive in isStep1DataEntryFinished()). Also
// immediately opens the first home's edit form itself, so clicking "edit"
// alone (without also clicking a ring/home) already lands the user in an
// editable address form instead of just re-arming the click-to-edit ability.
// step1-finished-state stays on, so share/print/start over stay visible.
function step1EditAfterFinish() {
  if (!elPageStep1) return;
  step1EditModeAfterFinishActive = true;
  if (typeof shrinkStep1DashboardAnimated === "function") shrinkStep1DashboardAnimated();
  updateStep1TopProgress();
  updateStep1RingReading();
  updateStep1HomesList();
  if (typeof updateAddHomeBtnState === "function") updateAddHomeBtnState();
  if (Array.isArray(addresses) && addresses.length > 0) {
    openStep1HomeEditMode(0);
  }
}

// Leaves the after-finish edit-review flow (see step1EditAfterFinish()) and
// returns to the normal (grown) finished dashboard -- used both when "back"
// is clicked mid-review (discarding the currently-open, unsaved ring) and
// after saving the last ring in the review sequence.
function step1ExitEditAfterFinish() {
  if (!elPageStep1) return;
  exitStep1EditMode();
  step1EditModeAfterFinishActive = false;
  const divAddr = elPageStep1.querySelector(".div-3 > .div-2");
  if (divAddr) divAddr.style.display = "none";
  if (typeof updateAddHomeBtnState === "function") updateAddHomeBtnState();
  if (typeof growStep1DashboardAnimated === "function") growStep1DashboardAnimated();
  updateStep1TopProgress();
  clearStep1HomesListFocus();
  updateStep1Headers();
}

if (elStep1GoBackBtn) {
  elStep1GoBackBtn.addEventListener("click", () => {
    if (step1EditModeAfterFinishActive) {
      step1ExitEditAfterFinish();
      return;
    }
    step1GoBackToIntro();
  });
}

if (elStep1EditFinishedBtn) {
  elStep1EditFinishedBtn.addEventListener("click", () => {
    step1EditAfterFinish();
  });
}

if (elStep1ShareBtn) {
  elStep1ShareBtn.addEventListener("click", () => {
    openPostcardPreview();
  });
}

if (elStep1PrintBtn) {
  elStep1PrintBtn.addEventListener("click", () => {
    printPostcardImmediatelyFromStep2();
  });
}

if (elStep1TopAllMapsBtn) {
  elStep1TopAllMapsBtn.addEventListener("click", async () => {
    await refreshServerMapsCache();
    prepareAllMapsFocusForCurrentMap();
    showPage("allmaps");
  });
}

function maybeResetStep1AfterCreateSave() {
  if (!resetStep1AfterCreateSavePending) return;
  resetStep1AfterCreateSavePending = false;
  resetStep1HouseList();
}

function getAddressesSignatureForAutoSave() {
  return getAddressesSignatureForList(addresses);
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

const elAllMapsMap = document.getElementById("allMapsMap");
const elAllMapsHideMapBtn = document.getElementById("allMapsHideMapBtn");
const elAllMapsEditBtn = document.getElementById("allMapsEditBtn");
const elAllMapsCountLabel = document.getElementById("allMapsCountLabel");
const elAllMapsZoomLabel = document.getElementById("allMapsZoomLabel");
const elAllMapsSearchInput = document.getElementById("allMapsSearchInput");
const elAllMapsSearchWrap = document.querySelector("#pageAllMaps .allMapsSearchWrap");
const elAllMapsListToggleBtn = document.getElementById("allMapsListToggleBtn");

const elCountry = document.getElementById("country");
const elCity = document.getElementById("city");
const elStreet = document.getElementById("street");
const elNumber = document.getElementById("number");
const elBelongingRate = document.getElementById("belonging_rate");
const elBelongingValueLabel = document.getElementById("belongingValueLabel");

function sanitizeEnglishOnlyName(raw) {
  // Allow English and Hebrew letters (plus spaces and basic name punctuation).
  return String(raw || "").replace(/[^A-Za-z֐-׿ .'-]+/g, "");
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
  const rawValue = parseFloat(elBelongingRate.value) || 1;
  const displayRate = Math.round(Math.max(1, Math.min(10, rawValue)));
  const strokeW = belongingCircleStrokeWeight(rawValue);
  elBelongingRate.style.setProperty("--belonging-thumb-stroke-width", `${strokeW}px`);
  if (!belongingLabelShown) {
    elBelongingValueLabel.textContent = "";
    elBelongingValueLabel.style.visibility = "hidden";
    return;
  }

  elBelongingValueLabel.style.visibility = "visible";
  elBelongingValueLabel.textContent = String(displayRate);

  // Position label above the thumb (centered).
  const min = Number(elBelongingRate.min || 1);
  const max = Number(elBelongingRate.max || 10);
  const t = max > min ? (rawValue - min) / (max - min) : 0;

  const trackWidth = elBelongingRate.clientWidth;
  const thumbSize = 21; // matches CSS ::-webkit-slider-thumb / ::-moz-range-thumb
  const x = t * Math.max(0, trackWidth - thumbSize) + thumbSize / 2;
  const left = elBelongingRate.offsetLeft + x;
  elBelongingValueLabel.style.left = `${left}px`;
}

function updateCreateLifePathButtonState() {
  if (!elCreateLifePathBtn) return;
  elCreateLifePathBtn.disabled = addresses.length === 0;
}

// Set to true right when the user clicks FINISH (the last home's belonging
// submit) so the finished-state dashboard grows by 30%; false otherwise
// (including while the address/belonging phases are still in progress).
// Persists across resizes -- see updateStep1Scale() -- and is reset back to
// false whenever the finished map is left (step1GoBackToIntro() / the
// state-reset helper near stopStep1EntrySound()).
let step1DashboardGrown = false;

function updateStep1Scale() {
  const DESIGN_W = 1920;
  const DESIGN_H = 1080;
  const viewport = window.visualViewport || null;
  const vw = Math.max(1, Number(viewport?.width || window.innerWidth || DESIGN_W));
  const vh = Math.max(1, Number(viewport?.height || window.innerHeight || DESIGN_H));
  const scale = vw / DESIGN_W;
  const visibleDesignHeight = vh / scale;
  const dashboardTopBase = 285;
  const dashboardHeightBase = Math.max(520, Math.min(810, visibleDesignHeight - dashboardTopBase));
  const dashboardBottom = dashboardTopBase + dashboardHeightBase;
  // On FINISH, the sections grow taller *upward*, targeting +40% -- their
  // bottom edge stays exactly where it always sits, only the shared top
  // boundary moves up to make room. There isn't remotely enough natural
  // headroom above the dashboard for a target that size (a few hundred px
  // on an 810px-tall dashboard vs. ~110px of real slack once every gap is
  // compressed to its floor), so in practice this is capped by headerSlack
  // below -- the move-frequency label and the timeline above the dashboard
  // compress their own spacing upward too, own text heights untouched, only
  // the gaps between rows shrink, each down to its own floor so nothing
  // touches. ("your map is complete" used to be part of this same stack,
  // but now lives as its own centered, top-aligned-to-logo overlay -- see
  // .step1MapCompleteTitle in styles.css -- so it no longer takes up room
  // here.) The logo/name-progress row above all of this never moves. See
  // growStep1DashboardAnimated().
  const HEADER_ZONE_TOP = 85; // just below the "name / xx/xx" progress row (bottom ~78.7px, now centered under the title instead of left-aligned near the logo)
  const HEADER_LABEL_H = 15; // label now matches the section titles' scale-independent 15px font
  const HEADER_TIMELINE_H = 24;
  // Per-row floors (not one shared minimum): the timeline row is allowed to
  // pack tighter than the label-to-dashboard gap, since that's the boundary
  // that reads most clearly as "start of the dashboard grid".
  const MIN_GAP_LABEL = 4;
  const MIN_GAP_TIMELINE = 2;
  const MIN_GAP_DASHBOARD = 4;
  // Original (ungrown) gaps, derived from today's fixed positions: label
  // top 178, timeline top 206, dashboard top 285.
  const gapToLabel = 178 - HEADER_ZONE_TOP; // 70
  const gapToTimeline = 206 - (178 + HEADER_LABEL_H); // 5
  const gapToDashboard = dashboardTopBase - (206 + HEADER_TIMELINE_H); // 55
  const headerSlack = (gapToLabel - MIN_GAP_LABEL)
    + (gapToTimeline - MIN_GAP_TIMELINE)
    + (gapToDashboard - MIN_GAP_DASHBOARD);

  let dashboardTop = dashboardTopBase;
  let dashboardHeight = dashboardHeightBase;
  let headerLabelTop = 178;
  let headerTimelineTop = 206;
  if (step1DashboardGrown) {
    const desiredGrowth = dashboardHeightBase * 0.4;
    const rawCompression = Math.min(desiredGrowth, Math.max(0, headerSlack));
    // The whole grown dashboard reads 10% shorter than the plain +40% growth
    // above would give -- applied to the full grown height (base + growth),
    // not just the growth portion, so it's derived here rather than just
    // scaling desiredGrowth.
    const grownHeightFull = dashboardHeightBase + rawCompression;
    const grownHeightTarget = grownHeightFull * 0.9;
    const compression = Math.max(0, grownHeightTarget - dashboardHeightBase);
    const t = headerSlack > 0 ? compression / headerSlack : 0;
    const newGapToLabel = gapToLabel - (gapToLabel - MIN_GAP_LABEL) * t;
    const newGapToTimeline = gapToTimeline - (gapToTimeline - MIN_GAP_TIMELINE) * t;
    headerLabelTop = HEADER_ZONE_TOP + newGapToLabel;
    headerTimelineTop = headerLabelTop + HEADER_LABEL_H + newGapToTimeline;
    dashboardHeight = dashboardHeightBase + compression;
    dashboardTop = dashboardBottom - dashboardHeight;
    // Manual fine-tune on top of the computed layout: label up 30px
    // (widening the label-to-timeline gap), timeline down 10px from its
    // computed position. Clamped so the label can't be pushed above the
    // name/progress row.
    const HEADER_SAFE_TOP = 72;
    headerLabelTop = Math.max(HEADER_SAFE_TOP, headerLabelTop - 30);
    headerTimelineTop = Math.max(headerLabelTop + HEADER_LABEL_H + MIN_GAP_TIMELINE + 10, headerTimelineTop);
    // "move frequency", the timeline itself, and the "edit" button (all
    // three read from --step1-header-timeline-top) raised net 4px further
    // (7px up, then lowered back down 3px).
    headerTimelineTop -= 4;
  }
  const dashboardTopSection = dashboardHeight * 0.6;
  const dashboardBottomSection = dashboardHeight * 0.4;
  const dashboardDivider = dashboardTopSection + 23;
  const offsetX = 0;
  const offsetY = 0;
  document.documentElement.style.setProperty("--step1-scale", String(scale));
  document.documentElement.style.setProperty("--step1-offset-x", `${offsetX}px`);
  document.documentElement.style.setProperty("--step1-offset-y", `${offsetY}px`);
  document.documentElement.style.setProperty("--step1-dashboard-top", `${dashboardTop}px`);
  document.documentElement.style.setProperty("--step1-dashboard-height", `${dashboardHeight}px`);
  document.documentElement.style.setProperty("--step1-dashboard-top-section", `${dashboardTopSection}px`);
  document.documentElement.style.setProperty("--step1-dashboard-bottom-section", `${dashboardBottomSection}px`);
  document.documentElement.style.setProperty("--step1-dashboard-divider", `${dashboardDivider}px`);
  document.documentElement.style.setProperty("--step1-header-label-top", `${headerLabelTop}px`);
  document.documentElement.style.setProperty("--step1-header-timeline-top", `${headerTimelineTop}px`);
  const invScale = scale > 0 && scale < 1 ? 1 / scale : 1;
  document.documentElement.style.setProperty("--step1-inv-scale", String(invScale));
  scheduleWelcomeBottomButtonsAlignment();
  alignStep1TopProgressCounter();
}

// Plays the 30%-growth animation: briefly enables a CSS transition on the
// dashboard panels, flips the grown flag, and recomputes -- the transition
// is scoped to a short-lived class so ordinary window resizes stay snap-to
// (no lag while dragging), only this one growth moment animates.
function growStep1DashboardAnimated() {
  if (!elPageStep1 || step1DashboardGrown) return;
  elPageStep1.classList.add("step1-dashboard-animating");
  step1DashboardGrown = true;
  updateStep1Scale();
  window.setTimeout(() => {
    if (elPageStep1) elPageStep1.classList.remove("step1-dashboard-animating");
    // The geo map panel (.step1-right) grows along with the other sections,
    // but Leaflet doesn't observe CSS transitions on its container -- resize
    // it once the 0.75s height transition has actually finished so the tiles
    // fill the new size instead of staying pinned to the old one.
    if (step1GeoMap) step1GeoMap.invalidateSize(true);
  }, 850);
}

// Mirror of growStep1DashboardAnimated() -- plays the shrink-back-down
// animation to the sections' original (pre-finish) size. Used when
// entering edit mode from the finished state (see step1EditAfterFinish()).
function shrinkStep1DashboardAnimated() {
  if (!elPageStep1 || !step1DashboardGrown) return;
  elPageStep1.classList.add("step1-dashboard-animating");
  step1DashboardGrown = false;
  updateStep1Scale();
  window.setTimeout(() => {
    if (elPageStep1) elPageStep1.classList.remove("step1-dashboard-animating");
    if (step1GeoMap) step1GeoMap.invalidateSize(true);
  }, 850);
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
  // Start shrinking a bit later so the initial scroll feels steadier.
  const shrinkStart = Math.max(40, Math.min(120, vh * 0.12));
  const shrinkSpan = Math.max(180, Math.min(420, vh * 0.6));
  const t = Math.max(0, Math.min(1, (scrollY - shrinkStart) / shrinkSpan));
  const shrinkEndY = shrinkStart + shrinkSpan;

  // Final (small) size tuning:
  // Target: match the 16px wordmark used on other pages.
  // The Welcome logo base font-size is 93px, so minScale = 16/93 ~= 0.172.
  const minScale = 16 / 93;
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
  const alignEndY = Number.isFinite(step1TopY) && step1TopY > 0 ? step1TopY : shrinkEndY;
  const alignSlideDistance = Math.max(120, Math.min(260, vh * 0.35));
  const alignStartY = Math.max(shrinkEndY, alignEndY - alignSlideDistance);


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

// Ambient background on the home page: a route of randomly placed circles
// (varying stroke width, like the movement map's belonging-weighted dots),
// built one hop at a time — the connecting line stretches from the previous
// point first, and only once it lands does the new circle fade in. Once the
// route is complete it holds briefly, fades out, and starts a fresh random
// route — loops forever while the home page is visible. `_homeBgRouteRunId`
// is a cancellation token: incrementing it makes any in-flight loop's next
// `await` see a stale id and stop, instead of needing to track/clear
// individual timers.
let _homeBgRouteRunId = 0;

function stopHomePageBackgroundRoute() {
  _homeBgRouteRunId++;
}

function startHomePageBackgroundRoute() {
  const svg = document.getElementById("homeBgRouteSvg");
  if (!svg) return;
  const myRun = ++_homeBgRouteRunId;
  const NS = "http://www.w3.org/2000/svg";
  const MIN_POINTS = 10;
  const MAX_POINTS = 12;
  // Points may land up to this many px beyond each edge, so the route can
  // visibly bleed off the frame instead of always staying fully inside it.
  const BLEED_PX = 90;
  const ROUTE_COLOR = "#dddbd4";
  // Constant-speed growth: duration scales with each segment's own length so
  // a short hop and a long hop both animate at the same visual pace, instead
  // of every segment taking the same fixed time regardless of distance.
  const LINE_SPEED_PX_PER_MS = 0.37;
  const MIN_LINE_MS = 380;
  const CIRCLE_FADE_MS = 820;
  const GAP_BEFORE_NEXT_MS = 480;
  const HOLD_MS = 2400;
  const FADE_OUT_MS = 750;

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function randomPoint(w, h) {
    return {
      x: -BLEED_PX + Math.random() * (w + BLEED_PX * 2),
      y: -BLEED_PX + Math.random() * (h + BLEED_PX * 2),
      sw: 1 + Math.random() * 5,
    };
  }

  function growLine(linesGroup, fromPt, toPt) {
    return new Promise((resolve) => {
      if (_homeBgRouteRunId !== myRun) {
        resolve();
        return;
      }
      const dist = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y);
      const durationMs = Math.max(MIN_LINE_MS, dist / LINE_SPEED_PX_PER_MS);
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", String(fromPt.x));
      line.setAttribute("y1", String(fromPt.y));
      line.setAttribute("x2", String(fromPt.x));
      line.setAttribute("y2", String(fromPt.y));
      line.setAttribute("stroke", ROUTE_COLOR);
      line.setAttribute("stroke-width", "1");
      linesGroup.appendChild(line);
      const t0 = performance.now();
      function frame(now) {
        if (_homeBgRouteRunId !== myRun) {
          resolve();
          return;
        }
        const t = Math.min(1, (now - t0) / durationMs);
        const e = easeInOutCubic(t);
        line.setAttribute("x2", String(fromPt.x + (toPt.x - fromPt.x) * e));
        line.setAttribute("y2", String(fromPt.y + (toPt.y - fromPt.y) * e));
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  function fadeInCircle(circlesGroup, pt, durationMs) {
    return new Promise((resolve) => {
      if (_homeBgRouteRunId !== myRun) {
        resolve();
        return;
      }
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", String(pt.x));
      circle.setAttribute("cy", String(pt.y));
      circle.setAttribute("r", "7");
      // Filled with the page background (not "none") so the line underneath
      // doesn't show through the middle of the ring.
      circle.setAttribute("fill", "#f4f2ea");
      circle.setAttribute("stroke", ROUTE_COLOR);
      circle.setAttribute("stroke-width", pt.sw.toFixed(2));
      circle.style.opacity = "0";
      circle.style.transition = `opacity ${durationMs}ms ease`;
      circlesGroup.appendChild(circle);
      requestAnimationFrame(() => {
        circle.style.opacity = "1";
      });
      setTimeout(resolve, durationMs);
    });
  }

  async function loop() {
    while (_homeBgRouteRunId === myRun) {
      svg.innerHTML = "";
      svg.style.transition = "";
      svg.style.opacity = "1";

      // Two layers, lines then circles, so every circle paints above every
      // line regardless of insertion order — later hops' lines start exactly
      // at an earlier point's center, and without this a fresh line would
      // paint over (in front of) that already-placed circle.
      const linesGroup = document.createElementNS(NS, "g");
      const circlesGroup = document.createElementNS(NS, "g");
      svg.appendChild(linesGroup);
      svg.appendChild(circlesGroup);

      // Match the viewBox to the SVG's actual on-screen pixel size so 1 unit
      // == 1 css px in both axes — otherwise a non-square viewBox stretched
      // over a non-square viewport skews circles into ellipses.
      const rect = svg.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

      const pointCount = MIN_POINTS + Math.floor(Math.random() * (MAX_POINTS - MIN_POINTS + 1));
      let prevPt = null;
      for (let i = 0; i < pointCount; i++) {
        if (_homeBgRouteRunId !== myRun) return;
        const pt = randomPoint(w, h);
        if (prevPt) {
          await growLine(linesGroup, prevPt, pt);
          if (_homeBgRouteRunId !== myRun) return;
        }
        await fadeInCircle(circlesGroup, pt, CIRCLE_FADE_MS);
        if (_homeBgRouteRunId !== myRun) return;
        prevPt = pt;
        await sleep(GAP_BEFORE_NEXT_MS);
      }

      if (_homeBgRouteRunId !== myRun) return;
      await sleep(HOLD_MS);
      if (_homeBgRouteRunId !== myRun) return;

      svg.style.transition = `opacity ${FADE_OUT_MS}ms ease`;
      svg.style.opacity = "0";
      await sleep(FADE_OUT_MS + 50);
    }
  }

  loop();
}

function scrollWelcomeToTop(behavior) {
  if (!elPageWelcome) return;
  elPageWelcome.scrollTo({ top: 0, left: 0, behavior: behavior || "auto" });
}

function scrollWelcomeToScreen2(behavior) {
  if (!elPageWelcome) return;
  // Scroll all the way to the bottom of the content (scrollHeight -
  // clientHeight), not a hardcoded one-screen offset -- lands on screen 2
  // correctly regardless of exactly how much taller than 100vh
  // .homePageInner is (see its height in styles.css).
  const max = Math.max(0, elPageWelcome.scrollHeight - elPageWelcome.clientHeight);
  elPageWelcome.scrollTo({ top: max, left: 0, behavior: behavior || "auto" });
}

// Archive/All Maps can be entered from either the home page or Step 1; their
// "back" buttons should return to whichever one was actually last active,
// not always assume Step 1. Updated every time showPage() shows one of the
// two "home base" pages, left untouched while on Archive/All Maps/etc. so it
// still remembers the right one when back is eventually clicked.
let _lastPrimaryPageKey = "step1";

function showPage(which, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const pageKey = which;

  if (pageKey === "step1" || pageKey === "welcome") {
    _lastPrimaryPageKey = pageKey;
  }

  const pages = [
    { key: "welcome", el: elPageWelcome },
    { key: "about", el: elPageAbout },
    { key: "step1", el: elPageStep1 },
    { key: "step2", el: elPageStep2 },
    { key: "emotion", el: elPageEmotion },
    { key: "step1EmotionFullscreen", el: elPageStep1EmotionFullscreen },
    { key: "allmaps", el: elPageAllMaps },
    { key: "archive", el: elPageArchive },
  ];

  const isHomeFlow = pageKey === "step1";

  // Leaving Step 1 for any other page -- see _step1SkipEmotionRebuildOnce's
  // own comment for why this is always safe to skip on the way back.
  if (pageKey !== "step1" && elPageStep1 && !elPageStep1.classList.contains("hidden")) {
    _step1SkipEmotionRebuildOnce = true;
  }

  document.body.classList.toggle("homeFlow", isHomeFlow);

  // If we leave the Emotion page, stop/disarm any running or armed motion.
  // Step 1, its fullscreen map, and the solo ring page all share one
  // breathing/sound session — navigating among those three shouldn't tear
  // anything down (returning to Step 1 restarts it anyway via
  // renderStep1EmotionMap(), but there's no reason to stop-then-immediately-
  // restart). Only leaving to a page with no connection to the emotion map
  // (Step 2, All Maps, Archive, Welcome) tears it down.
  if (which !== "emotion" && which !== "step1EmotionFullscreen" && which !== "step1") {
    try {
      _emotionRingFocusIndex = null;
      hideEmotionRingSoloTextOverlays();
      disarmEmotionHomeHoverTooltips();
      disarmEmotionBreathing();
      stopEmotionBreathing();
      stopEmotionSound();
      if (elPageEmotion) elPageEmotion.classList.remove("emotionSoloActive");
      pendingEmotionSoloTargetRingSizePx = null;
      pendingEmotionSoloShapeParams = null;
    } catch {
      // ignore
    }
  }

  pages.forEach((p) => {
    if (!p.el) return;
    const shouldShow = p.key === pageKey;
    p.el.classList.toggle("hidden", !shouldShow);
  });

  if (pageKey === "welcome") {
    startHomePageBackgroundRoute();
    // "auto" (instant), not "smooth": this runs in the same tick as
    // unhiding #pageWelcome, where an animated scroll is unreliable across
    // browsers.
    if (options.welcomeScroll === "screen2") scrollWelcomeToScreen2("auto");
    else scrollWelcomeToTop("auto");
    resetHomeLogoScrollMorph();
  } else {
    stopHomePageBackgroundRoute();
  }

  if (isHomeFlow) {
    // Apply any pending Step 1 reset after a successful Create+Save.
    maybeResetStep1AfterCreateSave();
  }

  if (isHomeFlow) {
    updateStep1Scale();
    scheduleWelcomeLogoUpdate();
    setTimeout(() => {
      ensureStep1GeoMap();
      updateStep1GeoMapView();
      if (_step1SkipEmotionRebuildOnce) {
        _step1SkipEmotionRebuildOnce = false;
      } else {
        renderStep1EmotionMap();
      }
    }, 0);
  }

  // Keep pages fixed to the viewport. Internal panels may scroll, but the
  // document itself should never become a scrollable page.
  if (!isHomeFlow) {
    try {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } catch {
      // ignore
    }
  } else {
    try {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } catch {
      // ignore
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
      updateStep2ReadingInfo();

      // When Step 2 opens, mark the saved addresses and draw their dots/line.
      clearStep2LifePath();
      renderStep2AddressDots();
      renderStep2AddressLine();

      // Requirement: the LifePath map page should open showing all Israel.
      pendingStep2View = null;
      requestStep2OpenFitToAddresses();
      forceStep2OpenFitToAddressesSoon(200);
      updateStep2ZoomLabel();

      // Map + reading panel treated as one unit and centered together (their
      // own gap never changes) -- deferred until the opening fit-to-
      // addresses view actually settles, since the dots' on-screen position
      // (which this measures) isn't final until then. moveend covers the
      // normal case; the timeout is a safety net for whenever it doesn't
      // fire (e.g. the view was already exactly at rest).
      try {
        map.once("moveend", () => centerStep2ReadingUnit());
      } catch {
        // ignore
      }
      setTimeout(() => centerStep2ReadingUnit(), 300);
      if (!_step2ReadingUnitResizeArmed) {
        _step2ReadingUnitResizeArmed = true;
        window.addEventListener("resize", () => {
          if (elPageStep2 && !elPageStep2.classList.contains("hidden")) centerStep2ReadingUnit();
        }, { passive: true });
      }
      return;
    }, 0);
  }

  if (which === "emotion") {
    setTimeout(() => {
      updateEmotionTitle();
      renderEmotionMap(pendingEmotionStart);
      pendingEmotionStart = null;
      applyPendingEmotionSoloFocus();
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
    setTimeout(async () => {
      await refreshServerMapsCache();
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

function loadSavedMapSnapshotIntoEditingState(snapshot, archiveDisplayName = "") {
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
  currentLoadedMapDisplayName = String(archiveDisplayName || snapshot.fullName || snapshot.label || "").trim();

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
  // Reuse the exact emotion-ring geometry recorded when this map was saved
  // (if any) instead of recomputing it live -- keeps a reopened map's
  // emotion rings identical to how they looked at save time even if the
  // tuning constants have since changed (see renderStep1EmotionMap()'s own
  // frozenLayout handling). Falls back to a normal live render for maps
  // saved before this existed.
  renderStep1EmotionMap({ frozenLayout: snapshot.emotionLayoutSnapshot || null });
  updateCreateLifePathButtonState();
  currentAddressVerified = false;
  updateAddButtonState();

  if (typeof setGeoLayerEnabled === "function") {
    const hasSetting = snapshot && typeof snapshot === "object" && Object.prototype.hasOwnProperty.call(snapshot, "geoLayerEnabled");
    setGeoLayerEnabled(hasSetting ? Boolean(snapshot.geoLayerEnabled) : true);
  }
}

function openSavedMapSnapshotFinishedFromArchive(snapshot, archiveDisplayName = "") {
  if (!snapshot) return;
  resetStep1AfterCreateSaveArmed = false;
  resetStep1AfterCreateSavePending = false;
  loadSavedMapSnapshotIntoEditingState(snapshot, archiveDisplayName);

  step1EditModeAfterFinishActive = false;
  step1SummaryPhaseActive = true;
  if (elPageStep1) {
    elPageStep1.classList.remove("step1-address-phase", "step1-summary-phase");
    elPageStep1.classList.add("step1-belonging-phase", "step1-finished-state", "step1-archive-loaded");
  }

  step1DashboardGrown = true;
  updateStep1Scale();
  _step1SkipEmotionRebuildOnce = true;
  showPage("step1", { scroll: "step1", behavior: "auto" });
  updateStep1TopProgress();
  updateStep1HomesList();
  updateStep1RingReading();
  clearStep1HomesListFocus();
  if (typeof updateAddHomeBtnState === "function") updateAddHomeBtnState();

  const divAddr = elPageStep1 && elPageStep1.querySelector(".div-3 > .div-2");
  if (divAddr) divAddr.style.display = "none";

  setTimeout(() => {
    try {
      updateStep1Scale();
      ensureStep1GeoMap();
      renderStep1EmotionMap({ frozenLayout: snapshot.emotionLayoutSnapshot || null });
      fitStep1GeoMapToIsraelBoundaries({ animate: false });
      updateStep1GeoMapMarkers();
      if (step1GeoRouteLine) step1GeoRouteLine.setStyle({ color: getStep1GeoRouteColor(), weight: 1 });
      updateStep1TimeBelonging();
    } catch {
      // ignore
    }
  }, 0);
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

/** @type {string | null} */
let allMapsPendingFocusKey = null;

/** @type {{ center: L.LatLng, zoom: number } | null} */
let allMapsViewBeforeHighlightFocus = null;

/** @type {{ center: L.LatLng, zoom: number } | null} */
let allMapsPendingRestoreView = null;

let allMapsListVisible = false;

let allMapsSearchQuery = "";

function normalizeAllMapsSearchText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function focusAllMapsListNameByQuery(query) {
  if (!elSavedMapsList) return;
  const q = normalizeAllMapsSearchText(query);
  if (!q) return;

  const buttons = Array.from(elSavedMapsList.querySelectorAll(".allMapsListName"));
  const match = buttons.find((btn) => {
    const hay = normalizeAllMapsSearchText(btn.getAttribute("data-search-text") || btn.textContent || "");
    return hay.includes(q);
  });
  if (!match) return;

  try {
    const listRect = elSavedMapsList.getBoundingClientRect();
    const itemRect = match.getBoundingClientRect();
    const currentTop = Number(elSavedMapsList.scrollTop) || 0;
    const targetTop = Math.max(0, currentTop + (itemRect.top - listRect.top));
    elSavedMapsList.scrollTo({ top: targetTop, behavior: "smooth" });
  } catch {
    try {
      match.scrollIntoView({ block: "start", inline: "nearest", behavior: "smooth" });
    } catch {
      // ignore
    }
  }
}

function applyAllMapsSearchMatchHighlight(query) {
  if (!elSavedMapsList) return;
  const q = normalizeAllMapsSearchText(query);
  const buttons = Array.from(elSavedMapsList.querySelectorAll(".allMapsListName"));
  for (const btn of buttons) {
    const hay = normalizeAllMapsSearchText(btn.getAttribute("data-search-text") || btn.textContent || "");
    const isMatch = Boolean(q) && hay.includes(q);
    btn.classList.toggle("isSearchMatch", isMatch);
  }
}

// Keep the All Maps view stable when the user interacts with the list.
// We only auto-fit once when entering the All Maps page.
let allMapsHasAutoFitOnThisEntry = false;

/** @type {L.Map | null} */
let step1GeoMap = null;
/** @type {L.TileLayer | null} */
let step1GeoTileLayer = null;
/** @type {L.Polyline | null} */
let step1GeoRouteLine = null;
/** @type {L.LayerGroup | null} */
let step1GeoMarkerLayer = null;
/** @type {L.Renderer | null} */
let step1GeoVectorRenderer = null;
/** @type {L.CircleMarker | null} */
let step1FocusMarker = null;
/** @type {(Address & { lat: number, lon: number }) | null} */
let step1PendingPreviewAddress = null;
let _step1EditingIdx = -1;
const STEP1_SHOW_GEO_CIRCLES = true;
const STEP1_SHOW_FOCUS_CIRCLE = true;

function getStep1DisplayAddresses() {
  const base = Array.isArray(addresses) ? addresses.slice() : [];
  const preview = step1PendingPreviewAddress;
  if (!preview) return base;

  if (isStep1EditModeActive()) {
    const existing = base[_step1EditingIdx] || {};
    base[_step1EditingIdx] = {
      ...existing,
      ...preview,
      id: existing.id || preview.id,
      valid: preview.valid !== false,
    };
    return base;
  }

  base.push(preview);
  return base;
}

function getStep1DisplayValidAddresses() {
  return getStep1DisplayAddresses().filter((a) => a && a.valid !== false);
}

function getStep1CurrentPreviewIndex() {
  return isStep1EditModeActive() ? _step1EditingIdx : (Array.isArray(addresses) ? addresses.length : 0);
}

function updateStep1EditPreviewFromFields() {
  if (!isStep1EditModeActive()) return null;
  const existing = addresses[_step1EditingIdx];
  if (!existing) return null;
  const parsedStreetAndNumber = elStreetAndNumber ? parseStreetAndNumber(elStreetAndNumber.value) : null;
  const belongingVal = elBelongingInline ? elBelongingInline.value : (elBelongingRate ? elBelongingRate.value : existing.belonging_rate);
  step1PendingPreviewAddress = {
    ...existing,
    ...(step1PendingPreviewAddress || {}),
    id: existing.id,
    country: getValue("country") || existing.country,
    state: getValue("state") || existing.state,
    city: getValue("city") || existing.city,
    street: getValue("street") || existing.street,
    number: getValue("number") || existing.number,
    startYear: String(elStartYear?.value || existing.startYear || "").trim(),
    belonging_rate: normalizeBelongingRate(belongingVal, stableBelongingRateFromId(existing.id)),
    valid: true,
    _origCountry: getValue("country") || existing._origCountry || existing.country,
    _origCity: getValue("city") || existing._origCity || existing.city,
    _origStreet: getValue("street") || existing._origStreet || existing.street,
    _origNumber: getValue("number") || existing._origNumber || existing.number,
    _origStreetAndNumber: String(elStreetAndNumber?.value || parsedStreetAndNumber?.raw || existing._origStreetAndNumber || "").trim(),
  };
  return step1PendingPreviewAddress;
}

function ensureStep1GeoMap() {
  if (!elStep1GeoMap || step1GeoMap) return;

  step1GeoMap = L.map(elStep1GeoMap, {
    zoomControl: false,
    attributionControl: false,
    dragging: true,
    touchZoom: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    boxZoom: true,
    keyboard: true,
    tap: true,
    maxZoom: 18,
  });

  // Use the dark basemap for the data-entry map.
  step1GeoTileLayer = createBasemapTileLayer(basemapStyleId);
  if (step1GeoTileLayer) {
    step1GeoTileLayer.addTo(step1GeoMap);
  }
  applyBasemapStyleClasses();

  // Start with faded map before any addresses are entered.
  if (addresses.length === 0) {
    step1MapPreEntry = true;
    if (elStep1GeoMap) elStep1GeoMap.classList.add("map-pre-entry");
    if (elPageStep1) elPageStep1.classList.add("map-colors-dark");
  } else {
    step1MapPreEntry = false;
  }

  step1GeoMap.fitBounds(ISRAEL_BOUNDS.pad(ISRAEL_FIT_PADDING), { animate: false, paddingTopLeft: [0, 0], paddingBottomRight: [0, 0] });
  updateStep1GeoMapMarkers();
  // Kick off background coord refresh after a short settle delay.
  setTimeout(refreshAddressCoords, 800);
}

let step1SummaryPhaseActive = false;
let step1MapPreEntry = true;

// Silently re-geocode saved addresses that may have imprecise (city-level) coordinates
// due to previously cached stale data. Runs once per session after the map is ready.
let _addressCoordsRefreshDone = false;
async function refreshAddressCoords() {
  if (_addressCoordsRefreshDone) return;
  _addressCoordsRefreshDone = true;
  let changed = false;
  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    if (!addr || addr.valid === false || !String(addr.street || "").trim()) continue;
    const key = canonicalKey(addr);
    const wasCached = Boolean(geocodeCache[key]);
    let geo;
    try {
      geo = await geocodeAddress(addr);
    } catch { continue; }
    if (!wasCached) {
      // Fresh Nominatim request was made — rate-limit to respect usage policy.
      await new Promise(r => setTimeout(r, 1100));
    }
    if (!geo || !isFinite(geo.lat) || !isFinite(geo.lon)) continue;
    if (geo.matchLevel === "place") continue; // no improvement over city-level
    const oldLat = Number(addr.lat);
    const oldLon = Number(addr.lon);
    const moved = !isFinite(oldLat) || !isFinite(oldLon) ||
      Math.abs(geo.lat - oldLat) > 0.002 || Math.abs(geo.lon - oldLon) > 0.002;
    if (!moved) continue;
    addresses[i] = { ...addresses[i], lat: geo.lat, lon: geo.lon, displayName: geo.displayName || addresses[i].displayName };
    changed = true;
  }
  if (changed) {
    saveJson(STORAGE_KEY, addresses);
    updateStep1GeoMapMarkers();
    updateStep1GeoMapView();
  }
}

function isStep1ArchiveLoadedView() {
  return Boolean(elPageStep1 && elPageStep1.classList.contains("step1-archive-loaded"));
}

function getStep1GeoMarkerColor() {
  // step1SummaryPhaseActive stays true for the rest of the session once a
  // map is finished, including while re-editing it afterward -- forcing
  // black here was never actually exercised in the normal finished view
  // (dots are rendered once, right before this flag flips true, and never
  // re-rendered again while just viewing), but re-editing DOES trigger a
  // re-render (every "add home" save calls updateStep1GeoMapMarkers()
  // again), so without this exception the dots would flip to black the
  // moment you save any ring during a review.
  if (step1SummaryPhaseActive && !step1EditModeAfterFinishActive && !isStep1ArchiveLoadedView()) return "#000000";
  return isDarkBasemap(basemapStyleId) ? "#f4f2ea" : "#000000";
}

function getStep1GeoRouteColor() {
  return isDarkBasemap(basemapStyleId) ? "#f3f1e6" : "#000000";
}

function getStep1GeoRouteDotFillStyle() {
  return {
    fillColor: "#f4f2ea",
    fillOpacity: 0,
  };
}


function emotionRingStrokeWeight(rate) {
  const r = Math.max(1, Math.min(10, parseFloat(rate) || 1));
  const t = (r - 1) / 9; // 0..1
  const minW = 1.5; // level 1 — same as the placeholder ring default
  const maxW = 14;  // level 10 — noticeably thick
  const gamma = 1.3;
  const shaped = Math.pow(Math.max(0, Math.min(1, t)), gamma);
  return minW + (maxW - minW) * shaped;
}

function updateCurrentEmotionRingStroke(rate) {
  if (!elStep1EmotionSvg) return;
  const ringsGroup = elStep1EmotionSvg.querySelector("[data-layer='step1-emotion-rings']");
  const container = ringsGroup || elStep1EmotionSvg;
  const allRings = Array.from(container.children).filter(
    (el) => el.tagName === "circle" || el.tagName === "path"
  );
  const idx = getStep1CurrentPreviewIndex();
  if (idx < allRings.length) {
    const w = emotionRingStrokeWeight(rate);
    allRings[idx].setAttribute("stroke-width", String(w));
    // Keep the ring's own breathe-loop state in sync too -- otherwise the
    // updateAllEmotionRingAngles() call right after this one reads the
    // stale pre-drag ring.sw as its new transition's start value and the
    // stroke visibly snaps back before re-animating to what we just set.
    const ringData = _activeEmotionRings.find((r) => r.idx === idx);
    if (ringData) {
      ringData.sw = w;
      if (ringData._transition) ringData._transition.oldSW = w;
    }
  }
}


function getStep1GeoRouteLatLngs() {
  const pts = [];
  for (const addr of getStep1DisplayValidAddresses()) {
    if (isFinite(addr?.lat) && isFinite(addr?.lon)) {
      pts.push(L.latLng(Number(addr.lat), Number(addr.lon)));
    }
  }
  return pts;
}

function getStep1GeoPointAddresses() {
  const pts = [];
  for (const addr of getStep1DisplayAddresses()) {
    if (!addr || addr.valid === false) continue;
    if (!isFinite(addr.lat) || !isFinite(addr.lon)) continue;
    pts.push(addr);
  }
  return pts;
}

function renderStep1GeoMapDots() {
  if (!step1GeoMap) return;
  if (!step1GeoMarkerLayer) {
    step1GeoMarkerLayer = L.layerGroup().addTo(step1GeoMap);
  }
  step1GeoMarkerLayer.clearLayers();
  if (!STEP1_SHOW_GEO_CIRCLES) return;
  if (!step1GeoVectorRenderer) step1GeoVectorRenderer = L.svg();

  const color = getStep1GeoMarkerColor();
  getStep1GeoPointAddresses().forEach((addr, index) => {
    const rate = normalizeBelongingRate(addr.belonging_rate, stableBelongingRateFromId(addr.id || `step1-${index}`));
    const radius = addressDotRadius(rate);
    const dot = L.circleMarker([Number(addr.lat), Number(addr.lon)], {
      renderer: step1GeoVectorRenderer,
      className: "lifepathStep1GeoDot",
      radius,
      weight: belongingCircleStrokeWeight(rate),
      opacity: 1,
      color,
      ...getStep1GeoRouteDotFillStyle(),
    });
    dot.addTo(step1GeoMarkerLayer);
  });
}

function updateStep1GeoRouteLine() {
  if (!step1GeoMap) return;
  if (step1GeoRouteLine) {
    try {
      step1GeoMap.removeLayer(step1GeoRouteLine);
    } catch {
      // ignore
    }
    step1GeoRouteLine = null;
  }

  const pts = getStep1GeoRouteLatLngs();
  if (pts.length < 2) return;
  if (!step1GeoVectorRenderer) step1GeoVectorRenderer = L.svg();
  step1GeoRouteLine = L.polyline(pts, {
    renderer: step1GeoVectorRenderer,
    className: "lifepathStep2Path",
    weight: 1,
    opacity: 1,
    color: getStep1GeoRouteColor(),
    lineCap: "round",
    lineJoin: "round",
  }).addTo(step1GeoMap);
  if (typeof step1GeoRouteLine.bringToBack === "function") step1GeoRouteLine.bringToBack();
}

function updateStep1GeoMapMarkers() {
  ensureStep1GeoMap();
  renderStep1GeoMapDots();
  updateStep1GeoRouteLine();
  updateStep1RoutePreview();
  updateStep1HomesList();
  updateStep1PanelStats();
  updateStep1JourneyTimeline();
  updateStep1RingReading();
  updateStep1TimeBelonging();
}

function clearStep1GeoMapState() {
  try {
    if (step1GeoMarkerLayer) step1GeoMarkerLayer.clearLayers();
    if (step1GeoRouteLine && step1GeoMap) step1GeoMap.removeLayer(step1GeoRouteLine);
    step1GeoRouteLine = null;
    clearStep1FocusMarker();
    step1MapPreEntry = true;
    if (elStep1GeoMap) elStep1GeoMap.classList.add("map-pre-entry");
    if (elPageStep1) elPageStep1.classList.add("map-colors-dark");
    if (elStep1RoutePreview) elStep1RoutePreview.innerHTML = "";
    if (step1GeoMap) {
      step1GeoMap.fitBounds(ISRAEL_BOUNDS.pad(ISRAEL_FIT_PADDING), {
        animate: false,
        paddingTopLeft: [0, 0],
        paddingBottomRight: [0, 0],
      });
    }
  } catch {
    // ignore
  }
}

function fitStep1GeoMapToIsraelBoundaries(options) {
  const opts = options && typeof options === "object" ? options : {};
  ensureStep1GeoMap();
  if (!step1GeoMap) return;

  const israelPts = getStep1GeoRouteLatLngs().filter((ll) => ISRAEL_BOUNDS.contains(ll));
  const bounds = israelPts.length > 1 ? L.latLngBounds(israelPts) : ISRAEL_BOUNDS;
  const pad = israelPts.length > 1 ? 0.15 : ISRAEL_FIT_PADDING;

  step1MapPreEntry = false;
  if (elStep1GeoMap) elStep1GeoMap.classList.remove("map-pre-entry");
  if (elPageStep1) elPageStep1.classList.remove("map-colors-dark");

  const applyFit = () => {
    if (!step1GeoMap) return;
    step1GeoMap.invalidateSize(true);
    if (israelPts.length === 1) {
      step1GeoMap.setView(israelPts[0], 15.5, { animate: false });
      return;
    }
    step1GeoMap.fitBounds(bounds.pad(pad), {
      animate: false,
      paddingTopLeft: [0, 0],
      paddingBottomRight: [0, 0],
    });
  };

  if (opts.animate) {
    step1GeoMap.invalidateSize(true);
    requestAnimationFrame(() => {
      if (!step1GeoMap) return;
      step1GeoMap.invalidateSize(true);
      if (israelPts.length === 1) {
        step1GeoMap.flyTo(israelPts[0], 15.5, { animate: true, duration: 1.4, easeLinearity: 0.25 });
      } else {
        step1GeoMap.flyToBounds(bounds.pad(pad), {
          animate: true,
          duration: 1.4,
          easeLinearity: 0.25,
          paddingTopLeft: [0, 0],
          paddingBottomRight: [0, 0],
        });
      }
    });
    setTimeout(() => {
      if (step1GeoMap) step1GeoMap.invalidateSize(true);
    }, 120);
    return;
  }

  applyFit();
  requestAnimationFrame(applyFit);
  setTimeout(applyFit, 120);
}

function updateStep1GeoMapView() {}

function focusStep1GeoMapAt(lat, lon, zoom, options) {
  const opts = options && typeof options === "object" ? options : {};
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return;
  if (step1EditModeAfterFinishActive || isStep1ArchiveLoadedView()) {
    fitStep1GeoMapToIsraelBoundaries({ animate: Boolean(opts.animate) });
    return;
  }
  ensureStep1GeoMap();
  if (!step1GeoMap) return;

  const maxZoom = Number(step1GeoMap.getMaxZoom && step1GeoMap.getMaxZoom());
  const targetZoom = Math.min(Number.isFinite(maxZoom) ? maxZoom : 18, Math.max(1, Number(zoom) || 12));
  const applyFocus = () => {
    if (!step1GeoMap) return;
    step1GeoMap.invalidateSize(true);
    step1GeoMap.setView([latNum, lonNum], targetZoom, { animate: false });
  };

  step1MapPreEntry = false;
  if (elStep1GeoMap) elStep1GeoMap.classList.remove("map-pre-entry");
  if (elPageStep1) elPageStep1.classList.remove("map-colors-dark");

  if (opts.animate) {
    step1GeoMap.invalidateSize(true);
    requestAnimationFrame(() => {
      if (!step1GeoMap) return;
      step1GeoMap.invalidateSize(true);
      step1GeoMap.flyTo([latNum, lonNum], targetZoom, { animate: true, duration: 1.05 });
    });
    setTimeout(() => {
      if (step1GeoMap) step1GeoMap.invalidateSize(true);
    }, 120);
    return;
  }

  applyFocus();
  requestAnimationFrame(applyFocus);
  setTimeout(applyFocus, 120);
}

function fitStep1GeoMapToAllAddresses(options) {
  const opts = options && typeof options === "object" ? options : {};
  ensureStep1GeoMap();
  if (!step1GeoMap) return;

  const allPts = getStep1GeoRouteLatLngs();
  if (!allPts.length) return;
  // On finish, focus on Israel only, even if a home outside Israel was
  // entered along the way (during entry itself, focusStep1GeoMapAt() still
  // centers on whatever address was just typed, wherever it is -- this
  // only changes the final, zoomed-out "whole route" view). Falls back to
  // every point if none happen to be in Israel, same convention as All
  // Maps' own Israel-first fit.
  const israelPts = allPts.filter((ll) => ISRAEL_BOUNDS.contains(ll));
  const pts = israelPts.length > 0 ? israelPts : allPts;

  step1MapPreEntry = false;
  if (elStep1GeoMap) elStep1GeoMap.classList.remove("map-pre-entry");
  if (elPageStep1) elPageStep1.classList.remove("map-colors-dark");

  if (opts.animate) {
    // A single flyTo/flyToBounds call with an explicit duration reads as one
    // soft, continuous motion. Calling fitBounds repeatedly (as the
    // non-animated retry loop below does) would restart the animation each
    // time and look like a jerky snap instead.
    step1GeoMap.invalidateSize(true);
    requestAnimationFrame(() => {
      if (!step1GeoMap) return;
      step1GeoMap.invalidateSize(true);
      if (pts.length === 1) {
        step1GeoMap.flyTo(pts[0], 15.5, { animate: true, duration: 1.4, easeLinearity: 0.25 });
      } else {
        const bounds = L.latLngBounds(pts);
        step1GeoMap.flyToBounds(bounds.pad(0.15), { animate: true, duration: 1.4, easeLinearity: 0.25 });
      }
    });
    setTimeout(() => {
      if (step1GeoMap) step1GeoMap.invalidateSize(true);
    }, 120);
    return;
  }

  const applyFit = () => {
    if (!step1GeoMap) return;
    step1GeoMap.invalidateSize(true);
    if (pts.length === 1) {
      step1GeoMap.setView(pts[0], 15.5, { animate: false });
      return;
    }
    const bounds = L.latLngBounds(pts);
    step1GeoMap.fitBounds(bounds.pad(0.15), { animate: false });
  };

  applyFit();
  requestAnimationFrame(applyFit);
  setTimeout(applyFit, 120);
}

/** @type {number | null} */

const elStep1RoutePreview = document.getElementById("step1RoutePreview");

let _routePreviewPrevPtCount = 0;
let _step1RoutePreviewHoverArmed = false;
let _step1RoutePreviewTooltipEl = null;
let _step1RoutePreviewHoveredDot = null;

function getStep1RoutePreviewDots() {
  if (!elStep1RoutePreview) return [];
  return Array.from(elStep1RoutePreview.querySelectorAll("circle[data-step1-route-dot='1']"));
}

function getStep1RoutePreviewLines() {
  if (!elStep1RoutePreview) return [];
  return Array.from(elStep1RoutePreview.querySelectorAll("path[data-step1-route-line='1'], line[data-step1-route-line='1']"));
}

function ensureStep1RoutePreviewTooltipEl() {
  if (_step1RoutePreviewTooltipEl) return _step1RoutePreviewTooltipEl;
  try {
    const el = document.createElement("div");
    el.id = "step1RoutePreviewTooltip";
    el.style.cssText = "position:fixed;pointer-events:none;font-family:'NarkissBlock-Light-TRIAL',sans-serif;font-size:16px;line-height:1.2;color:#000000;white-space:nowrap;display:none;z-index:9000;text-transform:none;";
    document.body.appendChild(el);
    _step1RoutePreviewTooltipEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideStep1RoutePreviewTooltip() {
  const tooltip = _step1RoutePreviewTooltipEl;
  if (!tooltip) return;
  tooltip.style.display = "none";
}

function showStep1RoutePreviewTooltip(dot, clientX, clientY) {
  const tooltip = ensureStep1RoutePreviewTooltipEl();
  if (!tooltip || !dot) return;
  const homeLabel = String(dot.getAttribute("data-home-label") || "").trim();
  const addressLabel = String(dot.getAttribute("data-address-label") || "").trim();
  if (!homeLabel && !addressLabel) return;
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--step1-scale")) || 1;
  tooltip.style.fontSize = (16 * scale) + "px";
  tooltip.innerHTML = "";
  const homeEl = document.createElement("div");
  homeEl.textContent = homeLabel;
  const addressEl = document.createElement("div");
  addressEl.textContent = addressLabel;
  tooltip.append(homeEl, addressEl);
  tooltip.style.left = (Number(clientX) + 14) + "px";
  tooltip.style.top = (Number(clientY) - 8) + "px";
  tooltip.style.display = "block";
}

function setStep1RoutePreviewHover(targetDot) {
  if (areStep1MapSpecificInteractionsDisabled()) {
    targetDot = null;
  }
  _step1RoutePreviewHoveredDot = targetDot || null;
  for (const line of getStep1RoutePreviewLines()) {
    line.setAttribute("stroke", targetDot ? "#c3c1b7" : "#000000");
  }
  for (const dot of getStep1RoutePreviewDots()) {
    dot.setAttribute("stroke", dot === targetDot ? "#000000" : (targetDot ? "#c3c1b7" : "#000000"));
  }
}

function setStep1RoutePreviewEditFocus(idx = _step1EditingIdx) {
  const dots = getStep1RoutePreviewDots();
  const hasFocus = isStep1EditModeActive() && idx >= 0 && dots.some((dot) => Number(dot.dataset.addressIndex) === idx);
  for (const line of getStep1RoutePreviewLines()) {
    line.setAttribute("stroke", hasFocus ? "#c3c1b7" : "#000000");
  }
  dots.forEach((dot, dotIdx) => {
    const addressIdx = Number(dot.dataset.addressIndex);
    dot.setAttribute("stroke", hasFocus && addressIdx !== idx ? "#c3c1b7" : "#000000");
  });
}

function clearStep1RoutePreviewHover() {
  _step1RoutePreviewHoveredDot = null;
  if (isStep1EditModeActive()) setStep1RoutePreviewEditFocus();
  else setStep1RoutePreviewHover(null);
  hideStep1RoutePreviewTooltip();
}

function armStep1RoutePreviewHover() {
  if (!elStep1RoutePreview || _step1RoutePreviewHoverArmed) return;
  _step1RoutePreviewHoverArmed = true;

  const dotFromEventTarget = (target) => {
    try {
      if (!target || typeof target.closest !== "function") return null;
      return target.closest("circle[data-step1-route-dot='1']");
    } catch {
      return null;
    }
  };

  elStep1RoutePreview.addEventListener("pointermove", (e) => {
    if (areStep1MapSpecificInteractionsDisabled()) {
      clearStep1RoutePreviewHover();
      return;
    }
    if (!_step1RoutePreviewHoveredDot) return;
    showStep1RoutePreviewTooltip(_step1RoutePreviewHoveredDot, e.clientX, e.clientY);
  }, { passive: true });

  elStep1RoutePreview.addEventListener("pointerover", (e) => {
    if (areStep1MapSpecificInteractionsDisabled()) {
      clearStep1RoutePreviewHover();
      return;
    }
    const dot = dotFromEventTarget(e.target);
    if (!dot) return;
    setStep1RoutePreviewHover(dot);
    showStep1RoutePreviewTooltip(dot, e.clientX, e.clientY);
  }, { passive: true });

  elStep1RoutePreview.addEventListener("pointerout", (e) => {
    if (areStep1MapSpecificInteractionsDisabled()) {
      clearStep1RoutePreviewHover();
      return;
    }
    const fromDot = dotFromEventTarget(e.target);
    if (!fromDot) return;
    const toDot = dotFromEventTarget(e.relatedTarget);
    if (toDot) {
      setStep1RoutePreviewHover(toDot);
      showStep1RoutePreviewTooltip(toDot, e.clientX, e.clientY);
      return;
    }
    clearStep1RoutePreviewHover();
  }, { passive: true });

  elStep1RoutePreview.addEventListener("pointerleave", clearStep1RoutePreviewHover, { passive: true });

  elStep1RoutePreview.addEventListener("click", (e) => {
    if (areStep1MapSpecificInteractionsDisabled()) {
      clearStep1RoutePreviewHover();
      return;
    }
    const dot = dotFromEventTarget(e.target);
    if (!dot) return;
    const ringIdx = Number(dot.dataset.addressIndex);
    if (ringIdx < 0) return;
    openStep1HomeEditMode(ringIdx);
  });
}

function updateStep1RoutePreview() {
  if (!elStep1RoutePreview) return;
  armStep1RoutePreviewHover();

  const allAddrs = getStep1DisplayAddresses()
    .filter((a) => a && a.valid !== false && isFinite(a.lat) && isFinite(a.lon));

  const isInIsrael = (lat, lon) => ISRAEL_BOUNDS.contains(L.latLng(Number(lat), Number(lon)));
  const pts = allAddrs.map((a, index) => ({
    lat: Number(a.lat),
    lon: Number(a.lon),
    inIsrael: isInIsrael(a.lat, a.lon),
    rate: normalizeBelongingRate(a.belonging_rate, stableBelongingRateFromId(a.id)),
    homeLabel: `home no.${formatHomeNumber(index + 1)}`,
    addressLabel: formatAddressAsTyped(a),
    addressIndex: index,
  }));

  const israelPts = pts.filter((p) => p.inIsrael);
  const viewPts = israelPts.length > 0 ? israelPts : pts;
  const viewAddressIndexes = new Set(viewPts.map((p) => p.addressIndex));

  // Track the displayed point count, including the current address preview, so
  // the route animation runs while entering the address and does not rerun on save.
  const isNewPoint = pts.length > _routePreviewPrevPtCount && pts.length >= 2;
  _routePreviewPrevPtCount = pts.length;

  if (pts.length === 0) {
    elStep1RoutePreview.innerHTML = "";
    return;
  }

  const panelRect = elStep1RoutePreview.getBoundingClientRect();
  const svgW = Math.max(1, panelRect.width || 460);
  const svgH = Math.max(1, panelRect.height || 500);
  const NS = "http://www.w3.org/2000/svg";

  const screenToSvgSize = Math.max(
    svgW / Math.max(1, panelRect.width || svgW),
    svgH / Math.max(1, panelRect.height || svgH)
  );
  const routePreviewStrokeWeightPx = (rate) => routePreviewStrokeWeight(rate) * screenToSvgSize;
  const routePreviewDotRadiusPx = (rate) => ROUTE_PREVIEW_DOT_INNER_RADIUS * screenToSvgSize + routePreviewStrokeWeightPx(rate) / 2;

  const MAX_BELONGING_RATE = 10;
  // Screen-pixel-aware radius/stroke: the SVG viewBox follows the rendered
  // panel size, and these values are converted from target pixels to SVG units.
  const MAX_STROKE_WIDTH = routePreviewStrokeWeightPx(MAX_BELONGING_RATE);
  const MAX_OUTER_RADIUS = ROUTE_PREVIEW_DOT_INNER_RADIUS * screenToSvgSize + MAX_STROKE_WIDTH;
  const BORDER_INSET = 5;
  const minCenterX = BORDER_INSET + MAX_OUTER_RADIUS;
  const maxCenterX = svgW - BORDER_INSET - MAX_OUTER_RADIUS;
  const minCenterY = BORDER_INSET + MAX_OUTER_RADIUS;
  const maxCenterY = svgH - BORDER_INSET - MAX_OUTER_RADIUS;
  const innerW = Math.max(1, maxCenterX - minCenterX);
  const innerH = Math.max(1, maxCenterY - minCenterY);

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of viewPts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const latRange = Math.max(0.01, maxLat - minLat);
  const lonRange = Math.max(0.01, maxLon - minLon);
  // Keep map relation faithful: use a uniform scale for both axes.
  const scale = Math.min(innerW / lonRange, innerH / latRange);
  const drawW = lonRange * scale;
  const drawH = latRange * scale;
  const offsetX = minCenterX + (innerW - drawW) / 2;
  const offsetY = minCenterY + (innerH - drawH) / 2;
  const toX = (lon) => Math.round((offsetX + (lon - minLon) * scale) * 10) / 10;
  const toY = (lat) => Math.round((offsetY + (maxLat - lat) * scale) * 10) / 10;

  // Build all route coords. The scale/center is computed from Israeli points
  // only, but off-Israel points remain in the path so lines still head outward
  // and clip naturally at the panel edge.
  const coords = pts.map((p) => {
    return {
      x: toX(p.lon),
      y: toY(p.lat),
      rate: p.rate,
      homeLabel: p.homeLabel,
      addressLabel: p.addressLabel,
      addressIndex: p.addressIndex,
      inIsrael: p.inIsrael,
    };
  });

  if (coords.length > 0) {
    const fitCoords = coords.filter((c) => viewAddressIndexes.has(c.addressIndex));
    const zoomCoords = fitCoords.length > 0 ? fitCoords : coords;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of zoomCoords) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
    }

    // Zoom-to-fit all points while preserving map aspect relation (uniform scale).
    const fitW = Math.max(1, maxX - minX);
    const fitH = Math.max(1, maxY - minY);
    const zoomFit = Math.min(innerW / fitW, innerH / fitH);
    // Was capped at 8x, which left closely-clustered homes (e.g. all in the
    // same city) drawn tiny in the middle of a mostly-empty box instead of
    // actually filling it -- raised so it can zoom in as far as the points'
    // own spread calls for.
    const ROUTE_PREVIEW_ZOOM_RATIO = 0.8;
    const zoom = Math.max(0.2, Math.min(40, zoomFit * ROUTE_PREVIEW_ZOOM_RATIO));
    const srcCx = (minX + maxX) / 2;
    const srcCy = (minY + maxY) / 2;
    const dstCx = (minCenterX + maxCenterX) / 2;
    const dstCy = (minCenterY + maxCenterY) / 2;

    for (const c of coords) {
      c.x = (c.x - srcCx) * zoom + dstCx;
      c.y = (c.y - srcCy) * zoom + dstCy;
    }

    const bottomMostVisibleY = Math.max(...zoomCoords.map((c) => c.y));
    const lowerIntoFrameShift = Math.max(0, maxCenterY - bottomMostVisibleY);
    if (lowerIntoFrameShift > 0) {
      for (const c of coords) c.y += lowerIntoFrameShift;
    }
  }

  // Build SVG from scratch.
  elStep1RoutePreview.innerHTML = "";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(svgW));
  svg.setAttribute("height", String(svgH));
  svg.setAttribute("viewBox", `0 0 ${svgW} ${svgH}`);
  svg.setAttribute("preserveAspectRatio", "none");

  const clipRouteSegmentToPanel = (a, b) => {
    const canReachPanelFrame = !a.inIsrael || !b.inIsrael;
    const xMin = canReachPanelFrame ? 0 : minCenterX;
    const xMax = canReachPanelFrame ? svgW : maxCenterX;
    const yMin = canReachPanelFrame ? 0 : minCenterY;
    const yMax = canReachPanelFrame ? svgH : maxCenterY;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;
    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    };
    if (
      !clip(-dx, a.x - xMin) ||
      !clip(dx, xMax - a.x) ||
      !clip(-dy, a.y - yMin) ||
      !clip(dy, yMax - a.y)
    ) {
      return null;
    }
    return [
      { x: a.x + t0 * dx, y: a.y + t0 * dy },
      { x: a.x + t1 * dx, y: a.y + t1 * dy },
    ];
  };

  // Draw lines for all but the last segment (already completed).
  if (coords.length >= 2) {
    let pathD = "";
    const lineEnd = isNewPoint ? coords.length - 1 : coords.length;
    for (let i = 1; i < lineEnd; i++) {
      const clipped = clipRouteSegmentToPanel(coords[i - 1], coords[i]);
      if (!clipped) continue;
      pathD += `M${clipped[0].x},${clipped[0].y}L${clipped[1].x},${clipped[1].y}`;
    }
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", pathD);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#000000");
    path.setAttribute("stroke-width", "0.6");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("data-step1-route-line", "1");
    svg.appendChild(path);

    // Animate the last segment if a new point was added.
    if (isNewPoint) {
      const prev = coords[coords.length - 2];
      const last = coords[coords.length - 1];
      const clippedAnimationSegment = clipRouteSegmentToPanel(prev, last);
      const animLine = document.createElementNS(NS, "line");
      const animFrom = clippedAnimationSegment ? clippedAnimationSegment[0] : prev;
      const animTo = clippedAnimationSegment ? clippedAnimationSegment[1] : prev;
      animLine.setAttribute("x1", String(animFrom.x));
      animLine.setAttribute("y1", String(animFrom.y));
      animLine.setAttribute("x2", String(animFrom.x));
      animLine.setAttribute("y2", String(animFrom.y));
      animLine.setAttribute("stroke", "#000000");
      animLine.setAttribute("stroke-width", "0.6");
      animLine.setAttribute("stroke-linecap", "round");
      animLine.setAttribute("data-step1-route-line", "1");
      svg.appendChild(animLine);

      // Animate line stretching.
      const duration = 600;
      const start = performance.now();
      const growLine = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const ease = 1 - Math.pow(1 - t, 3);
        animLine.setAttribute("x2", String(animFrom.x + (animTo.x - animFrom.x) * ease));
        animLine.setAttribute("y2", String(animFrom.y + (animTo.y - animFrom.y) * ease));
        if (t < 1) {
          requestAnimationFrame(growLine);
        } else {
          // Line complete — now grow the dot.
          const sw = routePreviewStrokeWeightPx(last.rate);
          const r = routePreviewDotRadiusPx(last.rate);
          const dot = document.createElementNS(NS, "circle");
          dot.setAttribute("cx", String(last.x));
          dot.setAttribute("cy", String(last.y));
          dot.setAttribute("r", "0");
          dot.setAttribute("fill", "#f4f2ea");
          dot.setAttribute("stroke", "#000000");
          dot.setAttribute("stroke-width", String(sw));
          dot.setAttribute("data-step1-route-dot", "1");
          dot.setAttribute("data-address-index", String(last.addressIndex));
          dot.setAttribute("data-home-label", last.homeLabel || "");
          dot.setAttribute("data-address-label", last.addressLabel || "");
          dot.style.pointerEvents = "all";
          svg.appendChild(dot);
          const dotStart = performance.now();
          const growDot = (now2) => {
            const t2 = Math.min(1, (now2 - dotStart) / 300);
            const ease2 = 1 - Math.pow(1 - t2, 3);
            dot.setAttribute("r", String(r * ease2));
            if (t2 < 1) requestAnimationFrame(growDot);
          };
          requestAnimationFrame(growDot);
        }
      };
      requestAnimationFrame(growLine);
    }
  }

  // Draw dots for all existing points (not the new animated one).
  const dotEnd = isNewPoint ? coords.length - 1 : coords.length;
  for (let i = 0; i < dotEnd; i++) {
    const c = coords[i];
    const sw = routePreviewStrokeWeightPx(c.rate);
    const r = routePreviewDotRadiusPx(c.rate);
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(c.x));
    dot.setAttribute("cy", String(c.y));
    dot.setAttribute("r", String(r));
    dot.setAttribute("fill", "#f4f2ea");
    dot.setAttribute("stroke", "#000000");
    dot.setAttribute("stroke-width", String(sw));
    dot.setAttribute("data-step1-route-dot", "1");
    dot.setAttribute("data-address-index", String(c.addressIndex));
    dot.setAttribute("data-home-label", c.homeLabel || "");
    dot.setAttribute("data-address-label", c.addressLabel || "");
    dot.style.pointerEvents = "all";
    svg.appendChild(dot);
  }

  elStep1RoutePreview.appendChild(svg);
  setStep1RoutePreviewEditFocus();
}

let _step1RoutePreviewLayoutRaf = 0;
function scheduleStep1RoutePreviewLayoutUpdate() {
  if (_step1RoutePreviewLayoutRaf) cancelAnimationFrame(_step1RoutePreviewLayoutRaf);
  _step1RoutePreviewLayoutRaf = requestAnimationFrame(() => {
    _step1RoutePreviewLayoutRaf = requestAnimationFrame(() => {
      _step1RoutePreviewLayoutRaf = 0;
      if (!elPageStep1 || elPageStep1.classList.contains("hidden")) return;
      updateStep1RoutePreview();
    });
  });
}

// --- Panel Stats (avg belonging + journey distance) ---

const elStep1AvgBelonging = document.getElementById("step1AvgBelonging");
const elStep1JourneyDistance = document.getElementById("step1JourneyDistance");
const elStep1JourneyTimeline = document.getElementById("step1JourneyTimeline");
const elStep1HomeCountLabel = document.getElementById("step1HomeCountLabel");

// Small year-axis timeline next to "journey distance": left end is the first
// home's start year, right end is fixed at 2026 (same "current" convention
// used for the last home's still-ongoing duration elsewhere — see
// _tbCalcDurations()/home-list end-year above). One circle per home, placed
// along the line by its start year and sized/stroked by its belonging rate,
// same visual language as the route preview's dots (belongingCircleStrokeWeight()).
function updateStep1JourneyTimeline() {
  const svgHost = elStep1JourneyTimeline;
  if (!svgHost) return;

  const withYears = getStep1DisplayValidAddresses()
    .map((addr) => ({ addr, year: parseInt(String(addr.startYear || ""), 10) }))
    .filter((entry) => Number.isFinite(entry.year));

  if (withYears.length === 0) {
    svgHost.innerHTML = "";
    return;
  }

  const NS = "http://www.w3.org/2000/svg";
  const endYear = 2026;
  const firstYear = withYears[0].year;
  const span = Math.max(1, endYear - firstYear);
  // Matches .step1JourneyTimeline's CSS width — keep these two in sync.
  const vbW = 950;
  const labelGap = 10;
  const lineY = 12;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${vbW} 24`);

  // Year labels sit flush against the timeline's own ends -- the start
  // year's left edge at x=0 (the geographic map's own right edge in the
  // finished layout) and the end year's right edge at x=vbW (the rightmost
  // divider line), extending inward. The axis line/dots below are then
  // inset just enough to clear whatever room these labels actually need.
  const firstYearLabel = document.createElementNS(NS, "text");
  firstYearLabel.setAttribute("x", "0");
  firstYearLabel.setAttribute("y", String(lineY));
  firstYearLabel.setAttribute("text-anchor", "start");
  firstYearLabel.setAttribute("dominant-baseline", "middle");
  firstYearLabel.textContent = String(firstYear);
  svg.appendChild(firstYearLabel);

  const endYearLabel = document.createElementNS(NS, "text");
  endYearLabel.setAttribute("x", String(vbW));
  endYearLabel.setAttribute("y", String(lineY));
  endYearLabel.setAttribute("text-anchor", "end");
  endYearLabel.setAttribute("dominant-baseline", "middle");
  endYearLabel.textContent = String(endYear);
  svg.appendChild(endYearLabel);

  // Attach before measuring -- getComputedTextLength() needs live layout,
  // and font metrics aren't fixed-width, so this is the actual rendered
  // width rather than a guessed constant.
  svgHost.innerHTML = "";
  svgHost.appendChild(svg);
  let firstLabelWidth = 0;
  let endLabelWidth = 0;
  try { firstLabelWidth = firstYearLabel.getComputedTextLength() || 0; } catch { /* ignore */ }
  try { endLabelWidth = endYearLabel.getComputedTextLength() || 0; } catch { /* ignore */ }

  // Extra 10px inset beyond the label clearance above -- shortens the line
  // (and, so dots stay sitting exactly on it, the year-to-x mapping too)
  // without moving the year labels themselves, which stay flush at 0/vbW.
  const lineInset = 30;
  const xStart = firstLabelWidth + labelGap + lineInset;
  const xEnd = vbW - endLabelWidth - labelGap - lineInset;
  const yearToX = (year) => xStart + ((year - firstYear) / span) * (xEnd - xStart);

  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", String(xStart));
  line.setAttribute("y1", String(lineY));
  line.setAttribute("x2", String(xEnd));
  line.setAttribute("y2", String(lineY));
  line.setAttribute("stroke", "#000000");
  line.setAttribute("stroke-width", "0.6");
  svg.appendChild(line);

  // Same fixed inner radius + outward-only stroke growth as the geo map and
  // route preview dots (see addressDotRadius()) -- all three stay pixel-
  // consistent with each other.
  withYears.forEach(({ addr, year }, index) => {
    const rate = normalizeBelongingRate(addr.belonging_rate, 5);
    const sw = belongingCircleStrokeWeight(rate);
    const r = addressDotRadius(rate);
    const dot = document.createElementNS(NS, "circle");
    // The leftmost (first/earliest-year) dot only, nudged 3px right of
    // where yearToX() would otherwise place it.
    const cx = yearToX(Math.min(endYear, Math.max(firstYear, year))) + (index === 0 ? 3 : 0);
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(lineY));
    dot.setAttribute("r", String(r));
    dot.setAttribute("fill", "#f4f2ea");
    dot.setAttribute("stroke", "#000000");
    dot.setAttribute("stroke-width", String(sw));
    svg.appendChild(dot);
  });
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateStep1PanelStats() {
  const validAddrs = getStep1DisplayValidAddresses();

  if (elStep1HomeCountLabel) {
    elStep1HomeCountLabel.textContent = validAddrs.length > 0
      ? `${String(validAddrs.length).padStart(2, "0")} homes`
      : "";
  }

  // Avg belonging
  if (elStep1AvgBelonging) {
    if (validAddrs.length === 0) {
      elStep1AvgBelonging.textContent = `avg belonging`;
      elStep1AvgBelonging.style.color = "#c3c1b7";
    } else {
      const sum = validAddrs.reduce((s, a) => s + normalizeBelongingRate(a.belonging_rate, 5), 0);
      const avg = Math.round((sum / validAddrs.length) * 10) / 10;
      elStep1AvgBelonging.innerHTML = `avg belonging    <span class="step1PanelStatValue">${avg}</span>`;
      elStep1AvgBelonging.style.color = "#000000";
    }
  }

  // Journey distance
  if (elStep1JourneyDistance) {
    const withCoords = validAddrs.filter((a) => isFinite(a.lat) && isFinite(a.lon));
    if (withCoords.length < 2) {
      elStep1JourneyDistance.textContent = `journey distance`;
      elStep1JourneyDistance.style.color = "#c3c1b7";
    } else {
      let totalKm = 0;
      for (let i = 1; i < withCoords.length; i++) {
        totalKm += haversineKm(withCoords[i - 1].lat, withCoords[i - 1].lon, withCoords[i].lat, withCoords[i].lon);
      }
      const display = totalKm < 1 ? `${Math.round(totalKm * 1000)} m` : `${Math.round(totalKm)} km`;
      elStep1JourneyDistance.innerHTML = `journey distance    <span class="step1PanelStatValue">${display}</span>`;
      elStep1JourneyDistance.style.color = "#000000";
    }
  }
}

// --- Time & Belonging line chart ---

const elStep1TimeBelongingChart = document.getElementById("step1TimeBelongingChart");

let _tbSvg = null;
let _tbPoints = [];
let _tbDurPoints = [];

function _tbCalcDurations(validAddrs, isLastHome) {
  return validAddrs.map((addr, i) => {
    const start = parseInt(String(addr.startYear || ""), 10);
    if (!isFinite(start)) return null;
    if (i < validAddrs.length - 1) {
      const nextStart = parseInt(String(validAddrs[i + 1].startYear || ""), 10);
      if (!isFinite(nextStart)) return null;
      return Math.max(1, nextStart - start);
    }
    // Last home: only show duration once finish is pressed (isLastHome)
    if (isLastHome) return Math.max(1, 2026 - start);
    return null;
  });
}

function _tbDrawDurationCurve(svg, NS, durPoints, belongingPoints, durations, belongingRates, skipAnim) {
  // Only remove connectors and labels — dur-line/dur-dot are managed incrementally.
  svg.querySelectorAll(".tb-connector, .tb-label").forEach((el) => el.remove());

  const vb = parseSvgViewBox(svg.getAttribute("viewBox") || "0 0 400 180");
  const chartW = Number(vb?.w) > 0 ? Number(vb.w) : 400;
  const chartH = Number(vb?.h) > 0 ? Number(vb.h) : 180;
  const padX = Math.max(26, Math.round(chartW * 0.1));
  const padTop = Math.max(12, Math.round(chartH * 0.06));
  const padBottom = Math.max(10, Math.round(chartH * 0.04));
  const plotH = chartH - padTop - padBottom;
  const maxScale = 10;

  const firstBelonging = svg.querySelector(".tb-line-seg, .tb-dot");

  // Vertical connector lines between belonging and duration dots
  for (const dp of durPoints) {
    const bp = belongingPoints.find((p) => Math.abs(p.x - dp.x) < 1);
    if (!bp) continue;
    const conn = document.createElementNS(NS, "line");
    conn.setAttribute("x1", String(dp.x));
    conn.setAttribute("y1", String(Math.min(dp.y, bp.y)));
    conn.setAttribute("x2", String(dp.x));
    conn.setAttribute("y2", String(Math.max(dp.y, bp.y)));
    conn.setAttribute("stroke", "#8e3300");
    conn.setAttribute("stroke-width", "0.3");
    conn.setAttribute("opacity", "0.4");
    conn.classList.add("tb-connector");
    if (firstBelonging) svg.insertBefore(conn, firstBelonging);
    else svg.appendChild(conn);
  }

  // Incremental animated dur-line and dur-dot — only add new ones.
  const existingDots = svg.querySelectorAll(".tb-dur-dot").length;

  if (skipAnim) {
    // Full static redraw (rebuild case)
    svg.querySelectorAll(".tb-dur-line, .tb-dur-dot").forEach((el) => el.remove());
    for (let i = 0; i < durPoints.length - 1; i++) {
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", String(durPoints[i].x));
      line.setAttribute("y1", String(durPoints[i].y));
      line.setAttribute("x2", String(durPoints[i + 1].x));
      line.setAttribute("y2", String(durPoints[i + 1].y));
      line.setAttribute("stroke", "#000000");
      line.setAttribute("stroke-width", "0.6");
      line.setAttribute("stroke-dasharray", "4 4");
      line.classList.add("tb-dur-line");
      const firstDot = svg.querySelector(".tb-dot");
      if (firstDot) svg.insertBefore(line, firstDot);
      else svg.appendChild(line);
    }
    for (const pt of durPoints) {
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", String(pt.x));
      circle.setAttribute("cy", String(pt.y));
      circle.setAttribute("r", "3");
      circle.setAttribute("fill", "#000000");
      circle.classList.add("tb-dur-dot");
      svg.appendChild(circle);
    }
  } else {
    const newDurPoints = durPoints.slice(existingDots);
    for (let i = 0; i < newDurPoints.length; i++) {
      const pt = newDurPoints[i];
      const globalIdx = existingDots + i;
      const prevPt = globalIdx > 0 ? durPoints[globalIdx - 1] : null;

      if (prevPt) {
        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", String(prevPt.x));
        line.setAttribute("y1", String(prevPt.y));
        line.setAttribute("x2", String(prevPt.x));
        line.setAttribute("y2", String(prevPt.y));
        line.setAttribute("stroke", "#000000");
        line.setAttribute("stroke-width", "0.6");
        line.setAttribute("stroke-dasharray", "4 4");
        line.classList.add("tb-dur-line");
        const firstDot = svg.querySelector(".tb-dot, .tb-dur-dot");
        if (firstDot) svg.insertBefore(line, firstDot);
        else svg.appendChild(line);

        const lineAnimDur = 400;
        const lineStart = performance.now();
        const sx = prevPt.x, sy = prevPt.y, ex = pt.x, ey = pt.y;
        (function animDurLine(now) {
          const t = Math.min((now - lineStart) / lineAnimDur, 1);
          const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          line.setAttribute("x2", String(sx + (ex - sx) * ease));
          line.setAttribute("y2", String(sy + (ey - sy) * ease));
          if (t < 1) requestAnimationFrame(animDurLine);
        })(performance.now());
      }

      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", String(pt.x));
      circle.setAttribute("cy", String(pt.y));
      circle.setAttribute("r", "0");
      circle.setAttribute("fill", "#000000");
      circle.classList.add("tb-dur-dot");
      svg.appendChild(circle);

      const dotAnimDur = 350;
      const dotDelay = prevPt ? 300 : 0;
      const dotStart = performance.now() + dotDelay;
      const targetR = 3;
      (function animDurDot(now) {
        const elapsed = now - dotStart;
        if (elapsed < 0) { requestAnimationFrame(animDurDot); return; }
        const t = Math.min(elapsed / dotAnimDur, 1);
        const ease = t < 1 ? 1 - Math.pow(1 - t, 3) * (1 - t * 0.3) : 1;
        const r = targetR * Math.min(ease * 1.15, 1 + 0.15 * Math.max(0, 1 - t * 3));
        circle.setAttribute("r", String(Math.max(0, r)));
        if (t < 1) requestAnimationFrame(animDurDot);
        else circle.setAttribute("r", String(targetR));
      })(performance.now());
    }
  }

  // Left Y-axis: fixed belonging scale 01-10
  for (let v = 1; v <= 10; v++) {
    const y = padTop + plotH - (v / maxScale) * plotH;
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", "2");
    label.setAttribute("y", String(y));
    label.setAttribute("text-anchor", "start");
    label.setAttribute("dominant-baseline", "middle");
    label.setAttribute("font-family", "NarkissBlock-Extralight-TRIAL, sans-serif");
    label.setAttribute("font-size", "13");
    label.setAttribute("fill", "#c3c1b7");
    label.textContent = String(v).padStart(2, "0");
    label.classList.add("tb-label");
    svg.appendChild(label);
  }

  // "belonging" label below left 01
  const belongingLabel = document.createElementNS(NS, "text");
  const y01Left = padTop + plotH - (1 / maxScale) * plotH;
  const maxOffsetInside = Math.max(4, chartH - y01Left - 4);
  // Keep legend labels visually close to the bottom edge without clipping.
  const bottomLabelOffset = Math.max(0, maxOffsetInside - 4);
  belongingLabel.setAttribute("x", "2");
  belongingLabel.setAttribute("y", String(y01Left + bottomLabelOffset));
  belongingLabel.setAttribute("text-anchor", "start");
  belongingLabel.setAttribute("dominant-baseline", "middle");
  belongingLabel.setAttribute("font-family", "NarkissBlock-Extralight-TRIAL, sans-serif");
  belongingLabel.setAttribute("font-size", "13");
  belongingLabel.setAttribute("fill", "#c3c1b7");
  belongingLabel.textContent = "belonging";
  belongingLabel.classList.add("tb-label");
  svg.appendChild(belongingLabel);

  // Legend line (solid) to the right of "belonging"
  const belongLegendY = y01Left + bottomLabelOffset;
  const belongLegendLine = document.createElementNS(NS, "line");
  belongLegendLine.setAttribute("x1", String(Math.max(60, padX + 18)));
  belongLegendLine.setAttribute("y1", String(belongLegendY));
  belongLegendLine.setAttribute("x2", String(Math.max(89, padX + 47)));
  belongLegendLine.setAttribute("y2", String(belongLegendY));
  belongLegendLine.setAttribute("stroke", "#afada5");
  belongLegendLine.setAttribute("stroke-width", "1.2");
  belongLegendLine.classList.add("tb-label");
  svg.appendChild(belongLegendLine);

  // Right Y-axis: fixed duration scale 01-10+
  for (let v = 1; v <= 10; v++) {
    const y = padTop + plotH - (v / maxScale) * plotH;
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(chartW - 2));
    label.setAttribute("y", String(y));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("dominant-baseline", "middle");
    label.setAttribute("font-family", "NarkissBlock-Extralight-TRIAL, sans-serif");
    label.setAttribute("font-size", "13");
    label.setAttribute("fill", "#c3c1b7");
    label.textContent = v === 10 ? "10+" : String(v).padStart(2, "0");
    label.classList.add("tb-label");
    svg.appendChild(label);
  }

  // "years" label below right 01
  const yearsLabel = document.createElementNS(NS, "text");
  const y01Right = padTop + plotH - (1 / maxScale) * plotH;
  yearsLabel.setAttribute("x", String(chartW - 2));
  yearsLabel.setAttribute("y", String(y01Right + bottomLabelOffset));
  yearsLabel.setAttribute("text-anchor", "end");
  yearsLabel.setAttribute("dominant-baseline", "middle");
  yearsLabel.setAttribute("font-family", "NarkissBlock-Extralight-TRIAL, sans-serif");
  yearsLabel.setAttribute("font-size", "13");
  yearsLabel.setAttribute("fill", "#c3c1b7");
  yearsLabel.textContent = "years";
  yearsLabel.classList.add("tb-label");
  svg.appendChild(yearsLabel);

  // Legend line (dashed) to the left of "years"
  const yearsLegendY = y01Right + bottomLabelOffset;
  const yearsLegendLine = document.createElementNS(NS, "line");
  yearsLegendLine.setAttribute("x1", String(chartW - 59));
  yearsLegendLine.setAttribute("y1", String(yearsLegendY));
  yearsLegendLine.setAttribute("x2", String(chartW - 30));
  yearsLegendLine.setAttribute("y2", String(yearsLegendY));
  yearsLegendLine.setAttribute("stroke", "#afada5");
  yearsLegendLine.setAttribute("stroke-width", "1");
  yearsLegendLine.setAttribute("stroke-dasharray", "4 4");
  yearsLegendLine.classList.add("tb-label");
  svg.appendChild(yearsLegendLine);
}

function updateStep1TimeBelonging() {
  if (!elStep1TimeBelongingChart) return;

  const validAddrs = getStep1DisplayValidAddresses();

  const NS = "http://www.w3.org/2000/svg";
  const maxRate = 10;
  const chartW = Math.max(320, Math.round(elStep1TimeBelongingChart.getBoundingClientRect().width || 400));
  const padX = Math.max(26, Math.round(chartW * 0.1));
  const chartH = Math.max(120, Math.round(elStep1TimeBelongingChart.getBoundingClientRect().height || 180));
  const padTop = Math.max(12, Math.round(chartH * 0.06));
  const padBottom = Math.max(10, Math.round(chartH * 0.04));
  const plotW = chartW - padX * 2;
  const plotH = chartH - padTop - padBottom;

  if (validAddrs.length === 0) {
    elStep1TimeBelongingChart.innerHTML = "";
    _tbSvg = null;
    _tbPoints = [];
    _tbDurPoints = [];

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(chartW));
    svg.setAttribute("height", String(chartH));
    svg.setAttribute("viewBox", `0 0 ${chartW} ${chartH}`);
    svg.style.overflow = "visible";
    svg.style.opacity = "0";
    svg.style.transform = "translateY(8px)";
    svg.style.transition = "opacity 600ms ease, transform 600ms ease";
    _tbDrawDurationCurve(svg, NS, [], [], [], []);
    elStep1TimeBelongingChart.appendChild(svg);
    requestAnimationFrame(() => {
      svg.style.opacity = "1";
      svg.style.transform = "translateY(0)";
    });
    return;
  }

  const totalExpected = Math.max(validAddrs.length, parseInt(String(elHomesCount?.value || ""), 10) || 1);
  const slotW = plotW / totalExpected;

  const belongingRates = [];
  const newPoints = validAddrs.map((addr, i) => {
    const rate = normalizeBelongingRate(addr.belonging_rate, stableBelongingRateFromId(addr.id));
    belongingRates.push(rate);
    const x = padX + slotW * i + slotW / 2;
    const y = padTop + plotH - (rate / maxRate) * plotH;
    return { x, y };
  });

  // Duration curve points — only for homes whose duration is known
  // Y-axis scale: 1-10 years, capped at 10 (10+)
  const maxDurScale = 10;
  const isLastHome = validAddrs.length >= totalExpected;
  const durations = _tbCalcDurations(validAddrs, isLastHome);
  const durPoints = [];
  for (let i = 0; i < validAddrs.length; i++) {
    if (durations[i] === null) continue;
    const capped = Math.min(durations[i], maxDurScale);
    const x = padX + slotW * i + slotW / 2;
    const y = padTop + plotH - (capped / maxDurScale) * plotH;
    durPoints.push({ x, y, durYears: durations[i] });
  }

  // First time, edit preview, or full rebuild needed
  const needsStaticRebuild = !_tbSvg || !_tbSvg.parentNode || newPoints.length < _tbPoints.length || (isStep1EditModeActive() && Boolean(step1PendingPreviewAddress)) || (newPoints.length === _tbPoints.length && newPoints.some((pt, i) => Math.abs(pt.x - (_tbPoints[i]?.x || 0)) > 0.01 || Math.abs(pt.y - (_tbPoints[i]?.y || 0)) > 0.01));
  if (needsStaticRebuild) {
    elStep1TimeBelongingChart.innerHTML = "";

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(chartW));
    svg.setAttribute("height", String(chartH));
    svg.setAttribute("viewBox", `0 0 ${chartW} ${chartH}`);
    svg.style.overflow = "visible";
    _tbSvg = svg;

    // Draw belonging line segments
    for (let i = 0; i < newPoints.length - 1; i++) {
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", String(newPoints[i].x));
      line.setAttribute("y1", String(newPoints[i].y));
      line.setAttribute("x2", String(newPoints[i + 1].x));
      line.setAttribute("y2", String(newPoints[i + 1].y));
      line.setAttribute("stroke", "#000000");
      line.setAttribute("stroke-width", "0.6");
      line.classList.add("tb-line-seg");
      svg.appendChild(line);
    }

    // Draw belonging dots
    for (let i = 0; i < newPoints.length; i++) {
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", String(newPoints[i].x));
      circle.setAttribute("cy", String(newPoints[i].y));
      circle.setAttribute("r", "3");
      circle.setAttribute("fill", "#000000");
      circle.classList.add("tb-dot");
      svg.appendChild(circle);
    }

    // Draw duration curve + labels + connectors (no animation on rebuild)
    _tbDrawDurationCurve(svg, NS, durPoints, newPoints, durations, belongingRates, true);

    elStep1TimeBelongingChart.appendChild(svg);
    _tbPoints = newPoints;
    _tbDurPoints = durPoints;
    return;
  }

  // Incremental: a new point was added
  const svg = _tbSvg;
  const lastNew = newPoints[newPoints.length - 1];

  // Animate new belonging line segment
  if (newPoints.length >= 2) {
    const prev = newPoints[newPoints.length - 2];
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(prev.x));
    line.setAttribute("y1", String(prev.y));
    line.setAttribute("x2", String(prev.x));
    line.setAttribute("y2", String(prev.y));
    line.setAttribute("stroke", "#000000");
    line.setAttribute("stroke-width", "0.6");
    line.classList.add("tb-line-seg");
    const firstDot = svg.querySelector(".tb-dot");
    if (firstDot) svg.insertBefore(line, firstDot);
    else svg.appendChild(line);

    const lineAnimDur = 400;
    const lineStart = performance.now();
    const sx = prev.x, sy = prev.y, ex = lastNew.x, ey = lastNew.y;
    function animLine(now) {
      const t = Math.min((now - lineStart) / lineAnimDur, 1);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      line.setAttribute("x2", String(sx + (ex - sx) * ease));
      line.setAttribute("y2", String(sy + (ey - sy) * ease));
      if (t < 1) requestAnimationFrame(animLine);
    }
    requestAnimationFrame(animLine);
  }

  // Add new belonging dot with grow animation
  const circle = document.createElementNS(NS, "circle");
  circle.setAttribute("cx", String(lastNew.x));
  circle.setAttribute("cy", String(lastNew.y));
  circle.setAttribute("r", "0");
  circle.setAttribute("fill", "#000000");
  circle.classList.add("tb-dot");
  svg.appendChild(circle);

  const dotAnimDur = 350;
  const dotDelay = newPoints.length >= 2 ? 300 : 0;
  const dotStart = performance.now() + dotDelay;
  const targetR = 3;
  function animDot(now) {
    const elapsed = now - dotStart;
    if (elapsed < 0) { requestAnimationFrame(animDot); return; }
    const t = Math.min(elapsed / dotAnimDur, 1);
    const ease = t < 1 ? 1 - Math.pow(1 - t, 3) * (1 - t * 0.3) : 1;
    const r = targetR * Math.min(ease * 1.15, 1 + 0.15 * Math.max(0, 1 - t * 3));
    circle.setAttribute("r", String(Math.max(0, r)));
    if (t < 1) requestAnimationFrame(animDot);
    else circle.setAttribute("r", String(targetR));
  }
  requestAnimationFrame(animDot);

  // Rebuild duration curve + labels + connectors
  _tbDrawDurationCurve(svg, NS, durPoints, newPoints, durations, belongingRates);

  _tbPoints = newPoints;
  _tbDurPoints = durPoints;
}

// --- Ring Reading (individual rings shown side by side) ---

const elStep1RingReadingContent = document.getElementById("step1RingReadingContent");

let _ringReadingBreathRaf = null;
let _step1RingReadingHoverArmed = false;
let _step1RingReadingTooltipEl = null;
let _step1RingReadingHoveredPath = null;
let _step1RingReadingRenderKey = "";

function getStep1RingReadingPaths() {
  if (!elStep1RingReadingContent) return [];
  return Array.from(elStep1RingReadingContent.querySelectorAll("path[data-step1-ring-reading-path='1']"));
}

function setStep1RingReadingHover(targetPath) {
  const paths = getStep1RingReadingPaths();
  for (const path of paths) {
    path.setAttribute("stroke", path === targetPath ? "#000000" : "#c3c1b7");
  }
}

function clearStep1RingReadingHover() {
  _step1RingReadingHoveredPath = null;
  setStep1RingReadingEditFocus();
  hideStep1RingReadingTooltip();
}

function setStep1RingReadingEditFocus(idx = _step1EditingIdx) {
  const paths = getStep1RingReadingPaths();
  const hasFocus = isStep1EditModeActive() && idx >= 0 && idx < paths.length;
  paths.forEach((path, pathIdx) => {
    path.setAttribute("stroke", hasFocus && pathIdx !== idx ? "#c3c1b7" : "#000000");
  });
}

function ensureStep1RingReadingTooltipEl() {
  if (_step1RingReadingTooltipEl) return _step1RingReadingTooltipEl;
  try {
    const el = document.createElement("div");
    el.id = "step1RingReadingTooltip";
    el.style.cssText = "position:fixed;pointer-events:none;font-family:'NarkissBlock-Light-TRIAL',sans-serif;font-size:16px;color:#000000;white-space:nowrap;display:none;z-index:9000;text-transform:none;";
    document.body.appendChild(el);
    _step1RingReadingTooltipEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideStep1RingReadingTooltip() {
  const tooltip = _step1RingReadingTooltipEl;
  if (!tooltip) return;
  tooltip.style.display = "none";
}

function showStep1RingReadingTooltip(path, clientX, clientY) {
  const tooltip = ensureStep1RingReadingTooltipEl();
  if (!tooltip || !path) return;
  const label = String(path.getAttribute("data-home-label") || "").trim();
  if (!label) return;
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--step1-scale")) || 1;
  tooltip.style.fontSize = (16 * scale) + "px";
  tooltip.textContent = label;
  tooltip.style.left = (Number(clientX) + 14) + "px";
  tooltip.style.top = (Number(clientY) - 8) + "px";
  tooltip.style.display = "block";
}

function armStep1RingReadingHover() {
  if (!elStep1RingReadingContent || _step1RingReadingHoverArmed) return;
  _step1RingReadingHoverArmed = true;

  const pathFromEventTarget = (target) => {
    try {
      if (!target || typeof target.closest !== "function") return null;
      const path = target.closest("path[data-step1-ring-reading-path='1'], path[data-step1-ring-reading-hit='1']");
      if (!path) return null;
      return path.__step1RingReadingVisualPath || path;
    } catch {
      return null;
    }
  };

  const ringIndexFromEventTarget = (target) => {
    const path = pathFromEventTarget(target);
    if (path) {
      const idx = getStep1RingReadingPaths().indexOf(path);
      if (idx >= 0) return idx;
    }
    try {
      if (!target || typeof target.closest !== "function") return -1;
      const svg = target.closest("svg");
      if (!svg || !elStep1RingReadingContent.contains(svg)) return -1;
      return Array.from(elStep1RingReadingContent.querySelectorAll("svg")).indexOf(svg);
    } catch {
      return -1;
    }
  };

  elStep1RingReadingContent.addEventListener("click", (e) => {
    if (!isStep1DataEntryFinished()) return;
    const ringIdx = ringIndexFromEventTarget(e.target);
    if (ringIdx < 0) return;
    e.preventDefault();
    e.stopPropagation();
    openEmotionMapSoloFromStep1RingReading(ringIdx);
  }, true);

  elStep1RingReadingContent.addEventListener("pointermove", (e) => {
    if (!_step1RingReadingHoveredPath) return;
    showStep1RingReadingTooltip(_step1RingReadingHoveredPath, e.clientX, e.clientY);
  }, { passive: true });

  elStep1RingReadingContent.addEventListener("pointerover", (e) => {
    const path = pathFromEventTarget(e.target);
    if (!path) return;
    _step1RingReadingHoveredPath = path;
    setStep1RingReadingHover(path);
    showStep1RingReadingTooltip(path, e.clientX, e.clientY);
  }, { passive: true });

  elStep1RingReadingContent.addEventListener("pointerout", (e) => {
    const fromPath = pathFromEventTarget(e.target);
    if (!fromPath) return;
    const toPath = pathFromEventTarget(e.relatedTarget);
    if (toPath) {
      _step1RingReadingHoveredPath = toPath;
      setStep1RingReadingHover(toPath);
      showStep1RingReadingTooltip(toPath, e.clientX, e.clientY);
      return;
    }
    clearStep1RingReadingHover();
  }, { passive: true });

  elStep1RingReadingContent.addEventListener("pointerleave", () => {
    clearStep1RingReadingHover();
  }, { passive: true });

  elStep1RingReadingContent.addEventListener("click", (e) => {
    const ringIdx = ringIndexFromEventTarget(e.target);
    if (ringIdx < 0) return;
    if (isStep1DataEntryFinished()) {
      openEmotionMapSoloFromStep1RingReading(ringIdx);
      return;
    }
    handleStep1RingClick(ringIdx);
  });
}

function openEmotionMapSoloFromStep1RingReading(ringIdx, originOverride) {
  if (!isStep1DataEntryFinished()) return;
  const idx = Number(ringIdx);
  if (!Number.isFinite(idx)) return;
  try {
    ensureEmotionAudioReady();
  } catch {
    // ignore
  }
  pauseStep1EntrySoundForSolo();
  pendingEmotionSoloRingSnapshot = null;
  _emotionSoloOriginRect = null;
  _emotionSoloOriginColor = null;
  _emotionSoloOriginStrokeWidthPx = null;
  _emotionSoloOriginPathD = null;
  _emotionSoloOriginViewBox = null;

  // The caller already knows exactly where this ring is on screen right now
  // (e.g. the fullscreen emotion map's ring spread) -- use that directly as
  // the fly-animation origin instead of re-measuring Step 1's own ring-
  // reading panel below, which has no relationship to that on-screen
  // position and would make the animation start from the wrong place.
  if (originOverride && originOverride.rect && originOverride.rect.width > 0 && originOverride.rect.height > 0) {
    _emotionSoloOriginRect = originOverride.rect;
    _emotionSoloOriginColor = originOverride.color || "#111827";
    _emotionSoloOriginStrokeWidthPx = originOverride.strokeWidthPx || 2;
    _emotionSoloOriginPathD = originOverride.pathD || null;
    _emotionSoloOriginViewBox = originOverride.viewBox || null;
    pendingEmotionSoloTargetRingSizePx = originOverride.targetRingSizePx || null;
    pendingEmotionSoloShapeParams = originOverride.shapeParams || null;
    pendingEmotionSoloFocusIndex = Math.max(0, Math.floor(idx));
    pendingEmotionStart = null;
    showPage("emotion");
    return;
  }

  // Entering solo any other way (e.g. Step 1's own ring-reading strip) --
  // make sure a stale flag from an abandoned spread/Step2->solo trip
  // (entered but never actually left via "back") can't misroute this one.
  _emotionSoloReturnToStep1FullscreenSpread = false;
  _emotionSoloReturnToStep2 = false;

  // All of the measurements below (getBoundingClientRect/getBBox on the
  // ring-reading panel's own SVGs) return zeroed-out garbage if the Step 1
  // page is display:none — which it is whenever this is invoked from the
  // fullscreen emotion map page instead of Step 1 itself. Worse, if Step 1 is
  // merely un-hidden *alongside* whatever page is already showing (rather
  // than being the only visible page), shared layout (e.g. flex sizing that
  // assumes a single full-viewport page) can size its content completely
  // differently than a normal Step 1 visit would. So: make Step 1 the sole
  // visible page just for this synchronous measurement (no await/rAF in
  // between, so the browser never actually paints the intermediate frame),
  // guaranteeing the solo ring comes out at the exact same size/thickness no
  // matter which page sent us here.
  const measurementPageEls = [
    elPageWelcome, elPageStep1, elPageStep2, elPageEmotion,
    elPageStep1EmotionFullscreen, elPageAllMaps, elPageArchive,
  ].filter(Boolean);
  const measurementPagePrevHidden = measurementPageEls.map((el) => el.classList.contains("hidden"));
  measurementPageEls.forEach((el) => el.classList.add("hidden"));
  if (elPageStep1) elPageStep1.classList.remove("hidden");
  // Step 1's ring-reading panel is laid out at a size CSS derives from
  // body.homeFlow (see showPage()) — without it, rings measure at a
  // different, wrong size even while Step 1 itself is the visible page.
  const measurementHomeFlowWasSet = document.body.classList.contains("homeFlow");
  document.body.classList.add("homeFlow");
  try {
    const path = getStep1RingReadingPaths()[Math.max(0, Math.floor(idx))];
    const rect = path && typeof path.getBoundingClientRect === "function" ? path.getBoundingClientRect() : null;
    const ringSize = rect ? Math.max(Number(rect.width) || 0, Number(rect.height) || 0) : 0;
    const sourceStrokeWidth = Number(path && path.getAttribute("stroke-width"));
    const sourceSvg = path && path.ownerSVGElement;
    const sourceSvgRect = sourceSvg && typeof sourceSvg.getBoundingClientRect === "function" ? sourceSvg.getBoundingClientRect() : null;
    const sourceVb = sourceSvg ? parseSvgViewBox(sourceSvg.getAttribute("viewBox")) : null;
    const sourceUnitsPerPx = sourceSvgRect && sourceVb && Number(sourceSvgRect.width) > 0
      ? Math.max(1e-6, Number(sourceVb.w) || 1) / Math.max(1e-6, Number(sourceSvgRect.width) || 1)
      : 1;
    const sourceStrokeWidthPx = Number.isFinite(sourceStrokeWidth) && sourceStrokeWidth > 0
      ? sourceStrokeWidth / sourceUnitsPerPx
      : Number(path && path.getAttribute("data-step1-ring-stroke-width-px"));
    pendingEmotionSoloTargetRingSizePx = ringSize > 0 ? ringSize * 1.5 : null;
    pendingEmotionSoloShapeParams = path ? {
      index: Math.max(0, Math.floor(idx)),
      phi: Number(path.getAttribute("data-step1-ring-phi")),
      ampRatio: Number(path.getAttribute("data-step1-ring-amp-ratio")),
      strokeRatio: Number(path.getAttribute("data-step1-ring-stroke-ratio")),
      strokeWidth: sourceStrokeWidth,
      strokeWidthPx: sourceStrokeWidthPx,
    } : null;
    if (rect && rect.width > 0 && rect.height > 0) {
      _emotionSoloOriginRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      _emotionSoloOriginColor = (path && path.getAttribute("stroke")) || "#111827";
      _emotionSoloOriginStrokeWidthPx = Number.isFinite(sourceStrokeWidthPx) && sourceStrokeWidthPx > 0
        ? sourceStrokeWidthPx
        : 2;

      // Capture the ring's actual path so the fly overlay can render its true
      // (mildly distorted) shape instead of approximating a circle.
      try {
        const d = path && path.getAttribute("d");
        const bbox = path && typeof path.getBBox === "function" ? path.getBBox() : null;
        if (d && bbox && bbox.width > 0 && bbox.height > 0) {
          const localStrokeWidth = Number.isFinite(sourceStrokeWidth) && sourceStrokeWidth > 0 ? sourceStrokeWidth : 2;
          // getBBox() excludes the stroke; a stroke extends strokeWidth/2 beyond
          // the path's geometric edge on each side (SVG strokes are centered on
          // the path by default). Padding by the *full* stroke width here made
          // the rendered content noticeably smaller than the container's true
          // edge-to-edge rect (which getBoundingClientRect() — used for both the
          // container and the real ring — does include the stroke in), so the
          // overlay looked smaller than the real ring throughout the flight and
          // "popped" larger the instant it was swapped for the real ring.
          const pad = localStrokeWidth / 2;
          _emotionSoloOriginPathD = d;
          _emotionSoloOriginViewBox = `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`;
        }
      } catch {
        // ignore — falls back to the plain-circle overlay
      }
    }
  } catch {
    pendingEmotionSoloTargetRingSizePx = null;
    pendingEmotionSoloShapeParams = null;
  } finally {
    measurementPageEls.forEach((el, i) => el.classList.toggle("hidden", measurementPagePrevHidden[i]));
    document.body.classList.toggle("homeFlow", measurementHomeFlowWasSet);
  }

  pendingEmotionSoloFocusIndex = Math.max(0, Math.floor(idx));
  pendingEmotionStart = null;
  // Breathing doesn't auto-start on render: it continuously animates ring
  // geometry, and if it started now it would keep running on the still-hidden
  // ring for the whole fly-overlay duration, so the real ring's size would
  // have drifted from its resting size by the time it's revealed (a visible
  // "pop"). renderEmotionMap() just arms it instead; applyPendingEmotionSoloFocus()
  // starts it manually at the exact moment the ring becomes visible.
  showPage("emotion");
}

function updateStep1RingReading() {
  if (!elStep1RingReadingContent) return;
  armStep1RingReadingHover();

  const validAddrs = (Array.isArray(addresses) ? addresses : [])
    .filter((a) => a && a.valid !== false);
  const renderKey = validAddrs
    .map((addr) => [addr.id, addr.lat, addr.lon, addr.belonging_rate, addr.startYear].join("|"))
    .join(";");

  if (validAddrs.length === 0) {
    elStep1RingReadingContent.innerHTML = "";
    _step1RingReadingHoveredPath = null;
    _step1RingReadingRenderKey = "";
    hideStep1RingReadingTooltip();
    return;
  }

  const existingCount = elStep1RingReadingContent.querySelectorAll("svg").length;
  if (existingCount === validAddrs.length && _step1RingReadingRenderKey === renderKey) return;

  elStep1RingReadingContent.innerHTML = "";
  _step1RingReadingHoveredPath = null;
  hideStep1RingReadingTooltip();
  _step1RingReadingRenderKey = renderKey;

  const totalCount = Math.max(parseInt(String(elHomesCount?.value || ""), 10) || 0, validAddrs.length);
  const firstIndex = 0;

  const NS = "http://www.w3.org/2000/svg";

  // Match the emotion map's placeholder sizing exactly.
  const emotionMaxR = 290;
  const gap = emotionMaxR / (totalCount + 1);

  // Use the emotion map's exact viewBox (1000x620) so rings are at identical scale.
  const emotionVbW = 1000;
  const emotionVbH = 620;

  for (let i = firstIndex; i < validAddrs.length; i++) {
    const emotionR = gap * (i + 1);

    // Crop a square around this ring in emotion map coordinates.
    const addr = validAddrs[i];
    const rateForMargin = normalizeBelongingRate(addr.belonging_rate, stableBelongingRateFromId(addr.id));
    const swForMargin = emotionRingStrokeWeight(rateForMargin);
    const ampForMargin = Math.abs(distortionAmplitudeFromBelonging(rateForMargin, emotionR) * 0.9);
    // Margin includes stroke width, distortion amplitude, and breathing room.
    const margin = Math.max(emotionR * 0.3 + 10, swForMargin + ampForMargin + 8);
    const cropSize = (emotionR + margin) * 2;
    const emotionScale = 460 / emotionVbW;
    const displaySize = Math.round(emotionR * 2 * emotionScale) + 8;

    const cx = emotionVbW / 2;
    const cy = emotionVbH / 2;
    const vbX = cx - emotionR - margin;
    const vbY = cy - emotionR - margin;

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(displaySize));
    svg.setAttribute("height", String(displaySize));
    svg.setAttribute("viewBox", `${vbX} ${vbY} ${cropSize} ${cropSize}`);

    const cxR = cx;
    const cyR = cy;

    const rate = rateForMargin;
    const sw = swForMargin;
    const phi = addr && isFinite(addr.lat) && isFinite(addr.lon)
      ? step1EmotionAngleForAddress(addr, i, validAddrs) : 0;
    const ringGapRR = emotionMaxR / (totalCount + 1);
    const maxAmpRR = ringGapRR * 0.4;
    const rawAmpRR = distortionAmplitudeFromBelonging(rate, emotionR) * 0.7;
    const amp = Math.max(-maxAmpRR, Math.min(maxAmpRR, rawAmpRR));
    const opts = ringDistortionOptsForAmp(amp, i * 7.1);
    const d = buildDistortedRingPath(cxR, cyR, emotionR, phi, amp, opts);

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#000000");
    path.setAttribute("stroke-width", String(sw));
    path.setAttribute("data-step1-ring-reading-path", "1");
    path.setAttribute("data-home-label", `home ${String(i + 1).padStart(2, "0")}`);
    path.setAttribute("data-step1-ring-phi", String(phi));
    path.setAttribute("data-step1-ring-amp-ratio", String(emotionR ? amp / emotionR : 0));
    path.setAttribute("data-step1-ring-stroke-ratio", String(emotionR ? sw / emotionR : 0));
    path.setAttribute("data-step1-ring-stroke-width", String(sw));
    path.setAttribute("data-step1-ring-stroke-width-px", String(sw * displaySize / cropSize));
    svg.appendChild(path);

    const hitPath = document.createElementNS(NS, "path");
    hitPath.setAttribute("d", d);
    hitPath.setAttribute("fill", "none");
    hitPath.setAttribute("stroke", "#000000");
    hitPath.setAttribute("stroke-width", String(Math.max(sw + 10, 14)));
    hitPath.setAttribute("opacity", "0.001");
    hitPath.setAttribute("pointer-events", "stroke");
    hitPath.setAttribute("data-step1-ring-reading-hit", "1");
    hitPath.setAttribute("data-home-label", `home ${String(i + 1).padStart(2, "0")}`);
    hitPath.setAttribute("data-step1-ring-phi", String(phi));
    hitPath.setAttribute("data-step1-ring-amp-ratio", String(emotionR ? amp / emotionR : 0));
    hitPath.setAttribute("data-step1-ring-stroke-ratio", String(emotionR ? sw / emotionR : 0));
    hitPath.setAttribute("data-step1-ring-stroke-width", String(sw));
    hitPath.setAttribute("data-step1-ring-stroke-width-px", String(sw * displaySize / cropSize));
    try {
      hitPath.__step1RingReadingVisualPath = path;
    } catch {
      // ignore
    }
    svg.appendChild(hitPath);

    // Fade-in + grow entrance animation
    svg.style.opacity = "0";
    svg.style.transform = "scale(0.3)";
    svg.style.transformOrigin = "center center";
    svg.style.transition = "opacity 500ms ease, transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1)";
    elStep1RingReadingContent.appendChild(svg);
    requestAnimationFrame(() => {
      svg.style.opacity = "1";
      svg.style.transform = "scale(1)";
    });

    // Breathing animation for this ring — uses the exact same per-ring
    // amplitude/speed profile as the main emotion map (belonging-based
    // factor from EMOTION_BREATH_RATE_AMP/SPEED_TABLE, times this ring's
    // inner/outer position in the full set), so a given ring breathes
    // identically here as it does everywhere else, not an approximation.
    const totalForProfile = Math.max(1, validAddrs.length);
    const uProfile = totalForProfile <= 1 ? 1 : i / (totalForProfile - 1);
    const innerF = Math.max(0, Number(EMOTION_BREATH_INNER_FACTOR) || 0);
    const outerF = Math.max(innerF, Number(EMOTION_BREATH_OUTER_FACTOR) || innerF);
    const profileExp = Math.max(0.25, Number(EMOTION_BREATH_PROFILE_EXP) || 1);
    const indexProfile = innerF + (outerF - innerF) * Math.pow(uProfile, profileExp);
    const rateRounded = Math.max(1, Math.min(10, Math.round(rate)));
    const belongingAmpFactor = EMOTION_BREATH_RATE_AMP_TABLE[rateRounded] ?? 0.5;
    const belongingSpeedFactor = Math.max(0.5, Math.min(2, EMOTION_BREATH_RATE_SPEED_TABLE[rateRounded] ?? 1));
    const breathAmpUnits = Math.max(0, Number(EMOTION_BREATH_AMPLITUDE_PX) || 0) * indexProfile * belongingAmpFactor;
    const period = Math.max(600, Number(EMOTION_BREATH_PERIOD_MS) || 4200);

    const breathData = { phi, amp, baseR: emotionR, cx: cxR, cy: cyR, idx: i, breathAmpUnits, belongingSpeedFactor };
    const t0 = performance.now();
    const breathe = (now) => {
      const elapsed = now - t0;
      const phase = (elapsed / period) * Math.PI * 2 * breathData.belongingSpeedFactor;
      const curR = breathData.baseR + breathData.breathAmpUnits * Math.sin(phase);
      const d = buildDistortedRingPath(breathData.cx, breathData.cy, curR, breathData.phi, breathData.amp, ringDistortionOptsForAmp(breathData.amp, breathData.idx * 7.1));
      path.setAttribute("d", d);
      hitPath.setAttribute("d", d);
      if (path.parentNode) requestAnimationFrame(breathe);
    };
    requestAnimationFrame(breathe);
  }
  setStep1RingReadingEditFocus();
}

// --- Homes List Panel (right side, shows addresses as they're added) ---

const elStep1HomesList = document.getElementById("step1HomesList");
let _step1HomesListInteractionArmed = false;

function getStep1HomesListItems() {
  if (!elStep1HomesList) return [];
  return Array.from(elStep1HomesList.querySelectorAll(".homesListItem[data-home-idx]"));
}

function setStep1HomesListFocus(idx = _step1EditingIdx) {
  const items = getStep1HomesListItems();
  const hasFocus = idx >= 0 && idx < items.length;
  items.forEach((item, itemIdx) => {
    item.classList.toggle("step1HomesListFocused", hasFocus && itemIdx === idx);
    item.classList.toggle("step1HomesListMuted", hasFocus && itemIdx !== idx);
  });
}

function clearStep1HomesListFocus() {
  if (isStep1EditModeActive()) {
    setStep1HomesListFocus();
    return;
  }
  for (const item of getStep1HomesListItems()) {
    item.classList.remove("step1HomesListFocused", "step1HomesListMuted");
  }
}

function armStep1HomesListInteraction() {
  if (!elStep1HomesList || _step1HomesListInteractionArmed) return;
  _step1HomesListInteractionArmed = true;

  const itemFromHomeNumber = (target) => {
    try {
      if (!target || typeof target.closest !== "function") return null;
      const num = target.closest(".homesListNum.filled");
      return num ? num.closest(".homesListItem[data-home-idx]") : null;
    } catch {
      return null;
    }
  };

  elStep1HomesList.addEventListener("pointerover", (e) => {
    if (isStep1DataEntryFinished()) {
      clearStep1HomesListFocus();
      return;
    }
    if (isStep1EditModeActive()) return;
    const item = itemFromHomeNumber(e.target);
    if (!item) return;
    const idx = parseInt(item.getAttribute("data-home-idx") || "-1", 10);
    if (idx < 0) return;
    setStep1HomesListFocus(idx);
  }, { passive: true });

  elStep1HomesList.addEventListener("pointerout", (e) => {
    if (isStep1DataEntryFinished()) {
      clearStep1HomesListFocus();
      return;
    }
    if (isStep1EditModeActive()) return;
    const fromItem = itemFromHomeNumber(e.target);
    if (!fromItem) return;
    const toItem = itemFromHomeNumber(e.relatedTarget);
    if (toItem) {
      const idx = parseInt(toItem.getAttribute("data-home-idx") || "-1", 10);
      if (idx >= 0) setStep1HomesListFocus(idx);
      return;
    }
    clearStep1HomesListFocus();
  }, { passive: true });

  elStep1HomesList.addEventListener("pointerleave", () => {
    if (isStep1DataEntryFinished()) {
      clearStep1HomesListFocus();
      return;
    }
    if (!isStep1EditModeActive()) clearStep1HomesListFocus();
  }, { passive: true });

  elStep1HomesList.addEventListener("click", (e) => {
    if (isStep1DataEntryFinished()) {
      clearStep1HomesListFocus();
      return;
    }
    const item = itemFromHomeNumber(e.target);
    if (!item) return;
    const idx = parseInt(item.getAttribute("data-home-idx") || "-1", 10);
    if (idx < 0) return;
    openStep1HomeEditMode(idx);
  });
}

function requestStep1PanelFullscreen(target) {
  if (!target) return;
  try {
    const request = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
    if (typeof request === "function") request.call(target);
  } catch {
    // ignore
  }
}

const elStep1RouteFullscreenBtn = document.getElementById("step1RouteFullscreenBtn");

if (elStep1RouteFullscreenBtn) {
  elStep1RouteFullscreenBtn.addEventListener("click", () => {
    if (!isStep1DataEntryFinished()) return;
    // Capture where the small route preview sits before navigating away, so
    // the full Step 2 map can grow open from that same spot (see
    // flipGrowElement below) instead of just appearing.
    const fromRect = elStep1RoutePreview ? elStep1RoutePreview.getBoundingClientRect() : null;
    requestStep2OpenFitToAddresses();
    step2HoldFitAfterNextDraw = true;
    setStep2CloseReturnPage("step1");
    showPage("step2");
    const mapWrap = document.querySelector("#pageStep2 .mapWrap");
    if (mapWrap) flipGrowElement(mapWrap, fromRect, null);
  });
}

const elStep1EmotionFullscreenBtn = document.getElementById("step1EmotionFullscreenBtn");
const elStep1EmotionFullscreenSvg = document.getElementById("step1EmotionFullscreenSvg");
const elStep1EmotionFullscreenBackBtn = document.getElementById("step1EmotionFullscreenBackBtn");
const elStep1EmotionFullscreenName = document.getElementById("step1EmotionFullscreenName");
const elStep1EmotionFullscreenInfoName = document.getElementById("step1EmotionFullscreenInfoName");
const elStep1EmotionFullscreenInfoRings = document.getElementById("step1EmotionFullscreenInfoRings");
const elStep1EmotionFullscreenInfoAge = document.getElementById("step1EmotionFullscreenInfoAge");
const elStep1EmotionFullscreenInfoAvg = document.getElementById("step1EmotionFullscreenInfoAvg");
const elStep1EmotionFullscreenInfoCountries = document.getElementById("step1EmotionFullscreenInfoCountries");
const elStep1EmotionFullscreenInfoCities = document.getElementById("step1EmotionFullscreenInfoCities");

// Cap on the innermost ring's on-screen radius (px) on the fullscreen page —
// the shared 1000x620 viewBox is calibrated for the small ~460px-wide Step 1
// preview, so simply stretching it to fill the screen makes the innermost
// ring balloon far past its intended size.
const STEP1_EMOTION_FULLSCREEN_MAX_INNER_RING_PX = 25;

function linkStep1EmotionFullscreenMirrors() {
  if (!elStep1EmotionFullscreenSvg) return;
  const sourceRings = Array.isArray(elStep1EmotionSvg && elStep1EmotionSvg.__lpEmotionRings) ? elStep1EmotionSvg.__lpEmotionRings : [];
  const mirrorRings = elStep1EmotionFullscreenSvg.querySelectorAll('[data-emotion-ring="1"]');
  const n = Math.min(sourceRings.length, mirrorRings.length);
  for (let i = 0; i < n; i++) {
    try { sourceRings[i].__lpMirrorPath = mirrorRings[i]; } catch { /* ignore */ }
  }
}

// Scale a ring (fullscreen copy only) up/down around the map's center via a
// transform, recording the factor in data-emotion-radius-scale so every
// other computation (leader lines, label layout, breathing sync) can read
// the ring's true effective radius as data-emotion-r0 * this scale. Never
// touches the Step 1 preview's own ring.
function applyStep1EmotionRingRadiusScale(ringEl, cx, cy, scale) {
  if (Math.abs(scale - 1) < 0.001) {
    ringEl.removeAttribute("transform");
    ringEl.setAttribute("data-emotion-radius-scale", "1");
  } else {
    ringEl.setAttribute("transform", `translate(${cx} ${cy}) scale(${scale}) translate(${-cx} ${-cy})`);
    ringEl.setAttribute("data-emotion-radius-scale", String(scale));
  }
}

// One-time counterpart to the per-frame damping applied in
// startEmotionBreathing()'s mirror update (see EMOTION_FULLSCREEN_DISTORTION_
// DAMPING) — re-derives each freshly-copied fullscreen ring's `d` with a
// slightly damped amplitude right away, instead of waiting for breathing's
// first animation frame to correct it a moment later.
function dampStep1EmotionFullscreenRingDistortion() {
  const svg = elStep1EmotionFullscreenSvg;
  if (!svg) return;
  const rings = Array.from(svg.querySelectorAll('[data-emotion-ring="1"]'));
  rings.forEach((ring, i) => {
    try {
      const phi = Number(ring.getAttribute("data-emotion-phi")) || 0;
      const r0 = Number(ring.getAttribute("data-emotion-r0")) || 0;
      const amp = Number(ring.getAttribute("data-emotion-amp")) || 0;
      if (!r0) return;
      const dampedAmp = amp * EMOTION_FULLSCREEN_DISTORTION_DAMPING;
      const opts = ringDistortionOptsForAmp(dampedAmp, i * 7.1);
      opts.organic = (Number(opts.organic) || 1) * EMOTION_FULLSCREEN_ORGANIC_BOOST;
      const d = buildDistortedRingPath(500, 310, r0, phi, dampedAmp, opts);
      ring.setAttribute("d", d);
    } catch {
      // ignore
    }
    // The just-copied stroke-width is whatever the Step 1 preview drew (see
    // step1PreviewEmotionStrokeWidthFromRate()), which is very slightly
    // thinner than the shared formula, Step 1-preview-only by design.
    // Re-derive the fullscreen page's own value from the un-thinned formula
    // (with the same Math.max(1, ...) floor Step 1's own renderer applies
    // when it sets stroke-width -- see renderStep1EmotionMap()) so it reads
    // exactly as it did before that Step 1-only adjustment.
    try {
      const rate = Number(ring.getAttribute("data-emotion-rate"));
      if (Number.isFinite(rate)) {
        ring.setAttribute("stroke-width", String(Math.max(1, emotionStrokeWidthFromRate(rate))));
      }
    } catch {
      // ignore
    }
  });
}

// The overall map (outermost ring) must never read larger than this on the
// fullscreen page, however many homes there are — fitStep1EmotionFullscreenInnerRing()
// separately fits the *innermost* ring to STEP1_EMOTION_FULLSCREEN_MAX_INNER_RING_PX,
// but with enough rings the outer one can still balloon past a comfortable
// size even so. compressStep1EmotionFullscreenRingSpan() below is what
// actually enforces this, by tightening the gaps between rings rather than
// shrinking the inner ring further.
const STEP1_EMOTION_FULLSCREEN_MAX_MAP_PX = 300;
// Maps with more than this many rings get a looser overall-diameter budget
// (below) instead of the default one -- with that many rings packed in,
// the tighter 300px budget forces gaps so small that rings start visually
// overlapping. The innermost ring's own cap is unaffected either way.
const STEP1_EMOTION_FULLSCREEN_MANY_RINGS_THRESHOLD = 10;
const STEP1_EMOTION_FULLSCREEN_MAX_MAP_PX_MANY_RINGS = 400;
// Maps with only a handful of rings have no crowding risk to begin with --
// the default 300px budget still ends up squeezing their gaps drastically
// whenever belonging rates differ a lot between just 2-4 homes. Give these a
// much looser budget instead, since there's plenty of screen space and
// nothing to protect against.
const STEP1_EMOTION_FULLSCREEN_FEW_RINGS_THRESHOLD = 6;
const STEP1_EMOTION_FULLSCREEN_MAX_MAP_PX_FEW_RINGS = 560;

function step1EmotionFullscreenMaxMapPx(ringCount) {
  if (ringCount > STEP1_EMOTION_FULLSCREEN_MANY_RINGS_THRESHOLD) return STEP1_EMOTION_FULLSCREEN_MAX_MAP_PX_MANY_RINGS;
  if (ringCount <= STEP1_EMOTION_FULLSCREEN_FEW_RINGS_THRESHOLD) return STEP1_EMOTION_FULLSCREEN_MAX_MAP_PX_FEW_RINGS;
  return STEP1_EMOTION_FULLSCREEN_MAX_MAP_PX;
}

// Both ring sizes below are ultimately set by fitStep1EmotionFullscreenInnerRing()
// zooming the whole viewBox until the innermost ring hits its target pixel
// radius — so the outermost ring's eventual on-screen radius is just the
// innermost ring's target radius scaled by their *ratio* in viewBox units.
// That means capping the outer ring only requires capping this ratio, and
// the cap is scale-invariant: it holds regardless of viewBox units, current
// zoom, or breathing amplitude at the instant this runs.
function compressStep1EmotionFullscreenRingSpan() {
  const svg = elStep1EmotionFullscreenSvg;
  if (!svg) return;
  const rings = Array.from(svg.querySelectorAll('[data-emotion-ring="1"]'));
  if (rings.length < 2) return;

  const viewBoxParts = (svg.getAttribute("viewBox") || "0 0 1000 620").split(/\s+/).map(Number);
  const [vbX, vbY, vbW, vbH] = viewBoxParts.length === 4 && viewBoxParts.every((v) => isFinite(v)) ? viewBoxParts : [0, 0, 1000, 620];
  const cx = vbX + vbW / 2;
  const cy = vbY + vbH / 2;

  const infos = rings
    .map((ring) => {
      const baseR0 = Number(ring.getAttribute("data-emotion-r0")) || 0;
      const currentScale = Number(ring.getAttribute("data-emotion-radius-scale")) || 1;
      return { el: ring, baseR0, r0: baseR0 * currentScale };
    })
    .filter((info) => info.baseR0 > 0);
  if (infos.length < 2) return;
  infos.sort((a, b) => a.r0 - b.r0);

  const innerR = infos[0].r0;
  const outerR = infos[infos.length - 1].r0;
  if (!(innerR > 0) || !(outerR > innerR)) return;

  const maxMapPx = step1EmotionFullscreenMaxMapPx(rings.length);
  const maxRatio = (maxMapPx / 2) / STEP1_EMOTION_FULLSCREEN_MAX_INNER_RING_PX;
  if (outerR / innerR <= maxRatio) return;

  // Pull every ring proportionally closer to the innermost one (which stays
  // put) until the outer/inner ratio — and so the eventual outer radius —
  // is back within budget. This is "reduce the gaps between rings," not a
  // uniform zoom: the inner ring's own size is unaffected.
  const spanCurrent = outerR - innerR;
  const spanAllowed = innerR * (maxRatio - 1);
  const compression = Math.max(0, spanAllowed / spanCurrent);

  for (const info of infos) {
    const newR0 = innerR + (info.r0 - innerR) * compression;
    const scale = newR0 / info.baseR0;
    applyStep1EmotionRingRadiusScale(info.el, cx, cy, scale);
  }
}

// The map's ring radii are evenly spaced by construction, but each ring's
// organic distortion (bulging out for belonging > 5, denting in for
// belonging < 5) can still push a ring's edge into its neighbor's territory
// — more visible zoomed in on the fullscreen page than in the small Step 1
// preview. Nudge just the affected ring(s) outward (via a scale transform
// around the map's center, applied only to the fullscreen copy) so
// consecutive rings keep a minimum clearance. The Step 1 preview itself is
// untouched — this only ever touches the fullscreen SVG's copies.
function resolveStep1EmotionFullscreenRingOverlaps() {
  const svg = elStep1EmotionFullscreenSvg;
  if (!svg) return;
  const rings = Array.from(svg.querySelectorAll('[data-emotion-ring="1"]'));
  if (rings.length < 2) return;

  const viewBoxParts = (svg.getAttribute("viewBox") || "0 0 1000 620").split(/\s+/).map(Number);
  const [vbX, vbY, vbW, vbH] = viewBoxParts.length === 4 && viewBoxParts.every((v) => isFinite(v)) ? viewBoxParts : [0, 0, 1000, 620];
  const cx = vbX + vbW / 2;
  const cy = vbY + vbH / 2;
  // Scales with the same per-ring-count size budget compressStep1Emotion
  // FullscreenRingSpan() used -- otherwise maxReasonableGap below (meant to
  // pull in only *pointlessly* huge gaps) also pulls in the deliberately
  // generous spacing that budget just gave a few-ring map, undoing it.
  const clearanceBudgetScale = step1EmotionFullscreenMaxMapPx(rings.length) / STEP1_EMOTION_FULLSCREEN_MAX_MAP_PX;
  const minClearanceUnits = Math.max(1, (vbW / 250) * clearanceBudgetScale);

  // Measure each ring's *true* rendered shape directly (getBBox, in the
  // ring's own pre-transform coordinate space) instead of estimating it
  // from data-emotion-amp/r0. The pull/push bump is localized to one angle
  // (not a uniform radial +/-amp offset), and the independent organic-wave
  // waviness can push the boundary out at *any* angle -- so a ring's true
  // worst-case extent can differ substantially from an "r0 +/- amp"
  // estimate, in either direction, at either edge. getBBox() reflects
  // whatever the path's `d` actually traces, sidestepping the need to
  // model that shape. It also sidesteps stroke-width separately: every
  // ring here carries vector-effect="non-scaling-stroke" (copied straight
  // from the Step 1 preview), so stroke-width is a fixed px amount, never
  // scaled by the transform this function applies below.
  const infos = rings.map((ring) => {
    const currentScale = Number(ring.getAttribute("data-emotion-radius-scale")) || 1;
    const bbox = ring.getBBox();
    const sw = Number(ring.getAttribute("stroke-width")) || 1;
    // A small fixed safety margin on top of the measured shape: the
    // organic wave is continuous, so the true worst angle may fall
    // slightly between rendered vertices, and breathing/hover can nudge
    // geometry a hair further still.
    const localOuterR = (Math.max(bbox.width, bbox.height) / 2) * 1.06;
    const localInnerR = (Math.min(bbox.width, bbox.height) / 2) * 0.94;
    return {
      el: ring,
      scale: currentScale,
      localOuterR,
      localInnerR,
      sw,
      outerEdge: localOuterR * currentScale + sw / 2,
      innerEdge: localInnerR * currentScale - sw / 2,
    };
  });

  // Growing a ring's scale to clear the one before it is a direct,
  // one-shot calculation here (innerEdge is linear in scale, and
  // localInnerR -- unlike an amp-ratio estimate -- is a fixed measured
  // constant, not something that itself grows as scale grows) -- so unlike
  // an amp-ratio-based estimate, this can't compound into runaway growth
  // chaining across many rings. Still re-sort and repeat a few times: a
  // push can move a ring past the *next* one's still-unprocessed position.
  // Also pull a ring back in if it ended up with far more clearance than it
  // needs (e.g. it never needed pushing itself, but the ring before it just
  // got pushed way out to clear *its own* neighbor, leaving this one with a
  // conspicuously huge, pointless gap next to otherwise-snug ones).
  //
  // maxReasonableGap must never be smaller than the gaps the compress step
  // *intentionally* already set up (a few-ring map's generous size budget
  // means genuinely bigger gaps, by design, not "pointlessly huge" ones) --
  // so it's derived from this map's own current average gap, not a fixed
  // vbW-relative constant blind to ring count.
  const sortedByOuter = infos.slice().sort((a, b) => a.outerEdge - b.outerEdge);
  let gapSum = 0;
  let gapCount = 0;
  for (let i = 1; i < sortedByOuter.length; i++) {
    const gap = sortedByOuter[i].innerEdge - sortedByOuter[i - 1].outerEdge;
    if (gap > 0) {
      gapSum += gap;
      gapCount += 1;
    }
  }
  const avgGap = gapCount > 0 ? gapSum / gapCount : minClearanceUnits;
  const maxReasonableGap = Math.max(minClearanceUnits * 1.4, avgGap * 2.2);
  for (let iter = 0; iter < infos.length * 8 + 20; iter++) {
    infos.sort((a, b) => a.outerEdge - b.outerEdge);
    let moved = false;
    for (let i = 1; i < infos.length; i++) {
      const prev = infos[i - 1];
      const cur = infos[i];
      if (cur.localInnerR <= 0.01) continue;
      const gap = cur.innerEdge - prev.outerEdge;
      let targetGap = null;
      if (gap < minClearanceUnits - 1e-6) targetGap = minClearanceUnits;
      else if (gap > maxReasonableGap) targetGap = maxReasonableGap;
      if (targetGap == null) continue;
      const targetInnerEdge = prev.outerEdge + targetGap;
      const newScale = (targetInnerEdge + cur.sw / 2) / cur.localInnerR;
      if (Math.abs(newScale - cur.scale) < 1e-6) continue;
      cur.scale = newScale;
      cur.outerEdge = cur.localOuterR * cur.scale + cur.sw / 2;
      cur.innerEdge = targetInnerEdge;
      moved = true;
    }
    if (!moved) break;
  }

  // Final safety net: however the pass above settled, never let the whole
  // map balloon past a sane final on-screen size -- if it did, shrink every
  // ring's scale proportionally together. That shrinks their absolute
  // clearances too, so it trades away some of the "never touching"
  // guarantee above, but only ever kicks in for distortion combinations far
  // outside realistic belonging-rate data, where a large-but-bounded map
  // with an occasional snug gap is a far better outcome than an unusable,
  // absurdly huge one.
  //
  // fitStep1EmotionFullscreenInnerRing() (which runs right after this
  // function, back in the caller) zooms the whole viewBox so the *smallest*
  // ring here ends up exactly STEP1_EMOTION_FULLSCREEN_MAX_INNER_RING_PX on
  // screen -- so the final on-screen size of every other ring is that fixed
  // target scaled by its ratio to the smallest ring's edge, not by its own
  // absolute vbW-relative units. Capping in absolute units here would only
  // coincidentally match the true final pixel size; capping the ratio
  // directly (mirroring compressStep1EmotionFullscreenRingSpan()'s own
  // maxMapPx/innerPx logic) is what actually bounds it.
  const smallestInnerEdge = infos.reduce((m, info) => Math.min(m, info.innerEdge), Infinity);
  const outerEdge = infos.reduce((m, info) => Math.max(m, info.outerEdge), 0);
  if (smallestInnerEdge > 0 && Number.isFinite(smallestInnerEdge)) {
    const maxMapPx = step1EmotionFullscreenMaxMapPx(rings.length);
    // Generous multiple of the "normal" budget: this is a last-resort cap
    // for pathological cases, not the everyday target -- compressStep1Emotion
    // FullscreenRingSpan() already aims for maxMapPx under ordinary
    // circumstances, and this function's own job above is to grow past that
    // only when actually needed to avoid touching. Kept within ~2.5x rather
    // than 6x: the fullscreen page's own container caps out at 1200px, so a
    // looser multiple than that let many-ring maps balloon past the visible
    // page instead of actually acting as a *safety* net.
    const maxRatio = ((maxMapPx * 2.5) / 2) / STEP1_EMOTION_FULLSCREEN_MAX_INNER_RING_PX;
    const ratio = outerEdge / smallestInnerEdge;
    if (ratio > maxRatio) {
      const shrink = maxRatio / ratio;
      for (const info of infos) {
        info.scale *= shrink;
        // Recompute properly, not just scale outerEdge/innerEdge by the same
        // factor: the `+/- sw/2` term doesn't shrink (stroke-width never
        // scales -- see the vector-effect note above), so naively assuming
        // a uniform shrink leaves every gap exactly as it already is
        // silently drifts it by a hair, which can turn an exactly-on-target
        // gap from the loop above into a real (if tiny) violation.
        info.outerEdge = info.localOuterR * info.scale + info.sw / 2;
        info.innerEdge = info.localInnerR * info.scale - info.sw / 2;
      }
      // Re-converge once more: the drift above is small, but re-running the
      // same loop costs little and guarantees it's actually gone rather
      // than assuming it is.
      for (let iter = 0; iter < infos.length * 2; iter++) {
        infos.sort((a, b) => a.outerEdge - b.outerEdge);
        let moved = false;
        for (let i = 1; i < infos.length; i++) {
          const prev = infos[i - 1];
          const cur = infos[i];
          const neededInnerEdge = prev.outerEdge + minClearanceUnits;
          if (cur.innerEdge < neededInnerEdge - 1e-6 && cur.localInnerR > 0.01) {
            cur.scale = (neededInnerEdge + cur.sw / 2) / cur.localInnerR;
            cur.outerEdge = cur.localOuterR * cur.scale + cur.sw / 2;
            cur.innerEdge = cur.localInnerR * cur.scale - cur.sw / 2;
            moved = true;
          }
        }
        if (!moved) break;
      }
    }
  }

  for (const info of infos) {
    applyStep1EmotionRingRadiusScale(info.el, cx, cy, info.scale);
  }
}

// Measures the map's own visible content (rings, or Step 2's dots/route)
// together with the reading panel as ONE combined unit, then shifts both by
// the same amount so that unit's combined bounding box is centered on the
// page -- the gap/relationship between the two never changes, only where
// the pair as a whole sits. Idempotent: always re-measures from each
// element's un-shifted ("natural") position first, so calling it again
// (e.g. on resize) recomputes cleanly instead of compounding a prior shift.
function centerReadingUnit(mapContentEls, wrapEl, panelEl) {
  if (!wrapEl || !panelEl) return;
  wrapEl.style.transform = "none";
  panelEl.style.transform = "none";

  const panelRect = panelEl.getBoundingClientRect();
  if (!panelRect || !(panelRect.width > 0)) return;

  let minX = Infinity;
  let maxX = -Infinity;
  (mapContentEls || []).forEach((el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return;
    const r = el.getBoundingClientRect();
    if (!r || !(r.width > 0) || !(r.height > 0)) return;
    if (r.left < minX) minX = r.left;
    if (r.right > maxX) maxX = r.right;
  });
  if (!Number.isFinite(minX)) return;
  if (panelRect.left < minX) minX = panelRect.left;
  if (panelRect.right > maxX) maxX = panelRect.right;

  const combinedCenter = (minX + maxX) / 2;
  const viewportCenter = (window.innerWidth || 1200) / 2;
  const shift = viewportCenter - combinedCenter;

  const applied = Math.abs(shift) > 0.5 ? `translateX(${shift}px)` : "";
  wrapEl.style.transform = applied;
  panelEl.style.transform = applied;
}

function centerStep1EmotionFullscreenReadingUnit() {
  const wrapEl = document.getElementById("step1EmotionFullscreenWrap");
  const panelEl = document.getElementById("step1EmotionFullscreenInfo");
  if (!wrapEl || !panelEl || !elStep1EmotionFullscreenSvg) return;
  const rings = Array.from(elStep1EmotionFullscreenSvg.querySelectorAll('[data-emotion-ring="1"]'));
  centerReadingUnit(rings, wrapEl, panelEl);
}

let _step2ReadingUnitResizeArmed = false;

function centerStep2ReadingUnit() {
  const wrapEl = document.getElementById("step2MapWrap");
  const panelEl = document.getElementById("step2ReadingInfo");
  if (!wrapEl || !panelEl) return;
  const mapContentEls = Array.from(document.querySelectorAll("#pageStep2 .lifepathStep2Dot, #pageStep2 .lifepathStep2Path"));
  centerReadingUnit(mapContentEls, wrapEl, panelEl);
}

function fitStep1EmotionFullscreenInnerRing() {
  if (!elStep1EmotionFullscreenSvg) return;
  const rings = Array.from(elStep1EmotionFullscreenSvg.querySelectorAll('[data-emotion-ring="1"]'));
  if (!rings.length) return;

  const baseViewBox = (elStep1EmotionSvg && elStep1EmotionSvg.getAttribute("viewBox")) || "0 0 1000 620";
  const parts = baseViewBox.split(/\s+/).map(Number);
  const [bx, by, bw, bh] = parts.length === 4 && parts.every((v) => isFinite(v)) ? parts : [0, 0, 1000, 620];
  // Reset to the un-zoomed viewBox first so both the container measurement
  // and the ring-cluster measurement below start from a known baseline.
  elStep1EmotionFullscreenSvg.setAttribute("viewBox", `${bx} ${by} ${bw} ${bh}`);

  const containerRect = elStep1EmotionFullscreenSvg.getBoundingClientRect();
  if (!containerRect || !containerRect.width || !containerRect.height) return;

  // Fit the *whole ring cluster* (union bbox of every ring) to an explicit
  // target diameter, tiered by ring count, rather than pegging just the
  // smallest ring to a fixed px target and letting the outer ring's size
  // fall out as an indirect consequence of compress/overlap-resolution
  // above -- with an extreme belonging-rate mix (very few or very many
  // rings), those passes can legitimately produce a smallest ring that
  // isn't actually home #1, or an inner/outer ratio that blows way past
  // what the container can show. This way the final on-screen size is
  // exactly what's measured, every time.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    const r = ring.getBoundingClientRect();
    if (!r || !r.width || !r.height) continue;
    if (r.left < minX) minX = r.left;
    if (r.top < minY) minY = r.top;
    if (r.right > maxX) maxX = r.right;
    if (r.bottom > maxY) maxY = r.bottom;
  }
  if (!Number.isFinite(minX)) return;
  const clusterWPx = maxX - minX;
  const clusterHPx = maxY - minY;
  if (clusterWPx <= 0 || clusterHPx <= 0) return;

  // Size rules for the whole map's diameter (its larger dimension), tiered
  // by ring count.
  const ringCount = rings.length;
  const targetDiameterPx = ringCount < 6 ? 190 : ringCount <= 10 ? 300 : 410;
  const clusterDiameterPx = Math.max(clusterWPx, clusterHPx);
  let scale = targetDiameterPx / clusterDiameterPx;
  // Never let the target exceed what the container can actually show (a
  // very spread-out cluster could otherwise still overflow).
  const maxScale = Math.min(containerRect.width, containerRect.height) / Math.max(clusterWPx, clusterHPx);
  scale = Math.min(scale, maxScale);
  if (!Number.isFinite(scale) || scale <= 0) return;

  // Convert the cluster's screen-space center into this SVG's current
  // user-space (viewBox) coordinates via its screen CTM -- robust to the
  // meet-scale letterboxing that hand-rolling the px<->viewBox math would
  // need to account for separately.
  const ctm = elStep1EmotionFullscreenSvg.getScreenCTM();
  if (!ctm) return;
  const inv = ctm.inverse();
  const pt = elStep1EmotionFullscreenSvg.createSVGPoint();
  pt.x = (minX + maxX) / 2;
  pt.y = (minY + maxY) / 2;
  const centerVb = pt.matrixTransform(inv);

  const newW = bw / scale;
  const newH = bh / scale;
  elStep1EmotionFullscreenSvg.setAttribute("viewBox", `${centerVb.x - newW / 2} ${centerVb.y - newH / 2} ${newW} ${newH}`);
}

const STEP1_EMOTION_LABEL_FONT_LIGHT = '"NarkissBlock-Extralight-TRIAL", sans-serif';
const STEP1_EMOTION_LABEL_FONT_REGULAR = '"NarkissBlock-Regular-TRIAL", sans-serif';
// Extra pullback (physical px) beyond exactly half the ring's stroke width.
// Kept at 0 so the leader line starts exactly at the ring's own outer edge —
// a positive value here pushes the start point past that edge, leaving a
// visible gap between the ring and the line instead of the line appearing
// to grow directly out of the ring's contour.
const STEP1_EMOTION_LINE_EXTRA_SHORTEN_PX = 0;

// Parse a ring's own rendered "Mx,yLx,yLx,y...Z" path string into points.
// Reading the ring's *actual current* geometry (rather than recomputing it
// from the bump/organic-wave formula, which would need to know exactly what
// live-breathing radius was in effect at that instant) is what guarantees
// the leader line always lands exactly on the drawn edge — it's derived
// from the same path that's on screen, not a parallel approximation of it.
function parseStep1EmotionRingPathPoints(d) {
  const points = [];
  if (!d) return points;
  const re = /[ML](-?[\d.]+),(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(d))) {
    points.push({ x: parseFloat(m[1]), y: parseFloat(m[2]) });
  }
  return points;
}

// Find where a horizontal ray at `targetY` crosses a ring's real boundary
// (as given by `points`, already in final/on-screen coordinates) on the
// given side of `cx`. A strongly-distorted ring can cross the same ray more
// than once on the same side; with no `preferNearX` hint this returns the
// outermost crossing (used for the initial, static layout). During
// breathing, passing the previous frame's x as `preferNearX` instead picks
// whichever crossing is closest to it, so the touch point tracks the same
// "physical" spot on the boundary continuously rather than jumping to a
// different crossing the instant the outermost one changes.
function findStep1EmotionRingBoundaryX(points, cx, targetY, sideSign, preferNearX) {
  const n = points.length;
  if (n < 2) return null;
  let best = null;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (a.y !== b.y && (a.y - targetY) * (b.y - targetY) <= 0) {
      const t = (targetY - a.y) / (b.y - a.y);
      const ix = a.x + t * (b.x - a.x);
      const onSide = sideSign >= 0 ? ix >= cx : ix <= cx;
      if (!onSide) continue;
      if (best === null) {
        best = ix;
      } else if (preferNearX != null) {
        if (Math.abs(ix - preferNearX) < Math.abs(best - preferNearX)) best = ix;
      } else if (sideSign >= 0 ? ix > best : ix < best) {
        best = ix;
      }
    }
  }
  return best;
}

// A ring's own `transform="translate(cx cy) scale(s) translate(-cx -cy)"`
// (see applyStep1EmotionRingRadiusScale) isn't reflected in its `d`
// attribute, so points read from `d` need this same scale re-applied around
// the map's center to land in final on-screen coordinates.
function scaleStep1EmotionRingPoint(point, cx, cy, scale) {
  if (scale === 1) return point;
  return { x: cx + (point.x - cx) * scale, y: cy + (point.y - cy) * scale };
}

// Re-anchor a ring's leader line (see renderStep1EmotionFullscreenRingLabels)
// to its current, breathing-animated shape every frame, by re-reading the
// ring's own just-updated `d` path — so the line's inner end always sits
// exactly on the boundary as it's actually drawn, never behind or past it.
function updateStep1EmotionRingLeaderLine(ringEl) {
  const info = ringEl && ringEl.__lpLeaderLineInfo;
  if (!info) return;
  try {
    const scale = Number(ringEl.getAttribute("data-emotion-radius-scale")) || 1;
    const rawPoints = parseStep1EmotionRingPathPoints(ringEl.getAttribute("d"));
    const points = scale === 1 ? rawPoints : rawPoints.map((p) => scaleStep1EmotionRingPoint(p, info.cx, info.cy, scale));
    const prevX = Number(info.line.getAttribute("x1"));
    const centerlineX = findStep1EmotionRingBoundaryX(points, info.cx, info.rowY, info.sideSign, isFinite(prevX) ? prevX : null);
    if (centerlineX == null) return;
    const startX = centerlineX + info.sideSign * (info.halfStrokeUnits || 0);
    info.line.setAttribute("x1", String(startX));
    if (info.startDot) info.startDot.setAttribute("cx", String(startX));
  } catch {
    // ignore
  }
}

// Draw a thin, horizontal leader line out of every ring on the fullscreen
// page, ending in a small label: home number, deformation direction/
// intensity (the ring's distortion amplitude — outward bulge for belonging
// > 5, inward dent for belonging < 5), its angle, and the belonging rate.
// Each line's inner end is a real point on that specific ring's own actual
// (currently rendered, possibly organically distorted) boundary — marked
// with a small dot so it's unambiguous which ring a line belongs to — and
// its outer end lines up with the other labels in its column. Ring sizes
// themselves are never touched here. Font size and line thickness are
// computed from the SVG's current on-screen scale so they stay a constant
// physical size no matter how far fitStep1EmotionFullscreenInnerRing() had
// to zoom the viewBox out.
//
// With `{ animate: true }` (used right after the map's own open animation
// finishes — see the fullscreen button's click handler), each ring's line
// draws itself in and its label fades/slides in just after, staggered
// ring-by-ring for a "being written" feel. Without it, everything appears
// immediately (used on resize, where re-animating would be distracting).
function renderStep1EmotionFullscreenRingLabels() {
  const svg = elStep1EmotionFullscreenSvg;
  if (!svg) return;

  const existing = svg.querySelector('[data-layer="step1-emotion-ring-labels"]');
  if (existing) existing.remove();

  const rings = Array.from(svg.querySelectorAll('[data-emotion-ring="1"]'));
  if (!rings.length) return;

  const viewBoxParts = (svg.getAttribute("viewBox") || "0 0 1000 620").split(/\s+/).map(Number);
  const [vbX, vbY, vbW, vbH] = viewBoxParts.length === 4 && viewBoxParts.every((v) => isFinite(v)) ? viewBoxParts : [0, 0, 1000, 620];

  const svgRect = svg.getBoundingClientRect();
  if (!svgRect.width || !svgRect.height) return;
  const pxPerUnit = Math.min(svgRect.width / vbW, svgRect.height / vbH) || 1;
  const toUnits = (px) => px / pxPerUnit;

  const cx = vbX + vbW / 2;
  const cy = vbY + vbH / 2;

  const ringInfo = rings.map((ring) => {
    const phi = Number(ring.getAttribute("data-emotion-phi")) || 0;
    const radiusScale = Number(ring.getAttribute("data-emotion-radius-scale")) || 1;
    // Effective radius after resolveStep1EmotionFullscreenRingOverlaps()'s
    // correction (if any) — everything below anchors to the ring as it's
    // actually drawn, not its pre-correction radius.
    const r0 = (Number(ring.getAttribute("data-emotion-r0")) || 0) * radiusScale;
    const amp = (Number(ring.getAttribute("data-emotion-amp")) || 0) * radiusScale;
    const rate = Number(ring.getAttribute("data-emotion-rate")) || 5;
    const homeNum = Number(ring.getAttribute("data-emotion-home-num")) || 0;
    const sw = Number(ring.getAttribute("stroke-width")) || 1;
    return { el: ring, phi, r0, amp, rate, homeNum, halfStroke: sw / 2 };
  });

  const lineGap = toUnits(14);
  const fontSizeUnits = toUnits(14);
  const lineHeightUnits = fontSizeUnits * 1.05;
  const linesPerLabel = 3; // home, deformation+intensity+angle, belonging
  // Kept as tight as legibly possible: each row's line has to land on its
  // own ring's true boundary (see layoutColumn below), and ring-to-ring
  // radius gaps shrink as home count grows, so an oversized row height
  // would force rows on small rings to compress into overlapping ones.
  const rowHeight = lineHeightUnits * linesPerLabel + toUnits(10);

  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("data-layer", "step1-emotion-ring-labels");
  group.setAttribute("pointer-events", "none");

  // `segments` is an array so a line can mix plain text with one or more
  // key:value pairs (e.g. deformation direction + intensity + angle all on
  // one line) — plain text and keys render in the light weight, values in
  // the regular weight, all flowing on the same line (no per-segment x, so
  // text-anchor aligns the line as a whole).
  const appendLabelLine = (parent, x, y, anchor, segments) => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(x));
    text.setAttribute("y", String(y));
    text.setAttribute("text-anchor", anchor);
    text.setAttribute("direction", "ltr");
    text.setAttribute("fill", "#000000");
    text.setAttribute("font-size", String(fontSizeUnits));
    text.setAttribute("opacity", "0.75");
    // The page's body defaults to text-transform: uppercase; override it
    // explicitly rather than relying on the SVG text just not inheriting it.
    text.style.textTransform = "lowercase";

    segments.forEach((seg) => {
      if (seg.value != null) {
        if (seg.key) {
          const keySpan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
          keySpan.setAttribute("font-family", STEP1_EMOTION_LABEL_FONT_LIGHT);
          keySpan.textContent = `${seg.key}: `;
          text.appendChild(keySpan);
        }

        const valueSpan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
        valueSpan.setAttribute("font-family", STEP1_EMOTION_LABEL_FONT_REGULAR);
        valueSpan.textContent = seg.value;
        text.appendChild(valueSpan);
      } else {
        const span = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
        span.setAttribute("font-family", STEP1_EMOTION_LABEL_FONT_LIGHT);
        span.textContent = seg.text;
        text.appendChild(span);
      }
    });

    parent.appendChild(text);
  };

  const columns = { right: [], left: [] };
  ringInfo.forEach((info) => {
    (Math.cos(info.phi) >= 0 ? columns.right : columns.left).push(info);
  });

  // Ring sizes are never touched here (that's Step 1's / resolveStep1Emotion-
  // FullscreenRingOverlaps()'s job) — rows are laid out around whatever size
  // each ring already is. A single column per side, alternating above/below
  // center in ascending-radius order: smallest ring first (closest to
  // center, where it's guaranteed to be able to reach), each subsequent
  // (larger) ring gets more room to spread further out. This keeps every
  // line touching its own ring and every label clear of the others, at the
  // cost of not always reading top-to-bottom in home-number order — with
  // this app's evenly-spaced ring radii, a handful of home entries just
  // don't leave enough radius budget between consecutive rings to also
  // guarantee strict order without either resizing rings or letting labels
  // overlap, and ring size + no-overlap take priority.
  const layout = [];
  const layoutColumn = (items, side) => {
    if (!items.length) return;
    items.sort((a, b) => a.r0 - b.r0);
    const sideSign = side === "right" ? 1 : -1;
    let posOffset = 0;
    let negOffset = 0;
    let useTop = true;

    items.forEach((info) => {
      const { el, phi, rate, homeNum, r0, amp } = info;
      const sign = useTop ? -1 : 1;
      useTop = !useTop;

      const prevOffset = sign < 0 ? posOffset : negOffset;
      const desiredOffset = prevOffset === 0 ? Math.min(r0, rowHeight / 2) : prevOffset + rowHeight;
      const offset = Math.min(desiredOffset, r0);
      if (sign < 0) posOffset = offset; else negOffset = offset;

      layout.push({ el, phi, rate, homeNum, sideSign, sign, offset, r0, amp });
    });
  };
  layoutColumn(columns.right, "right");
  layoutColumn(columns.left, "left");

  const outerEdge = ringInfo.reduce((max, info) => Math.max(max, info.r0 + Math.abs(info.amp) + info.halfStroke), 0);
  const labelColumnX = outerEdge + toUnits(90);

  // Each line's inner end is found on the ring's own actual, currently
  // -rendered path (re-parsed live, not recomputed from a formula) so it
  // always lands exactly on the drawn edge — never short of an outward
  // bulge (which would make the line look like it cuts across the ring) or
  // past an inward dent (which would leave a visible gap).
  layout.forEach((l) => {
    const { el, phi, rate, homeNum, sideSign, sign, offset, r0, amp } = l;
    const textAnchor = sideSign > 0 ? "start" : "end";
    const rowY = cy + sign * offset;
    const lineEndX = cx + sideSign * labelColumnX;
    const textX = lineEndX + sideSign * lineGap;

    const scale = Number(el.getAttribute("data-emotion-radius-scale")) || 1;
    const rawPoints = parseStep1EmotionRingPathPoints(el.getAttribute("d"));
    const points = scale === 1 ? rawPoints : rawPoints.map((p) => scaleStep1EmotionRingPoint(p, cx, cy, scale));
    const foundX = findStep1EmotionRingBoundaryX(points, cx, rowY, sideSign);
    const centerlineX = foundX != null ? foundX : cx + sideSign * Math.sqrt(Math.max(0, r0 * r0 - offset * offset));
    // `d` is the ring stroke's *centerline* — with vector-effect: non-
    // scaling-stroke, stroke-width is a literal screen-px width, so half of
    // it (converted to viewBox units) is exactly how far the ring's visible
    // ink extends outward past that centerline. Pull the line's end back by
    // that much (plus a small extra margin) so it stops just short of the
    // ring's actual outer edge instead of poking into its stroke.
    const ringSw = Number(el.getAttribute("stroke-width")) || 1;
    const halfStrokeUnits = toUnits(ringSw) / 2 + toUnits(STEP1_EMOTION_LINE_EXTRA_SHORTEN_PX);
    const startX = centerlineX + sideSign * halfStrokeUnits;

    const ringG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    ringG.setAttribute("data-ring-label-for", String(homeNum));
    // Hidden by default — only the ring currently under hover shows its own
    // line + text; see showStep1EmotionFullscreenRingLabel()/
    // hideStep1EmotionFullscreenRingLabel() in the hover wiring below.
    ringG.style.opacity = "0";
    group.appendChild(ringG);

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(startX));
    line.setAttribute("y1", String(rowY));
    line.setAttribute("x2", String(lineEndX));
    line.setAttribute("y2", String(rowY));
    line.setAttribute("stroke", "#000000");
    line.setAttribute("stroke-width", "0.6");
    line.setAttribute("stroke-linecap", "butt");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    line.setAttribute("opacity", "0.45");
    ringG.appendChild(line);

    // Small dot at the line's ring-side end, so it's unambiguous which ring
    // a line belongs to (matches the line's own inner-end point exactly, and
    // gets glued to the ring alongside it every breathing frame — see
    // updateStep1EmotionRingLeaderLine() below).
    const startDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    startDot.setAttribute("cx", String(startX));
    startDot.setAttribute("cy", String(rowY));
    startDot.setAttribute("r", String(toUnits(2)));
    startDot.setAttribute("fill", "#000000");
    startDot.setAttribute("opacity", "0.45");
    ringG.appendChild(startDot);

    // Let the ring's breathing animation keep this line's inner end glued
    // to its (continuously moving) own boundary — see
    // updateStep1EmotionRingLeaderLine(), called every breathing frame.
    try {
      el.__lpLeaderLineInfo = { line, startDot, offset, sideSign, cx, cy, rowY, halfStrokeUnits };
    } catch {
      // ignore
    }

    const angleDeg = Math.round(((phi * 180) / Math.PI + 360) % 360);
    const ampPct = r0 > 0 ? Math.round((amp / r0) * 100) : 0;
    const direction = ampPct > 0 ? "Outward" : ampPct < 0 ? "Inward" : "No";
    const lines = [
      [{ text: `Home ${String(homeNum).padStart(2, "0")}` }],
      [
        { text: `${direction} Deformation` },
        { text: ", " },
        { value: `${Math.abs(ampPct)}%` },
        { text: ", " },
        { value: `${angleDeg}°` },
      ],
      [{ key: "Belonging", value: `${Math.round(rate)}/10` }],
    ];

    const textG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    ringG.appendChild(textG);

    const startDy = -(lineHeightUnits * (lines.length - 1)) / 2;
    lines.forEach((segments, li) => {
      const y = rowY + startDy + li * lineHeightUnits;
      appendLabelLine(textG, textX, y, textAnchor, segments);
    });

    setStep1EmotionRingLabelClosed(line, textG);
    try {
      el.__lpLabelGroupEl = ringG;
      el.__lpLabelLineEl = line;
      el.__lpLabelTextG = textG;
    } catch {
      // ignore
    }
  });

  svg.appendChild(group);
}

// Sets a ring's leader line + label to their hidden, "not yet drawn" starting
// state (line undrawn via stroke-dashoffset, text transparent), with no
// transition — used both at build time (labels start hidden) and to reset a
// label before re-revealing it on a later hover.
function setStep1EmotionRingLabelClosed(lineEl, textG) {
  const x1 = Number(lineEl.getAttribute("x1")) || 0;
  const x2 = Number(lineEl.getAttribute("x2")) || 0;
  const len = Math.max(1, Math.abs(x2 - x1));
  lineEl.style.transition = "none";
  lineEl.style.strokeDasharray = String(len);
  lineEl.style.strokeDashoffset = String(len);
  if (textG) {
    textG.style.transition = "none";
    textG.style.opacity = "0";
  }
}

// "Writes in" one ring's leader line + label: the line draws itself via a
// stroke-dashoffset sweep, then the text fades in just behind it. Triggered
// on hover — see showStep1EmotionFullscreenRingLabel().
function revealStep1EmotionRingLabel(lineEl, textG, delayMs) {
  const x1 = Number(lineEl.getAttribute("x1")) || 0;
  const x2 = Number(lineEl.getAttribute("x2")) || 0;
  const len = Math.max(1, Math.abs(x2 - x1));

  lineEl.style.transition = "none";
  lineEl.style.strokeDasharray = String(len);
  lineEl.style.strokeDashoffset = String(len);
  if (textG) {
    textG.style.transition = "none";
    textG.style.opacity = "0";
  }

  requestAnimationFrame(() => {
    setTimeout(() => {
      lineEl.style.transition = "stroke-dashoffset 420ms ease-out";
      lineEl.style.strokeDashoffset = "0";
      if (textG) {
        textG.style.transition = "opacity 320ms ease-out 220ms";
        textG.style.opacity = "1";
      }
    }, delayMs);
  });
}

let _step1EmotionFullscreenResizeArmed = false;

function updateStep1EmotionFullscreenName() {
  if (!elStep1EmotionFullscreenName) return;
  elStep1EmotionFullscreenName.textContent = String(elStudentName?.value || "").trim();
}

function updateStep1EmotionFullscreenInfo() {
  if (!elStep1EmotionFullscreenInfoName) return;
  const validAddrs = getStep1DisplayValidAddresses();

  elStep1EmotionFullscreenInfoName.textContent = formatStep2SignatureDisplayName(elStudentName?.value || "");

  const ringsCount = validAddrs.length;
  elStep1EmotionFullscreenInfoRings.textContent = ringsCount > 0
    ? `${ringsCount} ring${ringsCount === 1 ? "" : "s"}`
    : "";

  const birthYear = validAddrs.length ? Math.floor(Number(validAddrs[0].startYear)) : NaN;
  const age = Number.isFinite(birthYear) ? Math.max(0, new Date().getFullYear() - birthYear) : "";
  setStep1EmotionFullscreenInfoRow(elStep1EmotionFullscreenInfoAge, "age :", age, "step1EmotionFullscreenInfoStatValue");

  let avg = "";
  if (validAddrs.length) {
    const sum = validAddrs.reduce((s, a) => s + normalizeBelongingRate(a.belonging_rate, 5), 0);
    avg = Math.round((sum / validAddrs.length) * 10) / 10;
  }
  setStep1EmotionFullscreenInfoRow(elStep1EmotionFullscreenInfoAvg, "avg. belonging :", avg, "step1EmotionFullscreenInfoStatValue");

  // Raw (untransliterated, un-title-cased) country/city text -- exactly as
  // typed on the address-entry page.
  const countries = formatRawCountriesForAddresses(validAddrs);
  setStep1EmotionFullscreenInfoRow(elStep1EmotionFullscreenInfoCountries, "countries :", countries !== "--" ? countries : "", "step1EmotionFullscreenInfoListValue");

  const cities = formatRawCitiesForAddresses(validAddrs);
  setStep1EmotionFullscreenInfoRow(elStep1EmotionFullscreenInfoCities, "cities :", cities !== "--" ? cities : "", "step1EmotionFullscreenInfoListValue");
}

// Builds a "label : value" row via textContent (not innerHTML) since the
// value can be raw user-typed text (country/city, see
// formatRawCountriesForAddresses/formatRawCitiesForAddresses) -- never
// interpolate that into markup.
function setStep1EmotionFullscreenInfoRow(el, labelText, valueText, valueClass) {
  if (!el) return;
  el.textContent = "";
  if (valueText === "" || valueText == null) return;
  const label = document.createElement("span");
  label.className = "step1EmotionFullscreenInfoLabel";
  label.textContent = labelText;
  const value = document.createElement("span");
  value.className = valueClass;
  value.textContent = String(valueText);
  el.append(label, value);
}

// "Grow" `el` open from the exact screen position/size of `fromRect` (a FLIP
// transition: snap `el`'s transform so it visually matches `fromRect`, then
// transition that transform back to identity so it appears to expand and
// glide into place). `toRect` lets callers measure the "same content" box
// (e.g. an inner element that excludes empty letterboxing) separately from
// `el` itself, which is the element the transform is actually applied to.
//
// Only a single uniform scale factor is ever used — never independent X/Y
// scaling — so the motion is a pure zoom + translate (move toward the
// screen center) with no shear/stretch. Non-uniform scaling of the organic,
// non-circular ring shapes reads as a spin rather than a gentle move.
function flipGrowElement(el, fromRect, toRect, opts) {
  if (!el || !fromRect || !fromRect.width || !fromRect.height) {
    if (opts && typeof opts.onDone === "function") opts.onDone();
    return;
  }
  const to = toRect || el.getBoundingClientRect();
  if (!to || !to.width || !to.height) {
    if (opts && typeof opts.onDone === "function") opts.onDone();
    return;
  }

  const scale = Math.min(fromRect.width / to.width, fromRect.height / to.height);
  const dx = (fromRect.left + fromRect.width / 2) - (to.left + to.width / 2);
  const dy = (fromRect.top + fromRect.height / 2) - (to.top + to.height / 2);

  const duration = (opts && opts.duration) || 650;
  const easing = (opts && opts.easing) || "cubic-bezier(0.33, 1, 0.68, 1)";
  const onDone = opts && typeof opts.onDone === "function" ? opts.onDone : null;

  el.style.transition = "none";
  el.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  // Force the browser to register the starting transform before animating away from it.
  void el.getBoundingClientRect();

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    el.style.transition = "";
    el.style.transform = "";
    el.removeEventListener("transitionend", cleanup);
    if (onDone) onDone();
  };

  requestAnimationFrame(() => {
    el.style.transition = `transform ${duration}ms ${easing}`;
    el.style.transform = "translate(0px, 0px) scale(1)";
    el.addEventListener("transitionend", cleanup);
    setTimeout(cleanup, duration + 150);
  });
}

// Measuring the ring group itself (rather than the whole, mostly-empty SVG
// panel it sits in) keeps the "from" box tight around the visible content —
// the panel is a tall sliver with the map letterboxed/centered inside it, so
// using the panel's own box would introduce empty margin into the scale
// math and make the grow motion look uneven.
function animateStep1EmotionFullscreenOpen(fromRect, onDone) {
  const svg = elStep1EmotionFullscreenSvg;
  if (!svg) {
    if (typeof onDone === "function") onDone();
    return;
  }
  const ringsGroup = svg.querySelector('[data-layer="step1-emotion-rings"]');
  const toRect = ringsGroup ? ringsGroup.getBoundingClientRect() : null;
  flipGrowElement(svg, fromRect, toRect, { onDone });
}

let _step1EmotionFullscreenRingHoverArmed = false;
let _step1EmotionFullscreenTooltipEl = null;
let _step1EmotionFullscreenHoveredRing = null;

function getStep1EmotionFullscreenRings() {
  return elStep1EmotionFullscreenSvg
    ? Array.from(elStep1EmotionFullscreenSvg.querySelectorAll('[data-emotion-ring="1"]'))
    : [];
}

// A ring's own stroke is only a couple of px wide, and the breathing
// animation continuously reshapes it — so even a stationary cursor can end
// up with nothing but empty space under it a moment later, purely because
// the ring itself moved. Without slack, that flips the native hit-test
// result and the browser fires a real pointerout, dropping hover the user
// never asked to leave. A wider invisible path traces the same `d` (kept in
// sync every breathing frame via ring.__lpHitPath, same mechanism the
// mirrors already use) and absorbs that wobble.
const STEP1_EMOTION_HOVER_HIT_SLACK_PX = 16;

function ensureStep1EmotionFullscreenRingHitPaths() {
  const svg = elStep1EmotionFullscreenSvg;
  if (!svg) return;
  const rings = getStep1EmotionFullscreenRings();
  for (const ring of rings) {
    if (ring.__lpHitPath) continue;
    try {
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hit.setAttribute("data-emotion-ring-hit", "1");
      hit.setAttribute("fill", "none");
      hit.setAttribute("stroke", "#000000");
      hit.setAttribute("stroke-linecap", "round");
      hit.setAttribute("stroke-linejoin", "round");
      hit.setAttribute("vector-effect", "non-scaling-stroke");
      hit.setAttribute("pointer-events", "stroke");
      hit.style.opacity = "0.001";
      const baseSw = parseFloat(ring.getAttribute("stroke-width")) || 1;
      hit.setAttribute("stroke-width", String(baseSw + STEP1_EMOTION_HOVER_HIT_SLACK_PX));
      hit.setAttribute("d", ring.getAttribute("d") || "");
      const transform = ring.getAttribute("transform");
      if (transform) hit.setAttribute("transform", transform);
      ring.parentNode.insertBefore(hit, ring.nextSibling);
      ring.__lpHitPath = hit;
      hit.__lpVisibleRing = ring;
    } catch {
      // ignore
    }
  }
}

const STEP1_EMOTION_HOVER_LABELS_FADE_MS = 340;

// Only ever one ring's label is shown at a time — the one currently hovered.
let _step1EmotionFullscreenLabelShownFor = null;

function showStep1EmotionFullscreenRingLabel(ring) {
  const ringG = ring && ring.__lpLabelGroupEl;
  const line = ring && ring.__lpLabelLineEl;
  if (!ringG || !line) return;
  ringG.style.transition = `opacity ${STEP1_EMOTION_HOVER_LABELS_FADE_MS}ms ease-in-out`;
  ringG.style.opacity = "1";
  revealStep1EmotionRingLabel(line, ring.__lpLabelTextG, 0);
}

function hideStep1EmotionFullscreenRingLabel(ring) {
  const ringG = ring && ring.__lpLabelGroupEl;
  if (!ringG) return;
  ringG.style.transition = `opacity ${STEP1_EMOTION_HOVER_LABELS_FADE_MS}ms ease-in-out`;
  ringG.style.opacity = "0";
}

// Hovering a ring on the fullscreen map's normal (non-spread) view only
// recolors it now -- the leader-line label and floating tooltip it used to
// reveal are still built and used elsewhere (ring spread, labels-on-open),
// just no longer triggered by plain hover here.
function setStep1EmotionFullscreenRingHover(targetRing) {
  const rings = getStep1EmotionFullscreenRings();
  for (const ring of rings) {
    ring.setAttribute("stroke", !targetRing || ring === targetRing ? "#000000" : "#c3c1b7");
  }
}

function clearStep1EmotionFullscreenRingHover() {
  _step1EmotionFullscreenHoveredRing = null;
  setStep1EmotionFullscreenRingHover(null);
}

function ensureStep1EmotionFullscreenTooltipEl() {
  if (_step1EmotionFullscreenTooltipEl) return _step1EmotionFullscreenTooltipEl;
  try {
    const el = document.createElement("div");
    el.id = "step1EmotionFullscreenHoverTooltip";
    el.style.cssText = "position:fixed;pointer-events:none;font-family:'NarkissBlock-Light-TRIAL',sans-serif;font-size:12px;color:#000000;white-space:nowrap;display:none;z-index:9000;text-transform:none;";
    document.body.appendChild(el);
    _step1EmotionFullscreenTooltipEl = el;
    return el;
  } catch {
    return null;
  }
}

function hideStep1EmotionFullscreenTooltip() {
  const tooltip = _step1EmotionFullscreenTooltipEl;
  if (!tooltip) return;
  tooltip.style.display = "none";
}

function showStep1EmotionFullscreenTooltip(ring, clientX, clientY) {
  const tooltip = ensureStep1EmotionFullscreenTooltipEl();
  if (!tooltip || !ring) return;
  const homeNum = Number(ring.getAttribute("data-emotion-home-num")) || 0;
  tooltip.textContent = `home ${String(homeNum).padStart(2, "0")}`;
  tooltip.style.left = (Number(clientX) + 14) + "px";
  tooltip.style.top = (Number(clientY) - 8) + "px";
  tooltip.style.display = "block";
}

function armStep1EmotionFullscreenRingHover() {
  if (!elStep1EmotionFullscreenSvg || _step1EmotionFullscreenRingHoverArmed) return;
  _step1EmotionFullscreenRingHoverArmed = true;

  const ringFromEventTarget = (target) => {
    try {
      if (!target || typeof target.closest !== "function") return null;
      const el = target.closest('[data-emotion-ring="1"], [data-emotion-ring-hit="1"]');
      if (!el) return null;
      return el.hasAttribute("data-emotion-ring-hit") ? (el.__lpVisibleRing || null) : el;
    } catch {
      return null;
    }
  };

  elStep1EmotionFullscreenSvg.addEventListener("pointermove", (e) => {
    // The spread label still follows the mouse (same tooltip used outside
    // spread) -- just reposition it, no need to redo the coloring/sound
    // focus work that pointerover/pointerout already did. Plain hover on
    // the normal (non-spread) map follows the same "home xx" tooltip too.
    if (_step1EmotionFullscreenSpreadActive && _step1EmotionFullscreenSpreadHoveredRing) {
      showStep1EmotionFullscreenTooltip(_step1EmotionFullscreenSpreadHoveredRing, e.clientX, e.clientY);
    } else if (!_step1EmotionFullscreenSpreadActive && _step1EmotionFullscreenHoveredRing) {
      showStep1EmotionFullscreenTooltip(_step1EmotionFullscreenHoveredRing, e.clientX, e.clientY);
    }
  }, { passive: true });

  elStep1EmotionFullscreenSvg.addEventListener("pointerover", (e) => {
    const ring = ringFromEventTarget(e.target);
    if (!ring) return;
    if (_step1EmotionFullscreenSpreadActive) {
      showStep1EmotionFullscreenSpreadHoverLabel(ring, e.clientX, e.clientY);
      return;
    }
    _step1EmotionFullscreenHoveredRing = ring;
    setStep1EmotionFullscreenRingHover(ring);
    showStep1EmotionFullscreenTooltip(ring, e.clientX, e.clientY);
  }, { passive: true });

  elStep1EmotionFullscreenSvg.addEventListener("pointerout", (e) => {
    const fromRing = ringFromEventTarget(e.target);
    if (!fromRing) return;
    const toRing = ringFromEventTarget(e.relatedTarget);
    if (_step1EmotionFullscreenSpreadActive) {
      if (toRing) showStep1EmotionFullscreenSpreadHoverLabel(toRing, e.clientX, e.clientY);
      else hideStep1EmotionFullscreenSpreadHoverLabel();
      return;
    }
    if (toRing) {
      _step1EmotionFullscreenHoveredRing = toRing;
      setStep1EmotionFullscreenRingHover(toRing);
      showStep1EmotionFullscreenTooltip(toRing, e.clientX, e.clientY);
      return;
    }
    clearStep1EmotionFullscreenRingHover();
    hideStep1EmotionFullscreenTooltip();
  }, { passive: true });

  elStep1EmotionFullscreenSvg.addEventListener("pointerleave", () => {
    if (_step1EmotionFullscreenSpreadActive) {
      hideStep1EmotionFullscreenSpreadHoverLabel();
      return;
    }
    clearStep1EmotionFullscreenRingHover();
    hideStep1EmotionFullscreenTooltip();
  }, { passive: true });

  // Click a ring -> spread every ring in this map out into a row (like the
  // Step 1 "ring reading" strip). While spread is active, clicking one of the
  // spread rings opens its solo ring-reading page (the exact same page Step
  // 1's own ring-reading strip opens); clicking empty space instead collapses
  // back to the normal concentric map. Coloring while spread is purely
  // hover-driven, not tied to which ring was actually clicked to get there —
  // see showStep1EmotionFullscreenSpreadHoverLabel().
  elStep1EmotionFullscreenSvg.addEventListener("click", (e) => {
    if (_step1EmotionFullscreenSpreadActive) {
      const ring = ringFromEventTarget(e.target);
      const homeNum = ring ? Number(ring.getAttribute("data-emotion-home-num")) || 0 : 0;
      if (homeNum > 0) {
        _emotionSoloReturnToStep1FullscreenSpread = true;
        _emotionSoloReturnToStep2 = false;
        const origin = buildEmotionSoloOriginFromRingEl(ring, homeNum - 1);
        openEmotionMapSoloFromStep1RingReading(homeNum - 1, origin);
        return;
      }
      exitStep1EmotionFullscreenRingSpread();
      return;
    }
    const ring = ringFromEventTarget(e.target);
    if (!ring) return;
    enterStep1EmotionFullscreenRingSpread(ring);
  });
}

// --- Ring spread: click a ring on the fullscreen emotion map to lay every
// ring in this map out side by side in a row, the clicked one enlarged and
// labeled; click again anywhere to collapse back to the normal concentric
// map. ---
let _step1EmotionFullscreenSpreadActive = false;
let _step1EmotionFullscreenSpreadRaf = 0;
let _step1EmotionFullscreenSpreadHoveredRing = null;

function getStep1EmotionFullscreenViewBox() {
  const svg = elStep1EmotionFullscreenSvg;
  const raw = (svg && svg.getAttribute("viewBox")) || "0 0 1000 620";
  const parts = raw.split(/\s+/).map(Number);
  const [vbX, vbY, vbW, vbH] = parts.length === 4 && parts.every((v) => isFinite(v)) ? parts : [0, 0, 1000, 620];
  return { vbX, vbY, vbW, vbH, cx: vbX + vbW / 2, cy: vbY + vbH / 2 };
}

// Combines the spread's own horizontal offset/scale with whatever transform
// the ring already had (e.g. resolveStep1EmotionFullscreenRingOverlaps()'s
// radius-scale correction) instead of clobbering it, and keeps the ring's
// hit-path (and label leader-line, if any) glued to the same offset.
function applyStep1EmotionFullscreenRingSpreadOffset(ring, dx, extraScale, cx, cy) {
  const base = ring.__lpPreSpreadTransform || "";
  const scalePart = extraScale && Math.abs(extraScale - 1) > 0.001
    ? `translate(${cx} ${cy}) scale(${extraScale}) translate(${-cx} ${-cy})`
    : "";
  const dxPart = dx ? `translate(${dx} 0)` : "";
  const combined = [dxPart, scalePart, base].filter(Boolean).join(" ");
  if (combined) ring.setAttribute("transform", combined);
  else ring.removeAttribute("transform");

  const hit = ring.__lpHitPath;
  if (hit) {
    if (combined) hit.setAttribute("transform", combined);
    else hit.removeAttribute("transform");
  }
  const labelG = ring.__lpLabelGroupEl;
  if (labelG) {
    if (dxPart) labelG.setAttribute("transform", dxPart);
    else labelG.removeAttribute("transform");
  }
}

function stopStep1EmotionFullscreenSpreadAnim() {
  if (_step1EmotionFullscreenSpreadRaf) cancelAnimationFrame(_step1EmotionFullscreenSpreadRaf);
  _step1EmotionFullscreenSpreadRaf = 0;
}

function animateStep1EmotionFullscreenRingSpread(targets, durationMs, onDone) {
  stopStep1EmotionFullscreenSpreadAnim();
  const { cx, cy } = getStep1EmotionFullscreenViewBox();
  const t0 = performance.now();
  const starts = new Map();
  targets.forEach((_, ring) => {
    starts.set(ring, { dx: Number(ring.__lpSpreadDx) || 0, scale: Number(ring.__lpSpreadScale) || 1 });
  });

  function frame(now) {
    const t = Math.min(1, (now - t0) / durationMs);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    targets.forEach((target, ring) => {
      const start = starts.get(ring) || { dx: 0, scale: 1 };
      const dx = start.dx + (target.dx - start.dx) * e;
      const scale = start.scale + ((target.scale ?? 1) - start.scale) * e;
      ring.__lpSpreadDx = dx;
      ring.__lpSpreadScale = scale;
      applyStep1EmotionFullscreenRingSpreadOffset(ring, dx, scale, cx, cy);
    });
    if (t < 1) {
      _step1EmotionFullscreenSpreadRaf = requestAnimationFrame(frame);
    } else {
      _step1EmotionFullscreenSpreadRaf = 0;
      if (onDone) onDone();
    }
  }
  _step1EmotionFullscreenSpreadRaf = requestAnimationFrame(frame);
}

function enterStep1EmotionFullscreenRingSpread(clickedRing) {
  const rings = getStep1EmotionFullscreenRings();
  if (!rings.length) return;
  _step1EmotionFullscreenSpreadActive = true;
  clearStep1EmotionFullscreenRingHover();

  // Reclaim the full page for the spread row -- same "empty page" layout
  // this had before the reading info panel was added to the concentric view.
  // Only the info text hides; the ring container itself is deliberately left
  // untouched (see the width/scale math below) so nothing about it resizes
  // or jumps when the spread starts -- restored in
  // exitStep1EmotionFullscreenRingSpread().
  if (elPageStep1EmotionFullscreen) elPageStep1EmotionFullscreen.classList.add("step1-emotion-fullscreen-spread");

  // Breathing keeps running through the spread (each ring's own breathing
  // animation stays visible while spread out in the row) -- left as-is here;
  // GAP_VB below already carries enough slack for the oscillation.

  // The shared ring-hover hit-paths carry generous slack (see
  // STEP1_EMOTION_HOVER_HIT_SLACK_PX) sized for the concentric map, where
  // neighbors are far apart — in this tightly-packed row it would make
  // adjacent rings' hover zones overlap. Shrink it for the duration of the
  // spread; restored in exitStep1EmotionFullscreenRingSpread().
  rings.forEach((ring) => {
    const hit = ring.__lpHitPath;
    if (!hit) return;
    if (ring.__lpPreSpreadHitStrokeWidth === undefined) {
      ring.__lpPreSpreadHitStrokeWidth = hit.getAttribute("stroke-width");
    }
    const baseSw = Number(ring.getAttribute("stroke-width")) || 1;
    hit.setAttribute("stroke-width", String(baseSw + 6));
  });

  const { cx, vbW } = getStep1EmotionFullscreenViewBox();
  const n = rings.length;

  // The ring container's own box/scale is left untouched (see above), so a
  // px-wide "spread across the page" target has to be converted into this
  // SVG's current viewBox units via its live screen scale (same technique
  // fitStep1EmotionFullscreenInnerRing() uses) -- overflow:visible on both
  // the SVG and its wrap already lets ring transforms render past the wrap's
  // own box, so this is enough to reach the full page width without
  // resizing anything.
  const ctm = elStep1EmotionFullscreenSvg.getScreenCTM();
  const pxPerVbUnit = ctm ? Math.max(1e-6, Math.hypot(ctm.a, ctm.b)) : 1;
  const targetRowPx = Math.max(200, (window.innerWidth || 1200) - 160);
  const usableW = targetRowPx / pxPerVbUnit;

  // The row is laid out centered on the true page middle (not on the ring
  // cluster's own current, off-center position) -- converting the physical
  // viewport center into this SVG's current viewBox units via the same CTM.
  // Each ring's own dx below is still measured from its actual current
  // position (cx), so the animation itself still glides smoothly from
  // wherever the map currently sits; only the row's target center moves.
  let pageCenterVbX = cx;
  if (ctm) {
    try {
      const inv = ctm.inverse();
      const pt = elStep1EmotionFullscreenSvg.createSVGPoint();
      pt.x = (window.innerWidth || 1200) / 2;
      pt.y = 0;
      pageCenterVbX = pt.matrixTransform(inv).x;
    } catch {
      // ignore
    }
  }
  // Fixed edge-to-edge gap between adjacent spread rings, held to a constant
  // physical 34px on screen (converted to this viewBox's current units) —
  // the row is laid out cumulatively (each ring's edge to the next ring's
  // edge), not by evenly spacing centers, so this gap reads as equal
  // regardless of how different two neighboring rings' sizes are.
  const GAP_VB = 34 / pxPerVbUnit;

  // Freeze each ring's own current transform (e.g. an overlap-resolution
  // radius-scale correction) so the spread offset composes on top of it
  // instead of replacing it, and so collapsing back can restore it exactly.
  rings.forEach((ring) => {
    if (ring.__lpPreSpreadTransform === undefined) {
      ring.__lpPreSpreadTransform = ring.getAttribute("transform") || "";
    }
  });

  // Rings can be very different sizes (they grow with home count in the
  // normal concentric map), so laying them out at their true size can make
  // the row overflow the screen. Find the single global shrink factor —
  // applied to every ring's *shape* alike — that's just small enough for the
  // whole row (every true diameter plus the fixed gaps) to fit; never
  // enlarges beyond a ring's own true size if there's already room to spare.
  // "True size" includes the static pull/push bump, not just the base
  // radius, so a ring's actual painted edge (its furthest visible point,
  // breathing now frozen) never eats into the gap. Each ring's stroke is
  // tracked separately: it's drawn with vector-effect="non-scaling-stroke",
  // so it stays a constant on-screen width regardless of this shrink —
  // folding it into the shrunk radius would under-budget the room it
  // actually needs once scale drops meaningfully below 1.
  const shapeRs = rings.map((ring) => {
    const r0 = Number(ring.getAttribute("data-emotion-r0")) || 0;
    const amp = Math.abs(Number(ring.getAttribute("data-emotion-amp")) || 0);
    const radiusScale = Number(ring.getAttribute("data-emotion-radius-scale")) || 1;
    return Math.max(1, (r0 + amp) * radiusScale);
  });
  const strokeHalves = rings.map((ring) => (Number(ring.getAttribute("stroke-width")) || 1) / 2);
  const sumShapeR = shapeRs.reduce((a, b) => a + b, 0);
  const sumStrokeHalf = strokeHalves.reduce((a, b) => a + b, 0);
  const totalGaps = GAP_VB * Math.max(0, n - 1);
  const availableForShapes = usableW - sumStrokeHalf * 2 - totalGaps;
  const spreadFitScale = sumShapeR > 0 ? Math.max(0.15, Math.min(1, availableForShapes / (sumShapeR * 2))) : 1;

  const rowWidth = sumShapeR * 2 * spreadFitScale + sumStrokeHalf * 2 + totalGaps;
  let cursor = pageCenterVbX - rowWidth / 2;
  const targets = new Map();
  rings.forEach((ring, i) => {
    const visualR = shapeRs[i] * spreadFitScale + strokeHalves[i];
    const centerX = cursor + visualR;
    cursor += visualR * 2 + GAP_VB;
    targets.set(ring, { dx: centerX - cx, scale: spreadFitScale });
  });

  animateStep1EmotionFullscreenRingSpread(targets, 700, () => {
    // Default, no-hover state: every ring black — coloring is otherwise
    // purely hover-driven (see showStep1EmotionFullscreenSpreadHoverLabel()),
    // not tied to whichever ring was actually clicked to enter the spread.
    rings.forEach((r) => r.setAttribute("stroke", "#000000"));
  });
}

function showStep1EmotionFullscreenSpreadHoverLabel(ring, clientX, clientY) {
  if (!ring) return;
  const homeNum = Number(ring.getAttribute("data-emotion-home-num")) || 0;
  // Follows the mouse cursor, same as the normal (non-spread) tooltip.
  showStep1EmotionFullscreenTooltip(ring, clientX, clientY);

  // Only the hovered ring is black — every other ring (including whichever
  // one was originally clicked to enter the spread) turns gray for as long
  // as the hover lasts, reverting to all-black together when it ends.
  const rings = getStep1EmotionFullscreenRings();
  rings.forEach((r) => {
    r.setAttribute("stroke", r === ring ? "#000000" : "#c3c1b7");
  });
  _step1EmotionFullscreenSpreadHoveredRing = ring;

  // Solo this ring's own sound while hovering it. The finished map's actual
  // audible loops live in window._step1RingLoops (see setStep1EntrySoundFocus());
  // setEmotionSoundFocus() targets the separate ambient system, which the
  // active finish flow never starts, but is called too in case that ever
  // changes.
  if (homeNum > 0) {
    try {
      setEmotionSoundFocus(homeNum - 1);
    } catch {
      // ignore
    }
    try {
      setStep1EntrySoundFocus(homeNum - 1);
    } catch {
      // ignore
    }
  }
}

function hideStep1EmotionFullscreenSpreadHoverLabel() {
  hideStep1EmotionFullscreenTooltip();
  if (_step1EmotionFullscreenSpreadHoveredRing) {
    const rings = getStep1EmotionFullscreenRings();
    rings.forEach((r) => r.setAttribute("stroke", "#000000"));
    _step1EmotionFullscreenSpreadHoveredRing = null;
  }
  try {
    setEmotionSoundFocus(null);
  } catch {
    // ignore
  }
  try {
    setStep1EntrySoundFocus(null);
  } catch {
    // ignore
  }
}

function exitStep1EmotionFullscreenRingSpread() {
  if (!_step1EmotionFullscreenSpreadActive) return;
  const rings = getStep1EmotionFullscreenRings();
  _step1EmotionFullscreenSpreadActive = false;

  if (elPageStep1EmotionFullscreen) elPageStep1EmotionFullscreen.classList.remove("step1-emotion-fullscreen-spread");

  hideStep1EmotionFullscreenSpreadHoverLabel();
  rings.forEach((ring) => ring.setAttribute("stroke", "#000000"));

  // Restore the hover hit-path slack shrunk on entry (see
  // enterStep1EmotionFullscreenRingSpread()).
  rings.forEach((ring) => {
    const hit = ring.__lpHitPath;
    if (hit && ring.__lpPreSpreadHitStrokeWidth !== undefined) {
      hit.setAttribute("stroke-width", ring.__lpPreSpreadHitStrokeWidth);
      ring.__lpPreSpreadHitStrokeWidth = undefined;
    }
  });

  const targets = new Map();
  rings.forEach((ring) => targets.set(ring, { dx: 0, scale: 1 }));
  animateStep1EmotionFullscreenRingSpread(targets, 600, () => {
    rings.forEach((ring) => {
      ring.__lpPreSpreadTransform = undefined;
    });
  });
}

// (Re)populates the fullscreen page's SVG from the live Step 1 preview and
// re-arms its breathing/hover wiring. Called each time the fullscreen page
// is opened from Step 1.
function populateStep1EmotionFullscreenSvg() {
  // Fresh ring elements are about to replace whatever's here, so any
  // in-progress spread is now meaningless — reset instead of leaving stale
  // references to detached rings.
  stopStep1EmotionFullscreenSpreadAnim();
  _step1EmotionFullscreenSpreadActive = false;
  _step1EmotionFullscreenSpreadHoveredRing = null;
  if (elPageStep1EmotionFullscreen) elPageStep1EmotionFullscreen.classList.remove("step1-emotion-fullscreen-spread");

  // (Re)start the ambient breathing + ring sounds in case the browser
  // blocked autoplay earlier, or a prior solo-mode visit stopped it — this
  // guarantees both are running before we snapshot the map.
  renderStep1EmotionMap();

  // A dedicated page, not the ring-reading solo page: just show the current
  // Step 1 emotion map preview blown up and centered, by copying its
  // already-rendered SVG content over. The copies are linked back to the
  // live preview's ring elements so the ongoing breathing motion (and its
  // sound) keeps animating both in sync.
  if (elStep1EmotionFullscreenSvg && elStep1EmotionSvg) {
    elStep1EmotionFullscreenSvg.setAttribute("viewBox", elStep1EmotionSvg.getAttribute("viewBox") || "0 0 1000 620");
    elStep1EmotionFullscreenSvg.innerHTML = elStep1EmotionSvg.innerHTML;
    linkStep1EmotionFullscreenMirrors();
    dampStep1EmotionFullscreenRingDistortion();
    // Fit the map to its size budget *first* so it stays as compact as
    // possible, then resolve overlaps *last* so it has the final say: no
    // ring may ever touch another, even if satisfying that means the map
    // ends up larger than the size budget compressStep1EmotionFullscreen
    // RingSpan() targets. (Previously this ran in the opposite order, so
    // the size-budget compression could re-introduce touching rings that
    // overlap resolution had just fixed.)
    compressStep1EmotionFullscreenRingSpan();
    resolveStep1EmotionFullscreenRingOverlaps();
    // Fresh ring elements were just swapped in, so any previously hovered
    // ring reference is now stale/detached.
    _step1EmotionFullscreenHoveredRing = null;
    _step1EmotionFullscreenLabelShownFor = null;
    ensureStep1EmotionFullscreenRingHitPaths();
    armStep1EmotionFullscreenRingHover();
  }
  updateStep1EmotionFullscreenName();
  updateStep1EmotionFullscreenInfo();
}

if (elStep1EmotionFullscreenBtn) {
  elStep1EmotionFullscreenBtn.addEventListener("click", () => {
    if (!isStep1DataEntryFinished()) return;
    // Clicking this button is itself a user gesture, so use it to (re)start the
    // ambient breathing + ring sounds in case the browser blocked autoplay
    // earlier — this guarantees both are running before we snapshot the map
    // for fromRect below. populateStep1EmotionFullscreenSvg() calls this
    // again too, but that repeat call is a no-op here.
    renderStep1EmotionMap();

    const smallRingsGroup = elStep1EmotionSvg ? elStep1EmotionSvg.querySelector('[data-layer="step1-emotion-rings"]') : null;
    const fromRect = smallRingsGroup ? smallRingsGroup.getBoundingClientRect() : (elStep1EmotionSvg ? elStep1EmotionSvg.getBoundingClientRect() : null);

    // showPage() must run *before* populate: resolveStep1EmotionFullscreen
    // RingOverlaps() (called from inside populate) measures rings via
    // getBBox(), which returns all-zero for anything under a display:none
    // ancestor -- so calling populate while this page is still hidden
    // silently no-ops every overlap check it does.
    showPage("step1EmotionFullscreen");
    populateStep1EmotionFullscreenSvg();
    fitStep1EmotionFullscreenInnerRing();
    // Map + reading panel treated as one unit and centered together (their
    // own gap never changes) -- done before the open animation below so its
    // own "grow to" measurement already reflects the final, centered rect.
    centerStep1EmotionFullscreenReadingUnit();
    // Built (hidden) only once the map has finished growing into place, so
    // each label anchors to its ring's final position — they stay hidden
    // until hovered; see showStep1EmotionFullscreenRingLabel().
    animateStep1EmotionFullscreenOpen(fromRect, () => {
      renderStep1EmotionFullscreenRingLabels();
    });

    if (!_step1EmotionFullscreenResizeArmed) {
      _step1EmotionFullscreenResizeArmed = true;
      window.addEventListener("resize", () => {
        if (elPageStep1EmotionFullscreen && !elPageStep1EmotionFullscreen.classList.contains("hidden")) {
          fitStep1EmotionFullscreenInnerRing();
          centerStep1EmotionFullscreenReadingUnit();
          renderStep1EmotionFullscreenRingLabels();
        }
      }, { passive: true });
    }
  });
}

if (elStep1EmotionFullscreenBackBtn) {
  elStep1EmotionFullscreenBackBtn.addEventListener("click", () => {
    // While rings are spread into a row, "back" first collapses that back to
    // the normal concentric emotion map (staying on this page) rather than
    // leaving the fullscreen page entirely — same as clicking anywhere else
    // while spread.
    if (_step1EmotionFullscreenSpreadActive) {
      exitStep1EmotionFullscreenRingSpread();
      return;
    }
    // No animation on close: drop any in-flight opening transform instantly.
    if (elStep1EmotionFullscreenSvg) {
      elStep1EmotionFullscreenSvg.style.transition = "";
      elStep1EmotionFullscreenSvg.style.transform = "";
    }
    // showPage() itself already set _step1SkipEmotionRebuildOnce when this
    // page was entered from Step 1 (see its own comment), so the rebuild
    // below is skipped automatically.
    showPage("step1", { scroll: "step1", behavior: "auto" });
  });
}

// Reveal a home's address/years/belonging text progressively (a soft "being
// written" effect) instead of popping in instantly. Timestamp-based so it
// stays correct no matter how often updateStep1HomesList() gets re-invoked
// (e.g. from unrelated keystrokes while another home is being typed) — it
// always renders "how much should be shown by now", and only restarts when
// the underlying text actually changes. Each field of a home has its own key
// (so e.g. editing just the belonging rate later only re-types that field),
// but since all of a newly-added home's fields first appear in the same
// updateStep1HomesList() pass, they naturally start typing in sync.
const _step1HomesListReveal = new Map();
let _step1HomesListRevealRAF = 0;

function step1ScheduleHomesListRevealTick() {
  if (_step1HomesListRevealRAF) return;
  _step1HomesListRevealRAF = requestAnimationFrame(() => {
    _step1HomesListRevealRAF = 0;
    updateStep1HomesList();
  });
}

function step1HomesListRevealText(key, fullText) {
  const text = String(fullText || "");
  if (!text) {
    _step1HomesListReveal.delete(key);
    return "";
  }

  const now = performance.now();
  let state = _step1HomesListReveal.get(key);
  if (!state || state.text !== text) {
    state = { text, startTs: now };
    _step1HomesListReveal.set(key, state);
  }

  const MS_PER_CHAR = 26;
  const MIN_DURATION_MS = 260;
  const MAX_DURATION_MS = 1000;
  const duration = Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, text.length * MS_PER_CHAR));
  const t = Math.min(1, (now - state.startTs) / duration);
  const revealedCount = Math.round(t * text.length);

  if (revealedCount < text.length) step1ScheduleHomesListRevealTick();
  return text.slice(0, revealedCount);
}

function updateStep1HomesList() {
  if (!elStep1HomesList) return;
  armStep1HomesListInteraction();

  const totalExpected = Math.max(
    getStep1DisplayValidAddresses().length,
    parseInt(String(elHomesCount?.value || ""), 10) || 0
  );
  // Plain committed addresses, NOT getStep1DisplayValidAddresses() -- that
  // one merges the live, uncommitted form/preview values into whichever
  // index is being edited, which would make this list "type live" as the
  // user edits an address. Only totalExpected (row count) above needs the
  // live-preview-aware version, to size in a placeholder row for a brand
  // new home still being typed; the actual per-row content below should
  // only ever reflect what's actually saved (addresses[idx]).
  const validAddrs = Array.isArray(addresses) ? addresses.filter((a) => a && a.valid !== false) : [];

  // A brand-new home's data should only "type itself out" once it's actually
  // committed (the user clicked add home / finish) — not while it's still a
  // live, uncommitted preview of whatever is currently in the form fields.
  // This does NOT apply while editing an already-committed home: that one
  // already has real saved data, so it should keep showing it throughout the
  // edit instead of blanking out, only actually changing once the edit is
  // saved (add home is clicked -- addresses[idx] is what's read above, so
  // it updates itself naturally at that point, not any sooner).
  const hasPreviewOverlay = Boolean(step1PendingPreviewAddress) && !isStep1EditModeActive();
  const previewOverlayIdx = hasPreviewOverlay
    ? (Array.isArray(addresses) ? addresses.length : 0)
    : -1;

  elStep1HomesList.innerHTML = "";

  for (let i = 0; i < totalExpected; i++) {
    const addr = validAddrs[i] || null;
    const isCommitted = Boolean(addr) && i !== previewOverlayIdx;
    // Nothing about a home (address, years, belonging) shows up in this list
    // until it's actually committed (add home / finish / Save Changes) — a
    // live, uncommitted preview of the form fields stays invisible here.
    const displayAddr = isCommitted ? addr : null;

    const item = document.createElement("div");
    item.className = "homesListItem";
    if (displayAddr) item.setAttribute("data-home-idx", String(i));

    const num = document.createElement("div");
    num.className = "homesListNum" + (displayAddr ? " filled" : "");
    num.textContent = `home no.${formatHomeNumber(i + 1)}`;
    item.appendChild(num);

    // Line 1: street + number, city, country — use original user-typed text when available.
    const addressLine = document.createElement("div");
    addressLine.className = "homesListDetail homesListAddress";
    if (displayAddr) {
      const streetPart = displayAddr._origStreetAndNumber
        || [displayAddr._origStreet || displayAddr.street, displayAddr._origNumber || displayAddr.number].filter(Boolean).join(" ");
      const city = displayAddr._origCity || displayAddr.city;
      const country = displayAddr._origCountry || displayAddr.country;
      const fullAddressText = [streetPart, city, country].filter(Boolean).join(", ");
      addressLine.textContent = step1HomesListRevealText(`${i}:address`, fullAddressText);
    } else {
      _step1HomesListReveal.delete(`${i}:address`);
    }
    item.appendChild(addressLine);

    // Line 2: years
    const yearsLine = document.createElement("div");
    yearsLine.className = "homesListDetail homesListYears";
    if (displayAddr) {
      const startY = String(displayAddr.startYear || "").trim();
      const nextIsCommitted = (i + 1) !== previewOverlayIdx;
      const nextAddr = nextIsCommitted ? (validAddrs[i + 1] || null) : null;
      const isLast = i === totalExpected - 1;
      const endY = nextAddr ? String(nextAddr.startYear || "").trim() : (isLast ? "2026" : "");
      let yearsText = "";
      if (startY && endY) {
        yearsText = `${startY} – ${endY}`;
      } else if (startY) {
        yearsText = `${startY} –`;
      }
      yearsLine.textContent = step1HomesListRevealText(`${i}:years`, yearsText);
    } else {
      _step1HomesListReveal.delete(`${i}:years`);
    }
    item.appendChild(yearsLine);

    // Line 3: belonging rate
    const belongLine = document.createElement("div");
    belongLine.className = "homesListDetail homesListBelonging";
    if (displayAddr) {
      const rate = normalizeBelongingRate(displayAddr.belonging_rate, stableBelongingRateFromId(displayAddr.id));
      const belongText = `belonging  ${String(rate).padStart(2, "0")}`;
      belongLine.textContent = step1HomesListRevealText(`${i}:belonging`, belongText);
    } else {
      _step1HomesListReveal.delete(`${i}:belonging`);
    }
    item.appendChild(belongLine);

    elStep1HomesList.appendChild(item);
  }
  setStep1HomesListFocus();
}

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
    allMapsZoomHintBaseZoom = allMapsMap.getZoom();
    allMapsZoomHintDismissed = false;
    updateAllMapsZoomHint();
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
  const visibleItems = items;

  const allValidPts = [];
  const israelPts = [];
  for (const snap of visibleItems) {
    const addrs = Array.isArray(snap?.addresses) ? snap.addresses : [];
    for (const a of addrs) {
      const ok = a && a.valid !== false && isFinite(a.lat) && isFinite(a.lon);
      if (!ok) continue;
      const ll = L.latLng(Number(a.lat), Number(a.lon));
      allValidPts.push(ll);
      if (ISRAEL_BOUNDS.contains(ll)) israelPts.push(ll);
    }
  }

  if (allValidPts.length === 1) {
    allMapsMap.setView(allValidPts[0], 6, { animate: false });
    enforceMinZoomToAvoidBlankViewport(allMapsMap);
    return;
  }

  const bounds = israelPts.length > 0
    ? L.latLngBounds(israelPts)
    : (allValidPts.length > 0 ? L.latLngBounds(allValidPts) : ISRAEL_BOUNDS);
  if (!bounds.isValid()) return;

  const pad = (israelPts.length > 0 || allValidPts.length > 0) ? 0.06 : ISRAEL_FIT_PADDING;
  allMapsMap.fitBounds(bounds.pad(pad), {
    animate: false,
    maxZoom: getMapMaxZoom(allMapsMap) ?? undefined,
  });
  enforceMinZoomToAvoidBlankViewport(allMapsMap);
}

function focusAllMapsOnHighlightedSnapshotIsraelOnly(targetKey) {
  if (!allMapsMap) return false;
  const wantKey = String(targetKey || "");
  if (!wantKey) return false;

  const list = getSavedMaps();
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  const snap = items.find((x) => {
    if (!x) return false;
    const snapKey = String(getSavedMapKey(x) || "");
    const snapLabel = String(x?.label || "");
    const effectiveKey = snapKey || snapLabel;
    return effectiveKey && effectiveKey === wantKey;
  });
  if (!snap) return false;

  /** @type {L.LatLng[]} */
  const allValidPts = [];
  /** @type {L.LatLng[]} */
  const israelPts = [];
  const addrs = Array.isArray(snap?.addresses) ? snap.addresses : [];
  for (const a of addrs) {
    const ok = a && a.valid !== false && isFinite(a.lat) && isFinite(a.lon);
    if (!ok) continue;
    const ll = L.latLng(Number(a.lat), Number(a.lon));
    allValidPts.push(ll);
    if (ISRAEL_BOUNDS.contains(ll)) israelPts.push(ll);
  }

  if (allValidPts.length === 1) {
    try {
      // Slightly less zoomed in than a plain fixed 6.
      allMapsMap.setView(allValidPts[0], 5.3, { animate: false });
      enforceMinZoomToAvoidBlankViewport(allMapsMap);
      return true;
    } catch {
      return false;
    }
  }

  const bounds = israelPts.length > 0
    ? L.latLngBounds(israelPts)
    : (allValidPts.length > 0 ? L.latLngBounds(allValidPts) : ISRAEL_BOUNDS);
  if (!bounds.isValid()) return false;

  // More padding than before -- fits the same bounds slightly less
  // tightly/zoomed in.
  const pad = (israelPts.length > 0 || allValidPts.length > 0) ? 0.12 : ISRAEL_FIT_PADDING;
  try {
    allMapsMap.fitBounds(bounds.pad(pad), {
      animate: false,
      maxZoom: getMapMaxZoom(allMapsMap) ?? undefined,
    });
    enforceMinZoomToAvoidBlankViewport(allMapsMap);
    return true;
  } catch {
    return false;
  }
}

function updateAllMapsCountLabel(visibleCount) {
  const n = Math.max(0, Number(visibleCount) || 0);
  const two = n < 100 ? String(n).padStart(2, "0") : String(n);
  if (elAllMapsCountLabel) elAllMapsCountLabel.textContent = `${two}lifepathe.maps`;
}

function updateAllMapsHideMapLabel() {
  if (!elAllMapsHideMapBtn) return;
  elAllMapsHideMapBtn.textContent = allMapsTilesVisible ? "hide map" : "show map";
}

function setAllMapsTilesVisible(enabled) {
  if (!allMapsMap) return;
  const want = Boolean(enabled);
  if (want === Boolean(allMapsTilesVisible)) {
    updateAllMapsHideMapLabel();
    if (elPageAllMaps) {
      elPageAllMaps.classList.toggle("dark-map-ui", Boolean(allMapsTilesVisible) && isDarkBasemap(basemapStyleId));
      elPageAllMaps.classList.toggle("tiles-visible", Boolean(allMapsTilesVisible));
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
    elPageAllMaps.classList.toggle("tiles-visible", Boolean(allMapsTilesVisible));
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
    zoomSnap: 0.4,
    zoomDelta: 0.4,
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
    updateAllMapsZoomHint();
    if (allMapsTilesVisible && isLineArtBasemap(basemapStyleId) && allMapsLineArtLayer) {
      scheduleLineArtUpdate(allMapsMap, allMapsLineArtLayer, allMapsLineArtState);
    }
  });

  allMapsMap.on("moveend", () => {
    if (allMapsTilesVisible && isLineArtBasemap(basemapStyleId) && allMapsLineArtLayer) {
      scheduleLineArtUpdate(allMapsMap, allMapsLineArtLayer, allMapsLineArtState);
    }
  });

  // Clicking anywhere on the routes/map area cancels the current focus.
  allMapsMap.on("click", () => {
    if (allMapsHighlightedKey) toggleAllMapsHighlightKey(allMapsHighlightedKey);
  });

  // Use a sane default view near Israel (match Step 2; avoid world view).
  allMapsMap.setView([31.5, 35.1], 7, { animate: false });
  enforceMinZoomToAvoidBlankViewport(allMapsMap);

  // Leave the label blank until the page-open finalizes the baseline.
  allMapsZoomBase = null;
  updateAllMapsZoomLabel();
}

// Home page logo scroll-morph: screen 1's logo starts as a big centered
// hero image. Once scrolling brings its top edge to the top of the
// viewport, it "sticks" there instead of continuing to scroll away, and
// over a fixed further scroll distance it slides/shrinks into exactly the
// small top-left corner position and size every other page's logo uses
// (.appLogoImage's own "outside #pageStep1" formula: top/left scale with
// --step1-scale the same way .btnImg etc. already do).
let homeLogoHeroLeft = null;
let homeLogoHeroTop = null; // natural top-edge distance from the top of the scrollable content (.homePageInner) -- independent of current scroll position
let homeLogoHeroWidth = null;

function captureHomeLogoHeroMetrics() {
  const logo = document.querySelector("#pageWelcome .homePageLogo");
  if (!logo || !elPageWelcome) return;
  const wasFixed = logo.classList.contains("homeLogoFixed");
  if (wasFixed) logo.classList.remove("homeLogoFixed");
  const rect = logo.getBoundingClientRect();
  homeLogoHeroLeft = rect.left;
  homeLogoHeroTop = rect.top + elPageWelcome.scrollTop;
  homeLogoHeroWidth = rect.width;
  if (wasFixed) logo.classList.add("homeLogoFixed");
}

function updateHomeLogoScrollMorph() {
  homeLogoScrollRaf = 0;
  const logo = document.querySelector("#pageWelcome .homePageLogo");
  if (!logo || !elPageWelcome) return;
  if (homeLogoHeroTop == null) captureHomeLogoHeroMetrics();
  if (homeLogoHeroTop == null) return;

  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--step1-scale")) || 1;
  const targetTop = 34 * scale;
  const targetLeft = 40 * scale;
  const targetWidth = 100 * scale;

  // Sticks once the logo's natural top edge reaches the same top margin it
  // will end up at (targetTop) -- not the bare screen edge (0).
  const stickAt = homeLogoHeroTop - targetTop;
  const scrollTop = elPageWelcome.scrollTop;

  if (scrollTop < stickAt) {
    // Phase A -- still rising with normal scroll (not fixed yet), but
    // already shrinking toward the target width as it goes, so by the time
    // it reaches the stick point it's already at its final size. Left/top
    // stay untouched here: the element's own CSS (left:50% + translateX
    // -50%) keeps it centered automatically as its width shrinks -- no
    // horizontal movement happens until phase B.
    if (logo.classList.contains("homeLogoFixed")) {
      logo.classList.remove("homeLogoFixed");
      logo.style.top = "";
      logo.style.left = "";
    }
    const shrinkProgress = Math.max(0, Math.min(1, scrollTop / stickAt));
    logo.style.width = `${homeLogoHeroWidth + (targetWidth - homeLogoHeroWidth) * shrinkProgress}px`;
    return;
  }

  // Phase B -- stuck at the top margin, already at target width; only left
  // animates now, from wherever it was actually sitting (centered, at
  // target width) when it stuck.
  const phaseBStartLeft = homeLogoHeroLeft + (homeLogoHeroWidth - targetWidth) / 2;

  // Distance is however much scroll room is actually left after sticking
  // (not a fixed constant) -- guarantees progress reaches exactly 1 right
  // at the true bottom of the scroll regardless of the page's current
  // height, instead of possibly being cut off short of the target if a
  // fixed distance didn't fit within however much scroll room happens to
  // be available.
  const maxScroll = Math.max(0, elPageWelcome.scrollHeight - elPageWelcome.clientHeight);
  const moveDistance = Math.max(1, maxScroll - stickAt);
  const moveProgress = Math.max(0, Math.min(1, (scrollTop - stickAt) / moveDistance));
  logo.classList.add("homeLogoFixed");
  logo.style.top = `${targetTop}px`;
  logo.style.left = `${phaseBStartLeft + (targetLeft - phaseBStartLeft) * moveProgress}px`;
  logo.style.width = `${targetWidth}px`;
}

// "scroll down" label: sits snug to the right of the user's actual (OS)
// cursor -- the real pointer plays the "mouse icon" role, no custom one
// drawn -- while at the top of the home page. Visible immediately at a
// sensible default position (a mousemove isn't guaranteed to ever fire --
// e.g. the page can load with the cursor already stationary over it), then
// switches to live-following the cursor as soon as it actually moves.
// Faded out the moment scrolling starts. The tagline fades with the same
// scroll trigger, but isn't cursor-linked.
let homeScrollHintX = 60;
let homeScrollHintY = 60;
const HOME_SCROLL_HINT_OFFSET_X = 14;
const HOME_SCROLL_HINT_OFFSET_Y = 4;

function updateHomeScrollHint() {
  if (!elPageWelcome) return;
  const scrolled = elPageWelcome.scrollTop > 0;
  const hint = document.getElementById("homeScrollHint");
  if (hint) {
    hint.style.transform = `translate(${homeScrollHintX + HOME_SCROLL_HINT_OFFSET_X}px, ${homeScrollHintY + HOME_SCROLL_HINT_OFFSET_Y}px)`;
    hint.classList.toggle("homeScrollHintHidden", scrolled);
  }
  const tagline = document.getElementById("homePageTagline");
  if (tagline) tagline.classList.toggle("homeScrollHintHidden", scrolled);
}

function handleHomePageMouseMove(e) {
  homeScrollHintX = e.clientX;
  homeScrollHintY = e.clientY;
  updateHomeScrollHint();
}

if (elPageWelcome) {
  elPageWelcome.addEventListener("mousemove", handleHomePageMouseMove);
}

// All Maps: "zoom in" hint, same cursor-following pattern as the home
// page's scroll hint above. Visible until the user zooms in past whatever
// zoom level the map started at (allMapsZoomHintBaseZoom, captured in
// resetAllMapsZoomToBase() once the initial fit settles) -- unlike the
// scroll hint, this is a one-way latch: once hidden by zooming in, it
// stays hidden even if the user zooms back out.
let allMapsZoomHintX = 60;
let allMapsZoomHintY = 60;
let allMapsZoomHintBaseZoom = null;
let allMapsZoomHintDismissed = false;

function updateAllMapsZoomHint() {
  const hint = document.getElementById("allMapsZoomHint");
  if (!hint) return;
  if (!allMapsZoomHintDismissed) {
    const zoomedIn = Boolean(
      allMapsZoomHintBaseZoom !== null && allMapsMap && allMapsMap.getZoom() > allMapsZoomHintBaseZoom + 0.05
    );
    if (zoomedIn) allMapsZoomHintDismissed = true;
  }
  hint.style.transform = `translate(${allMapsZoomHintX + HOME_SCROLL_HINT_OFFSET_X}px, ${allMapsZoomHintY + HOME_SCROLL_HINT_OFFSET_Y}px)`;
  hint.classList.toggle("allMapsZoomHintHidden", allMapsZoomHintDismissed);
}

function handleAllMapsMouseMove(e) {
  allMapsZoomHintX = e.clientX;
  allMapsZoomHintY = e.clientY;
  updateAllMapsZoomHint();
}

if (elPageAllMaps) {
  elPageAllMaps.addEventListener("mousemove", handleAllMapsMouseMove);
}

let homeLogoScrollRaf = 0;
function scheduleHomeLogoScrollMorph() {
  if (homeLogoScrollRaf) return;
  homeLogoScrollRaf = requestAnimationFrame(() => {
    updateHomeLogoScrollMorph();
    updateHomeScrollHint();
  });
}

function resetHomeLogoScrollMorph() {
  homeLogoHeroTop = null;
  homeLogoHeroLeft = null;
  homeLogoHeroWidth = null;
  // Don't show the cursor-following hint at a stale position left over
  // from before this page was last hidden -- back to the default fallback
  // until a fresh mousemove updates it.
  homeScrollHintX = 60;
  homeScrollHintY = 60;
  const logo = document.querySelector("#pageWelcome .homePageLogo");
  if (logo) {
    logo.classList.remove("homeLogoFixed");
    logo.style.top = "";
    logo.style.left = "";
    logo.style.width = "";
  }
  updateHomeLogoScrollMorph();
  updateHomeScrollHint();
}

if (elPageWelcome) {
  elPageWelcome.addEventListener("scroll", scheduleHomeLogoScrollMorph, { passive: true });
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

// Shared by a list entry's name and its on/off button (see
// renderAllMapsCombinedMap()) -- both toggle the exact same highlight/focus
// state, just from two different controls.
function toggleAllMapsHighlightKey(effectiveKey) {
  if (allMapsHighlightedKey && effectiveKey && allMapsHighlightedKey === effectiveKey) {
    allMapsHighlightedKey = null;
    allMapsPendingFocusKey = null;
    if (allMapsViewBeforeHighlightFocus && isFinite(allMapsViewBeforeHighlightFocus.zoom)) {
      allMapsPendingRestoreView = allMapsViewBeforeHighlightFocus;
    }
    allMapsViewBeforeHighlightFocus = null;
  } else {
    // Remember the current view so toggling off can restore it.
    try {
      const c = allMapsMap ? allMapsMap.getCenter() : null;
      const z = allMapsMap ? allMapsMap.getZoom() : NaN;
      if (c && isFinite(c.lat) && isFinite(c.lng) && isFinite(z)) {
        allMapsViewBeforeHighlightFocus = { center: c, zoom: z };
      } else {
        allMapsViewBeforeHighlightFocus = null;
      }
    } catch {
      allMapsViewBeforeHighlightFocus = null;
    }
    allMapsHighlightedKey = effectiveKey || null;
    allMapsPendingFocusKey = allMapsHighlightedKey;
  }
  renderAllMapsCombinedMap();
}

function renderAllMapsCombinedMap() {
  if (!allMapsMap || !allMapsVectorLayer || !elSavedMapsEmpty) return;

  const preservedCenter = allMapsMap.getCenter();
  const preservedZoom = allMapsMap.getZoom();

  allMapsVectorLayer.clearLayers();

  const list = getSavedMaps();
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  const sortedItems = items.slice().sort((a, b) => {
    const aName = normalizeAllMapsSearchText(String(a?.fullName || a?.label || ""));
    const bName = normalizeAllMapsSearchText(String(b?.fullName || b?.label || ""));
    const byName = aName.localeCompare(bName, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    const aLabel = normalizeAllMapsSearchText(String(a?.label || ""));
    const bLabel = normalizeAllMapsSearchText(String(b?.label || ""));
    return aLabel.localeCompare(bLabel, undefined, { sensitivity: "base" });
  });
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

  if (elSavedMapsList) {
    elSavedMapsList.innerHTML = "";
    sortedItems.forEach((snap, idx) => {
      const li = document.createElement("li");
      li.className = "allMapsListItem";

      const snapKey = String(getSavedMapKey(snap) || "");
      const snapLabel = String(snap?.label || "");
      const effectiveKey = snapKey || snapLabel;

      const nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "allMapsListName";
      nameBtn.dataset.searchText = `${String(snap?.fullName || "")} ${snapLabel}`;
      renderMapLabelLikeSignature(nameBtn, snap, snapLabel);
      const isNameHighlighted = Boolean(allMapsHighlightedKey) && Boolean(effectiveKey) && effectiveKey === allMapsHighlightedKey;
      if (isNameHighlighted) nameBtn.classList.add("isHighlighted");
      else if (allMapsHighlightedKey) nameBtn.classList.add("isDimmed");
      nameBtn.addEventListener("click", () => toggleAllMapsHighlightKey(effectiveKey));

      // Sequential index next to each name (001, 002, ...), replacing the
      // old on/off button.
      const numberEl = document.createElement("span");
      numberEl.className = "allMapsListNumber";
      if (isNameHighlighted) numberEl.classList.add("isHighlighted");
      else if (allMapsHighlightedKey) numberEl.classList.add("isDimmed");
      numberEl.textContent = String(idx + 1).padStart(3, "0");

      li.append(nameBtn, numberEl);
      elSavedMapsList.appendChild(li);
    });

    // Keep search behavior stable after list re-renders: do not filter,
    // only jump focus to the first matching name.
    applyAllMapsSearchMatchHighlight(allMapsSearchQuery);
    if (allMapsSearchQuery) {
      focusAllMapsListNameByQuery(allMapsSearchQuery);
    } else if (allMapsHighlightedKey) {
      const selected = elSavedMapsList.querySelector(".allMapsListName.isHighlighted");
      try {
        selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch {
        // ignore
      }
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
    const someHighlighted = Boolean(allMapsHighlightedKey);
    const highlightColor = getAllMapsHighlightColor();
    const dimmedColor = getAllMapsDimmedRouteColor();

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
      const overlayColor = isHighlighted ? highlightColor : (someHighlighted ? dimmedColor : baseColor);
      const dot = L.circleMarker([lat, lon], {
        radius,
        weight: belongingCircleStrokeWeight(rate),
        opacity: 1,
        color: overlayColor,
        ...getAllMapsRouteDotFillStyle(),
        lifepathAllMapsKey: effectiveKey,
      });
      allMapsVectorLayer.addLayer(dot);
      if (isHighlighted && typeof dot.bringToFront === "function") highlightedDots.push(dot);
    }

    if (current.length >= 2) segments.push(current);

    if (segments.length) {
      const baseColor = getAllMapsOverlayStrokeColor();
      const overlayColor = isHighlighted ? highlightColor : (someHighlighted ? dimmedColor : baseColor);
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

  // Keep all dots above all route lines so lines never show through circles.
  // Bring non-highlighted dots first, then highlighted ones last (on top of everything).
  try {
    const highlightedLayers = [];
    allMapsVectorLayer.eachLayer((layer) => {
      if (!(layer instanceof L.CircleMarker) || typeof layer.bringToFront !== "function") return;
      const key = String(layer?.options?.lifepathAllMapsKey || "");
      if (allMapsHighlightedKey && key === allMapsHighlightedKey) {
        highlightedLayers.push(layer);
      } else {
        layer.bringToFront();
      }
    });
    // Now bring highlighted line and dots to the very top.
    if (allMapsHighlightedKey) {
      allMapsVectorLayer.eachLayer((layer) => {
        if (!layer || typeof layer.bringToFront !== "function") return;
        if (layer instanceof L.CircleMarker) return;
        const key = String(layer?.options?.lifepathAllMapsKey || "");
        if (key === allMapsHighlightedKey) layer.bringToFront();
      });
      for (const l of highlightedLayers) l.bringToFront();
    }
  } catch {
    // ignore
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

  // User clicked a name: zoom to the highlighted map's Israel-only points.
  if (allMapsPendingFocusKey) {
    const key = allMapsPendingFocusKey;
    allMapsPendingFocusKey = null;
    if (allMapsHighlightedKey && key === allMapsHighlightedKey) {
      focusAllMapsOnHighlightedSnapshotIsraelOnly(key);
      return;
    }
  }

  // User toggled the highlighted map off: restore the pre-focus view.
  if (allMapsPendingRestoreView) {
    const view = allMapsPendingRestoreView;
    allMapsPendingRestoreView = null;
    if (view && view.center && isFinite(view.center.lat) && isFinite(view.center.lng) && isFinite(view.zoom)) {
      try {
        allMapsMap.setView(view.center, view.zoom, { animate: false });
        enforceMinZoomToAvoidBlankViewport(allMapsMap);
      } catch {
        // ignore
      }
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

if (elAllMapsHideMapBtn) {
  elAllMapsHideMapBtn.addEventListener("click", () => {
    ensureAllMapsMap();
    toggleAllMapsTiles();
  });
}

function setAllMapsListVisible(visible) {
  allMapsListVisible = Boolean(visible);
  if (elSavedMapsList) elSavedMapsList.classList.toggle("allMapsListCollapsed", !allMapsListVisible);
  if (elAllMapsSearchWrap) elAllMapsSearchWrap.classList.toggle("allMapsListCollapsed", !allMapsListVisible);
  if (elAllMapsListToggleBtn) {
    elAllMapsListToggleBtn.textContent = allMapsListVisible ? "hide maps list" : "show maps list";
    elAllMapsListToggleBtn.setAttribute("aria-expanded", allMapsListVisible ? "true" : "false");
  }
}

if (elAllMapsListToggleBtn && elSavedMapsList) {
  setAllMapsListVisible(false);
  elAllMapsListToggleBtn.addEventListener("click", () => {
    // The search row only ever shows alongside the names list (see
    // .allMapsListCollapsed in styles.css for the fade/slide animation).
    setAllMapsListVisible(!allMapsListVisible);
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

if (elAllMapsSearchInput) {
  const clearAllMapsSelectionForSearch = () => {
    if (!allMapsHighlightedKey && !allMapsPendingFocusKey && !allMapsPendingRestoreView) return false;
    allMapsHighlightedKey = null;
    allMapsPendingFocusKey = null;
    allMapsPendingRestoreView = null;
    allMapsViewBeforeHighlightFocus = null;
    renderAllMapsCombinedMap();
    return true;
  };

  elAllMapsSearchInput.addEventListener("keydown", () => {
    clearAllMapsSelectionForSearch();
  });

  elAllMapsSearchInput.addEventListener("input", () => {
    allMapsSearchQuery = String(elAllMapsSearchInput.value || "");
    clearAllMapsSelectionForSearch();
    applyAllMapsSearchMatchHighlight(allMapsSearchQuery);
    focusAllMapsListNameByQuery(allMapsSearchQuery);
  });
}

window.addEventListener("resize", () => {
  if (elPageAllMaps && !elPageAllMaps.classList.contains("hidden")) {
    alignAllMapsPanelToEditButton();
  }
});

function updateEmotionTitle() {
  if (!elEmotionTitle) return;
  const name = formatStep2SignatureDisplayName(elStudentName?.value || "");
  const count = formatAddrCount(addresses.length);
  if (!name) {
    elEmotionTitle.innerHTML = "";
    return;
  }
  elEmotionTitle.innerHTML = `<div class="step2SignatureMain"><span>${name}</span><span class="step2SignatureCount">${count} addrs</span></div>`;
}

/**
 * @typedef {Object} EmotionStart
 * @property {{x:number,y:number,strokeWidth:number,startR:number}[]} points
 * @property {{x:number,y:number}[][]=} routeSegments
 * @property {{x:number,y:number}=} routeCenter
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
// Also applied to stroke thickness below for proportional scaling.
const EMOTION_GEOMETRY_SCALE = 1.2;
// Additional geometry-only enlargement (does NOT affect stroke thickness).
const EMOTION_GEOMETRY_BOOST = 1.15;
// Small proportional thickening for emotion ring strokes.
const EMOTION_STROKE_THICKEN = 0.74;
// Visual scale of the Emotion Map rings relative to the captured Step 2 map.
// Requirement: reduce emotional map by 50%.
const EMOTION_RING_SCALE = 0.845 * EMOTION_TIGHTEN * EMOTION_GEOMETRY_SCALE * EMOTION_GEOMETRY_BOOST;
// Visual scale of the Emotion Map circle stroke widths.
// Requirement: tighten strokes by 50%, while still reflecting belonging rate.
const EMOTION_STROKE_SCALE = 0.319 * EMOTION_TIGHTEN * EMOTION_GEOMETRY_SCALE * EMOTION_STROKE_THICKEN;
// Visual strength of the belonging/location distortion.
// Higher => stronger pull/push at the ring's location angle. Scaled down
// 10% across every rate (rate 10 included) so its own already-dampened pull
// (see rate10Dampen below) reads a bit weaker still, while every other
// rate's pull shrinks by that same proportion, preserving their relative
// balance.
const EMOTION_DISTORTION_SCALE = 5.6 * 0.9;
// Distortion response curve: higher => increases separation near 10.
const EMOTION_DISTORTION_EXP = 1.35;
// Max distortion amplitude as a fraction of ring radius (before curve applied).
const EMOTION_DISTORTION_MAX_AMP_COEFF = 0.11;
// Safety clamp to avoid extreme self-intersections.
const EMOTION_DISTORTION_CLAMP_FRACTION = 0.72;
// One-off art direction tweak: Nastya Faybish map needs a stronger pull
// on the innermost ring.
const NASTYA_INNER_RING_DISTORTION_MULT = 3.2;
// Shape of the angular distortion “bump” at the location angle.
// Outward pulls use the base values; inward pulls (belonging < 5) are softened.
const EMOTION_BUMP_SIGMA = 0.72;
const EMOTION_BUMP_POWER = 2.2;
const EMOTION_INWARD_BUMP_SIGMA = 0.88;
const EMOTION_INWARD_BUMP_POWER = 2.15;
// The fullscreen emotion map page renders its rings' pull/push (outward
// bulge / inward dent) slightly weaker than Step 1's — the breathing motion
// itself is unaffected, only this static distortion amplitude. Applies
// uniformly to every rate, so the strongest cases (belonging 1 and 10) and
// everything in between all get proportionally softer together.
const EMOTION_FULLSCREEN_DISTORTION_DAMPING = 0.6;
// Step 1 main-page-only: a slight extra reduction of the pull/push
// distortion specifically for whichever ring has belonging rate 10, on top
// of distortionAmplitudeFromBelonging()'s own small rate-10 taper. Applied
// only where Step 1's own preview ring renders its `d` (both the initial
// static path and every breathing frame) — the fullscreen page's mirror
// derives its shape from the un-reduced amplitude, so it's unaffected, and
// so is the solo "emotion" page (which builds its own rings independently).
const STEP1_MAIN_RATE10_DISTORTION_MULT = 0.85;
// Fullscreen-only: how much of Step 1's breathing *oscillation* (not its
// base radius) carries over — 1 = identical to Step 1, smaller = a
// narrower breathing range while every rate's relative strength (and the
// motion's speed) stays exactly as before.
//
// Kept well below 1: resolveStep1EmotionFullscreenRingOverlaps() only ever
// measures/fits each ring's *rest* shape (a single getBBox() snapshot), so
// it has no way to know how far breathing will later swing a ring beyond
// that. A wide range here can carry a ring past the small safety margin
// that fit was built on, visibly crowding or touching its neighbor mid-
// breath even though the two never touch at rest.
const EMOTION_FULLSCREEN_BREATH_RANGE_DAMPING = 1;
// Fullscreen-only: the small organic waviness layered on every ring's
// boundary (see buildDistortedRingPath's `organic` option). Reduced (not
// boosted) here for the same reason as the breath-range damping above --
// this waviness is *also* extra excursion beyond the rest shape that
// resolveStep1EmotionFullscreenRingOverlaps() never measured.
const EMOTION_FULLSCREEN_ORGANIC_BOOST = 1.05;

// The same per-theta wave buildDistortedRingPath() layers onto every ring's boundary (its
// `organic` option) — pulled out as its own function so the no-touch/no-overlap clearance
// checks below can sample the *exact* rendered wobble instead of only the analytic pointed-bump
// radius, which is all they modeled before. Without this, the wave could visually cut into a
// neighboring ring even when the clearance math reported zero deficit.
function emotionRingOrganicWave(theta, seed) {
  const s = Number(seed) || 0;
  return (
    Math.sin(theta * 2 + s * 1.31 + Math.sin(s * 0.7) * 4.2) * 0.4 +
    Math.sin(theta * 5 + s * 2.89 + Math.cos(s * 1.3) * 3.1) * 0.3 +
    Math.sin(theta * 7 + s * 4.57 + Math.sin(s * 2.1) * 2.7) * 0.2
  );
}

// Signed radial offset (in the same pre-groupScale units as a ring's base radius) that
// emotionRingOrganicWave() adds at a given theta for ring `index` (organicSeed = index * 7.1,
// matching every buildDistortedRingPath() call site). Uses the fullscreen-boosted organic
// strength (EMOTION_FULLSCREEN_ORGANIC_BOOST) as the worst case, since the fullscreen mirror
// renders a stronger wave on top of the exact same base radii Step 1's own preview uses.
function emotionRingOrganicOffsetPx(theta, index, r0) {
  const seed = (Number(index) || 0) * 7.1;
  return emotionRingOrganicWave(theta, seed) * EMOTION_FULLSCREEN_ORGANIC_BOOST * Math.max(1, Number(r0) || 1) * 0.025;
}
// Gentle outside->inside motion for Emotion Maps.
const EMOTION_BREATH_PERIOD_MS = 5460;
const EMOTION_BREATH_AMPLITUDE_PX = 5.9;
const EMOTION_BREATH_INNER_FACTOR = 0.12;
const EMOTION_BREATH_OUTER_FACTOR = 2.4;
const EMOTION_BREATH_PROFILE_EXP = 1.0;
// Belonging-rate -> breathing amplitude/speed multiplier, shared by every
// ring-breathing implementation (main map, archive hover, ring reading) so a
// given ring moves identically wherever it's rendered.
// 10/1 strongest & fastest, 9/2 slightly less, ... 5 weakest & slowest.
const EMOTION_BREATH_RATE_AMP_TABLE = [0, 1.0, 0.86, 0.72, 0.58, 0.30, 0.44, 0.58, 0.72, 0.86, 1.0];
const EMOTION_BREATH_RATE_SPEED_TABLE = [0, 1.35, 1.22, 1.10, 0.98, 0.75, 0.86, 0.98, 1.10, 1.22, 1.35];
// Ensure the outermost ring is *always* a little stronger/faster than the rest.
// Keep subtle: it should lead, not dominate.
const EMOTION_BREATH_OUTERMOST_AMP_MIN_ADV = 0.04;
const EMOTION_BREATH_OUTERMOST_AMP_MAX_ADV = 0.12;
const EMOTION_BREATH_OUTERMOST_SPEED_MIN_ADV = 0.04;
const EMOTION_BREATH_OUTERMOST_SPEED_MAX_ADV = 0.12;
const EMOTION_BREATH_STAGGER_MS = 110; // outer rings start first
const EMOTION_BREATH_RAMP_MS = 700;
const EMOTION_BREATH_SAMPLE_STEPS = 120;
const EMOTION_BREATH_CLEARANCE_ITERS = 3;
const EMOTION_BREATH_CLEARANCE_RELAX = 0.45;
const EMOTION_BREATH_SMOOTH_TAU_MS = 140;
const EMOTION_BREATH_MAX_STEP_PX = 0.7;
// During breathing, allow rings to *touch* (0px clearance) but still prevent overlap.
const EMOTION_BREATH_CLEARANCE_PX = 0;
// Minimum clearance between adjacent rings (edge-to-edge), in Emotion viewBox px.
// This clearance is enforced after taking distortions into account.
const EMOTION_RING_CLEARANCE_PX = 6;
// Keep consistent spacing between ring *edges* across sentiment maps.
// Smaller value => smaller overall rings.
const EMOTION_RING_GAP = 3.2 * EMOTION_TIGHTEN * EMOTION_GEOMETRY_SCALE * EMOTION_GEOMETRY_BOOST;
// Maximum extra thickness available for emotion-map strokes.
// Applied non-linearly so belonging=10 stays unchanged while low values get thinner.
const EMOTION_STROKE_BOOST = 5;
// Linear (proportional) stroke mapping for emotion rings:
// - belonging 1 => EMOTION_STROKE_MIN_PX
// - belonging 10 => EMOTION_STROKE_MAX_PX (can be tuned independently)
const EMOTION_STROKE_MIN_PX = 2;
const EMOTION_STROKE_MAX_PX = 19;
// Curve exponent for intermediate values (1 stays fixed, 10 stays fixed).
// > 1 makes higher belonging values separate a bit more.
const EMOTION_STROKE_CURVE_EXP = 1.3;

function emotionStrokeWidthFromRate(rate) {
  // Expect 1..10, but clamp defensively.
  const r = Math.max(1, Math.min(10, Number(rate) || 1));
  const minSw = Math.max(1, Number(EMOTION_STROKE_MIN_PX) || 1);
  const maxSw = Math.max(minSw, Number(EMOTION_STROKE_MAX_PX) || (10 + EMOTION_STROKE_BOOST));
  const t = (r - 1) / 9; // 0..1
  const te = Math.pow(t, Math.max(0.5, Number(EMOTION_STROKE_CURVE_EXP) || 1));
  const sw = minSw + (maxSw - minSw) * te;
  // SVG stroke-width supports sub-pixel values; keep a tiny minimum so
  // low-belonging rings don't disappear entirely.
  return Math.max(0.5, sw * EMOTION_STROKE_SCALE);
}

// Step 1 preview only: belonging=10 (and, by reshaping the same curve,
// every rate between -- belonging=1 is unaffected, same as
// EMOTION_STROKE_MAX_PX's own comment) reads very slightly thinner here
// than the shared formula above. The fullscreen mirror copies these rings
// verbatim, so dampStep1EmotionFullscreenRingDistortion() re-derives its
// own stroke-width from emotionStrokeWidthFromRate() (the un-thinned
// formula) right after the copy, keeping it exactly as before.
const EMOTION_STROKE_MAX_PX_STEP1_PREVIEW = EMOTION_STROKE_MAX_PX * 0.93;

function step1PreviewEmotionStrokeWidthFromRate(rate) {
  const r = Math.max(1, Math.min(10, Number(rate) || 1));
  const minSw = Math.max(1, Number(EMOTION_STROKE_MIN_PX) || 1);
  const maxSw = Math.max(minSw, Number(EMOTION_STROKE_MAX_PX_STEP1_PREVIEW) || (10 + EMOTION_STROKE_BOOST));
  const t = (r - 1) / 9;
  const te = Math.pow(t, Math.max(0.5, Number(EMOTION_STROKE_CURVE_EXP) || 1));
  const sw = minSw + (maxSw - minSw) * te;
  return Math.max(0.5, sw * EMOTION_STROKE_SCALE);
}

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

function computeEmotionGapUsed(maxR, strokeWidths) {
  const n = Array.isArray(strokeWidths) ? strokeWidths.length : 0;
  if (n <= 0) return 1;
  const strokes = strokeWidths.map((s) => Math.max(1, Number(s) || 1));
  const sumStrokes = strokes.reduce((a, b) => a + b, 0);
  const maxGap = Math.max(1, (Math.max(1, Number(maxR) || 1) - sumStrokes) / n);
  return Math.max(1, Math.min(EMOTION_RING_GAP, maxGap));
}

function computeEmotionRingLayoutNoTouch(baseRadii, strokeWidths, strokeRates, gapUsed, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const n = Array.isArray(baseRadii) ? baseRadii.length : 0;
  const radii = new Array(n);
  const amps = new Array(n);

  const ampScaleRaw = Number(options.ampScale);
  const ampScale = isFinite(ampScaleRaw) ? Math.max(0, Math.min(2, ampScaleRaw)) : 1;

  const groupScaleRaw = Number(options.groupScale);
  const groupScale = isFinite(groupScaleRaw) ? Math.max(0.2, Math.min(2, groupScaleRaw)) : 1;

  const strokesScaleWithGroup = Boolean(options.strokesScaleWithGroup);

  const phis = Array.isArray(options.phis) ? options.phis : [];
  const sampleSteps = Math.max(60, Math.round(Number(options.sampleSteps) || 360));

  const sw = Array.isArray(strokeWidths) ? strokeWidths.map((s) => Math.max(1, Number(s) || 1)) : [];
  const rates = Array.isArray(strokeRates) ? strokeRates.map((r) => Math.max(1, Math.min(10, Number(r) || 5))) : [];
  const gap = Math.max(1, Number(gapUsed) || 1);

  function bumpParamsForAmp(a) {
    const amp = Number(a) || 0;
    if (amp < 0) return { sigma: EMOTION_INWARD_BUMP_SIGMA, power: EMOTION_INWARD_BUMP_POWER };
    return { sigma: EMOTION_BUMP_SIGMA, power: EMOTION_BUMP_POWER };
  }

  function ringR(theta, r0, phi, amp) {
    const params = bumpParamsForAmp(amp);
    const dTheta = wrapAnglePi(theta - (Number(phi) || 0));
    const bump = amp === 0 ? 0 : pointedAngularBump(dTheta, params.sigma, params.power);
    return Math.max(1, (Number(r0) || 1) + (Number(amp) || 0) * bump);
  }

  function minClearancePx(inner, outer) {
    const innerSw = sw[inner] ?? 1;
    const outerSw = sw[outer] ?? 1;
    const innerSwPx = strokesScaleWithGroup ? innerSw * groupScale : innerSw;
    const outerSwPx = strokesScaleWithGroup ? outerSw * groupScale : outerSw;
    const innerPhi = phis[inner] ?? 0;
    const outerPhi = phis[outer] ?? 0;
    const innerR0 = radii[inner] ?? 1;
    const outerR0 = radii[outer] ?? 1;
    const innerAmp = amps[inner] ?? 0;
    const outerAmp = amps[outer] ?? 0;

    let minC = Infinity;
    for (let k = 0; k < sampleSteps; k++) {
      const theta = (k / sampleSteps) * Math.PI * 2;
      const rInner = (ringR(theta, innerR0, innerPhi, innerAmp) + emotionRingOrganicOffsetPx(theta, inner, innerR0)) * groupScale;
      const rOuter = (ringR(theta, outerR0, outerPhi, outerAmp) + emotionRingOrganicOffsetPx(theta, outer, outerR0)) * groupScale;
      const innerOuterEdge = rInner + innerSwPx / 2;
      const outerInnerEdge = rOuter - outerSwPx / 2;
      const c = outerInnerEdge - innerOuterEdge;
      if (c < minC) minC = c;
    }
    return minC;
  }

  for (let i = 0; i < n; i++) {
    const baseR = Math.max(1, Number(baseRadii[i]) || 1);
    const rate = rates[i] ?? 5;
    const swi = sw[i] ?? 1;

    if (i === 0) {
      // Requirement: keep the first circle exactly the same size.
      radii[i] = baseR;
    }

    // Compute initial amplitude for ring 0 (needed for spacing ring 1+).
    let amp = distortionAmplitudeFromBelonging(rate, radii[i]);
    if (i === 0 && options.isNastya) amp *= NASTYA_INNER_RING_DISTORTION_MULT;
    amp *= ampScale;
    amps[i] = amp;

    if (i === 0) continue;

    // Start from the base radius, but ensure at least the nominal edge gap.
    const prevR0 = radii[i - 1] ?? 1;
    const prevSw = sw[i - 1] ?? 1;
    const minFromNominal = strokesScaleWithGroup
      ? (prevR0 + (prevSw + swi) / 2 + gap / groupScale)
      : (prevR0 + ((prevSw + swi) / 2 + gap) / groupScale);
    radii[i] = Math.max(baseR, minFromNominal);

    // Iteratively increase this ring's base radius until the *actual* minimum
    // clearance (over sampled angles) reaches the desired gap.
    for (let iter = 0; iter < 8; iter++) {
      let a = distortionAmplitudeFromBelonging(rate, radii[i]) * ampScale;
      // (Nastya tweak applies only to ring 0)
      amps[i] = a;

      const minC = minClearancePx(i - 1, i);
      const deficit = gap - minC;
      if (!(deficit > 0.25)) break;
      radii[i] += deficit / groupScale;
    }

    // Recompute final amp after last radius adjustment.
    amps[i] = distortionAmplitudeFromBelonging(rate, radii[i]) * ampScale;
  }

  return { radii, amps };
}

// The exact options renderStep1EmotionMap() last used to start the Step 1
// preview's breathing loop — kept around so breathing can be resumed later
// (e.g. returning from the solo ring page) via startEmotionBreathing() alone,
// without renderStep1EmotionMap() rebuilding every ring from scratch (which
// would also perturb the fullscreen page's ring sizes/spacing on every trip).
let _step1EmotionLastPlaybackOptions = null;

// The exact geometry inputs (radii/angles/strokes/rates/scale) the last
// renderStep1EmotionMap() call used, whether freshly computed or itself
// reused from a frozen snapshot (see opts.frozenLayout there) — read by
// saveCurrentMapSnapshot() so a saved map's emotion rings can be pinned to
// exactly how they looked at save time, immune to later tuning changes.
let _step1EmotionLastLayoutSnapshot = null;

// Only usable if it actually matches the address set currently being saved
// (guards against a stale snapshot from a moment before the last edit's
// re-render caught up) — falls back to null, meaning the next open just
// recomputes live, same as before this feature existed.
function getStep1EmotionMapLayoutSnapshotForSave() {
  const snap = _step1EmotionLastLayoutSnapshot;
  if (!snap || snap.n !== (Array.isArray(addresses) ? addresses.length : -1)) return null;
  try {
    return JSON.parse(JSON.stringify(snap));
  } catch {
    return null;
  }
}

// Set right before returning from the solo page so the next
// renderStep1EmotionMap() call (always triggered by showPage("step1"))
// skips rebuilding the sound session — it should just keep playing.
let _step1SkipSoundRebuildOnce = false;

// Set by showPage() itself whenever Step 1 is the page being left (see
// below) -- every place that actually mutates `addresses` (add/edit/remove a
// home, "start over", loading a different saved snapshot) already calls
// renderStep1EmotionMap() directly on its own, so nothing about the address
// data can have changed while Step 1 sat hidden behind some other page.
// Whatever page comes next, the showPage("step1") rebuild below on the way
// back is pure redundant work -- and worse, a visible flash
// (renderStep1EmotionMap() wipes and redraws every ring from scratch),
// making the small preview look like it "changed" even though the end
// result is identical. Skipping it once here avoids that.
let _step1SkipEmotionRebuildOnce = false;

let _emotionBreathRaf = 0;

/** @type {any | null} */
let _emotionBreathArmedOpts = null;
/** @type {(ev: Event) => void | null} */
let _emotionBreathStartListener = null;

function disarmEmotionBreathing() {
  _emotionBreathArmedOpts = null;
  if (_emotionBreathStartListener && elEmotionSvg) {
    try {
      elEmotionSvg.removeEventListener("pointerdown", _emotionBreathStartListener);
    } catch {
      // ignore
    }
  }
  _emotionBreathStartListener = null;
}

// Arms breathing (motion only — sound for the solo page is handled entirely
// separately via setEmotionSoundFocus(), see applyPendingEmotionSoloFocus())
// so it starts on the first click/tap instead of immediately, avoiding a
// visible geometry "pop" while the ring is still mid fly-overlay animation.
function armEmotionBreathing(opts) {
  const options = opts && typeof opts === "object" ? opts : null;
  if (!options || !elEmotionSvg) return;
  if (elPageEmotion && elPageEmotion.classList.contains("hidden")) return;

  // Replace any previously-armed motion.
  disarmEmotionBreathing();
  _emotionBreathArmedOpts = options;

  _emotionBreathStartListener = () => {
    const pending = _emotionBreathArmedOpts;
    if (!pending) return;
    disarmEmotionBreathing();
    startEmotionBreathing(pending);
  };

  // One-time: first click/tap on the rings starts motion.
  elEmotionSvg.addEventListener("pointerdown", _emotionBreathStartListener, { passive: true });
}

function stopEmotionBreathing() {
  if (_emotionBreathRaf) cancelAnimationFrame(_emotionBreathRaf);
  _emotionBreathRaf = 0;
}

function startEmotionBreathing(opts) {
  stopEmotionBreathing();

  const options = opts && typeof opts === "object" ? opts : {};
  const rings = Array.isArray(options.rings) ? options.rings : [];
  const cx = Number(options.cx) || 0;
  const cy = Number(options.cy) || 0;
  const baseRadii = Array.isArray(options.baseRadii) ? options.baseRadii.map((r) => Math.max(1, Number(r) || 1)) : [];
  const phis = Array.isArray(options.phis) ? options.phis : [];
  const amps = Array.isArray(options.amps) ? options.amps : [];
  const strokes = Array.isArray(options.strokes) ? options.strokes.map((s) => Math.max(0.5, Number(s) || 1)) : [];
  const rates = Array.isArray(options.rates) ? options.rates.map((r) => Math.max(1, Math.min(10, Number(r) || 5))) : [];
  const groupScale = Math.max(0.2, Math.min(2, Number(options.groupScale) || 1));
  const gapPx = Math.max(0, Number(options.gapPx) || 0);
  const strokesScaleWithGroup = Boolean(options.strokesScaleWithGroup);
  const breathScale = Math.max(0.1, Number(options.breathScale) || 1);

  const n = Math.min(rings.length, baseRadii.length);
  if (n <= 1) return;

  const setRingD = (ringPath, d) => {
    try {
      ringPath.setAttribute("d", d);
    } catch {
      // ignore
    }
    try {
      const hit = ringPath && ringPath.__lpHitPath;
      if (hit && hit.setAttribute) hit.setAttribute("d", d);
    } catch {
      // ignore
    }
    try {
      const mirror = ringPath && ringPath.__lpMirrorPath;
      if (mirror && mirror.setAttribute) mirror.setAttribute("d", d);
    } catch {
      // ignore
    }
  };

  const t0 = performance.now();
  let lastNow = t0;
  let prevRadii = baseRadii.slice(0, n);
  const twoPi = Math.PI * 2;

  function belongingBreathFactor(rate) {
    const r = Math.max(1, Math.min(10, Math.round(Number(rate) || 5)));
    // Requested mapping:
    // 10/1 highest, 9/2 slightly lower, 8/3 lower, 7/4 lower, then 6, then 5 lowest.
    const table = [
      0,
      1.0,  // 1
      0.86, // 2
      0.72, // 3
      0.58, // 4
      0.30, // 5 (lowest)
      0.44, // 6
      0.58, // 7
      0.72, // 8
      0.86, // 9
      1.0,  // 10
    ];
    return table[r] ?? 0.5;
  }

  function belongingBreathSpeedFactor(rate) {
    const r = Math.max(1, Math.min(10, Math.round(Number(rate) || 5)));
    // Requested mapping (speed):
    // 10/1 fastest, 9/2 slightly slower, 8/3 slower, 7/4 slower, then 6, then 5 slowest.
    // Factor multiplies the phase advance (higher => faster cycles).
    const table = [
      0,
      1.35, // 1
      1.22, // 2
      1.10, // 3
      0.98, // 4
      0.75, // 5 (slowest)
      0.86, // 6
      0.98, // 7
      1.10, // 8
      1.22, // 9
      1.35, // 10
    ];
    const f = table[r] ?? 1;
    return Math.max(0.5, Math.min(2, f));
  }

  const belongingFactors = new Array(n);
  const belongingSpeedFactors = new Array(n);
  for (let i = 0; i < n; i++) {
    belongingFactors[i] = belongingBreathFactor(rates[i] ?? 5);
    belongingSpeedFactors[i] = belongingBreathSpeedFactor(rates[i] ?? 5);
  }

  // Precompute base per-ring amplitude & speed multipliers.
  // This avoids per-frame recompute and lets us enforce that the outermost ring
  // leads (slightly) regardless of belonging-based differences.
  const innerF = Math.max(0, Number(EMOTION_BREATH_INNER_FACTOR) || 0);
  const outerF = Math.max(innerF, Number(EMOTION_BREATH_OUTER_FACTOR) || innerF);
  const exp = Math.max(0.25, Number(EMOTION_BREATH_PROFILE_EXP) || 1);
  const ampFactorsByRing = new Array(n);
  const speedFactorsByRing = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = n <= 1 ? 1 : i / (n - 1); // 0 inner .. 1 outer
    const profile = innerF + (outerF - innerF) * Math.pow(u, exp);
    const belongProfile = belongingFactors[i] ?? 0.5;
    ampFactorsByRing[i] = profile * belongProfile * breathScale;
    speedFactorsByRing[i] = belongingSpeedFactors[i] ?? 1;
  }

  if (n >= 2) {
    const outerIdx = n - 1;
    const outerRate = Math.max(1, Math.min(10, Math.round(Number(rates[outerIdx]) || 5)));
    const shouldForceOuterLead = outerRate > 5;

    // If the outermost ring is in a belonging level where motion should weaken (<= 5),
    // do NOT force it to lead just because it's outer.
    if (!shouldForceOuterLead) {
      // keep computed factors as-is
    } else {

    let maxAmpOther = 0;
    let maxSpeedOther = 0;
    for (let i = 0; i < outerIdx; i++) {
      maxAmpOther = Math.max(maxAmpOther, Number(ampFactorsByRing[i]) || 0);
      maxSpeedOther = Math.max(maxSpeedOther, Number(speedFactorsByRing[i]) || 0);
    }

    if (maxAmpOther > 0) {
      const minTarget = maxAmpOther * (1 + EMOTION_BREATH_OUTERMOST_AMP_MIN_ADV);
      const capTarget = maxAmpOther * (1 + EMOTION_BREATH_OUTERMOST_AMP_MAX_ADV);
      const cur = Number(ampFactorsByRing[outerIdx]) || 0;
      ampFactorsByRing[outerIdx] = Math.max(cur, Math.min(minTarget, capTarget));
    }

    if (maxSpeedOther > 0) {
      const minTarget = maxSpeedOther * (1 + EMOTION_BREATH_OUTERMOST_SPEED_MIN_ADV);
      const capTarget = maxSpeedOther * (1 + EMOTION_BREATH_OUTERMOST_SPEED_MAX_ADV);
      const cur = Number(speedFactorsByRing[outerIdx]) || 0;
      speedFactorsByRing[outerIdx] = Math.max(cur, Math.min(minTarget, capTarget));
    }
    }
  }

  function smootherstep01(x) {
    const t = Math.max(0, Math.min(1, Number(x) || 0));
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  function pointedRingR(theta, r0, phi, amp) {
    const a = Number(amp) || 0;
    const params = a < 0 ? { sigma: EMOTION_INWARD_BUMP_SIGMA, power: EMOTION_INWARD_BUMP_POWER } : { sigma: EMOTION_BUMP_SIGMA, power: EMOTION_BUMP_POWER };
    const dTheta = wrapAnglePi(theta - (Number(phi) || 0));
    const bump = a === 0 ? 0 : pointedAngularBump(dTheta, params.sigma, params.power);
    return Math.max(1, (Number(r0) || 1) + a * bump);
  }

  function minClearancePxBetween(innerIdx, outerIdx, radiiNow) {
    const innerSw = strokes[innerIdx] ?? 1;
    const outerSw = strokes[outerIdx] ?? 1;
    const innerSwPx = strokesScaleWithGroup ? innerSw * groupScale : innerSw;
    const outerSwPx = strokesScaleWithGroup ? outerSw * groupScale : outerSw;
    const innerPhi = phis[innerIdx] ?? 0;
    const outerPhi = phis[outerIdx] ?? 0;
    const innerAmp = amps[innerIdx] ?? 0;
    const outerAmp = amps[outerIdx] ?? 0;
    const innerR0 = radiiNow[innerIdx] ?? 1;
    const outerR0 = radiiNow[outerIdx] ?? 1;

    let minC = Infinity;
    for (let k = 0; k < EMOTION_BREATH_SAMPLE_STEPS; k++) {
      const theta = (k / EMOTION_BREATH_SAMPLE_STEPS) * twoPi;
      const rInner = (pointedRingR(theta, innerR0, innerPhi, innerAmp) + emotionRingOrganicOffsetPx(theta, innerIdx, innerR0)) * groupScale;
      const rOuter = (pointedRingR(theta, outerR0, outerPhi, outerAmp) + emotionRingOrganicOffsetPx(theta, outerIdx, outerR0)) * groupScale;
      const innerOuterEdge = rInner + innerSwPx / 2;
      const outerInnerEdge = rOuter - outerSwPx / 2;
      const c = outerInnerEdge - innerOuterEdge;
      if (c < minC) minC = c;
    }
    return minC;
  }

  function enforceNoTouch(radiiWanted) {
    const radiiNow = radiiWanted.slice(0, n);
    for (let i = 1; i < n; i++) {
      const prevR0 = radiiNow[i - 1] ?? 1;
      const prevSw = strokes[i - 1] ?? 1;
      const swi = strokes[i] ?? 1;
      const minFromNominal = strokesScaleWithGroup
        ? (prevR0 + (prevSw + swi) / 2 + gapPx / groupScale)
        : (prevR0 + ((prevSw + swi) / 2 + gapPx) / groupScale);
      radiiNow[i] = Math.max(radiiNow[i] ?? 1, minFromNominal);

      for (let iter = 0; iter < EMOTION_BREATH_CLEARANCE_ITERS; iter++) {
        const minC = minClearancePxBetween(i - 1, i, radiiNow);
        const deficit = gapPx - minC;
        if (!(deficit > 0.15)) break;
        radiiNow[i] += (deficit / groupScale) * EMOTION_BREATH_CLEARANCE_RELAX;
      }
    }
    return radiiNow;
  }

  function frame(now) {
    // Stop if DOM nodes were removed.
    if (!rings.length || !rings[0] || !rings[0].ownerSVGElement || !rings[0].isConnected) {
      _emotionBreathRaf = 0;
      return;
    }

    const dt = Math.max(1, now - lastNow);
    lastNow = now;
    const t = now - t0;
    const period = Math.max(600, Number(EMOTION_BREATH_PERIOD_MS) || 4200);
    const ampPx = Math.max(0, Number(EMOTION_BREATH_AMPLITUDE_PX) || 0);

    const radiiWanted = new Array(n);
    for (let i = 0; i < n; i++) {
      const delay = (n - 1 - i) * EMOTION_BREATH_STAGGER_MS;
      const ramp = smootherstep01((t - delay) / EMOTION_BREATH_RAMP_MS);
      if (ramp <= 0) {
        radiiWanted[i] = baseRadii[i];
        continue;
      }

      const ampF = ampFactorsByRing[i] ?? 1;
      const soloVisualScale = Math.max(1, Number(rings[i] && rings[i].__lpSoloVisualScale) || 1);
      const speedF = speedFactorsByRing[i] ?? 1;

      const phase = ((t - delay) / period) * twoPi * speedF;
      const deltaPx = ramp * ampPx * (ampF / soloVisualScale) * Math.sin(phase);
      radiiWanted[i] = baseRadii[i] + deltaPx / groupScale;
    }

    const radiiConstrained = enforceNoTouch(radiiWanted);

    // Smooth and limit per-frame changes to avoid visible jumps.
    // Make smoothing/step limits proportional to the ring's speed factor so
    // faster rings keep their faster cadence in both growth and shrink.
    const tauBase = Math.max(16, Number(EMOTION_BREATH_SMOOTH_TAU_MS) || 140);
    const maxStepPxBase = Math.max(0.05, Number(EMOTION_BREATH_MAX_STEP_PX) || 0.7);
    const radiiNow = new Array(n);
    for (let i = 0; i < n; i++) {
      const speedF = Math.max(0.5, Math.min(2, Number(belongingSpeedFactors[i]) || 1));
      const tau = Math.max(10, tauBase / speedF);
      const alpha = 1 - Math.exp(-dt / tau);
      const maxStepBase = (maxStepPxBase * (0.65 + 0.35 * speedF)) / groupScale;

      const target = Math.max(1, Number(radiiConstrained[i]) || 1);
      const prev = Math.max(1, Number(prevRadii[i]) || 1);
      const blended = prev + (target - prev) * alpha;
      const delta = blended - prev;
      const limited = prev + Math.max(-maxStepBase, Math.min(maxStepBase, delta));
      radiiNow[i] = limited;
    }

    // enforceNoTouch() above only guarantees no crossing for the *target*
    // radii — each ring is then smoothed/step-limited independently at its
    // own speed, so two adjacent rings catching up at different rates can
    // still cross mid-transition even though their targets never would.
    // Re-clamp the actual (smoothed) radii we're about to render so rings
    // can touch but never cut into each other, then persist *that* as
    // prevRadii so next frame's smoothing starts from a safe state.
    const radiiSafe = enforceNoTouch(radiiNow);
    for (let i = 0; i < n; i++) radiiNow[i] = radiiSafe[i];
    prevRadii = radiiNow;

    for (let i = 0; i < n; i++) {
      const phi = phis[i] ?? 0;
      const amp = amps[i] ?? 0;
      // Main-page-only reduction for the belonging-10 ring — the mirror
      // block below intentionally keeps using the un-reduced `amp` above.
      const mainAmp = (rates[i] ?? 5) >= 9.5 ? amp * STEP1_MAIN_RATE10_DISTORTION_MULT : amp;
      const d = buildDistortedRingPath(cx, cy, radiiNow[i] ?? 1, phi, mainAmp, ringDistortionOptsForAmp(mainAmp, i * 7.1));
      setRingD(rings[i], d);
      try {
        const baseSw = Number(rings[i] && rings[i].__lpSoloBaseStrokeWidth);
        if (Number.isFinite(baseSw) && baseSw > 0) {
          rings[i].setAttribute("stroke-width", String(baseSw));
          const mirror = rings[i] && rings[i].__lpMirrorPath;
          if (mirror && mirror.setAttribute) mirror.setAttribute("stroke-width", String(baseSw));
        }
      } catch {
        // ignore
      }
      // The fullscreen page's copy gets: a very slightly weaker pull/push
      // shape (less outward bulge / inward dent), a very slightly narrower
      // breathing range (same speed, just a touch less swing), and a very
      // slightly stronger organic waviness — all independent of Step 1's
      // own rendering, by re-deriving the mirror's path from scratch each
      // frame instead of mirroring Step 1's path exactly.
      try {
        const mirror = rings[i] && rings[i].__lpMirrorPath;
        if (mirror && mirror.setAttribute) {
          const baseR = Number(baseRadii[i]) || (radiiNow[i] ?? 1);
          const liveR = radiiNow[i] ?? 1;
          const mirrorR = baseR + (liveR - baseR) * EMOTION_FULLSCREEN_BREATH_RANGE_DAMPING;
          const dampedAmp = amp * EMOTION_FULLSCREEN_DISTORTION_DAMPING;
          const mirrorOpts = ringDistortionOptsForAmp(dampedAmp, i * 7.1);
          mirrorOpts.organic = (Number(mirrorOpts.organic) || 1) * EMOTION_FULLSCREEN_ORGANIC_BOOST;
          const mirrorD = buildDistortedRingPath(cx, cy, mirrorR, phi, dampedAmp, mirrorOpts);
          mirror.setAttribute("d", mirrorD);
          const hit = mirror.__lpHitPath;
          if (hit && hit.setAttribute) hit.setAttribute("d", mirrorD);
        }
      } catch {
        // ignore
      }
      updateStep1EmotionRingLeaderLine(rings[i] && rings[i].__lpMirrorPath);
    }

    // Sound: duck each ring's volume in sync with its own breathing (shrink
    // => quieter, expand => louder). See updateEmotionSoundBreathDuckMult()/
    // applyEmotionSoundVolumesOnly() — focus/mute state itself is untouched
    // here, this only modulates on top of whatever's already audible.
    try {
      if (_emotionSoundRings) {
        const duckCfg = EMOTION_SOUND_CONFIG.breathDuck;
        const alpha = 1 - Math.exp(-dt / Math.max(20, duckCfg.smoothTauMs));
        for (let i = 0; i < n; i++) {
          const base = Number(baseRadii[i]) || 1;
          const nowR = Number(radiiNow[i]) || base;
          const ampF = Number(ampFactorsByRing[i]) || 0;
          const maxDelta = (ampPx * ampF) / Math.max(1e-6, groupScale);
          const signed = maxDelta > 1e-6 ? clamp((nowR - base) / maxDelta, -1, 1) : 0;
          updateEmotionSoundBreathDuckMult(i, signed, alpha);
        }
        applyEmotionSoundVolumesOnly();
      }
    } catch {
      // ignore
    }

    _emotionBreathRaf = requestAnimationFrame(frame);
  }

  _emotionBreathRaf = requestAnimationFrame(frame);
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

function wrapAnglePi(theta) {
  const twoPi = Math.PI * 2;
  let t = Number(theta) || 0;
  // Wrap into [0, 2pi)
  t = ((t % twoPi) + twoPi) % twoPi;
  // Shift into (-pi, pi]
  if (t > Math.PI) t -= twoPi;
  return t;
}

function gaussianBump(dTheta, sigma) {
  const s = Math.max(1e-6, Number(sigma) || 1e-6);
  const x = Number(dTheta) || 0;
  return Math.exp(-(x * x) / (2 * s * s));
}

function pointedAngularBump(dTheta, sigma, power) {
  const s = Math.max(1e-6, Number(sigma) || 1e-6);
  const p = Math.max(0.8, Number(power) || 1.25);
  const x = Math.abs(Number(dTheta) || 0);
  // power < 2 makes the peak more "pointy" at theta=phi (cuspier than gaussian).
  return Math.exp(-Math.pow(x / s, p));
}

function distortionAmplitudeFromBelonging(rate, baseRadius) {
  const r = Math.max(1, Math.min(10, Number(rate) || 5));
  const delta = r - 5;
  if (delta === 0) return 0;

  // Normalize so 10 => +1, 1 => -1.
  const t = delta > 0 ? delta / 5 : delta / 4;
  const direction = r < 5 ? -1 : 1;
  const strength = Math.pow(Math.min(1, Math.abs(t)), EMOTION_DISTORTION_EXP);

  // Taper extremes: 5 = full strength (1.0), 1 and 10 = slightly reduced (0.6),
  // proportional in between.
  const distFromCenter = Math.abs(r - 5.5);
  const taper = 1 - distFromCenter / 12;

  // Scale with ring size so outer rings deform more in absolute terms.
  const rr = Math.max(1, Number(baseRadius) || 1);
  const maxAmp = rr * EMOTION_DISTORTION_MAX_AMP_COEFF * EMOTION_DISTORTION_SCALE;
  // Slightly reduce distortion specifically for belonging rate 10.
  const rate10Dampen = (r >= 9.5) ? 0.8 : 1;
  const amp = direction * maxAmp * strength * taper * rate10Dampen;
  const lim = rr * EMOTION_DISTORTION_CLAMP_FRACTION;
  return Math.max(-lim, Math.min(lim, amp));
}

function isCurrentMapNastyaFaybish() {
  try {
    const full = String(elStudentName?.value || "").trim();
    const n1 = normalizeNameForSignature(full);
    if (n1 === "nastyafaybish") return true;
  } catch {
    // ignore
  }

  try {
    const sig = String(elSignatureLabel?.textContent || "").trim().toLowerCase();
    const compact = sig.replace(/\s+/g, "");
    if (compact.startsWith("nastyafaybish.")) return true;
    if (compact === "nastyafaybish") return true;
  } catch {
    // ignore
  }

  try {
    const sig = String(elEmotionTitle?.textContent || "").trim().toLowerCase();
    const compact = sig.replace(/\s+/g, "");
    if (compact.startsWith("nastyafaybish.")) return true;
    if (compact === "nastyafaybish") return true;
  } catch {
    // ignore
  }

  return false;
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

function buildDistortedRingPath(cx, cy, baseRadius, angleRad, amplitude, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const steps = Math.max(48, Math.round(Number(options.steps) || 240));
  const sigma = Math.max(0.12, Number(options.sigma) || EMOTION_BUMP_SIGMA);
  const power = Math.max(0.8, Number(options.power) || EMOTION_BUMP_POWER);
  const organic = Number(options.organic) || 0;
  const organicSeed = Number(options.organicSeed) || 0;

  const cX = Number(cx) || 0;
  const cY = Number(cy) || 0;
  const r0 = Math.max(1, Number(baseRadius) || 1);
  const phi = Number(angleRad) || 0;
  const amp = Number(amplitude) || 0;

  // Use only integer frequencies for organic waves so theta=0 and theta=2π
  // produce the same value, ensuring a seamless closed ring.
  let d = "";
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const theta = t * Math.PI * 2;
    const dTheta = wrapAnglePi(theta - phi);
    const bump = amp === 0 ? 0 : pointedAngularBump(dTheta, sigma, power);
    let r = Math.max(1, r0 + amp * bump);
    if (organic > 0) {
      r += emotionRingOrganicWave(theta, organicSeed) * organic * r0 * 0.025;
    }
    r = Math.max(1, r);
    const x = cX + r * Math.cos(theta);
    const y = cY + r * Math.sin(theta);
    const cmd = i === 0 ? "M" : "L";
    d += `${cmd}${Math.round(x * 1000) / 1000},${Math.round(y * 1000) / 1000}`;
  }
  d += "Z";
  return d;
}

function addInnerDots(parent, cx, cy, baseRadius, phi, amp, strokeWidth, opts) {
  const r0 = Math.max(1, Number(baseRadius) || 1);
  const sw = Math.max(1, Number(strokeWidth) || 1);
  const seed = Number(opts?.organicSeed) || 0;
  const dotR = Math.max(0.3, sw * 0.08);
  const inset = sw / 2 + dotR + 0.5;
  const count = Math.floor(12 + seed * 0.3) % 18 + 8;
  const NS = "http://www.w3.org/2000/svg";

  for (let j = 0; j < count; j++) {
    const frac = (j / count) + (Math.sin(seed * 3.7 + j * 2.31) * 0.5 + 0.5) / count * 0.6;
    const theta = frac * Math.PI * 2;
    const dTheta = wrapAnglePi(theta - (Number(phi) || 0));
    const bump = amp === 0 ? 0 : pointedAngularBump(dTheta, EMOTION_BUMP_SIGMA, EMOTION_BUMP_POWER);
    let r = Math.max(1, r0 + (Number(amp) || 0) * bump) - inset;
    if (r < 2) continue;
    const x = Number(cx) + r * Math.cos(theta);
    const y = Number(cy) + r * Math.sin(theta);
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(Math.round(x * 100) / 100));
    dot.setAttribute("cy", String(Math.round(y * 100) / 100));
    dot.setAttribute("r", String(dotR));
    dot.setAttribute("fill", "#111827");
    dot.setAttribute("opacity", String(0.25 + Math.abs(Math.sin(seed + j * 1.7)) * 0.35));
    parent.appendChild(dot);
  }
}

function ringDistortionOptsForAmp(amplitude, organicSeed) {
  const a = Number(amplitude) || 0;
  const base = {};
  if (organicSeed !== undefined) {
    // Slightly stronger than the neutral 1 -- applies to every ring alike,
    // regardless of its own stroke width.
    base.organic = 1.12;
    base.organicSeed = Number(organicSeed) || 0;
  }
  // Only soften inward pulls (negative amplitude => belonging < 5).
  if (a < 0) {
    return { ...base, sigma: EMOTION_INWARD_BUMP_SIGMA, power: EMOTION_INWARD_BUMP_POWER };
  }
  return Object.keys(base).length > 0 ? base : null;
}

function renderEmotionMap(start) {
  if (!elEmotionSvg) return;

  // Reset any previous ring focus when entering/re-rendering the emotion map.
  _emotionRingFocusIndex = null;
  try {
    hideEmotionRingSoloTextOverlays();
  } catch {
    // ignore
  }

  disarmEmotionBreathing();
  stopEmotionBreathing();

  // Clear previous content.
  while (elEmotionSvg.firstChild) elEmotionSvg.removeChild(elEmotionSvg.firstChild);

  // Use the Step 2 map's pixel coordinate system when available so the emotion
  // view matches the previous step's zoom/scale.
  const vbW = start && isFinite(start.mapW) && start.mapW > 0 ? Number(start.mapW) : EMOTION_VB;
  const vbH = start && isFinite(start.mapH) && start.mapH > 0 ? Number(start.mapH) : EMOTION_VB;
  elEmotionSvg.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);

  // Optional: route layer (LifePath line) under the emotion rings.
  // Requirement: present but invisible/transparent, and positioned so the
  // emotion map center matches the route center (Israel-only if abroad exists).
  try {
    /** @type {{x:number,y:number}[][]} */
    const routeSegments = Array.isArray(start?.routeSegments) ? start.routeSegments : [];
    /** @type {{x:number,y:number}[]} */
    const routePointsFallback = (!routeSegments.length && Array.isArray(start?.points))
      ? start.points.map((p) => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 }))
      : [];

    const segmentsToDraw = routeSegments.length
      ? routeSegments
      : (routePointsFallback.length >= 2 ? [routePointsFallback] : []);

    if (segmentsToDraw.length) {
      const NS = "http://www.w3.org/2000/svg";
      const g = document.createElementNS(NS, "g");
      g.setAttribute("data-layer", "emotion-route");
      g.style.opacity = "0";
      g.style.pointerEvents = "none";

      const cx = vbW / 2;
      const cy = vbH / 2;

      // Center the route under the rings.
      const center = (() => {
        const c = start && start.routeCenter;
        if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) return { x: Number(c.x), y: Number(c.y) };

        // Fallback: bbox center of all route points.
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const seg of segmentsToDraw) {
          for (const pt of Array.isArray(seg) ? seg : []) {
            const x = Number(pt?.x);
            const y = Number(pt?.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
        return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      })();

      if (center) {
        const dx = cx - center.x;
        const dy = cy - center.y;
        // Use attribute to avoid needing CSS transforms in SVG.
        g.setAttribute("transform", `translate(${dx},${dy})`);
      }

      for (const seg of segmentsToDraw) {
        if (!Array.isArray(seg) || seg.length < 2) continue;
        const pl = document.createElementNS(NS, "polyline");
        pl.setAttribute("fill", "none");
        pl.setAttribute("stroke", "#111827");
        pl.setAttribute("stroke-width", "1");
        pl.setAttribute("stroke-linecap", "round");
        pl.setAttribute("stroke-linejoin", "round");
        pl.setAttribute(
          "points",
          seg
            .map((pt) => `${Math.round((Number(pt?.x) || 0) * 1000) / 1000},${Math.round((Number(pt?.y) || 0) * 1000) / 1000}`)
            .join(" ")
        );
        g.appendChild(pl);
      }

      if (g.childNodes.length) {
        elEmotionSvg.appendChild(g);
      }
    }
  } catch {
    // ignore
  }

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

  const isNastya = isCurrentMapNastyaFaybish();
  const hasStartSource = Boolean(start && start.points && start.points.length);

  const finalStrokes = points.map((p) => emotionStrokeWidthFromRate(p.strokeWidth));
  const maxStroke = Math.max(1, ...finalStrokes);
  const cx = vbW / 2;
  const cy = vbH / 2;
  const padding = 14 + maxStroke;
  const maxAllowedRadius = Math.max(1, Math.min(vbW, vbH) / 2 - padding);
  const ampScale = n > 12 ? 0.5 : 1;
  const groupScaleBase = n > 15 ? 0.8 : (n < 12 ? 1.08 : 1);
  const isPaulina = isCurrentMapPaulinaRozga22(n);
  // Density tweak: for emotion maps with many rings, shrink the whole group.
  // Requirement: when there are > 20 addresses, reduce emotion map display by 20%.
  // Applies also to Paulina (in addition to the Paulina-specific scale).
  const crowdScale = (n > 20) ? 0.8 : 1;
  // Paulina request: shrink rings proportionally (including stroke thickness).
  // This requires allowing strokes to scale with the group transform.
  // Paulina: additional 20% shrink (on top of the >20 addresses crowdScale).
  const paulinaScale = isPaulina ? (0.72 * 0.8) : 1;
  const groupScale = Math.max(0.4, Math.min(1.3, groupScaleBase * paulinaScale * crowdScale));
  const strokesScaleWithGroup = isPaulina;
  const gapUsed = EMOTION_RING_CLEARANCE_PX;
  const baseStrokeRates = points.map((p) => Math.max(1, Math.min(10, Number(p?.strokeWidth) || 5)));
  const phis = points.map((p, i) => (
    hasStartSource
      ? Math.atan2((Number(p.startY) || 0) - cy, (Number(p.startX) || 0) - cx)
      : (i * Math.PI * 2) / Math.max(1, n)
  ));

  // Auto-fit: if the final distorted rings would exceed the viewBox bounds,
  // recompute smaller target radii (without scaling strokes).
  const baseMaxR = Math.max(1, (Math.min(vbW, vbH) / 2 - padding) * EMOTION_RING_SCALE);
  const computeLayoutForMaxR = (maxRValue) => {
    const baseRadii = computeEmotionRingRadii(Math.max(1, maxRValue), finalStrokes);
    return computeEmotionRingLayoutNoTouch(baseRadii, finalStrokes, baseStrokeRates, gapUsed, { isNastya, phis, ampScale, groupScale, strokesScaleWithGroup, sampleSteps: 360 });
  };
  const computeMaxOuterEdge = (layout) => {
    const radii = Array.isArray(layout?.radii) ? layout.radii : [];
    let maxOuterEdge = 1;
    for (let i = 0; i < n; i++) {
      const r0 = Math.max(1, Number(radii[i]) || 1);
      const amp = Number(layout?.amps?.[i]) || 0;
      const sw = Math.max(1, Number(finalStrokes[i]) || 1);
      const swPx = strokesScaleWithGroup ? sw * groupScale : sw;
      const outerEdge = (r0 + Math.max(0, amp)) * groupScale + swPx / 2;
      if (outerEdge > maxOuterEdge) maxOuterEdge = outerEdge;
    }
    return maxOuterEdge;
  };

  let maxRFit = baseMaxR;
  let layout = computeLayoutForMaxR(maxRFit);
  for (let iter = 0; iter < 4; iter++) {
    const maxOuterEdge = computeMaxOuterEdge(layout);
    const allowedOuterEdge = maxAllowedRadius;
    if (maxOuterEdge <= allowedOuterEdge) break;
    const shrink = allowedOuterEdge / Math.max(1, maxOuterEdge);
    maxRFit = Math.max(1, maxRFit * Math.max(0.2, Math.min(1, shrink)));
    layout = computeLayoutForMaxR(maxRFit);
  }
  const targetRadii = layout.radii;

  // Hover label for each ring: inner-most is home 01, next is 02, etc.
  // Determine the order by actual radius (smallest radius = inner-most),
  // so numbering stays correct even if the points array order changes.
  const homeNumberByIndex = new Array(n).fill(0);
  try {
    const idxs = Array.from({ length: n }, (_, i) => i);
    idxs.sort((a, b) => {
      const ra = Number(targetRadii?.[a]) || 0;
      const rb = Number(targetRadii?.[b]) || 0;
      return ra - rb || a - b;
    });
    for (let pos = 0; pos < idxs.length; pos++) {
      homeNumberByIndex[idxs[pos]] = pos + 1;
    }
  } catch {
    // ignore; fallback is handled below
  }

  const ringsGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  ringsGroup.setAttribute("data-layer", "emotion-rings");
  if (groupScale !== 1) {
    ringsGroup.setAttribute(
      "transform",
      `translate(${cx} ${cy}) scale(${groupScale}) translate(${-cx} ${-cy})`
    );
  }
  elEmotionSvg.appendChild(ringsGroup);

  const rings = [];
  const finalRingStrokes = [];
  const startRingStrokes = [];
  const ringAngles = [];
  const ringAmps = [];
  const homeLabelToVisibleRing = new Map();
  const ringHomeNums = new Array(n).fill(0);
  const ringTypes = new Array(n).fill("inner");
  const innerCountForTypes = Math.max(1, Math.ceil(n * (Number(EMOTION_SOUND_CONFIG.innerFraction) || 0.30)));

  const setRingD = (ringPath, d) => {
    try {
      ringPath.setAttribute("d", d);
    } catch {
      // ignore
    }
    try {
      const hit = ringPath && ringPath.__lpHitPath;
      if (hit && hit.setAttribute) hit.setAttribute("d", d);
    } catch {
      // ignore
    }
  };

  const setRingStrokeWidth = (ringPath, sw) => {
    try {
      ringPath.setAttribute("stroke-width", String(sw));
    } catch {
      // ignore
    }
    try {
      const hit = ringPath && ringPath.__lpHitPath;
      if (hit && hit.setAttribute) hit.setAttribute("stroke-width", String((Number(sw) || 0) + 2));
    } catch {
      // ignore
    }
  };
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

    // Slightly larger invisible hit area so hover still works with ~1px deviation.
    const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");

    // Native SVG tooltip on hover.
    try {
      const homeNum = homeNumberByIndex[i] || (i + 1);
      ringHomeNums[i] = homeNum;
      const pos = Math.max(0, Math.min(n - 1, homeNum - 1));
      ringTypes[i] = pos < innerCountForTypes ? "inner" : "outer";
      const label = `home ${String(homeNum).padStart(2, "0")}`;
      try {
        path.setAttribute("data-emotion-ring", "1");
        path.setAttribute("data-emotion-ring-visible", "1");
        path.setAttribute("data-home-label", label);

        hitPath.setAttribute("data-emotion-ring", "1");
        hitPath.setAttribute("data-emotion-ring-hit", "1");
        hitPath.setAttribute("data-home-label", label);
      } catch {
        // ignore
      }

      try {
        homeLabelToVisibleRing.set(label, path);
      } catch {
        // ignore
      }
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = label;
      path.appendChild(title);
    } catch {
      // ignore
    }

    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#111827");
    path.setAttribute("pointer-events", "visibleStroke");

    // Hit path is visually invisible but should capture pointer events on the stroke.
    hitPath.setAttribute("fill", "none");
    hitPath.setAttribute("stroke", "#111827");
    hitPath.style.opacity = "0.001";
    hitPath.setAttribute("pointer-events", "stroke");
    hitPath.setAttribute("stroke-linecap", "round");
    hitPath.setAttribute("stroke-linejoin", "round");
    if (!strokesScaleWithGroup) {
      // Keep stroke thickness constant even if we scale the rings group.
      path.setAttribute("vector-effect", "non-scaling-stroke");
      hitPath.setAttribute("vector-effect", "non-scaling-stroke");
    }

    const focusRingFromGesture = () => {
      try {
        ensureEmotionAudioReady();
      } catch {
        // ignore
      }
      const already = Number.isFinite(_emotionRingFocusIndex) && Math.floor(Number(_emotionRingFocusIndex) || 0) === i;
      if (already) {
        return;
      } else {
        _emotionRingFocusIndex = i;
        applyEmotionRingFocusVisuals(i);
      }

      try {
        setEmotionSoundFocus(i);
      } catch {
        // ignore
      }
    };

    const baseStrokeRate = baseStrokeRates[i] ?? Math.max(1, Math.min(10, Number(p.strokeWidth) || 5));
    const finalStroke = Math.max(1, Number(finalStrokes[i]) || 1);
    // When we *animate from the Step 2 map*, the rings should begin with the
    // same thickness the user just saw on the map (which uses belongingCircleStrokeWeight).
    const startStroke = hasStartSource ? belongingCircleStrokeWeight(baseStrokeRate) : finalStroke;
    // Keep hit path in sync with the visible path's geometry.
    try {
      path.__lpHitPath = hitPath;
    } catch {
      // ignore
    }

    // Ring click behavior: focus the clicked ring.
    try {
      hitPath.setAttribute("data-ring-index", String(i));
      hitPath.setAttribute("stroke-width", String(Math.max(12, finalStroke + 10)));
      hitPath.addEventListener("pointerdown", focusRingFromGesture, { passive: true });
      hitPath.addEventListener("click", focusRingFromGesture, { passive: true });
      path.addEventListener("pointerdown", focusRingFromGesture, { passive: true });
      path.addEventListener("click", focusRingFromGesture, { passive: true });
    } catch {
      // ignore
    }
    setRingStrokeWidth(path, startStroke);

    // Distortion direction: angle of the original map location relative to center.
    const phi = phis[i] ?? 0;
    const targetR = Math.max(1, Number(targetRadii[i]) || 1);
    const ampTarget = Number(layout?.amps?.[i]) || 0;

    const soloShape = pendingEmotionSoloShapeParams;
    const hasSoloShape = soloShape
      && Math.floor(Number(soloShape.index)) === i
      && Number.isFinite(Number(soloShape.phi));
    const finalPhi = hasSoloShape ? Number(soloShape.phi) : phi;
    const finalAmp = hasSoloShape && Number.isFinite(Number(soloShape.ampRatio))
      ? targetR * Number(soloShape.ampRatio)
      : ampTarget;
    // Cap at finalStroke (the belonging-rate-defined thickness): the solo
    // ring's carried-over pixel measurement exists only to avoid a visual
    // "pop" during the fly-in transition -- it should never let the ring end
    // up rendering thicker than what its own belonging rate calls for.
    const finalStrokeForRing = Math.min(finalStroke, hasSoloShape && Number.isFinite(Number(soloShape.strokeWidthPx)) && Number(soloShape.strokeWidthPx) > 0
      ? Math.max(0.5, Number(soloShape.strokeWidthPx))
      : (hasSoloShape && Number.isFinite(Number(soloShape.strokeRatio)) && Number(soloShape.strokeRatio) > 0
        ? Math.max(0.5, targetR * Number(soloShape.strokeRatio))
        : finalStroke));
    setRingStrokeWidth(path, finalStrokeForRing);

    ringAngles.push(finalPhi);
    ringAmps.push(finalAmp);
    finalRingStrokes.push(finalStrokeForRing);
    startRingStrokes.push(startStroke);
    ringsGroup.appendChild(path);
    ringsGroup.appendChild(hitPath);
    rings.push(path);
  }

  // Expose ring state for focus + tick/audio helpers.
  try {
    elEmotionSvg.__lpEmotionRings = rings;
    elEmotionSvg.__lpEmotionRates = baseStrokeRates;
  } catch {
    // ignore
  }

  // Store an index for fast hover highlight lookup.
  try {
    elEmotionSvg.__lpHomeLabelToRingEl = homeLabelToVisibleRing;
  } catch {
    // ignore
  }

  // Robust hover tooltip (HTML) for ring numbering.
  // Arm it after the rings exist so event delegation can find data attributes.
  try {
    armEmotionHomeHoverTooltips();
  } catch {
    // ignore
  }

  // Connecting line that will “cross” while circles move.
  let connector = null;
  let connectorFinalStroke = 1 + EMOTION_STROKE_BOOST;
  let connectorStartStroke = connectorFinalStroke;
  if (n >= 2) {
    connector = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    connector.setAttribute("fill", "none");
    connector.setAttribute("stroke", "#111827");
    if (!strokesScaleWithGroup) connector.setAttribute("vector-effect", "non-scaling-stroke");
    connectorFinalStroke = 1 + EMOTION_STROKE_BOOST;
    // Match the Step 2 map path thickness at animation start.
    connectorStartStroke = (start && start.points && start.points.length) ? 1 : connectorFinalStroke;
    connector.setAttribute("stroke-width", String(connectorStartStroke));
    connector.setAttribute("stroke-linecap", "round");
    connector.setAttribute("stroke-linejoin", "round");
    connector.style.opacity = "1";
    ringsGroup.insertBefore(connector, rings[0]);
  }

  const targets = points.map((p, i) => ({
    x: cx,
    y: cy,
    r: targetRadii[i] || 1,
  }));

  const emotionPlaybackOptions = {
    rings,
    cx,
    cy,
    baseRadii: targets.map((t) => t.r),
    phis: ringAngles,
    amps: ringAmps,
    strokes: finalRingStrokes,
    rates: baseStrokeRates,
    ringHomeNums,
    ringTypes,
    groupScale,
    strokesScaleWithGroup,
    gapPx: EMOTION_BREATH_CLEARANCE_PX,
  };

  // If we don't have a start source, skip animation.
  if (!(start && start.points && start.points.length)) {
    for (let i = 0; i < rings.length; i++) {
      const amp = ringAmps[i] ?? 0;
      const phi = ringAngles[i] ?? 0;
      const d = buildDistortedRingPath(cx, cy, targets[i].r, phi, amp, ringDistortionOptsForAmp(amp, i * 7.1));
      setRingD(rings[i], d);
    }

    armEmotionBreathing(emotionPlaybackOptions);
    return;
  }

  const starts = points.map((p) => ({ x: p.startX, y: p.startY, r: Math.max(1, p.startR) }));
  const durationMs = EMOTION_ANIM_MS;
  let startTs = 0;

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
    for (let i = 0; i < rings.length; i++) {
      const sx = starts[i].x;
      const sy = starts[i].y;
      const sr = starts[i].r;
      const tx = targets[i].x;
      const ty = targets[i].y;
      const tr = targets[i].r;

      const x = lerp(sx, tx, e);
      const y = lerp(sy, ty, e);
      const r = lerp(sr, tr, e);
      const phi = ringAngles[i] ?? 0;
      const ampTarget = ringAmps[i] ?? 0;
      const amp = lerp(0, ampTarget, e);
      const d = buildDistortedRingPath(x, y, r, phi, amp, ringDistortionOptsForAmp(ampTarget, i * 7.1));
      setRingD(rings[i], d);

      // Ramp stroke width during the animation.
      const sw0 = startRingStrokes[i] ?? 1;
      const sw1 = finalRingStrokes[i] ?? sw0;
      setRingStrokeWidth(rings[i], lerp(sw0, sw1, e));
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
      armEmotionBreathing(emotionPlaybackOptions);
    }
  }

  // Smoothness: let the browser paint the initial (Step2-matching) state first.
  requestAnimationFrame(() => {
    requestAnimationFrame((now) => {
      startTs = Number(now) || performance.now();
      requestAnimationFrame(frame);
    });
  });
}

function clearStep1EmotionMap() {
  stopEmotionBreathing();
  stopEmotionSound();
  _step1EmotionLastPlaybackOptions = null;
  _activeEmotionRings.length = 0;
  if (!elStep1EmotionSvg) return;
  while (elStep1EmotionSvg.firstChild) elStep1EmotionSvg.removeChild(elStep1EmotionSvg.firstChild);
  try {
    elStep1EmotionSvg.__lpEmotionRings = [];
    elStep1EmotionSvg.__lpEmotionRates = [];
  } catch {
    // ignore
  }
}

function getStep1EmotionAddresses() {
  return (Array.isArray(addresses) ? addresses : []).filter((addr) => addr && addr.valid !== false);
}

function step1EmotionAngleForAddress(addr, index, list) {
  try {
    const withCoords = (Array.isArray(list) ? list : [])
      .filter((a) => a && isFinite(a.lat) && isFinite(a.lon));
    if (!addr || !isFinite(addr.lat) || !isFinite(addr.lon) || !withCoords.length) {
      return (Number(index) || 0) * Math.PI * 2 / Math.max(1, Array.isArray(list) ? list.length : 1);
    }

    let latSum = 0;
    let lonSum = 0;
    for (const a of withCoords) {
      latSum += Number(a.lat);
      lonSum += Number(a.lon);
    }
    const centerLat = latSum / withCoords.length;
    const centerLon = lonSum / withCoords.length;
    const dx = Number(addr.lon) - centerLon;
    const dy = centerLat - Number(addr.lat);
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
      return (Number(index) || 0) * Math.PI * 2 / Math.max(1, Array.isArray(list) ? list.length : 1);
    }
    return Math.atan2(dy, dx);
  } catch {
    return (Number(index) || 0) * Math.PI * 2 / Math.max(1, Array.isArray(list) ? list.length : 1);
  }
}

function renderStep1EmotionMap(options) {
  const opts = options && typeof options === "object" ? options : {};
  if (!elStep1EmotionSvg) return;

  const items = getStep1EmotionAddresses();
  if (!items.length) {
    clearStep1EmotionMap();
    // No homes saved yet -- show the expected-count placeholder rings
    // (from homesCount) instead of leaving the map empty.
    renderStep1PlaceholderEmotionRings();
    return;
  }

  stopEmotionBreathing();

  while (elStep1EmotionSvg.firstChild) elStep1EmotionSvg.removeChild(elStep1EmotionSvg.firstChild);

  const vbW = 1000;
  const vbH = 620;
  elStep1EmotionSvg.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);

  const n = items.length;
  const cx = vbW / 2;
  const cy = vbH / 2;
  let baseStrokeRates = items.map((addr) => normalizeBelongingRate(addr.belonging_rate, stableBelongingRateFromId(addr.id)));
  let finalStrokes = baseStrokeRates.map((rate) => step1PreviewEmotionStrokeWidthFromRate(rate));
  const maxStroke = Math.max(1, ...finalStrokes);
  const padding = 18 + maxStroke;
  const maxAllowedRadius = Math.max(1, Math.min(vbW, vbH) / 2 - padding);
  const ampScale = n > 12 ? 0.5 : 1;
  const groupScaleBase = n > 15 ? 0.8 : (n < 12 ? 1.08 : 1);
  const crowdScale = n > 20 ? 0.8 : 1;
  let groupScale = Math.max(0.4, Math.min(1.3, groupScaleBase * crowdScale));
  const strokesScaleWithGroup = false;
  const gapUsed = EMOTION_RING_CLEARANCE_PX;
  let phis = items.map((addr, i) => step1EmotionAngleForAddress(addr, i, items));
  const baseMaxR = Math.max(1, (Math.min(vbW, vbH) / 2 - padding) * EMOTION_RING_SCALE);
  const isNastya = isCurrentMapNastyaFaybish();

  const computeLayoutForMaxR = (maxRValue) => {
    const baseRadii = computeEmotionRingRadii(Math.max(1, maxRValue), finalStrokes);
    return computeEmotionRingLayoutNoTouch(baseRadii, finalStrokes, baseStrokeRates, gapUsed, { isNastya, phis, ampScale, groupScale, strokesScaleWithGroup, sampleSteps: 360 });
  };
  const computeMaxOuterEdge = (layout) => {
    const radii = Array.isArray(layout?.radii) ? layout.radii : [];
    let maxOuterEdge = 1;
    for (let i = 0; i < n; i++) {
      const r0 = Math.max(1, Number(radii[i]) || 1);
      const amp = Number(layout?.amps?.[i]) || 0;
      const sw = Math.max(1, Number(finalStrokes[i]) || 1);
      const outerEdge = (r0 + Math.max(0, amp)) * groupScale + sw / 2;
      if (outerEdge > maxOuterEdge) maxOuterEdge = outerEdge;
    }
    return maxOuterEdge;
  };

  let maxRFit = baseMaxR;
  let layout = computeLayoutForMaxR(maxRFit);
  for (let iter = 0; iter < 4; iter++) {
    const maxOuterEdge = computeMaxOuterEdge(layout);
    if (maxOuterEdge <= maxAllowedRadius) break;
    const shrink = maxAllowedRadius / Math.max(1, maxOuterEdge);
    maxRFit = Math.max(1, maxRFit * Math.max(0.2, Math.min(1, shrink)));
    layout = computeLayoutForMaxR(maxRFit);
  }

  let targetRadii = Array.isArray(layout?.radii) ? layout.radii : [];

  // Use the total expected homes count (from homesCount field) so ring positions
  // match the placeholder template. Filled rings stay at their template position.
  const totalExpected = Math.max(n, parseInt(String(elHomesCount?.value || ""), 10) || n);
  // Same size treatment as renderStep1PlaceholderEmotionRings() -- 20%
  // smaller for 5-or-fewer-home maps, 10% bigger for 11-or-more -- so the
  // map doesn't jump in size once the first ring is activated.
  const mapSizeScale = totalExpected <= 5 ? 0.8 : (totalExpected >= 11 ? 1.1 : 1);
  const placeholderMaxR = (Math.min(cx, cy) - 20) * mapSizeScale;
  const placeholderGap = placeholderMaxR / (totalExpected + 1);

  // Override target radii to match placeholder positions.
  for (let i = 0; i < n; i++) {
    targetRadii[i] = placeholderGap * (i + 1);
  }

  // Radii already set to placeholder positions — no rescaling needed.
  const desiredMaxR = placeholderMaxR * totalExpected / (totalExpected + 1);
  let radiiScale = 1;

  // Safety: ensure the outermost ring (with distortions and stroke) fits in the viewBox.
  const maxSafeR = Math.min(cx, cy) - 10;
  let worstEdge = 0;
  for (let i = 0; i < n; i++) {
    const r = Number(targetRadii[i]) || 0;
    const amp = (Number(layout?.amps?.[i]) || 0) * radiiScale;
    const sw = Math.max(1, Number(finalStrokes[i]) || 1);
    const edge = (r + Math.abs(amp)) * groupScale + sw / 2;
    if (edge > worstEdge) worstEdge = edge;
  }
  if (worstEdge > maxSafeR) {
    const shrink = maxSafeR / worstEdge;
    radiiScale *= shrink;
    targetRadii = targetRadii.map((r) => r * shrink);
  }

  // Minimum overall on-screen diameter for the whole map (outermost ring,
  // including its stroke) -- this container is a fixed 460x486px box against
  // this SVG's fixed 1000x620 viewBox, so the (width-bound) conversion
  // factor below is a constant, not something that varies with viewport size.
  // Every ring uses vector-effect="non-scaling-stroke", so stroke-width is
  // already a final on-screen px amount, unaffected by groupScale or the
  // viewBox/container ratio -- only the radius portion needs conversion.
  const EMOTION_MAP_PX_PER_VB_UNIT = 460 / vbW;
  const EMOTION_MAP_MIN_DIAMETER_PX = 70;

  // The ring's own radius, not its (organic-wave) distortion amplitude, is
  // what actually determines its overall size -- the wave amplitude here is
  // a comparatively small wobble on top, and for belonging rate 10
  // specifically gets heavily damped again at draw time
  // (STEP1_MAIN_RATE10_DISTORTION_MULT, wobbleFitScale below), so basing
  // this size rule on it would systematically undershoot.
  let currentWorstEdgePx = 0;
  let worstScaledPartPx = 0; // radius * groupScale * px-per-unit, which is what growing targetRadii actually scales
  let worstSwHalfPx = 0; // stroke-width/2 is a fixed px amount regardless of radius, so it must be excluded from the scaled portion above
  for (let i = 0; i < n; i++) {
    const r = Number(targetRadii[i]) || 0;
    const sw = Math.max(1, Number(finalStrokes[i]) || 1);
    const scaledPartPx = r * groupScale * EMOTION_MAP_PX_PER_VB_UNIT;
    const edgePx = scaledPartPx + sw / 2;
    if (edgePx > currentWorstEdgePx) {
      currentWorstEdgePx = edgePx;
      worstScaledPartPx = scaledPartPx;
      worstSwHalfPx = sw / 2;
    }
  }
  if (currentWorstEdgePx > 0 && currentWorstEdgePx < EMOTION_MAP_MIN_DIAMETER_PX / 2 && worstScaledPartPx > 0) {
    const targetScaledPartPx = Math.max(0, EMOTION_MAP_MIN_DIAMETER_PX / 2 - worstSwHalfPx);
    const grow = targetScaledPartPx / worstScaledPartPx;
    if (grow > 1) {
      radiiScale *= grow;
      targetRadii = targetRadii.map((r) => r * grow);
    }
  }

  // Continuous adaptive fit: computed from the *final* (post-safety-shrink)
  // gap between adjacent rings, since that shrink above can itself compress
  // an already-tight many-ring layout much further. The pull/push distortion
  // (a fraction of each ring's own radius) naturally shrinks along with that
  // — it's derived from targetR below — but the breathing oscillation (a
  // fixed px budget, not tied to any radius) does not, so on a heavily
  // shrunk map it can end up many times the size of the now-tiny gap. Scale
  // both down together, just enough that the worst case (the outermost
  // ring, at the most extreme belonging rate, mid-breath) still fits inside
  // its share of the *actual* final gap — leaves few-ring maps untouched
  // (scale caps at 1) and only kicks in once crowding actually demands it.
  const finalGap = targetRadii.length > 1 ? targetRadii[1] - targetRadii[0] : placeholderGap;
  const finalOutermostR = targetRadii.length ? targetRadii[targetRadii.length - 1] : placeholderGap * n;
  const worstCaseStaticAmpPx = finalOutermostR * EMOTION_DISTORTION_MAX_AMP_COEFF * EMOTION_DISTORTION_SCALE * 0.9;
  const nominalBreathScale = 1.5;
  const worstCaseBreathPx = EMOTION_BREATH_AMPLITUDE_PX * EMOTION_BREATH_OUTER_FACTOR * nominalBreathScale;
  const worstCaseWobblePx = worstCaseStaticAmpPx + worstCaseBreathPx;
  const safeWobbleBudgetPx = Math.max(1, finalGap * 1.0);
  let wobbleFitScale = worstCaseWobblePx > 0 ? Math.max(0.65, Math.min(1, safeWobbleBudgetPx / worstCaseWobblePx)) : 1;

  // Frozen layout override (see captureStep1EmotionMapLayoutSnapshot() /
  // saveCurrentMapSnapshot()): reopening a saved map can pass back the exact
  // geometry inputs recorded when it was saved, so its rings look identical
  // to how they looked then even if the tuning constants feeding the
  // computation above (EMOTION_RING_SCALE and friends) change in a later
  // session. Everything from here on -- ring building, breathing,
  // fullscreen mirroring -- is unchanged either way; only these final
  // geometry inputs differ.
  const frozenLayout = opts.frozenLayout;
  if (frozenLayout && Array.isArray(frozenLayout.targetRadii) && frozenLayout.targetRadii.length === n) {
    targetRadii = frozenLayout.targetRadii.slice();
    phis = frozenLayout.phis.slice();
    finalStrokes = frozenLayout.finalStrokes.slice();
    baseStrokeRates = frozenLayout.baseStrokeRates.slice();
    groupScale = Number(frozenLayout.groupScale) || groupScale;
    wobbleFitScale = Number(frozenLayout.wobbleFitScale) || wobbleFitScale;
  }

  // Snapshot the exact geometry inputs about to be used, so a later save can
  // freeze this map's emotion-ring appearance (see frozenLayout above) --
  // captured unconditionally, whether this run just reused frozen data or
  // freshly computed it, since either way it reflects what's now on screen.
  _step1EmotionLastLayoutSnapshot = {
    n,
    targetRadii: targetRadii.slice(),
    phis: phis.slice(),
    finalStrokes: finalStrokes.slice(),
    baseStrokeRates: baseStrokeRates.slice(),
    groupScale,
    wobbleFitScale,
  };

  const ringsGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  ringsGroup.setAttribute("data-layer", "step1-emotion-rings");
  if (groupScale !== 1) {
    ringsGroup.setAttribute("transform", `translate(${cx} ${cy}) scale(${groupScale}) translate(${-cx} ${-cy})`);
  }
  elStep1EmotionSvg.appendChild(ringsGroup);

  const rings = [];
  const ringAngles = [];
  const ringAmps = [];
  const ringHomeNums = new Array(n).fill(0);
  const ringTypes = new Array(n).fill("inner");
  const innerCountForTypes = Math.max(1, Math.ceil(n * (Number(EMOTION_SOUND_CONFIG.innerFraction) || 0.30)));

  const setRingD = (ringPath, d) => {
    try { ringPath.setAttribute("d", d); } catch { /* ignore */ }
  };

  for (let i = 0; i < n; i++) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const homeNum = i + 1;
    const label = `home ${String(homeNum).padStart(2, "0")}`;
    const pos = Math.max(0, Math.min(n - 1, homeNum - 1));
    ringHomeNums[i] = homeNum;
    ringTypes[i] = pos < innerCountForTypes ? "inner" : "outer";

    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#000000");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    path.setAttribute("pointer-events", "visibleStroke");
    path.setAttribute("data-emotion-ring", "1");
    path.setAttribute("data-emotion-ring-visible", "1");
    path.setAttribute("data-home-label", label);
    path.setAttribute("stroke-width", String(Math.max(1, Number(finalStrokes[i]) || 1)));

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = label;
    path.appendChild(title);

    const phi = phis[i] ?? 0;
    const targetR = Math.max(1, Number(targetRadii[i]) || 1);
    // Recalculate distortion amplitude based on the actual (placeholder-matched) radius.
    const ampTarget = distortionAmplitudeFromBelonging(baseStrokeRates[i], targetR) * 0.9 * wobbleFitScale;
    // Main-page-only reduction for the belonging-10 ring, applied only to
    // this initial static path — data-emotion-amp below stays at the
    // un-reduced ampTarget since the fullscreen mirror reads it from there.
    const mainAmpTarget = (Number(baseStrokeRates[i]) || 5) >= 9.5 ? ampTarget * STEP1_MAIN_RATE10_DISTORTION_MULT : ampTarget;
    const targetD = buildDistortedRingPath(cx, cy, targetR, phi, mainAmpTarget, ringDistortionOptsForAmp(mainAmpTarget));
    const targetSW = Math.max(1, Number(finalStrokes[i]) || 1);

    // Stashed for the fullscreen page's per-ring leader-line labels (angle,
    // pull/push amplitude, belonging rate) — cheaper to record here than to
    // re-derive from the rendered path later.
    path.setAttribute("data-emotion-phi", String(phi));
    path.setAttribute("data-emotion-r0", String(targetR));
    path.setAttribute("data-emotion-amp", String(ampTarget));
    path.setAttribute("data-emotion-rate", String(baseStrokeRates[i]));
    path.setAttribute("data-emotion-home-num", String(homeNum));

    // If transitioning from placeholder circles, start at the old shape and animate.
    const transitionData = Array.isArray(opts.transitionFromCircles) ? opts.transitionFromCircles : null;
    if (transitionData && i < transitionData.length) {
      const oldR = transitionData[i].r || targetR;
      const oldSW = transitionData[i].sw || targetSW;
      const startD = buildDistortedRingPath(cx, cy, oldR, 0, 0);
      setRingD(path, startD);
      path.setAttribute("stroke-width", String(oldSW));

      const duration = 1500;
      const startTime = performance.now() + i * 80;
      const animateRing = (now) => {
        const elapsed = now - startTime;
        if (elapsed < 0) { requestAnimationFrame(animateRing); return; }
        const t = Math.min(1, elapsed / duration);
        // Smooth ease-in-out for gentle transition.
        const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const curR = oldR + (targetR - oldR) * ease;
        const curAmp = ampTarget * ease;
        const curOrganic = ease;
        const curSW = oldSW + (targetSW - oldSW) * ease;
        const curOpts = ringDistortionOptsForAmp(curAmp, i * 7.1);
        if (curOpts) curOpts.organic = curOrganic;
        const curD = buildDistortedRingPath(cx, cy, curR, phi * ease, curAmp, curOpts);
        setRingD(path, curD);
        path.setAttribute("stroke-width", String(curSW));
        if (t < 1) requestAnimationFrame(animateRing);
        else setRingD(path, targetD);
      };
      requestAnimationFrame(animateRing);
    } else {
      setRingD(path, targetD);
    }

    ringAngles.push(phi);
    ringAmps.push(ampTarget);
    ringsGroup.appendChild(path);
    rings.push(path);
  }

  try {
    elStep1EmotionSvg.__lpEmotionRings = rings;
    elStep1EmotionSvg.__lpEmotionRates = baseStrokeRates;
  } catch {
    // ignore
  }

  const playbackOptions = {
    rings,
    cx,
    cy,
    baseRadii: targetRadii.map((r) => Math.max(1, Number(r) || 1)),
    phis: ringAngles,
    amps: ringAmps,
    strokes: finalStrokes,
    rates: baseStrokeRates,
    ringHomeNums,
    ringTypes,
    groupScale,
    strokesScaleWithGroup,
    gapPx: EMOTION_BREATH_CLEARANCE_PX,
    breathScale: nominalBreathScale * wobbleFitScale,
  };

  // Add placeholder circles for unfilled rings (remaining expected homes).
  if (totalExpected > n) {
    for (let j = n; j < totalExpected; j++) {
      const pr = placeholderGap * (j + 1);
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", String(pr));
      circle.setAttribute("fill", "none");
      circle.setAttribute("stroke", "#c9c8c1");
      circle.setAttribute("stroke-width", "1.5");
      ringsGroup.appendChild(circle);
    }
  }

  _step1EmotionLastPlaybackOptions = playbackOptions;
  startEmotionBreathing(playbackOptions);
  // Returning from the solo page sets this so sound just keeps playing
  // instead of being torn down and rebuilt here — see the back button
  // handler below.
  const skipSound = _step1SkipSoundRebuildOnce;
  _step1SkipSoundRebuildOnce = false;
  if (!skipSound) {
    try {
      ensureEmotionAudioReady();
      startEmotionSound(playbackOptions);
    } catch {
      // Browser may still require a real gesture before audio plays — the
      // document-level fallback (armEmotionSoundGestureFallback()) retries on
      // the next click/tap anywhere.
    }
  }
}

function animateEmotionBackToMap(start) {
  stopEmotionBreathing();
  stopEmotionSound();
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
  const circleStartStrokes = targets.map((t) => emotionStrokeWidthFromRate(t.strokeWidth));
  const maxStroke = Math.max(1, ...circleStartStrokes);
  const cx = vbW / 2;
  const cy = vbH / 2;
  const padding = 14 + maxStroke;
  const maxR = Math.max(1, (Math.min(vbW, vbH) / 2 - padding) * EMOTION_RING_SCALE);
  const ringRadii = computeEmotionRingRadii(maxR, circleStartStrokes);

  const groupScaleBase = n > 15 ? 0.8 : (n < 12 ? 1.08 : 1);
  const isPaulina = isCurrentMapPaulinaRozga22(n);
  const crowdScale = (n > 20) ? 0.8 : 1;
  const paulinaScale = isPaulina ? (0.72 * 0.8) : 1;
  const groupScale = Math.max(0.4, Math.min(1.3, groupScaleBase * paulinaScale * crowdScale));
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
  const circleEndStrokes = [];
  for (let i = 0; i < n; i++) {
    const t = targets[i];
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", String(cy));
    c.setAttribute("r", String(ringRadii[i] || 1));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke", "#111827");
    if (!isPaulina) c.setAttribute("vector-effect", "non-scaling-stroke");

    const baseStroke = Math.max(1, Math.min(10, Number(t.strokeWidth) || 1));
    const startStroke = Math.max(1, Number(circleStartStrokes[i]) || 1);
    // When returning to Step 2, match the map's circle marker stroke mapping.
    const endStroke = belongingCircleStrokeWeight(baseStroke);
    c.setAttribute("stroke-width", String(startStroke));
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
    if (!isPaulina) connector.setAttribute("vector-effect", "non-scaling-stroke");
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
  let startTs = 0;

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

  // Smoothness: paint the initial emotion state before interpolating back.
  requestAnimationFrame(() => {
    requestAnimationFrame((now) => {
      startTs = Number(now) || performance.now();
      requestAnimationFrame(frame);
    });
  });
}

function captureEmotionStartFromStep2() {
  try {
    const size = map.getSize();
    const mapW = Number(size?.x) || 0;
    const mapH = Number(size?.y) || 0;
    if (mapW <= 0 || mapH <= 0) return null;

    /** @type {{x:number,y:number,strokeWidth:number,startR:number}[]} */
    const pts = [];

    /** @type {{x:number,y:number}[][]} */
    const routeSegments = [];
    /** @type {{x:number,y:number}[]} */
    let currentRoute = [];

    /** @type {{x:number,y:number,isIsrael:boolean}[]} */
    const allRoutePtsForCenter = [];
    /** @type {{x:number,y:number,isIsrael:boolean}[]} */
    const israelRoutePtsForCenter = [];
    let sawAbroad = false;

    const israelBoundsForCenter = (() => {
      try {
        // Pad slightly to avoid misclassifying border locations.
        if (typeof ISRAEL_BOUNDS === "undefined" || !ISRAEL_BOUNDS) return null;
        return ISRAEL_BOUNDS.pad(0.06);
      } catch {
        return null;
      }
    })();

    for (let i = 0; i < addresses.length; i++) {
      const a = addresses[i];

      const ok = a && a.valid !== false && isFinite(a.lat) && isFinite(a.lon);
      if (!ok) {
        if (currentRoute.length >= 2) routeSegments.push(currentRoute);
        currentRoute = [];
        continue;
      }

      const rate = normalizeBelongingRate(a.belonging_rate, stableBelongingRateFromId(a.id));
      const innerRadius = 5;
      const startR = innerRadius + rate / 2;
      const ll = L.latLng(Number(a.lat), Number(a.lon));
      const p = map.latLngToContainerPoint(ll);

      const x = Number(p?.x) || 0;
      const y = Number(p?.y) || 0;
      pts.push({ x, y, strokeWidth: rate, startR });
      currentRoute.push({ x, y });

      let isIsrael = false;
      try {
        const c = toEnglishLike(String(a?.country || "")).trim().toLowerCase();
        const countrySaysIsrael = c.includes("israel") || c.includes("ישראל");
        const boundsSayIsrael = Boolean(israelBoundsForCenter && typeof israelBoundsForCenter.contains === "function" && israelBoundsForCenter.contains(ll));
        isIsrael = countrySaysIsrael || boundsSayIsrael;
      } catch {
        isIsrael = false;
      }
      if (!isIsrael) sawAbroad = true;

      const ptRec = { x, y, isIsrael };
      allRoutePtsForCenter.push(ptRec);
      if (isIsrael) israelRoutePtsForCenter.push(ptRec);
    }

    if (currentRoute.length >= 2) routeSegments.push(currentRoute);

    if (pts.length <= 0) return null;

    const routeCenter = (() => {
      const useIsraelOnly = sawAbroad && israelRoutePtsForCenter.length > 0;
      const ptsForCenter = useIsraelOnly ? israelRoutePtsForCenter : allRoutePtsForCenter;
      if (!ptsForCenter.length) return null;

      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const pt of ptsForCenter) {
        const x = Number(pt?.x);
        const y = Number(pt?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
      return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    })();

    return { points: pts, routeSegments, routeCenter: routeCenter || undefined, mapW, mapH };
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

function formatStep2SignatureDisplayName(text) {
  const raw = String(text || "").trim();
  // Hebrew names: keep as-is (no transliteration, no case transformation).
  if (containsHebrew(raw)) {
    return raw.replace(/\s+/g, " ");
  }

  const parts = raw
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.toLowerCase());

  if (!parts.length) return "";

  const upperFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

  if (parts.length === 1) return upperFirst(parts[0]);

  parts[0] = upperFirst(parts[0]);
  parts[parts.length - 1] = upperFirst(parts[parts.length - 1]);
  return parts.join(" ");
}

function updateStep2SignatureLabel() {
  if (!elSignatureLabel) return;
  // Shown exactly as typed on the address-entry page -- no case/format
  // transformation (unlike formatStep2SignatureDisplayName, used elsewhere
  // for archive/emotion labels).
  const name = String(elStudentName?.value || "").trim();
  const count = formatAddrCount(addresses.length);
  if (!name) {
    elSignatureLabel.innerHTML = "";
    if (elPostcardCardMapName) elPostcardCardMapName.textContent = "";
    return;
  }
  const mapName = `${normalizeNameForMapLabel(elStudentName?.value || "")}.${count}addrs`;
  // Keep the same nested span/font (Regular-weight) the name always rendered
  // in -- only the address-count span is dropped.
  elSignatureLabel.innerHTML = `<span class="step2SignatureMain">${name}</span>`;
  if (elPostcardCardMapName) elPostcardCardMapName.textContent = mapName;
}

// Reading panel on the route/movement map fullscreen page -- copied from
// the emotion fullscreen page's own panel (see
// updateStep1EmotionFullscreenInfo()), using "homes" in place of "rings".
function updateStep2ReadingInfo() {
  if (!elStep2ReadingInfoName) return;
  const validAddrs = (Array.isArray(addresses) ? addresses : []).filter((a) => a && a.valid !== false);

  elStep2ReadingInfoName.textContent = formatStep2SignatureDisplayName(elStudentName?.value || "");

  const homesCount = validAddrs.length;
  elStep2ReadingInfoCount.textContent = homesCount > 0
    ? `${homesCount} home${homesCount === 1 ? "" : "s"}`
    : "";

  const birthYear = validAddrs.length ? Math.floor(Number(validAddrs[0].startYear)) : NaN;
  const age = Number.isFinite(birthYear) ? Math.max(0, new Date().getFullYear() - birthYear) : "";
  setStep2ReadingInfoRow(elStep2ReadingInfoAge, "age :", age, "step2ReadingInfoStatValue");

  let avg = "";
  if (validAddrs.length) {
    const sum = validAddrs.reduce((s, a) => s + normalizeBelongingRate(a.belonging_rate, 5), 0);
    avg = Math.round((sum / validAddrs.length) * 10) / 10;
  }
  setStep2ReadingInfoRow(elStep2ReadingInfoAvg, "avg. belonging :", avg, "step2ReadingInfoStatValue");

  const countries = formatRawCountriesForAddresses(validAddrs);
  setStep2ReadingInfoRow(elStep2ReadingInfoCountries, "countries :", countries !== "--" ? countries : "", "step2ReadingInfoListValue");

  const cities = formatRawCitiesForAddresses(validAddrs);
  setStep2ReadingInfoRow(elStep2ReadingInfoCities, "cities :", cities !== "--" ? cities : "", "step2ReadingInfoListValue");
}

function setStep2ReadingInfoRow(el, labelText, valueText, valueClass) {
  if (!el) return;
  el.textContent = "";
  if (valueText === "" || valueText == null) return;
  const label = document.createElement("span");
  label.className = "step2ReadingInfoLabel";
  label.textContent = labelText;
  const value = document.createElement("span");
  value.className = valueClass;
  value.textContent = String(valueText);
  el.append(label, value);
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
    .filter((a) => a && a.valid !== false && isFinite(a.lat) && isFinite(a.lon))
    .map((a) => L.latLng(Number(a.lat), Number(a.lon)))
    .filter((ll) => ISRAEL_BOUNDS.contains(ll));

  if (pts.length === 1) {
    map.setView(pts[0], 6, { animate: false });
    enforceMinZoomToAvoidBlankViewport(map);
    return;
  }

  const bounds = pts.length > 0 ? L.latLngBounds(pts) : ISRAEL_BOUNDS;
  if (!bounds.isValid()) return;

  // Padding so markers/lines are not clipped -- slightly more than the bare
  // minimum so the opening view sits a touch more zoomed out.
  const pad = pts.length > 0 ? 0.21 : ISRAEL_FIT_PADDING;
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
    elHideMapBtn.textContent = geoLayerEnabled ? "hide map" : "show map";
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
  if (!step2VectorRenderer) step2VectorRenderer = L.svg();
  const overlayColor = getOverlayStrokeColor();
  const getMutedStrokeColor = () => (geoLayerEnabled ? "#545454" : "#c9c8c1");
  const resetStep2HoverState = () => {
    const baseColor = getOverlayStrokeColor();
    if (elPageStep2) elPageStep2.classList.remove("step2GeoHoverDimming");
    if (polyline && typeof polyline.setStyle === "function") {
      polyline.setStyle({ color: baseColor });
    }
    if (markerLayer && typeof markerLayer.eachLayer === "function") {
      markerLayer.eachLayer((layer) => {
        if (!layer) return;
        if (typeof layer.setStyle === "function") layer.setStyle({ color: baseColor });
        if (typeof layer.closeTooltip === "function") layer.closeTooltip();
      });
    }
  };
  step2HoverResetFn = resetStep2HoverState;
  if (!step2HoverPointerHandler && map && typeof map.on === "function") {
    step2HoverPointerHandler = (evt) => {
      const target = evt && evt.originalEvent ? evt.originalEvent.target : null;
      const overDot = !!(target && typeof target.closest === "function" && target.closest(".lifepathStep2Dot"));
      if (!overDot && typeof step2HoverResetFn === "function") step2HoverResetFn();
    };
    map.on("mousemove", step2HoverPointerHandler);
    map.on("mouseout", step2HoverPointerHandler);
  }
  const enforceStep2Order = () => {
    if (polyline && typeof polyline.bringToBack === "function") polyline.bringToBack();
    if (markerLayer && typeof markerLayer.eachLayer === "function") {
      markerLayer.eachLayer((layer) => {
        if (layer && typeof layer.bringToFront === "function") layer.bringToFront();
      });
    }
  };
  for (let i = 0; i < addresses.length; i++) {
    const a = addresses[i];
    if (!a || a.valid === false) continue;
    if (!isFinite(a.lat) || !isFinite(a.lon)) continue;

    const rate = normalizeBelongingRate(a.belonging_rate, stableBelongingRateFromId(a.id));
    const homeNo = formatHomeNumber(i + 1);
    // Exactly as typed on the address-entry page -- same language, same
    // spelling, no transliteration/reformatting.
    const hoverLabel = escapeHtmlText(formatAddressAsTyped(a));
    const lat = Number(a.lat);
    const lon = Number(a.lon);
    const belongingLabel = String(rate).padStart(2, "0");
    const tooltipHtml = `<div><span>home no.${homeNo}</span><span style="margin-left: 30px;">belonging&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="position: relative; left: -9px;">${belongingLabel}</span></span></div><div>${hoverLabel}</div>`;
    const innerRadius = 3.6;
    const radius = innerRadius + rate / 2;
    const dot = L.circleMarker([lat, lon], {
      renderer: step2VectorRenderer,
      className: "lifepathStep2Dot",
      radius,
      weight: belongingCircleStrokeWeight(rate),
      opacity: 1,
      color: overlayColor,
      ...getStep2RouteDotFillStyle(),
      lifepathHomeNo: homeNo,
    });
    dot.bindTooltip(tooltipHtml, { direction: "right", offset: [27, 0], sticky: false, className: "lifepathAddressTooltip" });
    dot.on("mouseover", () => {
      const mutedStrokeColor = getMutedStrokeColor();
      if (elPageStep2) elPageStep2.classList.toggle("step2GeoHoverDimming", Boolean(geoLayerEnabled));
      if (polyline && typeof polyline.setStyle === "function") {
        polyline.setStyle({ color: mutedStrokeColor });
      }
      enforceStep2Order();
      requestAnimationFrame(() => {
        if (markerLayer && typeof markerLayer.eachLayer === "function") {
          markerLayer.eachLayer((layer) => {
            if (!layer || typeof layer.setStyle !== "function") return;
            if (layer === dot) {
              layer.setStyle({ color: getOverlayStrokeColor() });
            } else {
              layer.setStyle({ color: mutedStrokeColor });
            }
          });
        }
      });
    });
    dot.on("mouseout", () => {
      if (typeof step2HoverResetFn === "function") step2HoverResetFn();
      enforceStep2Order();
    });
    dot.on("click", () => {
      const el = typeof dot.getElement === "function" ? dot.getElement() : dot._path;
      const rect = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
      const strokeWidthPx = belongingCircleStrokeWeight(rate);
      const ringSize = Math.max(rect.width, rect.height);
      _emotionSoloReturnToStep2 = true;
      _emotionSoloReturnToStep1FullscreenSpread = false;
      openEmotionMapSoloFromStep1RingReading(i, {
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        color: overlayColor,
        strokeWidthPx,
        pathD: null,
        viewBox: null,
        targetRingSizePx: ringSize > 0 ? ringSize * 1.5 : null,
        shapeParams: {
          index: i,
          phi: 0,
          ampRatio: 0,
          strokeRatio: null,
          strokeWidth: strokeWidthPx,
          strokeWidthPx,
        },
      });
    });
    markerLayer.addLayer(dot);
  }

  markerLayer.addTo(map);
  enforceStep2Order();
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
  if (!step2VectorRenderer) step2VectorRenderer = L.svg();
  polyline = L.polyline(segments, {
    renderer: step2VectorRenderer,
    className: "lifepathStep2Path",
    weight: 1,
    opacity: 1,
    color: overlayColor,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(map);

  if (markerLayer && typeof markerLayer.eachLayer === "function") {
    if (polyline && typeof polyline.bringToBack === "function") polyline.bringToBack();
    markerLayer.eachLayer((layer) => {
      if (layer && typeof layer.bringToFront === "function") layer.bringToFront();
    });
  }
}

function formatHomeNumber(n) {
  const num = Math.max(1, Number(n) || 1);
  return String(num).padStart(2, "0");
}

function getStep1TotalHomesCount() {
  const homesCountEl = document.getElementById("homesCount");
  const typedTotal = parseInt(String(homesCountEl?.value || ""), 10) || 0;
  const enteredTotal = Array.isArray(addresses) ? addresses.length : 0;
  return Math.max(typedTotal, enteredTotal);
}

function getStep1CurrentHomeNumber(totalHomes) {
  if (isStep1EditModeActive()) return Math.min(totalHomes || 1, Math.max(1, _step1EditingIdx + 1));
  const enteredTotal = Array.isArray(addresses) ? addresses.length : 0;
  if (elPageStep1 && elPageStep1.classList.contains("step1-summary-phase")) return Math.max(1, enteredTotal);
  if (totalHomes > 0) return Math.min(totalHomes, enteredTotal + 1);
  return Math.max(1, enteredTotal + 1);
}

function alignStep1TopProgressCounter() {
  if (!elStep1TopProgressSummary) return;
  requestAnimationFrame(() => {
    try {
      const host = elStep1TopProgressSummary.closest(".step1TopProgress");
      const homesEl = elStep1TopProgressSummary.querySelector(".step1TopProgressHomes");
      const hostRect = host?.getBoundingClientRect();
      const homesRect = homesEl?.getBoundingClientRect();
      if (!host || !hostRect || !homesRect || hostRect.width <= 0 || homesRect.width <= 0) return;
      const cssScale = host.offsetWidth > 0 ? hostRect.width / host.offsetWidth : 1;
      const leftPx = (homesRect.left - hostRect.left) / (cssScale || 1);
      host.style.setProperty("--step1-top-progress-counter-left", `${Math.round(leftPx)}px`);
    } catch {
      // ignore
    }
  });
}

function updateStep1TopProgress() {
  if (!elStep1TopProgressSummary || !elStep1TopProgressCounter) return;
  const studentName = String(currentLoadedMapDisplayName || elStudentName?.value || "").trim();
  const totalHomes = getStep1TotalHomesCount();
  if (!studentName && !totalHomes) {
    elStep1TopProgressSummary.textContent = "";
    elStep1TopProgressCounter.textContent = "";
    return;
  }

  const totalText = formatHomeNumber(totalHomes || 1);
  const currentText = formatHomeNumber(getStep1CurrentHomeNumber(totalHomes || 1));
  const isRtlName = /[֐-׿]/.test(studentName);
  const progressText = `\u200e${currentText}/${totalText}\u200e`;
  const isFinished = isStep1DataEntryFinished();
  elStep1TopProgressCounter.dir = "ltr";
  elStep1TopProgressSummary.replaceChildren();
  const nameSpan = document.createElement("span");
  nameSpan.className = "step1TopProgressName";
  nameSpan.textContent = studentName;

  // Editing an already-finished map (via the "edit" button, or by clicking
  // a ring/home in the finished dashboard): "edit" is shown as its own
  // title above the name (#step1EditModeTitle, styled/positioned exactly
  // like .step1MapCompleteTitle -- see styles.css), so this row just needs
  // the name + xx/yy (which home of the total is open).
  if (step1EditModeAfterFinishActive && isStep1EditModeActive()) {
    elStep1TopProgressSummary.dir = isRtlName ? "rtl" : "ltr";
    const spacer = document.createTextNode("    ");
    const homesSpan = document.createElement("span");
    homesSpan.className = "step1TopProgressHomes";
    homesSpan.dir = "ltr";
    homesSpan.textContent = progressText;
    elStep1TopProgressSummary.append(nameSpan, spacer, homesSpan);
    elStep1TopProgressCounter.textContent = "";
    return;
  }

  elStep1TopProgressSummary.dir = isRtlName ? "rtl" : "ltr";
  if (isFinished) {
    elStep1TopProgressSummary.append(nameSpan);
    elStep1TopProgressCounter.textContent = "";
    return;
  }
  const spacer = document.createTextNode("\u00a0\u00a0\u00a0\u00a0");
  const homesSpan = document.createElement("span");
  homesSpan.className = "step1TopProgressHomes";
  homesSpan.dir = "ltr";
  homesSpan.textContent = progressText;
  if (isStep1EditModeActive()) {
    const editSpan = document.createElement("span");
    editSpan.className = "step1TopProgressEdit";
    editSpan.textContent = "edit";
    homesSpan.appendChild(editSpan);
  }
  elStep1TopProgressSummary.append(nameSpan, spacer, homesSpan);
  elStep1TopProgressCounter.textContent = "";
}

function updateStep1Headers() {
  updateStep1TopProgress();
  updateStep1GeoMapNameLabel();

  if (elHomeSummary) {
    const last = addresses.length ? addresses[addresses.length - 1] : null;
    if (!last) {
      elHomeSummary.textContent = "";
    } else {
      const homeNo = formatHomeNumber(addresses.length);
      const label = formatAddress(last);
      const rate = normalizeBelongingRate(last.belonging_rate, stableBelongingRateFromId(last.id));
      elHomeSummary.textContent = `[home no.${homeNo}]\n${label}\nBelonging     ${rate}/10`;
    }
  }
}

function updateStep1GeoMapNameLabel() {
  if (!elStep1GeoMapName) return;
  elStep1GeoMapName.textContent = "";
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

function formatStep2MouseCoordinates(latlng) {
  if (!latlng) return "";
  const lat = Number(latlng.lat);
  const lng = Number(latlng.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  return `${lat.toFixed(5)} : ${lng.toFixed(5)}`;
}

function updateStep2CoordinateLabel(latlng) {
  if (!elCoordinateLabel) return;
  elCoordinateLabel.textContent = formatStep2MouseCoordinates(latlng);
}

map.on("mousemove", (evt) => {
  updateStep2CoordinateLabel(evt && evt.latlng);
});
updateStep2CoordinateLabel(map.getCenter());

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
  ctx.fillStyle = "#f4f2ea";
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
    ctx.fillStyle = "#f4f2ea";
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
let step2VectorRenderer = null;
let step2HoverResetFn = null;
let step2HoverPointerHandler = null;

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
  resetHomeLogoScrollMorph();
  updateBelongingValueLabel();
  scheduleStep1RoutePreviewLayoutUpdate();
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

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    updateStep1Scale();
    updateBelongingValueLabel();
    scheduleStep1RoutePreviewLayoutUpdate();
  }, { passive: true });
}

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

// --step1-scale otherwise stays unset (falling back to 1 in every calc()
// that reads it, e.g. .appLogoImage and .btnImg) until a resize event fires
// or Step 1 is entered -- computing it once here means every page's
// viewport-scaled elements are correctly sized from the very first paint.
updateStep1Scale();

// Default to the home page (logo, tagline, start).
showPage("welcome");

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
  const els = Array.from(document.querySelectorAll(".brand, .life-path, .appLogoImage"));
  const resetProcessAndGoHome = () => {
    try {
      resetForNextStudent();
      setStatus("");
      setAddressStatus("");
    } catch {
      // ignore
    }
    step2OpenedFromArchive = false;
    setStep2CloseReturnPage("step1");
    showPage("welcome");
  };

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

    el.addEventListener("click", resetProcessAndGoHome);

    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        resetProcessAndGoHome();
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
        setStep2CloseReturnPage("step1");
        showPage("archive");
        return;
      }

      // Default: close to whichever "home base" page (Step 1 or the home
      // page) was last active — preserving whatever is there, e.g. returning
      // from viewing your own just-created map should land back on the exact
      // same Step 1 page (name, addresses, emotion map still in place), not
      // reset it as if for the next student. Archive/All Maps opened from
      // the home page close back to the home page instead of Step 1.
      setStep2CloseReturnPage("step1");
      showPage(_lastPrimaryPageKey, { scroll: "step1", behavior: "auto" });
    });
  }
}

wireCloseToHomeButtons();


if (elStudentName) {
  elStudentName.addEventListener("input", () => {
    const before = String(elStudentName.value || "");
    const after = sanitizeEnglishOnlyName(before);
    if (after !== before) {
      const pos = elStudentName.selectionStart;
      elStudentName.value = after;
      const newPos = Math.min(pos, after.length);
      elStudentName.setSelectionRange(newPos, newPos);
    }
    currentLoadedMapDisplayName = "";

    // Keep postcard/Step 2 labels in sync while editing.
    try {
      updateStep2SignatureLabel();
      updateStep2ReadingInfo();
      updatePostcardCardMapName();
      updateStep1GeoMapNameLabel();
      updateStep1TopProgress();
    } catch {
      // ignore
    }
  });
}

const elHomesCount = document.getElementById("homesCount");
const elStep1NextBtn = document.getElementById("step1NextBtn");

function updateStep1NextBtnState() {
  if (!elStep1NextBtn) return;
  const nameOk = Boolean(String(elStudentName?.value || "").trim());
  const homesOk = Boolean(String(elHomesCount?.value || "").trim());
  elStep1NextBtn.classList.toggle("active", nameOk && homesOk);
}

const elStartYear = document.getElementById("startYear");

function isValidStartYear(val) {
  const s = String(val || "").trim();
  if (!/^\d{4}$/.test(s)) return false;
  const n = parseInt(s, 10);
  return n >= 1900 && n <= new Date().getFullYear();
}

if (elStartYear) {
  elStartYear.addEventListener("input", () => {
    elStartYear.value = elStartYear.value.replace(/[^0-9]/g, "").slice(0, 4);
    if (elStartYear.value.length === 4 && !isValidStartYear(elStartYear.value)) {
      elStartYear.classList.add("address-error");
    } else {
      elStartYear.classList.remove("address-error");
    }
    if (updateStep1EditPreviewFromFields()) {
      updateStep1GeoMapMarkers();
      updateAllEmotionRingAngles();
    }
  });
}

function renderStep1PlaceholderEmotionRings() {
  if (!elStep1EmotionSvg) return;
  stopEmotionTickSounds();
  _activeEmotionRings.length = 0;
  while (elStep1EmotionSvg.firstChild) elStep1EmotionSvg.removeChild(elStep1EmotionSvg.firstChild);

  const count = parseInt(String(elHomesCount?.value || ""), 10);
  // Show/hide placeholder text based on whether rings will be drawn.
  const placeholderText = document.getElementById("step1EmotionPlaceholderText");
  if (placeholderText) placeholderText.style.display = (count && count >= 1) ? "none" : "";
  if (!count || count < 1) return;
  const n = Math.min(count, 50);

  const vbW = 1000;
  const vbH = 620;
  elStep1EmotionSvg.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);

  const cx = vbW / 2;
  const cy = vbH / 2;
  const strokeW = 1.5;
  const padding = 20;
  // Small maps (5 homes or fewer) read as needlessly sparse at full size --
  // draw them 20% smaller than the usual fit-to-canvas size. Large maps (11+
  // rings) get drawn 10% bigger instead -- ring positions only, stroke
  // widths are untouched either way.
  const mapSizeScale = n <= 5 ? 0.8 : (n >= 11 ? 1.1 : 1);
  let maxR = (Math.min(cx, cy) - padding) * mapSizeScale;
  // Safety: for very large home counts, the 10% growth above could push the
  // outermost ring (plus its stroke) past the SVG's edge -- cap it so that
  // never happens.
  const safeOuterEdge = Math.min(cx, cy) - 10;
  const maxRForSafeEdge = (safeOuterEdge - strokeW / 2) * (n + 1) / n;
  maxR = Math.min(maxR, maxRForSafeEdge);
  const gap = maxR / (n + 1);

  for (let i = 0; i < n; i++) {
    const r = gap * (i + 1);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", "#c9c8c1");
    circle.setAttribute("stroke-width", String(strokeW));
    circle.style.transformOrigin = `${cx}px ${cy}px`;
    circle.style.animation = `emotionRingGrow 0.35s ease-out ${i * 0.07}s both`;
    elStep1EmotionSvg.appendChild(circle);
  }
}

function colorEmotionRing(index) {
  if (!elStep1EmotionSvg) return;
  const circles = elStep1EmotionSvg.querySelectorAll("circle");
  if (index < circles.length) {
    circles[index].setAttribute("stroke", "#000000");
  }
}

// Store active ring data so angles can be updated when new homes are added.
const _activeEmotionRings = [];

function restartStep1EmotionTickSounds() {
  if (!EMOTION_ENTRY_SOUND_ENABLED) {
    stopEmotionTickSounds();
    return;
  }
  const activeRings = _activeEmotionRings
    .filter((ring) => ring && ring.path && ring.path.parentNode)
    .sort((a, b) => (Number(a.idx) || 0) - (Number(b.idx) || 0));
  const tickRings = activeRings.filter((ring) => {
    const rate = Math.round(Number(ring.rate) || 0);
    return rate >= 1 && rate <= 4;
  });
  if (!tickRings.length) {
    stopEmotionTickSounds();
    return;
  }
  try {
    ensureEmotionAudioReady();
    for (let rate = 1; rate <= 4; rate++) void ensureTickBuffer(rate);
  } catch {
    // ignore
  }
  scheduleEmotionTickSoundsForRings({
    n: tickRings.length,
    rates: tickRings.map((ring) => Math.round(Number(ring.rate) || 1)),
    getRingVolume: () => clamp(0.34 / Math.sqrt(Math.max(1, tickRings.length)), 0.05, 0.30),
  });
}

// Each home added during entry gets its own persistent, never-replaced
// looping <audio> (see the EMOTION_ENTRY_SOUND_ENABLED block a few hundred
// lines below) — by design they layer on top of each other while you're
// still building the map. Once the map is finished, the "official" ambient
// system (_emotionSoundRings / startEmotionSound(), driving the finished map
// and its fullscreen page) takes over — but nothing ever stopped *these*
// entry-phase loops, so they kept playing underneath it forever, and
// "start over" left them running across a whole new map too. Call this
// (not the pause-based helper below, which is for the temporary old
// single-ring solo page) wherever the map is finished or discarded.
function stopStep1EntrySound() {
  const loops = window._step1RingLoops;
  if (Array.isArray(loops)) {
    for (const a of loops) {
      try {
        a.pause();
      } catch {
        // ignore
      }
      try {
        if ("currentTime" in a) a.currentTime = 0;
      } catch {
        // ignore
      }
    }
  }
  window._step1RingLoops = [];
}

// Solos one home's entry-phase loop (see EMOTION_ENTRY_SOUND_ENABLED below)
// by volume alone — index null restores every loop to its own original
// volume. This is the array that's actually audible on the finished map and
// its fullscreen page (see stopStep1EntrySound()'s comment on why
// renderStep1EmotionMap()'s separate _emotionSoundRings system doesn't run
// in the active finish flow), so ring-hover focus needs to act on *this*,
// not (only) setEmotionSoundFocus()'s _emotionSoundRings.
function setStep1EntrySoundFocus(index) {
  const loops = window._step1RingLoops;
  if (!Array.isArray(loops)) return;
  loops.forEach((a, i) => {
    if (!a) return;
    if (a.__lpBaseVolume === undefined) a.__lpBaseVolume = a.volume;
    try {
      a.volume = index == null || i === index ? a.__lpBaseVolume : 0;
    } catch {
      // ignore
    }
  });
}

// The solo ring page is its own separate page — its own sound (once that's
// specified) shouldn't play alongside Step 1's entry-phase ring sounds.
// Pausing (not stopping) each <audio> keeps its position, so resuming just
// picks back up rather than restarting from 0.
function pauseStep1EntrySoundForSolo() {
  const loops = window._step1RingLoops;
  if (Array.isArray(loops)) {
    for (const a of loops) {
      try {
        a.pause();
      } catch {
        // ignore
      }
    }
  }
  stopEmotionTickSounds();
}

function resumeStep1EntrySoundFromSolo() {
  if (!EMOTION_ENTRY_SOUND_ENABLED) return;
  const loops = window._step1RingLoops;
  if (Array.isArray(loops)) {
    for (const a of loops) {
      try {
        void a.play().catch(() => {});
      } catch {
        // ignore
      }
    }
  }
  restartStep1EmotionTickSounds();
}

let _emotionSoloRingAudio = null;

// Opening a ring in solo plays *only* that ring's own matching sound — no
// tick, nothing from any other ring. ringIdx matches the same 0-based,
// home-order indexing used everywhere else (getStep1EmotionAddresses()[idx]).
function startEmotionSoundForSoloRing(ringIdx) {
  stopEmotionSoundForSoloRing();
  if (!EMOTION_SOLO_SOUND_ENABLED) return;
  const validAddrs = getStep1EmotionAddresses();
  const addr = validAddrs[Math.max(0, Math.floor(Number(ringIdx) || 0))];
  if (!addr) return;
  try {
    const rate = normalizeBelongingRate(addr.belonging_rate, stableBelongingRateFromId(addr.id));
    const innerCount = Math.max(1, Math.ceil(validAddrs.length * EMOTION_SOUND_CONFIG.innerFraction));
    const isInner = ringIdx < innerCount;
    const src = emotionLoopSrcByRingAndRate(isInner, rate, ringIdx + 1);
    if (!src) return;
    ensureEmotionAudioReady();
    const audio = new Audio(src);
    audio.loop = true;
    audio.volume = EMOTION_ENTRY_RING_VOLUME;
    void audio.play().catch(() => {});
    _emotionSoloRingAudio = audio;
  } catch {
    // ignore
  }
}

function stopEmotionSoundForSoloRing() {
  if (_emotionSoloRingAudio) {
    try {
      _emotionSoloRingAudio.pause();
    } catch {
      // ignore
    }
    _emotionSoloRingAudio = null;
  }
}

function updateAllEmotionRingAngles() {
  const validAddrs = getStep1DisplayValidAddresses();
  const totalExpected = Math.max(validAddrs.length, parseInt(String(elHomesCount?.value || ""), 10) || 1);
  const ringGap = 290 / (totalExpected + 1);

  for (const ring of _activeEmotionRings) {
    if (!ring.path.parentNode) continue;
    const addr = validAddrs[ring.idx];
    if (!addr) continue;
    const rate = normalizeBelongingRate(addr.belonging_rate, stableBelongingRateFromId(addr.id));

    const newPhi = addr && isFinite(addr.lat) && isFinite(addr.lon)
      ? step1EmotionAngleForAddress(addr, ring.idx, validAddrs) : 0;
    const maxAmp = ringGap * 0.4;
    const rawAmp = distortionAmplitudeFromBelonging(rate, ring.r) * 0.7;
    const newAmp = Math.max(-maxAmp, Math.min(maxAmp, rawAmp));
    const newSW = emotionRingStrokeWeight(rate);

    // Animate smoothly from old phi/amp to new phi/amp.
    // Normalize the angle difference to take the shortest path (no full rotations).
    const oldPhi = ring.phi;
    const oldAmp = ring.amp;
    let dPhi = newPhi - oldPhi;
    // Wrap to [-PI, PI] so we always rotate the short way.
    while (dPhi > Math.PI) dPhi -= Math.PI * 2;
    while (dPhi < -Math.PI) dPhi += Math.PI * 2;
    const targetPhi = oldPhi + dPhi;
    const targetAmp = newAmp;
    const duration = 1500;
    const startTime = performance.now();
    ring.rate = rate;

    ring._transition = { oldPhi, oldAmp, targetPhi, targetAmp, startTime, duration, oldSW: ring.sw, targetSW: newSW };
  }
  restartStep1EmotionTickSounds();
}

function activateEmotionRing(ringIdx) {
  if (!elStep1EmotionSvg) return;
  const ringsGroup = elStep1EmotionSvg.querySelector("[data-layer='step1-emotion-rings']");
  const container = ringsGroup || elStep1EmotionSvg;
  const allRings = Array.from(container.children).filter(
    (el) => el.tagName === "circle" || el.tagName === "path"
  );
  if (ringIdx >= allRings.length) return;

  const target = allRings[ringIdx];
  // Only activate circles (placeholders). If already a path, it's already activated.
  if (target.tagName !== "circle") return;

  const circle = target;
  const r = parseFloat(circle.getAttribute("r")) || 1;
  const svgCx = parseFloat(circle.getAttribute("cx")) || 500;
  const svgCy = parseFloat(circle.getAttribute("cy")) || 310;

  const validAddrs = (Array.isArray(addresses) ? addresses : []).filter((a) => a && a.valid !== false);
  const addr = validAddrs[ringIdx];
  if (!addr) return;

  const rate = normalizeBelongingRate(addr.belonging_rate, stableBelongingRateFromId(addr.id));
  const sw = emotionRingStrokeWeight(rate);
  const phi = addr && isFinite(addr.lat) && isFinite(addr.lon)
    ? step1EmotionAngleForAddress(addr, ringIdx, validAddrs) : 0;
  // Clamp distortion so rings don't touch — max amplitude is half the gap between rings.
  const totalExpected = Math.max(validAddrs.length, parseInt(String(elHomesCount?.value || ""), 10) || 1);
  const ringGap = 290 / (totalExpected + 1);
  const maxAmp = ringGap * 0.4;
  const rawAmp = distortionAmplitudeFromBelonging(rate, r) * 0.7;
  const amp = Math.max(-maxAmp, Math.min(maxAmp, rawAmp));
  const opts = ringDistortionOptsForAmp(amp, ringIdx * 7.1);
  const d = buildDistortedRingPath(svgCx, svgCy, r, phi, amp, opts);

  // Replace the circle with a path — start at circle shape.
  const NS = "http://www.w3.org/2000/svg";
  const path = document.createElementNS(NS, "path");
  const startSW = parseFloat(circle.getAttribute("stroke-width")) || 1.5;
  const startD = buildDistortedRingPath(svgCx, svgCy, r, 0, 0);
  path.setAttribute("d", startD);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#000000");
  path.setAttribute("stroke-width", String(startSW));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  // Invisible hit path with larger stroke-width for better hover sensitivity.
  const hitPath = document.createElementNS(NS, "path");
  hitPath.setAttribute("d", startD);
  hitPath.setAttribute("fill", "none");
  hitPath.setAttribute("stroke", "transparent");
  hitPath.setAttribute("stroke-width", "14");
  hitPath.setAttribute("pointer-events", "stroke");
  hitPath.setAttribute("data-hit", "1");
  hitPath.setAttribute("data-ring-idx", String(ringIdx));

  const parent = circle.parentNode;
  if (parent) {
    parent.replaceChild(path, circle);
    parent.appendChild(hitPath);
  }

  // This ring's own sound starts now and keeps playing, layered on top of
  // every previously-added ring's sound (each one gets its own persistent
  // <audio>, never stopped/replaced here) — the file itself comes from the
  // same ring-to-sound matching rules used everywhere else.
  if (EMOTION_ENTRY_SOUND_ENABLED) try {
    const totalRings = Math.max(validAddrs.length, parseInt(String(elHomesCount?.value || ""), 10) || 1);
    const innerCount = Math.max(1, Math.ceil(totalRings * EMOTION_SOUND_CONFIG.innerFraction));
    const isInner = ringIdx < innerCount;
    const src = emotionLoopSrcByRingAndRate(isInner, rate, ringIdx + 1);
    if (src) {
      ensureEmotionAudioReady();
      const loopAudio = new Audio(src);
      loopAudio.loop = true;
      loopAudio.volume = EMOTION_ENTRY_RING_VOLUME;
      void loopAudio.play().catch(() => {});
      if (!window._step1RingLoops) window._step1RingLoops = [];
      window._step1RingLoops.push(loopAudio);
    }
  } catch {}

  // Store ring data starting at (phi=0, amp=0) — the breathe loop will morph to target.
  const ringData = { path, hitPath, idx: ringIdx, r, rate, phi: 0, amp: 0, sw: startSW, cx: svgCx, cy: svgCy };
  _activeEmotionRings.push(ringData);

  // Set initial transition: from circle (0,0) to distorted (phi, amp), also interpolate stroke-width.
  const morphDuration = 1200;
  ringData._transition = {
    oldPhi: 0, oldAmp: 0, targetPhi: phi, targetAmp: amp,
    oldSW: startSW, targetSW: sw,
    startTime: performance.now(), duration: morphDuration,
  };

  // Start breathing for this ring — handles morph + ongoing transitions + breathing.
  const period = 4000;
  const t0 = performance.now();
  const breathe = (now) => {
    let curPhi = ringData.phi;
    let curAmpBase = ringData.amp;
    let curSW = ringData.sw;
    if (ringData._transition) {
      const tr = ringData._transition;
      const tElapsed = now - tr.startTime;
      const tProgress = Math.min(1, tElapsed / tr.duration);
      const ease = tProgress < 0.5 ? 4 * tProgress * tProgress * tProgress : 1 - Math.pow(-2 * tProgress + 2, 3) / 2;
      curPhi = tr.oldPhi + (tr.targetPhi - tr.oldPhi) * ease;
      curAmpBase = tr.oldAmp + (tr.targetAmp - tr.oldAmp) * ease;
      if (tr.oldSW !== undefined) {
        curSW = tr.oldSW + (tr.targetSW - tr.oldSW) * ease;
        ringData.path.setAttribute("stroke-width", String(curSW));
      }
      if (tProgress >= 1) {
        ringData.phi = tr.targetPhi;
        ringData.amp = tr.targetAmp;
        ringData.sw = tr.targetSW !== undefined ? tr.targetSW : curSW;
        ringData._transition = null;
      }
    }

    const elapsed = now - t0;
    const speedF = 1 + (ringData.rate - 5) * 0.05;
    const phase = (elapsed / period) * Math.PI * 2 * speedF;
    const breathAmp = ringData.r * 0.04 * (ringData.rate / 10);
    const curR = ringData.r + breathAmp * Math.sin(phase);
    const curD = buildDistortedRingPath(ringData.cx, ringData.cy, curR, curPhi, curAmpBase, ringDistortionOptsForAmp(curAmpBase, ringData.idx * 7.1));
    ringData.path.setAttribute("d", curD);
    if (ringData.hitPath) ringData.hitPath.setAttribute("d", curD);
    if (ringData.path.parentNode) requestAnimationFrame(breathe);
  };
  requestAnimationFrame(breathe);
  restartStep1EmotionTickSounds();
}

function colorCurrentEmotionRing() {
  if (!elStep1EmotionSvg) return;
  // Get all ring elements (paths from activated rings + circles from placeholders)
  // in DOM order, which matches home order.
  const ringsGroup = elStep1EmotionSvg.querySelector("[data-layer='step1-emotion-rings']");
  const container = ringsGroup || elStep1EmotionSvg;
  const allRings = Array.from(container.children).filter(
    (el) => el.tagName === "circle" || el.tagName === "path"
  );
  const currentIdx = Array.isArray(addresses) ? addresses.length : 0;
  if (currentIdx < allRings.length) {
    const ring = allRings[currentIdx];
    ring.setAttribute("stroke", "#000000");
  }
}

function updateEmotionRingColors() {
  if (!elStep1EmotionSvg) return;
  const circles = elStep1EmotionSvg.querySelectorAll("circle");
  const savedCount = Array.isArray(addresses) ? addresses.length : 0;
  const hasPreview = Boolean(step1PendingPreviewAddress);
  const blackCount = savedCount + (hasPreview ? 1 : 0);
  circles.forEach((c, i) => {
    c.setAttribute("stroke", i < blackCount ? "#000000" : "#c9c8c1");
  });
}

function getStep1EmotionDisplayRings() {
  if (!elStep1EmotionSvg) return [];
  return Array.from(elStep1EmotionSvg.querySelectorAll(
    "circle[fill='none']:not([data-hit]), path[fill='none']:not([data-hit])"
  ));
}

function restoreStep1EmotionRingColors() {
  const rings = getStep1EmotionDisplayRings();
  const savedCount = Array.isArray(addresses) ? addresses.length : 0;
  rings.forEach((ring, idx) => {
    const isSaved = ring.tagName === "path" || idx < savedCount;
    ring.setAttribute("stroke", isSaved ? "#000000" : "#c9c8c1");
  });
}

function setStep1EmotionEditFocus(idx = _step1EditingIdx) {
  const rings = getStep1EmotionDisplayRings();
  const hasFocus = isStep1EditModeActive() && idx >= 0 && idx < rings.length;
  if (!hasFocus) {
    restoreStep1EmotionRingColors();
    return;
  }
  rings.forEach((ring, ringIdx) => {
    ring.setAttribute("stroke", ringIdx === idx ? "#000000" : "#c3c1b7");
  });
}

function isStep1EditModeActive() {
  return _step1EditingIdx >= 0 && Array.isArray(addresses) && _step1EditingIdx < addresses.length;
}

function getStep1EditDataFields() {
  return [elCountry, elCity, elStreetAndNumber, elStartYear, elBelongingInline].filter(Boolean);
}

function setStep1EditFieldActive(field) {
  if (!field) return;
  for (const item of getStep1EditDataFields()) {
    try {
      item.classList.toggle("step1EditFieldActive", item === field);
      const group = item.closest(".group-2");
      if (group) group.classList.toggle("step1EditFieldActive", item === field);
    } catch {
      // ignore
    }
  }
}

function clearStep1EditFieldActive() {
  for (const item of getStep1EditDataFields()) {
    try {
      item.classList.remove("step1EditFieldActive");
      const group = item.closest(".group-2");
      if (group) group.classList.remove("step1EditFieldActive");
    } catch {
      // ignore
    }
  }
}

function armStep1EditFieldActivation() {
  for (const field of getStep1EditDataFields()) {
    if (field.__step1EditActivationReady) continue;
    field.__step1EditActivationReady = true;
    const activate = () => {
      if (_step1EditingIdx < 0) return;
      setStep1EditFieldActive(field);
    };
    field.addEventListener("pointerdown", activate, { passive: true });
    field.addEventListener("focus", activate, { passive: true });
    field.addEventListener("input", activate, { passive: true });
  }
}

// Clicking a ring/dot that maps to a specific home during data entry
// (before finishing): an already-entered home opens for editing as before.
// The very next one still awaiting entry (its placeholder ring/dot, not
// committed yet) has nothing saved to load -- clicking it instead just
// brings focus to the form so typing can continue from there.
function handleStep1RingClick(ringIdx) {
  const isNextUnfilled = !isStep1EditModeActive()
    && !isStep1DataEntryFinished()
    && ringIdx === (Array.isArray(addresses) ? addresses.length : 0);
  if (isNextUnfilled) {
    if (elCity) elCity.focus({ preventScroll: true });
    return;
  }
  openStep1HomeEditMode(ringIdx);
}

function openStep1HomeEditMode(ringIdx) {
  if (ringIdx < 0 || ringIdx >= (Array.isArray(addresses) ? addresses.length : 0)) return;

  const addr = addresses[ringIdx];
  if (!addr) return;

  const divAddr = elPageStep1 && elPageStep1.querySelector(".div-3 > .div-2");
  if (divAddr && divAddr.style.display === "none") divAddr.style.display = "";
  if (elAddHomeBtn && elAddHomeBtn.style.display === "none") elAddHomeBtn.style.display = "";

  if (elCountry) elCountry.value = addr._origCountry || addr.country || "";
  if (elCity) elCity.value = addr._origCity || addr.city || "";
  const origStreetAndNumber = addr._origStreetAndNumber
    || [addr._origStreet || addr.street, addr._origNumber || addr.number].filter(Boolean).join(" ");
  if (elStreetAndNumber) elStreetAndNumber.value = origStreetAndNumber;
  if (elStreet) elStreet.value = addr._origStreet || addr.street || "";
  if (elNumber) elNumber.value = addr._origNumber || addr.number || "";
  if (elStartYear) elStartYear.value = addr.startYear || "";

  const rate = normalizeBelongingRate(addr.belonging_rate);
  if (elBelongingInline) {
    elBelongingInline.value = String(rate);
    elBelongingInline.dispatchEvent(new Event("input"));
  }

  currentAddressVerified = true;
  step1PendingPreviewAddress = {
    id: addr.id || "step1-preview",
    ...addr,
    belonging_rate: normalizeBelongingRate(addr.belonging_rate),
  };

  enterStep1EditMode(ringIdx);
  if (isFinite(addr.lat) && isFinite(addr.lon)) {
    focusStep1GeoMapAt(addr.lat, addr.lon, 15.5, { animate: true });
  }
  updateStep1AddrNextBtnState();
}

(function setupStep1EmotionHover() {
  if (!elStep1EmotionSvg) return;

  // Tooltip element.
  const tooltip = document.createElement("div");
  tooltip.style.cssText = "position:fixed;pointer-events:none;font-family:'NarkissBlock-Light-TRIAL',sans-serif;font-size:16px;color:#000000;white-space:nowrap;display:none;z-index:9000;text-transform:none;";
  document.body.appendChild(tooltip);

  function getRings() {
    return getStep1EmotionDisplayRings();
  }

  function restoreColors() {
    if (isStep1EditModeActive()) setStep1EmotionEditFocus();
    else restoreStep1EmotionRingColors();
    tooltip.style.display = "none";
  }

  elStep1EmotionSvg.addEventListener("mousemove", (e) => {
    if (areStep1MapSpecificInteractionsDisabled()) {
      restoreColors();
      return;
    }
    if (tooltip.style.display !== "none") {
      tooltip.style.left = (e.clientX + 14) + "px";
      tooltip.style.top = (e.clientY - 8) + "px";
    }
  }, { passive: true });

  elStep1EmotionSvg.addEventListener("mouseover", (e) => {
    if (areStep1MapSpecificInteractionsDisabled()) {
      restoreColors();
      return;
    }
    let target = e.target;
    // Resolve hit path → visual path.
    if (target.getAttribute("data-hit") === "1") {
      const idx = parseInt(target.getAttribute("data-ring-idx") || "0", 10);
      const rings = getRings();
      target = rings[idx] || null;
    }
    if (!target || target.tagName !== "path" || target.getAttribute("fill") !== "none") return;

    const rings = getRings();
    const ringIdx = rings.indexOf(target);
    rings.forEach(el => {
      el.setAttribute("stroke", el === target ? "#000000" : "#c3c1b7");
    });

    // Show tooltip.
    if (ringIdx >= 0) {
      const num = ringIdx + 1;
      const label = num < 10 ? `0${num}` : String(num);
      const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--step1-scale")) || 1;
      tooltip.style.fontSize = (16 * scale) + "px";
      tooltip.textContent = `home ${label}`;
      tooltip.style.left = (e.clientX + 14) + "px";
      tooltip.style.top = (e.clientY - 8) + "px";
      tooltip.style.display = "block";
    }
  }, { passive: true });

  elStep1EmotionSvg.addEventListener("mouseleave", restoreColors, { passive: true });

  elStep1EmotionSvg.addEventListener("click", (e) => {
    if (areStep1MapSpecificInteractionsDisabled()) {
      restoreColors();
      return;
    }
    let target = e.target;
    let ringIdx = -1;

    if (target.getAttribute("data-hit") === "1") {
      ringIdx = parseInt(target.getAttribute("data-ring-idx") || "-1", 10);
    } else {
      const rings = getRings();
      ringIdx = rings.indexOf(target);
    }

    handleStep1RingClick(ringIdx);
  });
})();

if (elHomesCount) {
  elHomesCount.addEventListener("input", () => {
    elHomesCount.value = elHomesCount.value.replace(/[^0-9]/g, "");
    updateStep1NextBtnState();
    updateStep1TopProgress();
    renderStep1PlaceholderEmotionRings();
  });
}

if (elStudentName) {
  elStudentName.addEventListener("input", () => {
    updateStep1NextBtnState();
    updateStep1TopProgress();
  });
}

// Intro screen (name + homes count): Enter acts like clicking "next" — the
// button's own click handler already no-ops unless .active (both fields
// filled), so this can't skip that validation.
if (elStudentName) {
  elStudentName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") elStep1NextBtn?.click();
  });
}
if (elHomesCount) {
  elHomesCount.addEventListener("keydown", (e) => {
    if (e.key === "Enter") elStep1NextBtn?.click();
  });
}

function step1TransitionPhase(removePhase, addPhase, callback) {
  if (!elPageStep1) { if (callback) callback(); return; }
  const form = elPageStep1.querySelector(".div");
  if (form) {
    form.style.transition = "opacity 0.25s ease-out";
    form.style.opacity = "0";
  }
  setTimeout(() => {
    if (removePhase) elPageStep1.classList.remove(removePhase);
    if (addPhase) elPageStep1.classList.add(addPhase);
    updateStep1TopProgress();
    if (callback) callback();
    if (form) {
      form.style.opacity = "1";
      form.style.transition = "opacity 0.35s ease-in";
    }
  }, 250);
}

if (elStep1NextBtn) {
  elStep1NextBtn.addEventListener("click", () => {
    if (!elStep1NextBtn.classList.contains("active")) return;
    // This button now lives on the home page (screen 2), not on #pageStep1
    // itself -- navigate there first, then transition straight into the
    // address-entry phase (Step 1's own name/count intro screen no longer
    // exists, since these two fields are answered here instead).
    showPage("step1");
    step1TransitionPhase(null, "step1-address-phase", () => {
      // The map container was hidden during intro — recalculate size and fit Israel.
      setTimeout(() => {
        ensureStep1GeoMap();
        if (step1GeoMap) {
          step1GeoMap.invalidateSize(false);
          step1GeoMap.fitBounds(ISRAEL_BOUNDS.pad(ISRAEL_FIT_PADDING), {
            animate: false,
            paddingTopLeft: [0, -20],
            paddingBottomRight: [0, -80],
          });
        }
      }, 50);
      const firstField = document.getElementById("country");
      if (firstField) firstField.focus({ preventScroll: true });
      // Color the first ring after the map settles.
      setTimeout(colorCurrentEmotionRing, 500);
      // Preload tick sounds (user gesture context).
      try {
        ensureEmotionAudioReady();
        for (let tr = 1; tr <= 4; tr++) ensureTickBuffer(tr);
      } catch {}
      updateStep1TimeBelonging();
      updateStep1PanelStats();
      updateStep1JourneyTimeline();
      updateStep1HomesList();
      setTimeout(() => {
        if (elBelongingInlineValue) {
          elBelongingInlineValue.textContent = "01";
          elBelongingInlineValue.style.left = "8px";
        }
      }, 50);
    });
  });
}

const elStep1AddrNextBtn = document.getElementById("step1AddrNextBtn");

function updateStep1AddrNextBtnState() {
  if (elStep1AddrNextBtn) {
    const country = String(elCountry?.value || "").trim();
    const city = String(elCity?.value || "").trim();
    const street = String(elStreet?.value || "").trim();
    const number = String(elNumber?.value || "").trim();
    const year = String(elStartYear?.value || "").trim();
    const allFilled = Boolean(country && city && street && isValidStartYear(year));
    elStep1AddrNextBtn.classList.toggle("active", allFilled);
  }
  const countryForHint = String(elCountry?.value || "").trim();
  const addressHintPlaceholder = countryForHint === "ישראל" ? "בעברית" : "English";
  if (elCity) elCity.placeholder = addressHintPlaceholder;
  const elStreetAndNumberField = document.getElementById("streetAndNumber");
  if (elStreetAndNumberField) elStreetAndNumberField.placeholder = addressHintPlaceholder;
  if (typeof updateAddHomeBtnState === "function") updateAddHomeBtnState();
}

function enterStep1EditMode(idx) {
  _step1EditingIdx = idx;
  if (elPageStep1) elPageStep1.classList.add("step1-edit-mode");
  armStep1EditFieldActivation();
  clearStep1EditFieldActive();
  try {
    if (document.activeElement && typeof document.activeElement.blur === "function") document.activeElement.blur();
  } catch {
    // ignore
  }
  if (elStep1AddrNextBtn) elStep1AddrNextBtn.textContent = "SAVE";
  updateStep1TopProgress();
  updateStep1RoutePreview();
  updateStep1RingReading();
  updateStep1HomesList();
  setStep1RoutePreviewEditFocus(idx);
  setStep1RingReadingEditFocus(idx);
  setStep1HomesListFocus(idx);
  setStep1EmotionEditFocus(idx);
  fitStep1GeoMapToIsraelBoundaries({ animate: true });
  if (typeof updateAddHomeBtnState === "function") updateAddHomeBtnState();
}

function exitStep1EditMode(opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  _step1EditingIdx = -1;
  if (elPageStep1) elPageStep1.classList.remove("step1-edit-mode");
  clearStep1EditFieldActive();
  if (elStep1AddrNextBtn) elStep1AddrNextBtn.textContent = "NEXT";
  setStep1RoutePreviewEditFocus(-1);
  setStep1RingReadingEditFocus(-1);
  setStep1HomesListFocus(-1);
  setStep1EmotionEditFocus(-1);
  if (!options.keepGeoFocus) fitStep1GeoMapToIsraelBoundaries({ animate: true });
  updateStep1Headers();
  if (typeof updateAddHomeBtnState === "function") updateAddHomeBtnState();
}

if (elCountry) elCountry.addEventListener("input", updateStep1AddrNextBtnState);
if (elCity) elCity.addEventListener("input", updateStep1AddrNextBtnState);
if (elStreet) elStreet.addEventListener("input", updateStep1AddrNextBtnState);
if (elNumber) elNumber.addEventListener("input", updateStep1AddrNextBtnState);
if (elStartYear) elStartYear.addEventListener("input", updateStep1AddrNextBtnState);

// Set the initial City / Street,number placeholder without calling
// updateStep1AddrNextBtnState() this early (it also calls
// updateAddHomeBtnState(), which reads elAddHomeBtn — a const declared
// further down the file, so calling it here would throw).
(function initAddressHintPlaceholder() {
  const countryForHint = String(elCountry?.value || "").trim();
  const hint = countryForHint === "ישראל" ? "בעברית" : "English";
  if (elCity) elCity.placeholder = hint;
  const streetAndNumberField = document.getElementById("streetAndNumber");
  if (streetAndNumberField) streetAndNumberField.placeholder = hint;
})();

const elStep1AddrBackBtn = document.getElementById("step1AddrBackBtn");
if (elStep1AddrBackBtn) {
  elStep1AddrBackBtn.addEventListener("click", () => {
    // Same reasoning as step1GoBackToIntro(): the intro state this used to
    // reveal no longer has the name/homes-count fields, so return to the
    // home page (screen 2) instead.
    if (elPageStep1) elPageStep1.classList.remove("step1-address-phase");
    showPage("welcome", { welcomeScroll: "screen2" });
  });
}

// Address NEXT → save address, then next home or finish
if (elStep1AddrNextBtn) {
  elStep1AddrNextBtn.addEventListener("click", async () => {
    if (!elStep1AddrNextBtn.classList.contains("active")) return;
    if (!currentAddressVerified || !step1PendingPreviewAddress) {
      // Verification hasn't completed yet — register interest and let it auto-proceed when done.
      if (_step1NextAfterVerify) return; // already waiting; don't restart the verification chain
      _step1NextAfterVerify = true;
      if (verifyAddressDebounceId) {
        window.clearTimeout(verifyAddressDebounceId);
        verifyAddressDebounceId = 0;
      }
      verifyCurrentAddress();
      return;
    }
    _step1NextAfterVerify = false;

    const editingIdx = _step1EditingIdx;

    const belongingVal = elBelongingInline ? elBelongingInline.value : (elBelongingRate ? elBelongingRate.value : "1");

    const address = {
      id: editingIdx >= 0 && addresses[editingIdx] ? addresses[editingIdx].id : cryptoId(),
      country: getValue("country"),
      state: getValue("state"),
      city: getValue("city"),
      street: getValue("street"),
      number: getValue("number"),
      startYear: String(elStartYear?.value || "").trim(),
      belonging_rate: normalizeBelongingRate(belongingVal),
      valid: true,
      _origCountry: getValue("country"),
      _origCity: getValue("city"),
      _origStreet: getValue("street"),
      _origNumber: getValue("number"),
      _origStreetAndNumber: String(elStreetAndNumber?.value || "").trim(),
    };

    const prev = step1PendingPreviewAddress;
    if (!prev) return;
    address.lat = prev.lat;
    address.lon = prev.lon;
    address.displayName = prev.displayName || "";

    // Reviewing/re-saving homes one at a time after finish (see "edit"):
    // stay in edit mode and advance to the next ring below instead of
    // exiting immediately, unless this is the last ring in the review.
    const isAfterFinishEdit = step1EditModeAfterFinishActive && editingIdx >= 0;
    const isLastInAfterFinishReview = isAfterFinishEdit && editingIdx >= addresses.length - 1;
    if (!isAfterFinishEdit || isLastInAfterFinishReview) {
      // Plain new-address save (editingIdx < 0): keep the geo map focused on
      // the address just entered instead of zooming out to fit the whole
      // route -- that only happens on Finish. Actual ring edits (editingIdx
      // >= 0) keep the existing "zoom back out" behavior.
      exitStep1EditMode(editingIdx < 0 ? { keepGeoFocus: true } : undefined);
    }

    const lastHome = editingIdx >= 0
      ? (addresses.length >= (parseInt(String(elHomesCount?.value || ""), 10) || 0))
      : isLastHome();

    if (editingIdx >= 0 && editingIdx < addresses.length) {
      addresses[editingIdx] = address;
    } else {
      addresses.push(address);
    }
    saveJson(STORAGE_KEY, addresses);

    currentAddressVerified = false;
    step1PendingPreviewAddress = null;
    updateStep1GeoMapMarkers();
    updateStep1GeoMapView();
    updateStep1Headers();

    // Update the just-added (or edited) ring in the emotion map with distortion + movement.
    // Don't re-render the whole emotion map — keep placeholders intact.
    activateEmotionRing(editingIdx >= 0 ? editingIdx : addresses.length - 1);
    // Update all existing rings' angles based on the new geography.
    updateAllEmotionRingAngles();
    updateStep1RingReading();
    updateStep1TimeBelonging();
    // Color the next ring black only after the map focuses on the new address.
    if (!lastHome && step1GeoMap) {
      step1GeoMap.once("moveend", () => {
        colorCurrentEmotionRing();
      });
    } else if (!lastHome) {
      colorCurrentEmotionRing();
    }

    if (lastHome && editingIdx < 0) {
      // Keep the current layout — don't change phases.
      step1SummaryPhaseActive = true;
      if (elPageStep1) {
        elPageStep1.classList.remove("step1-archive-loaded");
        elPageStep1.classList.add("step1-finished-state");
      }
      growStep1DashboardAnimated();
      // Deliberately NOT stopping the per-home entry loops here: this path
      // never calls renderStep1EmotionMap()/startEmotionSound() (see the
      // "keep placeholders intact" comment above), so those entry loops are
      // the *only* ambient sound the finished map actually has — stopping
      // them here left it (and the fullscreen page, which mirrors these
      // same rings) completely silent. They're stopped in
      // step1GoBackToIntro() instead, when the whole map — and its sound —
      // is meant to go away.
      updateStep1TopProgress();
      clearStep1HomesListFocus();
      // Hide controls for finished non-edit mode via centralized button-state logic.
      if (typeof updateAddHomeBtnState === "function") updateAddHomeBtnState();
      // Hide address form inputs.
      const divAddr = elPageStep1 && elPageStep1.querySelector(".div-3 > .div-2");
      if (divAddr) divAddr.style.display = "none";

      fitStep1GeoMapToIsraelBoundaries({ animate: true });

      // Auto-save to server and local archive.
      const studentName = String(elStudentName?.value || "").trim();
      if (studentName && addresses.length > 0) {
        (async () => {
          try {
            const signature = await buildSignature(studentName);
            const map = buildCurrentMapSnapshotPayload(studentName);
            await fetch("/api/signatures", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: cryptoId(), studentName, signature, map }),
            });
          } catch {}
        })();
        try {
          const name = normalizeNameForMapLabel(studentName);
          const count = formatAddrCount(addresses.length);
          const label = name ? `${name}.${count}addrs` : "";
          if (label) {
            const list = getSavedMaps();
            const nextSerial = allocateNextSavedMapSerial(list);
            const snapshotId = ensureSnapshotId(null);
            const snapshot = {
              version: 1, id: snapshotId, label, serial: nextSerial,
              fullName: studentName, count: addresses.length,
              savedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
              view: { lat: 31.5, lng: 35.1, zoom: 7 }, geoLayerEnabled: false,
              addresses: JSON.parse(JSON.stringify(addresses)),
            };
            const next = Array.isArray(list) ? list.slice() : [];
            next.push(snapshot);
            setSavedMaps(next.slice(0, 100));
          }
        } catch {}
      }
    } else {
      await animateStep1AddressFieldsClear();
      // studentName/homesCount now live outside <form id="addressForm">
      // (on the home page), so this reset() no longer touches them --
      // no more need to save/restore their values around it.
      elForm.reset();
      if (elCountry) elCountry.value = "ישראל";
      resetStep1BelongingSliderToDefault();
      finishStep1AddressFieldsClearAnimation();

      if (isAfterFinishEdit && !isLastInAfterFinishReview) {
        // More rings left to review — advance to the next one, still in
        // edit mode (repopulates the form with its saved data).
        openStep1HomeEditMode(editingIdx + 1);
      } else if (isAfterFinishEdit) {
        // Was the last ring in the review sequence — fully exit back to
        // the normal (grown) finished dashboard.
        step1ExitEditAfterFinish();
      } else if (lastHome) {
        // If editing after all homes were done, re-hide the form + this button —
        // back to "click any ring/address to edit it" browsing, per home.
        const divAddrEdit = elPageStep1 && elPageStep1.querySelector(".div-3 > .div-2");
        if (divAddrEdit) divAddrEdit.style.display = "none";
        if (typeof updateAddHomeBtnState === "function") updateAddHomeBtnState();
      }

      updateStep1AddrNextBtnState();
      updateStep1Headers();
      if (!lastHome && !isAfterFinishEdit && elCity) elCity.focus({ preventScroll: true });
    }
  });
}

// Belonging BACK → address phase
const elStep1BelongBackBtn = document.getElementById("step1BelongBackBtn");
if (elStep1BelongBackBtn) {
  elStep1BelongBackBtn.addEventListener("click", () => {
    step1TransitionPhase("step1-belonging-phase", "step1-address-phase");
  });
}

// Belonging NEXT ("continue to home no.xx") — save current address, go to next home
const elStep1BelongNextBtn = document.getElementById("step1BelongNextBtn");

function renderStep1Summary() {
  const el = document.getElementById("step1Summary");
  if (!el) return;
  el.innerHTML = "";

  // Change the main title to HOMES
  const titleEl = document.querySelector("#pageStep1 .createYourMapTitle");
  if (titleEl) titleEl.textContent = "HOMES";

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    if (!addr) continue;
    const item = document.createElement("div");
    item.className = "summaryItem";

    const homeLabel = document.createElement("div");
    homeLabel.className = "summaryHomeLabel";
    homeLabel.textContent = `home no.${formatHomeNumber(i + 1)}`;
    item.appendChild(homeLabel);

    const addrLine = document.createElement("div");
    addrLine.className = "summaryAddress";
    const streetPart = addr._origStreetAndNumber
      || [addr._origStreet || addr.street, addr._origNumber || addr.number].filter(Boolean).join(" ");
    const summaryCity = addr._origCity || addr.city;
    const summaryCountry = addr._origCountry || addr.country;
    addrLine.textContent = [streetPart, summaryCity, summaryCountry].filter(Boolean).join(", ");
    item.appendChild(addrLine);

    el.appendChild(item);
  }
}

function isLastHome() {
  const total = parseInt(String(elHomesCount?.value || ""), 10) || 0;
  const current = (Array.isArray(addresses) ? addresses.length : 0) + 1;
  return total > 0 && current >= total;
}

function updateBelongNextBtnLabel() {
  const btn = document.getElementById("step1BelongNextBtn");
  if (!btn) return;
  if (isLastHome()) {
    btn.textContent = "FINISH";
    btn.classList.add("finishBtn");
  } else {
    const nextNum = formatHomeNumber((Array.isArray(addresses) ? addresses.length : 0) + 2);
    btn.textContent = `CONTINUE TO HOME NO.${nextNum}`;
    btn.classList.remove("finishBtn");
  }
}

if (elStep1BelongNextBtn) {
  elStep1BelongNextBtn.addEventListener("click", async () => {
    if (isStep1EditModeActive()) {
      if (elStep1AddrNextBtn) elStep1AddrNextBtn.click();
      return;
    }
    if (!currentAddressVerified || !step1PendingPreviewAddress) return;

    const address = {
      id: cryptoId(),
      country: getValue("country"),
      state: getValue("state"),
      city: getValue("city"),
      street: getValue("street"),
      number: getValue("number"),
      startYear: String(elStartYear?.value || "").trim(),
      belonging_rate: normalizeBelongingRate(getValue("belonging_rate")),
      valid: true,
    };

    const prev = step1PendingPreviewAddress;
    if (!prev) return;
    address.lat = prev.lat;
    address.lon = prev.lon;
    address.displayName = prev.displayName || "";

    const lastHome = isLastHome();

    addresses.push(address);
    saveJson(STORAGE_KEY, addresses);

    currentAddressVerified = false;
    step1PendingPreviewAddress = null;
    belongingLabelShown = false;
    updateBelongingValueLabel();
    updateStep1GeoMapMarkers();
    updateStep1Headers();

    if (lastHome) {
      step1SummaryPhaseActive = true;
      // Show the summary phase
      step1TransitionPhase("step1-belonging-phase", "step1-summary-phase", () => {
        renderStep1Summary();
        fitStep1GeoMapToIsraelBoundaries({ animate: true });
      });
      // Auto-save the map to the archive (both movement and emotion).
      const studentName = String(elStudentName?.value || "").trim();
      if (studentName && addresses.length > 0) {
        // Save to server (signatures.json).
        (async () => {
          try {
            const signature = await buildSignature(studentName);
            const map = buildCurrentMapSnapshotPayload(studentName);
            await fetch("/api/signatures", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: cryptoId(),
                studentName,
                signature,
                map,
              }),
            });
          } catch {
            // Silent fail.
          }
        })();

        // Save to local archive (savedMaps) so it appears in the Archive page.
        try {
          const name = normalizeNameForMapLabel(studentName);
          const count = formatAddrCount(addresses.length);
          const label = name ? `${name}.${count}addrs` : "";
          if (label) {
            const list = getSavedMaps();
            const nextSerial = allocateNextSavedMapSerial(list);
            const snapshotId = ensureSnapshotId(null);
            const snapshot = {
              version: 1,
              id: snapshotId,
              label,
              serial: nextSerial,
              fullName: studentName,
              count: addresses.length,
              savedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              view: { lat: 31.5, lng: 35.1, zoom: 7 },
              geoLayerEnabled: false,
              addresses: JSON.parse(JSON.stringify(addresses)),
            };
            const next = Array.isArray(list) ? list.slice() : [];
            next.push(snapshot);
            setSavedMaps(next.slice(0, 100));
          }
        } catch {
          // Silent fail.
        }
      }

      // Capture placeholder ring states before they're replaced.
      const oldRings = [];
      if (elStep1EmotionSvg) {
        elStep1EmotionSvg.querySelectorAll("circle").forEach((c) => {
          oldRings.push({
            r: parseFloat(c.getAttribute("r")) || 0,
            sw: parseFloat(c.getAttribute("stroke-width")) || 1.5,
          });
        });
      }
      // Replace the placeholder rings with the full emotion map (with sound, distortions, motion).
      renderStep1EmotionMap({ transitionFromCircles: oldRings });

      // Recolor route to black.
      step1SummaryPhaseActive = true;
      if (elPageStep1) {
        elPageStep1.classList.remove("step1-archive-loaded");
        elPageStep1.classList.add("step1-finished-state");
      }
      growStep1DashboardAnimated();
      stopStep1EntrySound();
      updateStep1TopProgress();
      clearStep1HomesListFocus();
      setTimeout(() => {
        updateStep1GeoMapMarkers();
        if (step1GeoRouteLine) {
          step1GeoRouteLine.setStyle({ color: "#000000", weight: 1.5 });
        }
      }, 300);
    } else {
      // studentName/homesCount now live outside <form id="addressForm">
      // (on the home page), so this reset() no longer touches them --
      // no more need to save/restore their values around it.
      await animateStep1AddressFieldsClear();
      elForm.reset();
      if (elCountry) elCountry.value = "ישראל";
      finishStep1AddressFieldsClearAnimation();

      updateBelongNextBtnLabel();
      updateStep1AddrNextBtnState();

      // Switch back to address phase for the next home
      step1TransitionPhase("step1-belonging-phase", "step1-address-phase", () => {
        if (elCountry) elCountry.focus({ preventScroll: true });
      });
    }
  });
}

// Home page screen 2 (name/homes-count questions): reveal it via animation
// as it scrolls into view, and let the user start typing right away by
// focusing the name field the first time it becomes visible (unless
// they're already typing in another field). Auto-focus is gated to once
// per page-visit -- unlike Step 1's old equivalent of this observer (only
// ever active while Step 1 was freshly shown), this one watches an element
// that stays live while the user freely scrolls #pageWelcome back and
// forth, so an unconditional refocus would steal focus on every crossing.
const elHomePageScreen2 = document.getElementById("homePageScreen2");
if (elHomePageScreen2 && elStudentName && "IntersectionObserver" in window) {
  let screen2AutoFocused = false;
  // Fires a bit later into the scroll than a plain halfway crossing, so the
  // fade starts once screen 2 is clearly the thing being scrolled to rather
  // than the moment it first passes the midpoint.
  const REVEAL_THRESHOLD = 0.68;
  const revealHomeScreen2 = (entries) => {
    for (const entry of entries) {
      const visible = entry.isIntersecting && entry.intersectionRatio >= REVEAL_THRESHOLD;
      elHomePageScreen2.classList.toggle("homePageScreen2Visible", visible);
      if (!visible || screen2AutoFocused) continue;
      const active = document.activeElement;
      const typingElsewhere =
        active &&
        active !== elStudentName &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (!typingElsewhere) {
        screen2AutoFocused = true;
        try {
          elStudentName.focus({ preventScroll: true });
        } catch {
          // ignore
        }
      }
    }
  };
  const homeScreen2Observer = new IntersectionObserver(revealHomeScreen2, {
    threshold: [0, REVEAL_THRESHOLD, 1],
  });
  homeScreen2Observer.observe(elHomePageScreen2);
}

if (elArchiveBackBtn) {
  elArchiveBackBtn.addEventListener("click", () => {
    showPage(_lastPrimaryPageKey, { scroll: "step1", behavior: "auto" });
  });
}

const elHomeArchiveBtn = document.getElementById("homeArchiveBtn");
const elHomeAllMapsBtn = document.getElementById("homeAllMapsBtn");
const elHomeAboutBtn = document.getElementById("homeAboutBtn");
const elAboutBackBtn = document.getElementById("aboutBackBtn");

if (elHomeArchiveBtn) {
  elHomeArchiveBtn.addEventListener("click", () => {
    showPage("archive");
  });
}

if (elHomeAllMapsBtn) {
  elHomeAllMapsBtn.addEventListener("click", () => {
    showPage("allmaps");
  });
}

if (elHomeAboutBtn) {
  elHomeAboutBtn.addEventListener("click", () => {
    showPage("about");
  });
}

if (elAboutBackBtn) {
  elAboutBackBtn.addEventListener("click", () => {
    showPage("welcome");
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


if (elEmotionSoloBackBtn) {
  elEmotionSoloBackBtn.addEventListener("click", () => {
    _emotionRingFocusIndex = null;
    // showPage() skips its usual solo-overlay teardown when the destination
    // is "step1" (that exemption exists so returning to Step 1 doesn't
    // stop-then-immediately-restart the shared breathing/sound session) —
    // so the solo ring's text overlay (attachment/temporal/movement/etc.)
    // needs to be cleared explicitly here instead, or it stays stuck on
    // screen over Step 1.
    hideEmotionRingSoloTextOverlays();
    stopEmotionSoundForSoloRing();
    setEmotionSoundFocus(null);
    resumeStep1EntrySoundFromSolo();

    // Came here from the fullscreen emotion map's ring spread (see the
    // spread click handler) -- return there instead of Step 1, re-entering
    // spread so it looks exactly like where the user left off.
    if (_emotionSoloReturnToStep1FullscreenSpread) {
      _emotionSoloReturnToStep1FullscreenSpread = false;
      _step1SkipSoundRebuildOnce = true;
      showPage("step1EmotionFullscreen");
      populateStep1EmotionFullscreenSvg();
      fitStep1EmotionFullscreenInnerRing();
      enterStep1EmotionFullscreenRingSpread(null);
      return;
    }

    // Came here from the route/movement map (Step 2) -- return there instead
    // of Step 1. showPage("step2") already fully re-renders the map/dots/
    // reading panel on every entry, so no extra rebuild is needed here.
    if (_emotionSoloReturnToStep2) {
      _emotionSoloReturnToStep2 = false;
      showPage("step2");
      return;
    }

    // showPage("step1") below always triggers renderStep1EmotionMap(), which
    // would otherwise tear down and rebuild the sound session — this flag
    // tells it to leave sound alone this one time, so what
    // resumeStep1EntrySoundFromSolo() just resumed simply keeps playing.
    _step1SkipSoundRebuildOnce = true;
    showPage("step1", { scroll: "step1", behavior: "auto" });
  });
}

if (elEmotionSaveBtn) {
  elEmotionSaveBtn.addEventListener("click", () => {
    const ok = saveCurrentMapSnapshot();
  });
}

let _step1NextAfterVerify = false;

function verifyCurrentAddress() {
  syncStreetAndNumberFields();
  const country = String(elCountry?.value || "").trim();
  const city = String(elCity?.value || "").trim();
  const street = String(elStreet?.value || "").trim();
  const number = String(elNumber?.value || "").trim();

  if (!country || !city || !street || !number) {
    currentAddressVerified = false;
    step1PendingPreviewAddress = null;
    updateAddButtonState();
    updateStep1GeoMapMarkers();
    return;
  }

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
  const ctry = tidyToken(country);
  const cty = tidyToken(city);
  const street = tidyToken(streetLine);

  const tryFetch = async (params) => {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    url.searchParams.set("accept-language", "en");
    url.searchParams.set("addressdetails", "0");
    url.searchParams.set("namedetails", "0");
    url.searchParams.set("extratags", "0");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url.toString(), {
        signal: ctrl.signal,
        headers: { "Accept": "application/json", "Accept-Language": "en" },
      });
      if (!res.ok) return false;
      const data = await res.json();
      return Array.isArray(data) && data.length > 0;
    } catch {
      return false;
    } finally {
      clearTimeout(tid);
    }
  };

  // Try structured first.
  const structuredParams = {};
  if (street) structuredParams.street = street;
  if (cty) structuredParams.city = cty;
  if (ctry) structuredParams.country = ctry;
  if (await tryFetch(structuredParams)) return true;

  // Fall back to freeform (handles Hebrew city/country names in non-Israeli contexts).
  const freeformQ = [street, cty, ctry].filter(Boolean).join(", ");
  if (freeformQ) return tryFetch({ q: freeformQ });
  return false;
}

async function diagnoseAddressNotFound(address) {
  const country = tidyToken(address.country);
  const city = tidyToken(address.city);
  const street = tidyToken(address.street);

  // 1) If the country itself can't be found, likely the country.
  const countryOk = await nominatimSearchExistsStructured({ country, city: "", streetLine: "" });
  if (!countryOk) return "Country";

  // 2) If the city itself can't be found in this country, likely the city.
  const cityOk = await nominatimSearchExistsStructured({ country, city, streetLine: "" });
  if (!cityOk) return "City";

  // 3) If the street can't be found in this city/country, likely the street.
  const streetOk = await nominatimSearchExistsStructured({ country, city, streetLine: street });
  if (!streetOk) return "Street";

  // 4) City+street exist, but full address failed — likely the home number.
  return "Home number";
}

function verifyCurrentAddressWithDiagnosis(address) {
  const requestSeq = ++verifyAddressRequestSeq;
  geocodeStep1FullAddressInOrder(address)
    .then((geo) => {
      if (requestSeq !== verifyAddressRequestSeq) return;
      setStep1PreviewAddressFromGeo(address, geo);
      step1MapPreEntry = false;
      if (elStep1GeoMap) elStep1GeoMap.classList.remove("map-pre-entry");
      if (elPageStep1) elPageStep1.classList.remove("map-colors-dark");
      if (_step1NextAfterVerify) {
        _step1NextAfterVerify = false;
        setTimeout(() => { if (elStep1AddrNextBtn) elStep1AddrNextBtn.click(); }, 0);
      }
    })
    .catch(() => {
      if (requestSeq !== verifyAddressRequestSeq) return;
      currentAddressVerified = false;
      step1PendingPreviewAddress = null;
      _step1NextAfterVerify = false;
      clearAddressFieldErrors();
      updateAddButtonState();
      updateStep1AddrNextBtnState();
      diagnoseAddressNotFound(address)
        .then((field) => {
          // Stale by the time the diagnosis round-trip finishes (user typed
          // again, or a newer verify superseded this one) -- don't paint an
          // error over whatever they're now looking at.
          if (requestSeq !== verifyAddressRequestSeq) return;
          markAddressFieldError(field);
        })
        .catch(() => {
          // Diagnosis itself failed (e.g. network) -- leave no field marked
          // rather than guessing.
        });
    });
}

let verifyAddressDebounceId = 0;

function scheduleVerifyCurrentAddress(delayMs = 130) {
  if (verifyAddressDebounceId) window.clearTimeout(verifyAddressDebounceId);
  verifyAddressDebounceId = window.setTimeout(() => {
    verifyAddressDebounceId = 0;
    verifyCurrentAddress();
  }, delayMs);
}


function clearAddressFieldErrors() {
  const streetAndNumberEl = document.getElementById("streetAndNumber");
  [elCountry, elCity, elStreet, elNumber, streetAndNumberEl].forEach((el) => {
    if (el) el.classList.remove("address-error");
  });
}

function hasStep1StreetInput() {
  return Boolean(String(elStreet?.value || "").trim());
}

function markAddressFieldError(field) {
  // "Street" and "Home number" both live in the same visible combined
  // input (#streetAndNumber) -- elStreet/elNumber themselves are hidden,
  // so marking those wouldn't show anything.
  const streetAndNumberEl = document.getElementById("streetAndNumber");
  const map = { "Country": elCountry, "City": elCity, "Street": streetAndNumberEl, "Home number": streetAndNumberEl };
  const el = map[field];
  if (el) el.classList.add("address-error");
}

function handleAddressFieldInput() {
  currentAddressVerified = false;
  step1PendingPreviewAddress = null;
  const activeCityKey = [String(elCountry?.value || "").trim(), String(elCity?.value || "").trim()].join("|");
  if (step1ResolvedCityFocus?.key && step1ResolvedCityFocus.key !== activeCityKey) step1ResolvedCityFocus = null;
  clearAddressFieldErrors();
  updateAddButtonState();
  updateStep1GeoMapMarkers();
  scheduleStep1AddressMapSync();
  scheduleVerifyCurrentAddress(140);
}

function handleAddressFieldKeydown(e) {
  if (e.key === "Enter") {
    verifyCurrentAddress();
  }
}

function handleAddressFieldBlur() {
  verifyCurrentAddress();
}

function clearStep1FocusMarker() {
  if (step1FocusMarker && step1GeoMap) {
    try { step1GeoMap.removeLayer(step1FocusMarker); } catch { /* ignore */ }
  }
  step1FocusMarker = null;
}

function getCurrentStep1BelongingRate() {
  const inlineValue = String(elBelongingInline?.value || "").trim();
  const mainValue = String(elBelongingRate?.value || "").trim();
  return normalizeBelongingRate(inlineValue || mainValue || "1", 1);
}

function updateStep1FocusCircleStroke(rate = getCurrentStep1BelongingRate()) {
  if (!step1FocusMarker || typeof step1FocusMarker.setStyle !== "function") return;
  step1FocusMarker.setStyle({ weight: belongingCircleStrokeWeight(rate), radius: addressDotRadius(rate) });
}

function drawStep1FocusCircleAfterFocus(lat, lon, seq) {
  if (!STEP1_SHOW_FOCUS_CIRCLE || !step1GeoMap) return;
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!isFinite(latNum) || !isFinite(lonNum)) return;
  let drawn = false;
  const draw = () => {
    if (drawn || seq !== _streetFocusSeq || !step1GeoMap) return;
    drawn = true;
    try { step1GeoMap.off("moveend", draw); } catch { /* ignore */ }
    if (!step1GeoVectorRenderer) step1GeoVectorRenderer = L.svg();
    // The address can change (and re-geocode to a new spot) any number of
    // times before "add home" is clicked -- without removing the previous
    // marker first, each change would leave an orphaned extra circle on the
    // map instead of moving the one live-preview circle.
    clearStep1FocusMarker();
    const rate = getCurrentStep1BelongingRate();
    step1FocusMarker = L.circleMarker([latNum, lonNum], {
      renderer: step1GeoVectorRenderer,
      radius: addressDotRadius(rate),
      color: getStep1GeoMarkerColor(),
      weight: belongingCircleStrokeWeight(rate),
      fillOpacity: 0,
    }).addTo(step1GeoMap);
  };
  try { step1GeoMap.once("moveend", draw); } catch { /* ignore */ }
  setTimeout(draw, 1200);
}

let _cityFocusDebounceId = 0;
let _cityFocusSeq = 0;
let step1ResolvedCityFocus = null;

function parseNominatimBoundingBox(item) {
  const box = item?.boundingbox;
  if (!Array.isArray(box) || box.length < 4) return null;
  const south = Number(box[0]);
  const north = Number(box[1]);
  const west = Number(box[2]);
  const east = Number(box[3]);
  if (![south, north, west, east].every(isFinite)) return null;
  return { south, north, west, east };
}

function pointInBoundingBox(lat, lon, box, pad = 0.01) {
  if (!box || !isFinite(lat) || !isFinite(lon)) return false;
  return lat >= box.south - pad && lat <= box.north + pad && lon >= box.west - pad && lon <= box.east + pad;
}

function distanceKmBetween(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const radiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getNominatimItemCityTokens(item) {
  const address = item?.address || {};
  const namedetails = item?.namedetails || {};
  return [
    address.village,
    address.town,
    address.city,
    address.municipality,
    address.suburb,
    item?.name,
    namedetails.name,
    namedetails["name:he"],
    namedetails["name:en"],
    item?.display_name,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function nominatimItemMatchesCity(item, wantedCity = "", cityFocus = step1ResolvedCityFocus) {
  const city = normalizeTextForMatch(wantedCity);
  if (!city) return true;
  if (cityFocus?.key) {
    const focusCity = normalizeTextForMatch(cityFocus.city);
    const focusCountry = normalizeTextForMatch(cityFocus.country);
    const activeKey = [String(elCountry?.value || "").trim(), String(elCity?.value || "").trim()].join("|");
    if (activeKey === cityFocus.key && focusCity && (focusCity.includes(city) || city.includes(focusCity))) {
      const lat = Number(item?.lat);
      const lon = Number(item?.lon);
      if (cityFocus.boundingBox && pointInBoundingBox(lat, lon, cityFocus.boundingBox, 0.02)) return true;
      if (isFinite(lat) && isFinite(lon) && isFinite(cityFocus.lat) && isFinite(cityFocus.lon)) {
        return distanceKmBetween(lat, lon, cityFocus.lat, cityFocus.lon) <= 5;
      }
    }
    if (focusCountry && normalizeTextForMatch(item?.address?.country || "").includes(focusCountry)) {
      const lat = Number(item?.lat);
      const lon = Number(item?.lon);
      if (cityFocus.boundingBox && pointInBoundingBox(lat, lon, cityFocus.boundingBox, 0.02)) return true;
    }
  }
  const latinCity = normalizeTextForMatch(toEnglishLike(wantedCity));
  const tokens = getNominatimItemCityTokens(item).map((token) => normalizeTextForMatch(token));
  if (tokens.some((token) => token && (token.includes(city) || city.includes(token) || token.includes(latinCity) || latinCity.includes(token)))) return true;

  const lat = Number(item?.lat);
  const lon = Number(item?.lon);
  if (cityFocus?.boundingBox && pointInBoundingBox(lat, lon, cityFocus.boundingBox, 0.02)) return true;
  if (isFinite(lat) && isFinite(lon) && isFinite(cityFocus?.lat) && isFinite(cityFocus?.lon)) {
    return distanceKmBetween(lat, lon, cityFocus.lat, cityFocus.lon) <= 5;
  }
  return false;
}

// Resolves (and caches in step1ResolvedCityFocus) a coarse lat/lon anchor
// for the currently-typed country+city, with no side effect on the map view
// -- used both by focusCityOnGeoMap() (which does pan the map) and by
// geocodeStep1FullAddressInOrder() (which needs a *reliable geographic*
// reference for nominatimItemMatchesCity() to check candidates against;
// comparing transliterated Hebrew text against Nominatim's English place
// names is unreliable enough to reject genuinely correct results -- see
// transliterateHebrewToLatin(), a crude per-letter mapper, not a real
// transliteration of how Hebrew place names are actually spelled in Latin).
async function resolveStep1CityFocus() {
  const seq = ++_cityFocusSeq;
  const country = String(elCountry?.value || "").trim();
  const city = String(elCity?.value || "").trim();
  if (!city) return null;
  const cityKey = [country, city].join("|");
  if (step1ResolvedCityFocus?.key === cityKey) return step1ResolvedCityFocus;

  try {
    const q = [city, country].filter(Boolean).join(", ");
    const params = {
      format: "json",
      limit: "1",
      addressdetails: "1",
      namedetails: "1",
      extratags: "1",
      "accept-language": "en",
      q,
    };
    const res = await fetch("/api/nominatim", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ params }),
    });
    if (seq !== _cityFocusSeq) return step1ResolvedCityFocus;
    if (!res.ok) { console.warn("[cityFocus] geocoder", res.status, q); } else {
      const payload = await res.json();
      const data = payload?.ok && Array.isArray(payload.data) ? payload.data : [];
      if (seq !== _cityFocusSeq) return step1ResolvedCityFocus;
      if (Array.isArray(data) && data.length) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        if (isFinite(lat) && isFinite(lon)) {
          step1ResolvedCityFocus = {
            key: cityKey,
            city,
            country,
            lat,
            lon,
            boundingBox: parseNominatimBoundingBox(data[0]),
            displayName: String(data[0].display_name || q),
          };
          return step1ResolvedCityFocus;
        }
      } else {
        console.warn("[cityFocus] no result for", q);
      }
    }
  } catch {
    // Fall back to the shared geocoder below.
  }

  try {
    const geo = await geocodeAddress({ country, city, state: getValue("state"), street: "", number: "" });
    if (seq !== _cityFocusSeq) return step1ResolvedCityFocus;
    step1ResolvedCityFocus = {
      key: cityKey,
      city,
      country,
      lat: geo.lat,
      lon: geo.lon,
      boundingBox: null,
      displayName: String(geo.displayName || [city, country].filter(Boolean).join(", ")),
    };
    return step1ResolvedCityFocus;
  } catch (e) {
    console.warn("[cityFocus] error", e);
    return null;
  }
}

async function focusCityOnGeoMap() {
  const focus = await resolveStep1CityFocus();
  if (focus) focusStep1GeoMapAt(focus.lat, focus.lon, 12, { animate: true });
}

function scheduleCityMapFocus() {
  if (_cityFocusDebounceId) window.clearTimeout(_cityFocusDebounceId);
  _cityFocusDebounceId = window.setTimeout(() => {
    _cityFocusDebounceId = 0;
    focusCityOnGeoMap();
  }, 500);
}

function scheduleStep1AddressMapSync() {
  syncStreetAndNumberFields();
  const country = String(elCountry?.value || "").trim();
  const city = String(elCity?.value || "").trim();
  const street = String(elStreet?.value || "").trim();
  const number = String(elNumber?.value || "").trim();
  if (country && city && street && number) {
    if (_cityFocusDebounceId) window.clearTimeout(_cityFocusDebounceId);
    _cityFocusDebounceId = 0;
    scheduleStreetMapFocus();
  }
}

function setStep1PreviewAddressFromGeo(address, geo) {
  if (!geo || !isFinite(geo.lat) || !isFinite(geo.lon)) return;
  currentAddressVerified = true;
  const existing = isStep1EditModeActive() ? (addresses[_step1EditingIdx] || {}) : {};
  step1PendingPreviewAddress = {
    id: existing.id || "step1-preview",
    ...address,
    lat: geo.lat,
    lon: geo.lon,
    displayName: geo.displayName || "",
    startYear: String(elStartYear?.value || existing.startYear || "").trim(),
    belonging_rate: normalizeBelongingRate(getValue("belonging_rate"), 1),
    valid: true,
    _origCountry: getValue("country") || address._origCountry || address.country,
    _origCity: getValue("city") || address._origCity || address.city,
    _origStreet: getValue("street") || address._origStreet || address.street,
    _origNumber: getValue("number") || address._origNumber || address.number,
    _origStreetAndNumber: String(elStreetAndNumber?.value || address._origStreetAndNumber || "").trim(),
  };
  clearAddressFieldErrors();
  updateAddButtonState();
  if (typeof updateAddHomeBtnState === "function") updateAddHomeBtnState();
  updateStep1GeoMapMarkers();
  updateAllEmotionRingAngles();
}

function isKiryatYamGioraYoseftalAddress(address) {
  const country = normalizeTextForMatch(address?.country);
  const city = normalizeTextForMatch(address?.city);
  const street = normalizeTextForMatch(address?.street);
  return (country.includes("israel") || country.includes("ישראל"))
    && (city.includes("kiryatyam") || city.includes("קרייתים") || city.includes("קריתים") || (city.includes("קרית") && city.includes("ים")) || (city.includes("קריית") && city.includes("ים")))
    && (street.includes("giorayoseftal") || street.includes("yoseftal") || street.includes("גיוראיוספטל") || street.includes("יוספטל"));
}

function estimateKiryatYamGioraYoseftalByNumber(address) {
  const houseNumber = parseHouseNumberValue(address?.number);
  if (!isFinite(houseNumber)) return null;
  const anchor6 = { number: 6, lat: 32.8485940, lon: 35.0641184 };
  const anchor10 = { number: 10, lat: 32.8491867, lon: 35.0644751 };
  const t = (houseNumber - anchor6.number) / (anchor10.number - anchor6.number);
  return {
    lat: anchor6.lat + (anchor10.lat - anchor6.lat) * t,
    lon: anchor6.lon + (anchor10.lon - anchor6.lon) * t,
    estimated: true,
  };
}

function isKiryatBialikKerenHayesod160Address(address) {
  const country = normalizeTextForMatch(address?.country);
  const city = normalizeTextForMatch(address?.city);
  const street = normalizeTextForMatch(address?.street);
  const number = normalizeHouseNumberForMatch(address?.number);
  return (country.includes("israel") || country.includes("ישראל"))
    && (city.includes("kiryatbialik") || city.includes("qiryatbialik") || city.includes("קריתביאליק") || city.includes("קרייתביאליק"))
    && (street.includes("kerenhayesod") || street.includes("קרןהיסוד"))
    && houseNumberMatches(number, "160");
}

function exactKiryatBialikKerenHayesod160Location(address) {
  if (!isKiryatBialikKerenHayesod160Address(address)) return null;
  return {
    lat: 32.840014,
    lon: 35.09117,
    displayName: "Keren HaYesod 160, Kiryat Bialik, Israel",
  };
}

function isKiryatBialikDerechAkko160Address(address) {
  const country = normalizeTextForMatch(address?.country);
  const city = normalizeTextForMatch(address?.city);
  const street = normalizeTextForMatch(address?.street);
  const number = normalizeHouseNumberForMatch(address?.number);
  return (country.includes("israel") || country.includes("ישראל"))
    && (city.includes("kiryatbialik") || city.includes("qiryatbialik") || city.includes("קריתביאליק") || city.includes("קרייתביאליק"))
    && (street.includes("derechakko") || street.includes("acko") || street.includes("akko") || street.includes("דרךעכו") || street.includes("עכו"))
    && houseNumberMatches(number, "160");
}

function exactKiryatBialikDerechAkko160Location(address) {
  if (!isKiryatBialikDerechAkko160Address(address)) return null;
  return {
    lat: 32.846819,
    lon: 35.091494,
    displayName: "Derech Akko 160, Kiryat Bialik, Israel",
  };
}

const HEBREW_STREET_PREFIX_WORDS = new Set(["רחוב", "דרך", "שדרות", "סמטת", "סמטה", "שביל", "כביש", "משעול", "מבוא", "רח'", "שד'"]);

function hebrewDefiniteArticleStreetVariants(streetText) {
  const trimmed = String(streetText || "").trim();
  if (!trimmed) return [];
  const words = trimmed.split(/\s+/);
  const variants = new Set();
  words.forEach((word, idx) => {
    if (HEBREW_STREET_PREFIX_WORDS.has(word)) return;
    if (!/^[א-ת]/.test(word)) return;
    const altWord = (word.charAt(0) === "ה" && word.length > 1) ? word.slice(1) : ("ה" + word);
    const altWords = words.slice();
    altWords[idx] = altWord;
    const variant = altWords.join(" ");
    if (variant !== trimmed) variants.add(variant);
  });
  return Array.from(variants);
}

// Two different triggers (focusStreetOnGeoMap() and verifyCurrentAddress())
// both call geocodeStep1FullAddressInOrder() for the same edit, and often
// nearly simultaneously -- dedupe so that only ever fires the network work
// below once per in-progress address, with the second caller just riding
// along on the first's promise instead of doubling every request.
const _step1GeocodeInFlight = new Map();

async function geocodeStep1FullAddressInOrder(address) {
  const country = tidyToken(address.country);
  const city = tidyToken(address.city);
  const street = tidyToken(address.street);
  const number = tidyToken(address.number);
  if (!country || !city || !street || !number) throw new Error("Full address is required");

  const exactLocal = exactKiryatBialikKerenHayesod160Location(address) || exactKiryatBialikDerechAkko160Location(address);
  if (exactLocal) {
    const record = {
      lat: exactLocal.lat,
      lon: exactLocal.lon,
      displayName: exactLocal.displayName,
      normalized: { country, city, street, number },
      matchLevel: "address",
      ts: Date.now(),
    };
    geocodeCache[canonicalKey(address)] = record;
    saveJson(GEOCODE_CACHE_KEY, geocodeCache);
    return record;
  }

  // Already resolved this exact address (e.g. the user backspaced and
  // retyped the same thing, or a previous keystroke's lookup already
  // finished) -- skip the network entirely.
  const cacheKey = canonicalKey(address);
  const cachedRecord = geocodeCache[cacheKey];
  if (cachedRecord && isFinite(cachedRecord.lat) && isFinite(cachedRecord.lon)) {
    return cachedRecord;
  }

  if (_step1GeocodeInFlight.has(cacheKey)) {
    return _step1GeocodeInFlight.get(cacheKey);
  }

  const run = (async () => {
    const streetLine = tidyToken(address._origStreetAndNumber || [street, number].filter(Boolean).join(" "));
    const baseParams = {
      format: "json",
      limit: "10",
      addressdetails: "1",
      namedetails: "1",
      extratags: "1",
      "accept-language": "en",
    };
    const searches = [
      { ...baseParams, country, city, street: streetLine },
      { ...baseParams, q: [streetLine, city, country].filter(Boolean).join(", ") },
    ];
    for (const streetVariant of hebrewDefiniteArticleStreetVariants(street)) {
      const streetLineVariant = tidyToken([streetVariant, number].filter(Boolean).join(" "));
      searches.push(
        { ...baseParams, country, city, street: streetLineVariant },
        { ...baseParams, q: [streetLineVariant, city, country].filter(Boolean).join(", ") },
      );
    }

    // Every search variant, plus the city-anchor lookup (see
    // resolveStep1CityFocus()'s own comment), all fire in parallel instead
    // of one-at-a-time -- wall-clock time then depends on the slowest
    // single request, not their sum. Priority (structured/first-variant
    // over a later one) is preserved by picking the first non-empty result
    // in original search order once everything has settled, not by which
    // happened to respond first.
    const [cityFocus, itemsPerSearch] = await Promise.all([
      resolveStep1CityFocus(),
      Promise.all(searches.map(async (params) => {
        try {
          const res = await fetch("/api/nominatim", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ params }),
          });
          if (!res.ok) return [];
          const payload = await res.json();
          return payload?.ok && Array.isArray(payload.data) ? payload.data : [];
        } catch {
          return [];
        }
      })),
    ]);

    // The freeform (q:) search especially can drop an unrecognized street
    // token and still return *some* result -- often in a different city
    // entirely, since it matches whatever it *can* parse. Require the
    // candidate to actually be in the requested city so an unrecognized
    // street can't silently relocate the map to the wrong place. Only
    // enforced when cityFocus resolved (a reliable geographic check) --
    // without it, nominatimItemMatchesCity() would fall back to comparing
    // transliterated text, which is unreliable enough (especially for
    // Hebrew) to reject genuinely correct results, so skip rather than risk
    // that false rejection.
    let item = null;
    for (const items of itemsPerSearch) {
      const found = items.find((candidate) =>
        isFinite(Number(candidate?.lat)) && isFinite(Number(candidate?.lon))
        && (!cityFocus || nominatimItemMatchesCity(candidate, address.city, cityFocus)));
      if (found) { item = found; break; }
    }

    if (item) {
      let lat = Number(item.lat);
      let lon = Number(item.lon);
      let matchLevel = item?.address?.house_number ? "address" : "street";
      if (isKiryatYamGioraYoseftalAddress(address) && !houseNumberMatches(item?.address?.house_number, number)) {
        const estimatedHouse = estimateKiryatYamGioraYoseftalByNumber(address);
        if (estimatedHouse && isFinite(estimatedHouse.lat) && isFinite(estimatedHouse.lon)) {
          lat = Number(estimatedHouse.lat);
          lon = Number(estimatedHouse.lon);
          matchLevel = "address";
        }
      }
      const displayName = String(item.display_name || [streetLine, city, country].filter(Boolean).join(", "));
      const record = {
        lat,
        lon,
        displayName,
        normalized: { country, city, street, number },
        matchLevel,
        ts: Date.now(),
      };
      geocodeCache[cacheKey] = record;
      saveJson(GEOCODE_CACHE_KEY, geocodeCache);
      return record;
    }

    if (isKiryatYamGioraYoseftalAddress(address)) {
      const estimatedHouse = estimateKiryatYamGioraYoseftalByNumber(address);
      if (estimatedHouse && isFinite(estimatedHouse.lat) && isFinite(estimatedHouse.lon)) {
        const displayName = [streetLine, city, country].filter(Boolean).join(", ");
        const record = {
          lat: Number(estimatedHouse.lat),
          lon: Number(estimatedHouse.lon),
          displayName,
          normalized: { country, city, street, number },
          matchLevel: "address",
          ts: Date.now(),
        };
        geocodeCache[cacheKey] = record;
        saveJson(GEOCODE_CACHE_KEY, geocodeCache);
        return record;
      }
    }

    throw new Error(`No full address result for: ${[streetLine, city, country].filter(Boolean).join(", ")}`);
  })();

  _step1GeocodeInFlight.set(cacheKey, run);
  try {
    return await run;
  } finally {
    _step1GeocodeInFlight.delete(cacheKey);
  }
}

let _streetFocusDebounceId = 0;
let _streetFocusSeq = 0;

async function focusStreetOnGeoMap() {
  const seq = ++_streetFocusSeq;
  const parsedStreetAndNumber = syncStreetAndNumberFields();
  const country = String(elCountry?.value || "").trim();
  const city = String(elCity?.value || "").trim();
  const street = String(elStreet?.value || "").trim();
  const number = String(elNumber?.value || "").trim();
  if (!country || !city || !street || !number) return;
  const address = { country, city, state: getValue("state"), street, number, _origStreetAndNumber: parsedStreetAndNumber.raw };
  try {
    const geo = await geocodeStep1FullAddressInOrder(address);
    if (seq !== _streetFocusSeq) return;
    setStep1PreviewAddressFromGeo(address, geo);
    focusStep1GeoMapAt(geo.lat, geo.lon, 15.5, { animate: true });
    drawStep1FocusCircleAfterFocus(geo.lat, geo.lon, seq);
  } catch (e) {
    console.warn("[streetFocus] error", e);
    if (seq !== _streetFocusSeq) return;
    // The street/number couldn't be resolved -- don't leave a stale
    // precise marker from a previous address sitting there, and don't let
    // the map drift anywhere unexpected. Fall back to just the city (if
    // that part alone is recognized) so the map stays anchored on the
    // right city while the street field's own red underline (see
    // markAddressFieldError()) flags what actually needs fixing.
    clearStep1FocusMarker();
    await focusCityOnGeoMap();
  }
}

function scheduleStreetMapFocus() {
  if (_streetFocusDebounceId) window.clearTimeout(_streetFocusDebounceId);
  _streetFocusDebounceId = window.setTimeout(() => {
    _streetFocusDebounceId = 0;
    focusStreetOnGeoMap();
  }, 5);
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
  elStreet.addEventListener("input", () => { handleAddressFieldInput(); scheduleStreetMapFocus(); });
  elStreet.addEventListener("keydown", handleAddressFieldKeydown);
  elStreet.addEventListener("blur", () => { handleAddressFieldBlur(); scheduleStreetMapFocus(); });
}
if (elNumber) {
  elNumber.addEventListener("input", () => {
    handleAddressFieldInput();
    // Auto-verify shortly after the home number is entered (no extra click needed).
    scheduleVerifyCurrentAddress();
    scheduleStreetMapFocus();
  });
  elNumber.addEventListener("keydown", handleAddressFieldKeydown);
  elNumber.addEventListener("blur", () => { handleAddressFieldBlur(); scheduleStreetMapFocus(); });
}
if (elBelongingRate) {
  elBelongingRate.addEventListener("input", () => {
    belongingLabelShown = true;
    updateBelongingValueLabel();
    if (isStep1EditModeActive()) updateStep1EditPreviewFromFields();
    if (step1PendingPreviewAddress) {
      const rawRate = parseFloat(getValue("belonging_rate")) || 1;
      step1PendingPreviewAddress.belonging_rate = rawRate;
      updateCurrentEmotionRingStroke(rawRate);
      updateStep1FocusCircleStroke(rawRate);
      updateStep1GeoMapMarkers();
      updateAllEmotionRingAngles();
    }
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

// "add home" button
const elAddHomeBtn = document.getElementById("addHomeBtn");

function updateAddHomeBtnState() {
  if (!elAddHomeBtn) return;
  const shouldHide = Boolean(
    elPageStep1
    && elPageStep1.classList.contains("step1-finished-state")
    && !isStep1EditModeActive(),
  );
  elAddHomeBtn.style.display = shouldHide ? "none" : "";
  if (shouldHide) return;
  const country = String(elCountry?.value || "").trim();
  const city = String(elCity?.value || "").trim();
  const cityVal = String(elCity?.value || "").trim();
  const streetVal = String(elStreet?.value || "").trim();
  const year = String(elStartYear?.value || "").trim();
  const allOk = Boolean(country && cityVal && streetVal && isValidStartYear(year) && currentAddressVerified && step1PendingPreviewAddress);
  elAddHomeBtn.classList.toggle("active", allOk);
  // Image-swap instead of textContent (which would wipe out the <img>):
  // "Save Changes" (edit mode) has no dedicated asset, so it falls back to
  // the default add-home image, same as the plain "add home" state.
  const img = elAddHomeBtn.querySelector(".btnImg");
  if (img) {
    // Reviewing homes one at a time after finish (see step1EditAfterFinish()):
    // "finish" shows specifically on the last ring in that review sequence,
    // since saving it exits edit mode instead of advancing to another one.
    const isLastInAfterFinishReview = step1EditModeAfterFinishActive
      && isStep1EditModeActive()
      && _step1EditingIdx >= (Array.isArray(addresses) ? addresses.length : 0) - 1;
    const showFinish = (!isStep1EditModeActive() && isLastHome()) || isLastInAfterFinishReview;
    img.classList.toggle("btnImgFinish", showFinish);
    img.classList.toggle("btnImgAddHome", !showFinish);
    img.src = showFinish ? "buttons/finish.png" : "buttons/add-home.png";
    img.alt = showFinish ? "finish" : "add home";
  }
}

if (elAddHomeBtn) {
  elAddHomeBtn.addEventListener("click", async () => {
    if (!elAddHomeBtn.classList.contains("active")) return;
    // Trigger the same logic as the address NEXT button.
    if (elStep1AddrNextBtn) elStep1AddrNextBtn.click();
  });
}

// Split combined "street and number" field into hidden street/number fields.
// Parse "street number" from the street+number field into hidden fields.
const elStreetAndNumber = document.getElementById("streetAndNumber");
function parseStreetAndNumber(value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) return { raw: "", street: "", number: "" };

  const houseNumberPattern = "\\d+(?:\\s*[A-Za-zא-ת])?(?:[\\/-]\\d+(?:\\s*[A-Za-zא-ת])?)?";
  const trailing = raw.match(new RegExp(`^(.+?)[\\s,]+(${houseNumberPattern})$`));
  if (trailing) {
    return { raw, street: trailing[1].trim(), number: trailing[2].replace(/\s+/g, "").trim() };
  }

  const leading = raw.match(new RegExp(`^(${houseNumberPattern})[\\s,]+(.+)$`));
  if (leading) {
    return { raw, street: leading[2].trim(), number: leading[1].replace(/\s+/g, "").trim() };
  }

  return { raw, street: raw, number: "" };
}

function syncStreetAndNumberFields() {
  if (!elStreetAndNumber) {
    return {
      raw: [String(elStreet?.value || "").trim(), String(elNumber?.value || "").trim()].filter(Boolean).join(" "),
      street: String(elStreet?.value || "").trim(),
      number: String(elNumber?.value || "").trim(),
    };
  }
  const parsed = parseStreetAndNumber(elStreetAndNumber?.value || "");
  if (elStreet) elStreet.value = parsed.street;
  if (elNumber) elNumber.value = parsed.number;
  return parsed;
}

if (elStreetAndNumber) {
  elStreetAndNumber.addEventListener("input", () => {
    syncStreetAndNumberFields();
    handleAddressFieldInput();
    updateStep1AddrNextBtnState();
    scheduleStreetMapFocus();
    // Auto-verify when street is entered.
    if (elStreet && elStreet.value.trim()) {
      scheduleVerifyCurrentAddress();
    }
  });
  elStreetAndNumber.addEventListener("blur", (evt) => {
    syncStreetAndNumberFields();
    handleAddressFieldBlur();
    if (evt?.relatedTarget === elStartYear) return;
    scheduleStreetMapFocus();
  });
  elStreetAndNumber.addEventListener("keydown", handleAddressFieldKeydown);
}

// Inline belonging slider syncs with the original one.
const elBelongingInline = document.getElementById("belonging_rate_inline");
const elBelongingInlineValue = document.querySelector(".belongingInlineValue");

function getStep1AddressClearFields() {
  return [elCountry, elCity, elStreetAndNumber, elStartYear]
    .filter((el) => el && typeof el.classList !== "undefined");
}

async function animateStep1AddressFieldsClear() {
  const fields = getStep1AddressClearFields().filter((el) => String(el.value || "").trim());
  if (!fields.length) return;
  fields.forEach((el) => el.classList.add("step1AddressFieldClearing"));
  await sleep(120);
}

function finishStep1AddressFieldsClearAnimation() {
  requestAnimationFrame(() => {
    getStep1AddressClearFields().forEach((el) => el.classList.remove("step1AddressFieldClearing"));
  });
}

function resetStep1BelongingSliderToDefault() {
  if (elBelongingRate) elBelongingRate.value = "1";
  if (elBelongingInline) {
    elBelongingInline.value = "1";
    elBelongingInline.style.setProperty("--inline-belonging-stroke", `${belongingCircleStrokeWeight(1)}px`);
  }
  if (elBelongingInlineValue) {
    elBelongingInlineValue.textContent = "01";
    elBelongingInlineValue.style.left = "8px";
  }
}

if (elBelongingInline) {
  elBelongingInline.addEventListener("input", () => {
    const val = elBelongingInline.value;
    if (elBelongingRate) elBelongingRate.value = val;
    belongingLabelShown = true;
    updateBelongingValueLabel();
    // Update thumb stroke width based on belonging rate.
    const sw = belongingCircleStrokeWeight(parseFloat(val) || 1);
    elBelongingInline.style.setProperty("--inline-belonging-stroke", `${sw}px`);
    if (typeof updateAddHomeBtnState === "function") updateAddHomeBtnState();
    const displayVal = Math.round(parseFloat(val) || 1);
    if (elBelongingInlineValue) {
      elBelongingInlineValue.textContent = displayVal < 10 ? `0${displayVal}` : String(displayVal);
      const min = 1, max = 10;
      const t = (parseFloat(val) - min) / (max - min);
      const trackW = elBelongingInline.offsetWidth || 200;
      const thumbW = 16;
      const x = t * (trackW - thumbW) + thumbW / 2;
      elBelongingInlineValue.style.left = `${x}px`;
    }
    if (isStep1EditModeActive()) updateStep1EditPreviewFromFields();
    if (step1PendingPreviewAddress) {
      step1PendingPreviewAddress.belonging_rate = parseFloat(val) || 1;
      updateCurrentEmotionRingStroke(parseFloat(val) || 1);
      updateStep1FocusCircleStroke(parseFloat(val) || 1);
      updateStep1GeoMapMarkers();
      updateAllEmotionRingAngles();
    }
  });
}

elForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (isStep1EditModeActive()) {
    updateStep1AddrNextBtnState();
    if (elStep1AddrNextBtn && elStep1AddrNextBtn.classList.contains("active")) {
      elStep1AddrNextBtn.click();
    }
    return;
  }

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
    startYear: String(elStartYear?.value || "").trim(),
    belonging_rate: normalizeBelongingRate(getValue("belonging_rate")),
    valid: true,
  };

  const prev = step1PendingPreviewAddress;
  if (prev) {
    address.lat = prev.lat;
    address.lon = prev.lon;
    address.displayName = prev.displayName || "";
  } else {
    setAddressStatus("Unexpected error. Please try again.");
    return;
  }

  addresses.push(address);
  saveJson(STORAGE_KEY, addresses);
  showAddToListMessage(addresses.length);

  // studentName now lives outside <form id="addressForm"> (on the home
  // page), so this reset() no longer touches it.
  await animateStep1AddressFieldsClear();
  elForm.reset();
  resetStep1BelongingSliderToDefault();
  finishStep1AddressFieldsClearAnimation();

  currentAddressVerified = false;
  step1PendingPreviewAddress = null;
  setAddressStatus("");
  updateAddButtonState();
  belongingLabelShown = false;
  updateBelongingValueLabel();
  renderList();
  updateStep1GeoMapMarkers();
  updateStep1GeoMapView();
  updateStep1Headers();
  renderStep1EmotionMap();
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
    updateStep2ReadingInfo();

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
      setStep2CloseReturnPage("step1");
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

    // Draw circles: keep level 1 thickness unchanged; compress higher levels so 10 is thinner.
    // Keep radius based on the belonging rate (so only thickness changes).
    circlePoints.forEach((p) => {
      const rate = clamp(p.rate, 1, 10);
      const weight = belongingCircleStrokeWeight(rate);
      const innerRadius = 11;
      const radius = innerRadius + rate / 2;
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
    const map = buildCurrentMapSnapshotPayload(studentName);

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
        map,
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
    row2.textContent = `Belonging     ${rate}/10`;

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
  updateStep1GeoMapMarkers();
  updateStep1GeoMapView();
  updateStep1Headers();
  renderStep1EmotionMap();
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
  const markers = points.map((p, index) => {
    const rate = normalizeBelongingRate(p.rate, 1);
    const innerRadius = 4;
    const radius = innerRadius + rate / 2;
    const m = L.circleMarker([p.lat, p.lon], {
      className: "lifepathStep2Dot",
      radius,
      weight: belongingCircleStrokeWeight(rate),
      opacity: 1,
      color: overlayColor,
      ...getStep2RouteDotFillStyle(),
      lifepathHomeNo: formatHomeNumber(index + 1),
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

  step2HoverResetFn = null;

  clearBelongingCircles();
}

function clearBelongingCircles() {
  if (belongingCirclesLayer) {
    belongingCirclesLayer.clearLayers();
  }
}

function normalizeHouseNumberForMatch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_/\\.,#]/g, "");
}

function houseNumberMatches(resultNumber, wantedNumber) {
  const result = normalizeHouseNumberForMatch(resultNumber);
  const wanted = normalizeHouseNumberForMatch(wantedNumber);
  return Boolean(result && wanted && result === wanted);
}

function normalizeTextForMatch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_/\\.,#'״"׳]/g, "");
}

function nominatimItemHasStreet(item, wantedStreet = "") {
  const address = item?.address || {};
  if (address.road || address.pedestrian || address.footway || address.path || address.residential) return true;
  const displayName = normalizeTextForMatch(item?.display_name);
  const street = normalizeTextForMatch(wantedStreet);
  return Boolean(displayName && street && displayName.includes(street));
}

function pickBestNominatimItem(items, addr) {
  if (!Array.isArray(items) || !items.length) return null;
  const cityMatches = items.filter((item) => nominatimItemMatchesCity(item, addr?.city));
  const scopedItems = cityMatches.length ? cityMatches : (step1ResolvedCityFocus?.key ? [] : items);
  if (!scopedItems.length && addr?.city) return null;
  const wantedNumber = normalizeHouseNumberForMatch(addr?.number);
  if (!wantedNumber) return scopedItems[0] || items[0];

  const exactHouse = scopedItems.find((item) => houseNumberMatches(item?.address?.house_number, wantedNumber));
  if (exactHouse) return exactHouse;

  const displayMatch = scopedItems.find((item) => {
    const displayName = normalizeHouseNumberForMatch(item?.display_name);
    return Boolean(displayName && displayName.includes(wantedNumber));
  });
  if (displayMatch) return displayMatch;

  const streetMatch = scopedItems.find((item) => nominatimItemHasStreet(item, addr?.street));
  if (streetMatch) return streetMatch;

  return scopedItems[0] || null;
}

function parseHouseNumberValue(value) {
  const match = String(value || "").match(/\d+(?:[\.,]\d+)?/);
  if (!match) return NaN;
  return Number(match[0].replace(",", "."));
}

function escapeOverpassRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getOverpassElementLatLon(element) {
  const lat = Number(element?.lat ?? element?.center?.lat);
  const lon = Number(element?.lon ?? element?.center?.lon);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return { lat, lon };
}

function getNominatimStreetNames(item, fallbackStreet = "") {
  const address = item?.address || {};
  const names = [
    fallbackStreet,
    address.road,
    address.pedestrian,
    address.footway,
    address.path,
    address.residential,
    item?.namedetails?.name,
    item?.namedetails?.["name:he"],
    item?.namedetails?.["name:en"],
  ]
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  return names.filter((name, index, arr) => arr.findIndex((other) => normalizeTextForMatch(other) === normalizeTextForMatch(name)) === index);
}

function overpassStreetFilterForNames(streetNames) {
  const parts = streetNames
    .map((name) => escapeOverpassRegex(name))
    .filter(Boolean);
  if (!parts.length) return null;
  return parts.join("|");
}

function overpassHouseNumberElements(data, streetNames) {
  const normalizedNames = streetNames.map((name) => normalizeTextForMatch(name)).filter(Boolean);
  return (Array.isArray(data?.elements) ? data.elements : [])
    .filter((element) => {
      const elementStreet = normalizeTextForMatch(element?.tags?.["addr:street"] || "");
      if (!normalizedNames.length || !elementStreet) return true;
      return normalizedNames.some((name) => elementStreet.includes(name) || name.includes(elementStreet));
    });
}

async function estimateHouseNumberLocation(addr, anchorItem) {
  const wantedNumber = parseHouseNumberValue(addr?.number);
  const street = String(addr?.street || "").trim();
  const anchorLat = Number(anchorItem?.lat);
  const anchorLon = Number(anchorItem?.lon);
  if (!isFinite(wantedNumber) || !street || !isFinite(anchorLat) || !isFinite(anchorLon)) return null;

  const streetNames = getNominatimStreetNames(anchorItem, street);
  const streetRegex = overpassStreetFilterForNames(streetNames);
  if (!streetRegex) return null;
  const query = `
[out:json][timeout:10];
(
  node(around:8000,${anchorLat},${anchorLon})["addr:street"~"${streetRegex}",i]["addr:housenumber"];
  way(around:8000,${anchorLat},${anchorLon})["addr:street"~"${streetRegex}",i]["addr:housenumber"];
  relation(around:8000,${anchorLat},${anchorLon})["addr:street"~"${streetRegex}",i]["addr:housenumber"];
);
out center tags 100;
`;

  let data = null;
  try {
    const proxyRes = await fetch("/api/overpass", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (proxyRes.ok) {
      const payload = await proxyRes.json();
      if (payload?.ok && payload?.data) data = payload.data;
    }
  } catch {
    data = null;
  }

  if (!data) {
    const url = new URL("https://overpass-api.de/api/interpreter");
    url.searchParams.set("data", query);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(url.toString(), { signal: controller.signal, headers: { "Accept": "application/json" } });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) return null;
    data = await res.json();
  }

  const points = overpassHouseNumberElements(data, streetNames)
    .map((element) => {
      const pos = getOverpassElementLatLon(element);
      const rawNumber = element?.tags?.["addr:housenumber"];
      const num = parseHouseNumberValue(rawNumber);
      if (!pos || !isFinite(num)) return null;
      return { ...pos, num, rawNumber };
    })
    .filter(Boolean)
    .sort((a, b) => a.num - b.num);

  if (!points.length) return null;

  const exact = points.find((point) => houseNumberMatches(point.rawNumber, addr.number));
  if (exact) return { lat: exact.lat, lon: exact.lon, estimated: false };

  if (points.length === 1) return { lat: points[0].lat, lon: points[0].lon, estimated: true };

  let lower = null;
  let upper = null;
  for (const point of points) {
    if (point.num < wantedNumber) lower = point;
    if (point.num > wantedNumber) { upper = point; break; }
  }

  let a = lower;
  let b = upper;
  if (!a || !b) {
    const nearest = points
      .slice()
      .sort((p1, p2) => Math.abs(p1.num - wantedNumber) - Math.abs(p2.num - wantedNumber))
      .slice(0, 2)
      .sort((p1, p2) => p1.num - p2.num);
    a = nearest[0];
    b = nearest[1];
  }
  if (!a || !b || a.num === b.num) return { lat: a?.lat ?? anchorLat, lon: a?.lon ?? anchorLon, estimated: true };

  const rawT = (wantedNumber - a.num) / (b.num - a.num);
  const t = Math.max(-0.25, Math.min(1.25, rawT));
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    estimated: true,
  };
}

async function geocodeAddress(addr, options = {}) {
  const key = canonicalKey(addr);
  const cached = geocodeCache[key];
  const wantsExactAddress = Boolean(String(addr.street || "").trim() && String(addr.number || "").trim());

  const exactLocal = exactKiryatBialikKerenHayesod160Location(addr);
  if (exactLocal) {
    const normalized = {
      street: toEnglishLike(tidyToken(addr.street || "Keren HaYesod")),
      number: toEnglishLike(tidyToken(addr.number || "160")),
      city: toEnglishLike(tidyToken(addr.city || "Kiryat Bialik")),
      country: toEnglishLike(tidyToken(addr.country || "Israel")),
    };
    const record = {
      lat: exactLocal.lat,
      lon: exactLocal.lon,
      displayName: exactLocal.displayName,
      normalized,
      matchLevel: "address",
      ts: Date.now(),
    };
    geocodeCache[key] = record;
    saveJson(GEOCODE_CACHE_KEY, geocodeCache);
    return record;
  }

  if (cached && isFinite(cached.lat) && isFinite(cached.lon)) {
    const isExactCache = cached.matchLevel === "address";
    const isPlaceCache = cached.matchLevel === "place";
    const cacheMatchesNumber = !wantsExactAddress || houseNumberMatches(cached.normalized?.number, addr.number);
    if (!(options.ignorePlaceCache && isPlaceCache) && !(wantsExactAddress && (!isExactCache || !cacheMatchesNumber))) return cached;
  }

  const queryOriginal = buildQuery(addr);
  const queryLatin = buildQueryLatin(addr);

  const fetchNominatim = async (query) => {
    const params = {
      format: "json",
      limit: "20",
      dedupe: "0",
      "accept-language": "en",
      addressdetails: "1",
      namedetails: "1",
      extratags: "1",
      q: query,
    };
    let data = null;
    try {
      const proxyRes = await fetch("/api/nominatim", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ params }),
      });
      if (proxyRes.ok) {
        const proxyPayload = await proxyRes.json();
        if (proxyPayload && proxyPayload.ok && Array.isArray(proxyPayload.data)) data = proxyPayload.data;
      }
    } catch {
      data = null;
    }

    if (!data) {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      let res;
      try {
        res = await fetch(url.toString(), {
          signal: controller.signal,
          headers: { "Accept": "application/json", "Accept-Language": "en" },
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
      data = await res.json();
    }

    if (!Array.isArray(data) || data.length === 0) return null;
    return pickBestNominatimItem(data, addr);
  };

  const fetchNominatimStreetAnchor = async () => {
    const streetQuery = [addr.street, addr.city, addr.state, addr.country]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(", ");
    if (!streetQuery) return null;
    return fetchNominatim(streetQuery);
  };

  const streetAndNumber = String(addr._origStreetAndNumber || [addr.street, addr.number].filter(Boolean).join(" ")).trim();
  const numberAndStreet = [addr.number, addr.street].filter(Boolean).join(" ").trim();
  const streetFirst = [addr.street, addr.number].filter(Boolean).join(" ").trim();
  const rawQueries = [
    [streetAndNumber, addr.city, addr.state, addr.country],
    [numberAndStreet, addr.city, addr.state, addr.country],
    [streetFirst, addr.city, addr.state, addr.country],
    [addr.street, addr.city, addr.state, addr.country],
    [queryOriginal],
    [queryLatin],
    ...(wantsExactAddress ? [] : [[addr.city, addr.state, addr.country]]),
  ];
  const queries = rawQueries
    .map((parts) => parts.map((part) => String(part || "").trim()).filter(Boolean).join(", "))
    .filter((query, index, arr) => query && arr.indexOf(query) === index);

  let item = null;
  let usedQuery = queryOriginal;
  let fallbackItem = null;
  let fallbackQuery = queryOriginal;
  for (const query of queries) {
    const candidate = await fetchNominatim(query);
    if (!candidate) continue;

    if (!fallbackItem) {
      fallbackItem = candidate;
      fallbackQuery = query;
    }

    if (!wantsExactAddress || houseNumberMatches(candidate.address?.house_number, addr.number)) {
      item = candidate;
      usedQuery = query;
      break;
    }
  }

  if (!item && fallbackItem) {
    item = fallbackItem;
    usedQuery = fallbackQuery;
  }

  if (!item) {
    throw new Error(`No results for: ${queryOriginal}`);
  }

  let houseEstimate = null;
  if (wantsExactAddress && !houseNumberMatches(item.address?.house_number, addr.number)) {
    houseEstimate = await estimateHouseNumberLocation(addr, item).catch(() => null);
    if (!houseEstimate && !nominatimItemHasStreet(item, addr.street)) {
      const streetAnchor = await fetchNominatimStreetAnchor().catch(() => null);
      if (streetAnchor) houseEstimate = await estimateHouseNumberLocation(addr, streetAnchor).catch(() => null);
    }
  }

  const lat = Number(houseEstimate?.lat ?? item.lat);
  const lon = Number(houseEstimate?.lon ?? item.lon);
  if (!isFinite(lat) || !isFinite(lon)) {
    throw new Error(`Invalid coordinates for: ${usedQuery}`);
  }

  const displayFromNominatim = String(item.display_name || "").trim();
  let displayName = displayFromNominatim;

  // Normalize to the requested 4 fields (country, city, street, number).
  const addressDetails = item.address || {};
  const normStreet = tidyToken(addressDetails.road || addressDetails.pedestrian || addressDetails.footway || addressDetails.path || addr.street || "");
  const normNumber = tidyToken(addressDetails.house_number || addr.number || "");
  const normCity = tidyToken(addressDetails.village || addressDetails.town || addressDetails.city || addressDetails.municipality || addr.city || "");
  const normCountry = tidyToken(addressDetails.country || addr.country || "");
  const normalized = {
    street: toEnglishLike(normStreet),
    number: toEnglishLike(normNumber),
    city: toEnglishLike(normCity),
    country: toEnglishLike(normCountry),
  };

  if (!displayName || containsHebrew(displayName)) {
    const a = item.address || {};
    const road = a.road || a.pedestrian || a.footway || a.path || "";
    const houseNumber = a.house_number || "";
    const city = a.city || a.town || a.village || a.municipality || "";
    const country = a.country || "";

    const line1 = [road, houseNumber].filter(Boolean).join(" ").trim();
    const parts = [line1, city, country].filter(Boolean);
    displayName = parts.join(", ") || displayFromNominatim || usedQuery;
  }

  displayName = formatStandardAddress(normalized) || toEnglishLike(displayName || usedQuery);
  const matchLevel = wantsExactAddress
    ? (houseNumberMatches(item.address?.house_number, addr.number) || houseEstimate ? "address" : (nominatimItemHasStreet(item, addr.street) ? "street" : "place"))
    : (item.address?.house_number ? "address" : "place");

  if (wantsExactAddress && matchLevel === "place") {
    throw new Error(`No address or street-level result for: ${queryOriginal}`);
  }

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
  const left = a._origStreetAndNumber
    || [a._origStreet || a.street, a._origNumber || a.number].filter(Boolean).join(" ");
  const city = a._origCity || a.city;
  const country = a._origCountry || a.country;
  const right = [city, a.state, country].filter(Boolean).join(", ");
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
  step1SummaryPhaseActive = false;
  // Unlike resetStep1HouseList(), this was missing the phase-class cleanup —
  // leaving e.g. step1-finished-state/step1-summary-phase on the page after
  // clearing the data meant Step 1 stayed styled as "finished" (data-entry
  // fields still hidden) with nothing behind it to show, effectively stuck.
  if (elPageStep1) {
    elPageStep1.classList.remove(
      "step1-address-phase",
      "step1-belonging-phase",
      "step1-summary-phase",
      "step1-finished-state",
      "step1-archive-loaded"
    );
  }
  step1DashboardGrown = false;
  renderList();
  try {
    updateStep1HomesList();
    if (elStep1TimeBelongingChart) elStep1TimeBelongingChart.innerHTML = "";
    _tbSvg = null;
    _tbPoints = [];
    _tbDurPoints = [];
    if (elStep1RingReadingContent) elStep1RingReadingContent.innerHTML = "";
    _step1RingReadingHoveredPath = null;
    _step1RingReadingRenderKey = "";
    hideStep1RingReadingTooltip();
    clearStep1GeoMapState();
  } catch {
    // ignore
  }
  clearMap();

  // Clear Step 1 name + editing pointers.
  try {
    if (elStudentName) elStudentName.value = "";
  } catch {
    // ignore
  }
  currentEditingSnapshot = null;
  currentLoadedMapDisplayName = "";
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
    renderStep1EmotionMap();
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
