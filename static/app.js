(() => {
  const SERIES_VARS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5"];
  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const MONTH_LOOKUP = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };

  // Accepts "June 2026", "jun 2026", "2026 june", "2026-06", "06/2026", or a bare "2026".
  function parseQuickDate(text) {
    const s = text.trim().toLowerCase().replace(/\s+/g, " ");
    if (!s) return null;

    let m = s.match(/^(\d{4})[-/](\d{1,2})$/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return { year: +m[1], month: +m[2] };

    m = s.match(/^(\d{1,2})[-/](\d{4})$/);
    if (m && +m[1] >= 1 && +m[1] <= 12) return { year: +m[2], month: +m[1] };

    m = s.match(/^([a-z]+)\.?\s+(\d{4})$/);
    if (m && MONTH_LOOKUP[m[1]]) return { year: +m[2], month: MONTH_LOOKUP[m[1]] };

    m = s.match(/^(\d{4})\s+([a-z]+)\.?$/);
    if (m && MONTH_LOOKUP[m[2]]) return { year: +m[1], month: MONTH_LOOKUP[m[2]] };

    m = s.match(/^(\d{4})$/);
    if (m) return { year: +m[1], month: null };

    return null;
  }

  function quickDateToRange({ year, month }) {
    if (month) {
      const from = `${year}-${String(month).padStart(2, "0")}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      return { from, to };
    }
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }

  const state = {
    allRows: [],
    filteredOrdered: [],
    platforms: [],
    chartPlatforms: [],
    names: [],
    selectedPlatforms: new Set(),
    selectedNames: new Set(),
    search: "",
    dateFrom: "",
    dateTo: "",
    offset: 0,
    headOffset: 0,
    limit: 60,
    total: 0,
    loading: false,
    done: false,
    sort: "asc",
    timelineGranularity: "month",
    timelineZoom: 1,
  };

  const CONTEXT_BEFORE = 30;
  const CONTEXT_AFTER = 30;
  const TIMELINE_ZOOM_MIN = 1;
  const TIMELINE_ZOOM_MAX = 8;
  let lastTimeline = [];

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function colorForPlatform(platform) {
    const idx = state.platforms.indexOf(platform);
    const varName = SERIES_VARS[idx % SERIES_VARS.length] || SERIES_VARS[0];
    return cssVar(varName);
  }

  // Visualizations roll instagram (main)/(spam) back up into one "instagram"
  // series, so they use their own stable ordering/color slots distinct from
  // the split filter-chip list.
  function colorForChartPlatform(platform) {
    const idx = state.chartPlatforms.indexOf(platform);
    const varName = SERIES_VARS[idx % SERIES_VARS.length] || SERIES_VARS[0];
    return cssVar(varName);
  }

  function collapsePlatform(p) {
    return p.replace(/ \((main|spam|personal)\)$/, "");
  }

  const NAME_COLORS = { Vedh: "--name-blue", Tanvi: "--name-red" };
  function colorForName(name) {
    return cssVar(NAME_COLORS[name] || "--text-muted");
  }

  function fmtNum(n) {
    return n.toLocaleString();
  }

  function fmtDateTime(iso) {
    if (!iso) return "";
    const [d, t] = iso.split(" ");
    if (!t) return d;
    let [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${d} ${h}:${String(m).padStart(2, "0")} ${ampm}`;
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------- CSV parsing ----------

  // Minimal RFC4180 parser: handles quoted fields, embedded commas/newlines,
  // and doubled-quote escaping ("" -> ").
  function parseCsv(text) {
    const rows = [];
    const len = text.length;
    let pos = 0;
    let row = [];
    while (pos < len) {
      let field;
      if (text.charCodeAt(pos) === 34 /* " */) {
        pos++;
        let start = pos;
        const parts = [];
        for (;;) {
          const q = text.indexOf('"', pos);
          if (q === -1) { parts.push(text.slice(start)); pos = len; break; }
          if (text.charCodeAt(q + 1) === 34) {
            parts.push(text.slice(start, q + 1));
            pos = q + 2;
            start = pos;
            continue;
          }
          parts.push(text.slice(start, q));
          pos = q + 1;
          break;
        }
        field = parts.length === 1 ? parts[0] : parts.join("");
      } else {
        const start = pos;
        while (pos < len) {
          const code = text.charCodeAt(pos);
          if (code === 44 || code === 10 || code === 13) break;
          pos++;
        }
        field = text.slice(start, pos);
      }
      row.push(field);
      if (pos >= len) { rows.push(row); break; }
      const code = text.charCodeAt(pos);
      if (code === 44) { pos++; continue; }
      if (code === 13) { pos++; if (text.charCodeAt(pos) === 10) pos++; rows.push(row); row = []; continue; }
      if (code === 10) { pos++; rows.push(row); row = []; continue; }
    }
    return rows;
  }

  // Instagram is one platform in the raw data, but two functionally distinct
  // inboxes (main account vs. spam/throwaway accounts) distinguishable only via
  // original_account_name. Hangouts similarly splits into the group chat vs.
  // the personal 1:1 export. Split each into its own filterable pseudo-platform,
  // mirroring what the old server-side PLATFORM_EXPR did.
  function buildRows(parsed) {
    if (!parsed.length) return [];
    const header = parsed[0];
    const idx = {};
    header.forEach((h, i) => { idx[h.trim()] = i; });
    const rows = [];
    for (let i = 1; i < parsed.length; i++) {
      const r = parsed[i];
      if (r.length === 1 && r[0] === "") continue; // stray trailing blank line
      const platform = r[idx.platform] || "";
      const originalAccountName = r[idx.original_account_name] || "";
      let platformSplit = platform;
      if (platform === "instagram") {
        if (originalAccountName.includes("(main)")) platformSplit = "instagram (main)";
        else if (originalAccountName.includes("(spam)")) platformSplit = "instagram (spam)";
      } else if (platform === "hangouts") {
        if (originalAccountName.includes("(personal)")) platformSplit = "hangouts (personal)";
      }
      rows.push({
        name: r[idx.name] || "",
        message_content: r[idx.message_content] || "",
        date: r[idx.date] || "",
        platform,
        platformSplit,
        original_account_name: originalAccountName,
      });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // Stable identity for each row, independent of any filter/sort applied
    // later — used to jump from a search hit back to its place in the
    // full timeline ("view in context").
    rows.forEach((r, i) => { r.idx = i; });
    return rows;
  }

  // ---------- local persistence (IndexedDB) ----------

  const DB_NAME = "message-archive";
  const STORE_NAME = "csv";
  const RECORD_KEY = "latest";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getCachedCsv() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveCachedCsv(text, filename) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ text, filename, importedAt: Date.now() }, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearCachedCsv() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------- meta / filters ----------

  function computeMeta(rows) {
    const platforms = new Set();
    const chartPlatforms = new Set();
    const names = new Set();
    let minDate = null, maxDate = null;
    rows.forEach((r) => {
      platforms.add(r.platformSplit);
      chartPlatforms.add(r.platform);
      names.add(r.name);
      if (minDate === null || r.date < minDate) minDate = r.date;
      if (maxDate === null || r.date > maxDate) maxDate = r.date;
    });
    return {
      platforms: [...platforms].sort(),
      chartPlatforms: [...chartPlatforms].sort(),
      names: [...names].sort(),
      total: rows.length,
      min_date: minDate,
      max_date: maxDate,
    };
  }

  function renderMetaUI(meta) {
    state.platforms = meta.platforms;
    state.chartPlatforms = meta.chartPlatforms;
    state.names = meta.names;

    document.getElementById("totalCount").textContent =
      `${fmtNum(meta.total)} messages · ${meta.min_date?.slice(0,10)} → ${meta.max_date?.slice(0,10)}`;

    const platformFilter = document.getElementById("platformFilter");
    platformFilter.innerHTML = "";
    meta.platforms.forEach((p) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.dataset.value = p;
      const dot = document.createElement("span");
      dot.className = "chip-dot";
      dot.style.background = colorForPlatform(p);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(p));
      chip.addEventListener("click", () => {
        toggleSetValue(state.selectedPlatforms, p);
        chip.classList.toggle("active");
        refreshAll();
      });
      platformFilter.appendChild(chip);
    });

    const nameFilter = document.getElementById("nameFilter");
    nameFilter.innerHTML = "";
    meta.names.forEach((n) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.dataset.value = n;
      const dot = document.createElement("span");
      dot.className = "chip-dot";
      dot.style.background = colorForName(n);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(n));
      chip.addEventListener("click", () => {
        toggleSetValue(state.selectedNames, n);
        chip.classList.toggle("active");
        refreshAll();
      });
      nameFilter.appendChild(chip);
    });
  }

  function toggleSetValue(set, v) {
    if (set.has(v)) set.delete(v); else set.add(v);
  }

  function clearFilters() {
    state.selectedPlatforms.clear();
    state.selectedNames.clear();
    state.search = "";
    state.dateFrom = "";
    state.dateTo = "";
    document.getElementById("searchInput").value = "";
    document.getElementById("dateFrom").value = "";
    document.getElementById("dateTo").value = "";
    document.getElementById("dateQuick").value = "";
    document.getElementById("dateQuick").classList.remove("input-invalid");
    document.querySelectorAll(".chip.active").forEach((c) => c.classList.remove("active"));
    refreshAll();
  }

  // ---------- filtering / stats (all computed in-memory) ----------

  function applyFilters(rows) {
    const hasPlatforms = state.selectedPlatforms.size > 0;
    const hasNames = state.selectedNames.size > 0;
    const dateFrom = state.dateFrom;
    const dateTo = state.dateTo ? state.dateTo + " 23:59:59" : "";
    const search = state.search.trim().toLowerCase();
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (hasPlatforms && !state.selectedPlatforms.has(r.platformSplit)) continue;
      if (hasNames && !state.selectedNames.has(r.name)) continue;
      if (dateFrom && r.date < dateFrom) continue;
      if (dateTo && r.date > dateTo) continue;
      if (search && !r.message_content.toLowerCase().includes(search)) continue;
      out.push(r);
    }
    return out;
  }

  // rows arrive pre-sorted ascending by date; only reverse for desc display.
  function computeFilteredOrdered() {
    const filtered = applyFilters(state.allRows);
    return state.sort === "desc" ? filtered.slice().reverse() : filtered;
  }

  function computeStats(rows) {
    const timelineMap = new Map();
    const totalsMap = new Map();
    const hourArr = new Array(24).fill(0);
    rows.forEach((r) => {
      const month = r.date.slice(0, 7);
      const key = month + "|" + r.platform;
      timelineMap.set(key, (timelineMap.get(key) || 0) + 1);
      totalsMap.set(r.platform, (totalsMap.get(r.platform) || 0) + 1);
      const hr = parseInt(r.date.slice(11, 13), 10);
      if (!Number.isNaN(hr)) hourArr[hr]++;
    });
    const timeline = [...timelineMap.entries()]
      .map(([k, cnt]) => {
        const i = k.indexOf("|");
        return { month: k.slice(0, i), platform: k.slice(i + 1), cnt };
      })
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
    const totals = [...totalsMap.entries()]
      .map(([platform, cnt]) => ({ platform, cnt }))
      .sort((a, b) => b.cnt - a.cnt);
    const by_hour = hourArr.map((cnt, hr) => ({ hr, cnt })).filter((d) => d.cnt > 0);
    return { timeline, totals, by_hour };
  }

  function loadStats() {
    const stats = computeStats(state.filteredOrdered);
    renderTimelineChart(stats.timeline);
    renderTotalsChart(stats.totals);
    renderHourChart(stats.by_hour);
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // Rolls the (always monthly) stats timeline up into years when the user
  // has picked year granularity.
  function bucketTimeline(timeline, granularity) {
    if (granularity !== "year") {
      return timeline.map((d) => ({ bucket: d.month, platform: d.platform, cnt: d.cnt }));
    }
    const map = new Map();
    timeline.forEach((d) => {
      const year = d.month.slice(0, 4);
      const key = year + "|" + d.platform;
      map.set(key, (map.get(key) || 0) + d.cnt);
    });
    return [...map.entries()]
      .map(([k, cnt]) => {
        const i = k.indexOf("|");
        return { bucket: k.slice(0, i), platform: k.slice(i + 1), cnt };
      })
      .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
  }

  function formatBucketLabel(bucket, granularity) {
    if (granularity === "year") return bucket;
    const [y, m] = bucket.split("-");
    return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
  }

  function setTimelineZoom(zoom) {
    state.timelineZoom = Math.min(TIMELINE_ZOOM_MAX, Math.max(TIMELINE_ZOOM_MIN, zoom));
    document.getElementById("zoomLevelLabel").textContent = `${Math.round(state.timelineZoom * 100)}%`;
    renderTimelineChart(lastTimeline);
  }

  function renderTimelineChart(timeline) {
    lastTimeline = timeline;
    const container = document.getElementById("timelineChart");
    const legendEl = document.getElementById("timelineLegend");
    container.innerHTML = "";
    legendEl.innerHTML = "";

    const platforms = state.chartPlatforms.length ? state.chartPlatforms : [...new Set(timeline.map(d => d.platform))];
    // Filter chips use the split instagram (main)/(spam) labels, but the
    // chart data is collapsed back to "instagram" — map selections down to
    // chart-platform names to decide what's active/muted.
    const activeSet = state.selectedPlatforms.size
      ? new Set([...state.selectedPlatforms].map(collapsePlatform))
      : new Set(platforms);
    const shownPlatforms = platforms.filter((p) => activeSet.has(p));

    // legend (always visible text labels alongside color dot)
    platforms.forEach((p) => {
      const item = document.createElement("div");
      item.className = "legend-item" + (shownPlatforms.includes(p) ? "" : " muted");
      const dot = document.createElement("span");
      dot.className = "legend-dot";
      dot.style.background = colorForChartPlatform(p);
      item.appendChild(dot);
      item.appendChild(document.createTextNode(p));
      legendEl.appendChild(item);
    });

    const granularity = state.timelineGranularity;
    const bucketed = bucketTimeline(timeline, granularity);
    const buckets = [...new Set(bucketed.map((d) => d.bucket))].sort();
    if (buckets.length === 0) {
      container.innerHTML = '<div class="list-status">No data</div>';
      return;
    }

    const byPlatform = {};
    shownPlatforms.forEach((p) => { byPlatform[p] = new Array(buckets.length).fill(0); });
    bucketed.forEach((d) => {
      if (!byPlatform[d.platform]) return;
      const idx = buckets.indexOf(d.bucket);
      byPlatform[d.platform][idx] = d.cnt;
    });

    // The container is horizontally scrollable; the SVG's pixel width tracks
    // the zoom level 1:1 (zoom 1 = fit the visible container, no scroll).
    const H = 220, padL = 36, padR = 8, padT = 10, padB = 24;
    const fitW = Math.max(1, container.clientWidth || 1000);
    const W = Math.round(fitW * state.timelineZoom);
    const innerW = W - padL - padR, innerH = H - padT - padB;

    let maxY = 1;
    Object.values(byPlatform).forEach((arr) => arr.forEach((v) => { if (v > maxY) maxY = v; }));
    maxY = niceCeil(maxY);

    const xStep = buckets.length > 1 ? innerW / (buckets.length - 1) : 0;
    const xAt = (i) => padL + i * xStep;
    const yAt = (v) => padT + innerH - (v / maxY) * innerH;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
    svg.style.width = W + "px";

    // gridlines (0, mid, max)
    [0, 0.5, 1].forEach((f) => {
      const y = padT + innerH * (1 - f);
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y, y2: y, class: "gridline" }));
      const label = svgEl("text", { x: 4, y: y + 3, class: "axis-label" });
      label.textContent = fmtNum(Math.round(maxY * f));
      svg.appendChild(label);
    });

    // x labels: as many ticks as fit legibly — more space (zoomed in) shows more.
    const minLabelSpacing = granularity === "year" ? 50 : 70;
    const tickCount = Math.min(buckets.length, Math.max(2, Math.floor(innerW / minLabelSpacing)));
    for (let t = 0; t < tickCount; t++) {
      const idx = Math.round((t / Math.max(1, tickCount - 1)) * (buckets.length - 1));
      const label = svgEl("text", { x: xAt(idx), y: H - 6, class: "axis-label", "text-anchor": "middle" });
      label.textContent = formatBucketLabel(buckets[idx], granularity);
      svg.appendChild(label);
    }

    svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: padT + innerH, y2: padT + innerH, class: "baseline" }));

    shownPlatforms.forEach((p) => {
      const color = colorForChartPlatform(p);
      const arr = byPlatform[p];
      const points = arr.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" ");
      svg.appendChild(svgEl("polyline", {
        points, fill: "none", stroke: color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round",
      }));
    });

    // hover layer
    const hoverGroup = svgEl("g", { class: "hover-layer", style: "display:none" });
    const crosshair = svgEl("line", { class: "crosshair", y1: padT, y2: padT + innerH });
    hoverGroup.appendChild(crosshair);
    const hoverDots = {};
    shownPlatforms.forEach((p) => {
      const dot = svgEl("circle", { r: 4, fill: colorForChartPlatform(p), stroke: cssVar("--surface-1"), "stroke-width": 2 });
      hoverGroup.appendChild(dot);
      hoverDots[p] = dot;
    });
    svg.appendChild(hoverGroup);

    const hitRect = svgEl("rect", { x: padL, y: padT, width: innerW, height: innerH, fill: "transparent" });
    svg.appendChild(hitRect);

    container.style.position = "relative";
    container.appendChild(svg);

    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    container.appendChild(tooltip);

    hitRect.addEventListener("mousemove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = W / rect.width;
      const mx = (ev.clientX - rect.left) * scaleX;
      let idx = Math.round((mx - padL) / (xStep || 1));
      idx = Math.max(0, Math.min(buckets.length - 1, idx));

      hoverGroup.style.display = "";
      crosshair.setAttribute("x1", xAt(idx));
      crosshair.setAttribute("x2", xAt(idx));

      let rows = "";
      shownPlatforms.forEach((p) => {
        const v = byPlatform[p][idx];
        hoverDots[p].setAttribute("cx", xAt(idx));
        hoverDots[p].setAttribute("cy", yAt(v));
        rows += `<div class="tt-row"><span class="tt-dot" style="background:${colorForChartPlatform(p)}"></span>${escapeHtml(p)}: ${fmtNum(v)}</div>`;
      });
      tooltip.innerHTML = `<div class="tt-date">${formatBucketLabel(buckets[idx], granularity)}</div>${rows}`;
      tooltip.style.display = "block";

      const cx = ev.clientX - rect.left;
      const cy = ev.clientY - rect.top;
      let left = cx + 14, top = cy - 10;
      // Flip based on the *visible* (scrolled) viewport, not the full
      // (possibly zoomed-wide) content width, so the tooltip never renders
      // off past the edge the user can actually see.
      if (ev.clientX - container.getBoundingClientRect().left + 160 > container.clientWidth) left = cx - 160;
      tooltip.style.left = left + "px";
      tooltip.style.top = Math.max(0, top) + "px";
    });

    hitRect.addEventListener("mouseleave", () => {
      hoverGroup.style.display = "none";
      tooltip.style.display = "none";
    });

    // Ctrl/Cmd + wheel zooms (centered on the cursor); plain wheel pans
    // horizontally through the timeline, since there's nothing to scroll
    // vertically.
    if (!container.dataset.wheelBound) {
      container.dataset.wheelBound = "1";
      container.addEventListener("wheel", (ev) => {
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          const rect = container.getBoundingClientRect();
          const cursorX = ev.clientX - rect.left;
          const contentX = container.scrollLeft + cursorX;
          const ratio = contentX / container.scrollWidth;
          const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
          state.timelineZoom = Math.min(TIMELINE_ZOOM_MAX, Math.max(TIMELINE_ZOOM_MIN, state.timelineZoom * factor));
          document.getElementById("zoomLevelLabel").textContent = `${Math.round(state.timelineZoom * 100)}%`;
          renderTimelineChart(lastTimeline);
          container.scrollLeft = ratio * container.scrollWidth - cursorX;
        } else if (container.scrollWidth > container.clientWidth) {
          // Covers both a plain vertical mouse wheel (deltaY) and a
          // trackpad's horizontal two-finger swipe (deltaX) — exactly one
          // is normally nonzero per gesture.
          ev.preventDefault();
          container.scrollLeft += ev.deltaX + ev.deltaY;
          // This listener is bound once and outlives re-renders, so the
          // hover layer/tooltip it originally closed over may already be
          // detached — query the live ones and hide them, since panning
          // without a fresh mousemove leaves them pointing at stale data.
          const hoverLayer = container.querySelector(".hover-layer");
          if (hoverLayer) hoverLayer.style.display = "none";
          const liveTooltip = container.querySelector(".chart-tooltip");
          if (liveTooltip) liveTooltip.style.display = "none";
        }
      }, { passive: false });
    }

    // Click-and-drag panning (the container's cursor:grab CSS advertises this).
    if (!container.dataset.dragBound) {
      container.dataset.dragBound = "1";
      let dragging = false, dragStartX = 0, dragStartScrollLeft = 0;
      container.addEventListener("pointerdown", (ev) => {
        if (container.scrollWidth <= container.clientWidth) return;
        dragging = true;
        dragStartX = ev.clientX;
        dragStartScrollLeft = container.scrollLeft;
        container.setPointerCapture(ev.pointerId);
      });
      container.addEventListener("pointermove", (ev) => {
        if (!dragging) return;
        container.scrollLeft = dragStartScrollLeft - (ev.clientX - dragStartX);
      });
      const endDrag = () => { dragging = false; };
      container.addEventListener("pointerup", endDrag);
      container.addEventListener("pointercancel", endDrag);
    }
  }

  function niceCeil(v) {
    if (v <= 10) return Math.ceil(v);
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    let nice;
    if (norm <= 1) nice = 1;
    else if (norm <= 2) nice = 2;
    else if (norm <= 5) nice = 5;
    else nice = 10;
    return nice * mag;
  }

  function renderTotalsChart(totals) {
    const container = document.getElementById("totalsChart");
    container.innerHTML = "";
    if (!totals.length) {
      container.innerHTML = '<div class="list-status">No data</div>';
      return;
    }
    const W = 480, H = 200, padL = 10, padR = 10, padT = 20, padB = 24;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxV = niceCeil(Math.max(...totals.map((t) => t.cnt)));
    const n = totals.length;
    const gap = 18;
    const barW = Math.min(48, (innerW - gap * (n - 1)) / n);
    const totalBarsW = barW * n + gap * (n - 1);
    const startX = padL + (innerW - totalBarsW) / 2;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
    svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: padT + innerH, y2: padT + innerH, class: "baseline" }));

    totals.forEach((t, i) => {
      const x = startX + i * (barW + gap);
      const h = (t.cnt / maxV) * innerH;
      const y = padT + innerH - h;
      const color = colorForChartPlatform(t.platform);
      const rectG = svgEl("path", {
        d: roundedTopBarPath(x, y, barW, h, 4),
        fill: color,
      });
      svg.appendChild(rectG);

      const valLabel = svgEl("text", { x: x + barW / 2, y: y - 6, class: "bar-label", "text-anchor": "middle" });
      valLabel.textContent = fmtNum(t.cnt);
      svg.appendChild(valLabel);

      const nameLabel = svgEl("text", { x: x + barW / 2, y: H - 6, class: "axis-label", "text-anchor": "middle" });
      nameLabel.textContent = t.platform;
      svg.appendChild(nameLabel);
    });

    container.appendChild(svg);
  }

  function roundedTopBarPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    if (h <= 0) return "";
    return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
  }

  function renderHourChart(byHour) {
    const container = document.getElementById("hourChart");
    container.innerHTML = "";
    const data = new Array(24).fill(0);
    byHour.forEach((d) => { data[d.hr] = d.cnt; });

    const W = 480, H = 200, padL = 22, padR = 10, padT = 14, padB = 22;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxV = niceCeil(Math.max(1, ...data));
    const barGap = 2;
    const barW = innerW / 24 - barGap;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
    [0, 1].forEach((f) => {
      const y = padT + innerH * (1 - f);
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y, y2: y, class: "gridline" }));
      const label = svgEl("text", { x: 2, y: y + 3, class: "axis-label" });
      label.textContent = fmtNum(Math.round(maxV * f));
      svg.appendChild(label);
    });

    const color = cssVar("--series-1");
    data.forEach((v, h) => {
      const x = padL + h * (barW + barGap);
      const hgt = (v / maxV) * innerH;
      const y = padT + innerH - hgt;
      svg.appendChild(svgEl("path", { d: roundedTopBarPath(x, y, barW, hgt, 2), fill: color }));
    });

    [0, 6, 12, 18].forEach((h) => {
      const x = padL + h * (barW + barGap) + barW / 2;
      const label = svgEl("text", { x, y: H - 4, class: "axis-label", "text-anchor": "middle" });
      label.textContent = h === 0 ? "12am" : h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h-12}pm`;
      svg.appendChild(label);
    });

    container.appendChild(svg);
  }

  // ---------- message list ----------

  function platformDot(platform) {
    return `<span class="dot" style="background:${colorForPlatform(platform)}"></span>`;
  }

  function buildRowsFragment(messages) {
    const frag = document.createDocumentFragment();
    messages.forEach((m) => {
      const tr = document.createElement("tr");
      tr.className = "msg-row";
      tr.dataset.idx = m.idx;
      tr.innerHTML = `
        <td class="col-date">${fmtDateTime(m.date)}</td>
        <td class="col-platform"><span class="platform-badge">${platformDot(m.platformSplit)}${escapeHtml(m.platformSplit)}</span></td>
        <td class="col-name" style="color:${colorForName(m.name)}">${escapeHtml(m.name)}</td>
        <td class="col-content">${escapeHtml(m.message_content)}</td>
      `;
      frag.appendChild(tr);
    });
    return frag;
  }

  function renderRows(messages) {
    document.getElementById("messageBody").appendChild(buildRowsFragment(messages));
  }

  function prependRows(messages) {
    const tbody = document.getElementById("messageBody");
    tbody.insertBefore(buildRowsFragment(messages), tbody.firstChild);
  }

  function loadMoreMessages() {
    if (state.loading || state.done) return;
    document.getElementById("listStatus").textContent = "";

    const slice = state.filteredOrdered.slice(state.offset, state.offset + state.limit);
    renderRows(slice);
    state.offset += slice.length;
    document.getElementById("resultCount").textContent = `${fmtNum(state.total)} match${state.total === 1 ? "" : "es"}`;

    if (state.offset >= state.total || slice.length === 0) {
      state.done = true;
      document.getElementById("listStatus").textContent = state.total === 0 ? "No messages found" : "End of results";
    }
  }

  function resetList() {
    state.offset = 0;
    state.headOffset = 0;
    state.done = false;
    state.loading = false;
    document.getElementById("messageBody").innerHTML = "";
    document.getElementById("listStatus").textContent = "";
    document.getElementById("loadEarlier").classList.add("hidden");
  }

  function refreshAll() {
    state.filteredOrdered = computeFilteredOrdered();
    state.total = state.filteredOrdered.length;
    resetList();
    loadMoreMessages();
    loadStats();
  }

  // ---------- jump to context ----------

  function updateSortUI() {
    const arrow = state.sort === "asc" ? "&uarr;" : "&darr;";
    document.getElementById("sortArrow").innerHTML = arrow;
    document.getElementById("sortToggleArrow").innerHTML = arrow;
    document.getElementById("sortToggle").firstChild.textContent =
      state.sort === "asc" ? "Oldest first " : "Newest first ";
  }

  // Clears the text search (and, if needed, any other filter hiding the
  // target) and re-renders a window of messages centered on `idx` so a
  // search hit can be viewed with its surrounding conversation, instead of
  // just the isolated matching rows.
  function jumpToMessage(idx) {
    state.search = "";
    document.getElementById("searchInput").value = "";
    if (state.sort !== "asc") {
      state.sort = "asc";
      updateSortUI();
    }

    let ordered = computeFilteredOrdered();
    let pos = ordered.findIndex((r) => r.idx === idx);

    if (pos === -1) {
      // Another active filter (platform/name/date) hides the target row —
      // clear those too so the conversation is actually visible.
      state.selectedPlatforms.clear();
      state.selectedNames.clear();
      state.dateFrom = "";
      state.dateTo = "";
      document.getElementById("dateFrom").value = "";
      document.getElementById("dateTo").value = "";
      document.getElementById("dateQuick").value = "";
      document.getElementById("dateQuick").classList.remove("input-invalid");
      document.querySelectorAll(".chip.active").forEach((c) => c.classList.remove("active"));
      ordered = computeFilteredOrdered();
      pos = ordered.findIndex((r) => r.idx === idx);
    }
    if (pos === -1) return;

    state.filteredOrdered = ordered;
    state.total = ordered.length;
    resetList();

    const head = Math.max(0, pos - CONTEXT_BEFORE);
    const tail = Math.min(state.total, pos + CONTEXT_AFTER + 1);
    renderRows(ordered.slice(head, tail));
    state.headOffset = head;
    state.offset = tail;
    state.done = tail >= state.total;

    document.getElementById("listStatus").textContent = state.done ? "End of results" : "";
    document.getElementById("loadEarlier").classList.toggle("hidden", head === 0);
    document.getElementById("resultCount").textContent =
      `${fmtNum(state.total)} match${state.total === 1 ? "" : "es"}`;
    loadStats();

    requestAnimationFrame(() => {
      const row = document.querySelector(`tr[data-idx="${idx}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "center" });
      row.classList.add("highlight-flash");
      setTimeout(() => row.classList.remove("highlight-flash"), 1800);
    });
  }

  function loadEarlierMessages() {
    const tbody = document.getElementById("messageBody");
    const prevHeight = document.documentElement.scrollHeight;
    const newHead = Math.max(0, state.headOffset - CONTEXT_BEFORE);
    const slice = state.filteredOrdered.slice(newHead, state.headOffset);
    prependRows(slice);
    state.headOffset = newHead;
    document.getElementById("loadEarlier").classList.toggle("hidden", newHead === 0);
    window.scrollBy(0, document.documentElement.scrollHeight - prevHeight);
  }

  // ---------- file loading ----------

  function setUploadStatus(msg, isError) {
    const el = document.getElementById("uploadStatus");
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
  }

  function showUploadPrompt() {
    document.getElementById("app").classList.add("hidden");
    document.getElementById("uploadOverlay").classList.remove("hidden");
  }

  // Yield twice to the browser so the "Parsing…" status actually paints
  // before the (synchronous, CPU-bound) parse blocks the main thread.
  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function handleCsvText(text, filename, persist) {
    setUploadStatus(`Parsing ${filename || "messages.csv"}…`);
    await nextPaint();

    let rows;
    try {
      rows = buildRows(parseCsv(text));
    } catch (err) {
      setUploadStatus("Couldn't parse that file — is it messages.csv?", true);
      return;
    }
    if (!rows.length) {
      setUploadStatus("That file has no rows — is it messages.csv?", true);
      return;
    }

    state.allRows = rows;
    document.getElementById("uploadOverlay").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    startApp();

    if (persist) {
      saveCachedCsv(text, filename).catch(() => {
        // Best-effort cache; if IndexedDB quota/availability fails, the app
        // still works, it'll just prompt for the file again next visit.
      });
    }
  }

  async function loadFile(file) {
    setUploadStatus(`Reading ${file.name}…`);
    let text;
    try {
      text = await file.text();
    } catch (err) {
      setUploadStatus("Couldn't read that file.", true);
      return;
    }
    handleCsvText(text, file.name, true);
  }

  async function loadFromCacheOrPrompt() {
    let cached = null;
    try {
      cached = await getCachedCsv();
    } catch (err) {
      // IndexedDB unavailable (private browsing, etc.) — fall through to prompt.
    }
    if (cached && cached.text) {
      handleCsvText(cached.text, cached.filename, false);
    } else {
      showUploadPrompt();
    }
  }

  function initUploadUI() {
    document.getElementById("fileInput").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) loadFile(file);
    });

    const dropzone = document.getElementById("dropzone");
    ["dragenter", "dragover"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
      })
    );
    dropzone.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadFile(file);
    });

    document.getElementById("changeFileBtn").addEventListener("click", async () => {
      await clearCachedCsv().catch(() => {});
      document.getElementById("fileInput").value = "";
      setUploadStatus("");
      showUploadPrompt();
    });
  }

  // ---------- daily summaries / AI recaps ----------
  // Ported as-is from convolyzer's SummaryPanel + lib/anthropic.ts: same
  // system prompt, model list, topic-JSON parsing (with recovery for
  // truncated responses), and download format. The Anthropic SDK's
  // `dangerouslyAllowBrowser` just sets the header below itself, so a plain
  // fetch reproduces the same direct-from-browser call without the SDK.

  const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTH_FULL_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const SUMMARY_MODELS = [
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest, cheapest)" },
    { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { value: "claude-opus-4-8", label: "Claude Opus 4.8 (most capable)" },
  ];
  const SUMMARY_CARD_ACCENTS = ["var(--peach)", "var(--sage)", "var(--blue)", "var(--red)"];

  const summaryState = {
    apiKey: "",
    model: SUMMARY_MODELS[0].value,
    selectedDateKey: null,
    dailyCounts: [],
    dayMessages: [],
    loading: false,
    result: null,
  };

  function computeDailyCounts(rows) {
    const counts = new Map();
    rows.forEach((r) => {
      const dateKey = r.date.slice(0, 10);
      if (!dateKey) return;
      const existing = counts.get(dateKey);
      if (existing) existing.count += 1;
      else counts.set(dateKey, { dateKey, count: 1 });
    });
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }

  function dateKeyToLocalDate(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function formatFullDateLabel(dateKey) {
    const dt = dateKeyToLocalDate(dateKey);
    return `${WEEKDAY_NAMES[dt.getDay()]}, ${MONTH_FULL_NAMES[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
  }

  function parseTopics(raw) {
    const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        return parsed.filter((p) => p && typeof p.topic === "string" && typeof p.summary === "string");
      }
    } catch {
      // Response likely got cut off mid-array (hit max_tokens). Recover whichever
      // topic objects are complete instead of discarding the whole response.
      const objectPattern = /\{\s*"topic"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"summary"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;
      const recovered = [];
      for (const match of cleaned.matchAll(objectPattern)) {
        try {
          const obj = JSON.parse(match[0]);
          if (obj && typeof obj.topic === "string" && typeof obj.summary === "string") recovered.push(obj);
        } catch {
          // skip malformed match
        }
      }
      return recovered;
    }
    return [];
  }

  async function summarizeDay({ apiKey, model, participants, dateLabel, conversationText }) {
    const system = `You're analyzing a day's conversation between ${participants.join(
      " and "
    )} on ${dateLabel}. Break the conversation into the distinct topics or threads that came up and summarize each one separately. Be specific, capture the vibe, and keep it natural, like you're reminding a friend what they talked about. Write plainly: no em dashes, no exclamation points, and no stock AI phrasing like "delve into" or "it's worth noting."

Respond with ONLY a JSON array (no prose before or after, no markdown code fences) in exactly this shape:
[{"topic": "short 2-6 word title", "summary": "2-4 sentence summary of that thread"}]

If the whole day is really just one topic, return a single-element array.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        system,
        messages: [{ role: "user", content: conversationText }],
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const errBody = await res.json();
        if (errBody && errBody.error && errBody.error.message) message = errBody.error.message;
      } catch {
        // non-JSON error body; fall back to the generic message
      }
      throw new Error(message);
    }

    const data = await res.json();
    const raw = data.content && data.content[0] && data.content[0].type === "text" ? data.content[0].text : "";
    return {
      topics: parseTopics(raw),
      raw,
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
    };
  }

  function renderSummaryBusiestDays() {
    const container = document.getElementById("summaryBusiestDays");
    container.innerHTML = "";
    summaryState.dailyCounts.slice(0, 6).forEach((d) => {
      const [y, m, day] = d.dateKey.split("-").map(Number);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill-toggle" + (summaryState.selectedDateKey === d.dateKey ? " active" : "");
      btn.textContent = `${MONTH_NAMES[m - 1]} ${day}, ${y} · ${d.count}`;
      btn.addEventListener("click", () => {
        summaryState.selectedDateKey = d.dateKey;
        document.getElementById("summaryDate").value = d.dateKey;
        renderSummaryBusiestDays();
        updateSummaryDayCount();
      });
      container.appendChild(btn);
    });
  }

  function updateSummaryDayCount() {
    const dateKey = summaryState.selectedDateKey;
    const countEl = document.getElementById("summaryDayCount");
    const btn = document.getElementById("summaryGenerateBtn");
    if (!dateKey) {
      countEl.textContent = "";
      btn.disabled = true;
      return;
    }
    const count = state.allRows.filter((r) => r.date.slice(0, 10) === dateKey).length;
    countEl.textContent = count > 0 ? `${fmtNum(count)} messages on this day` : "No messages on this day";
    btn.disabled = count === 0 || summaryState.loading;
  }

  function renderSummaryResult(result) {
    const cards = result.topics.length > 0 ? result.topics : [{ topic: "Summary", summary: result.raw }];
    const cardsEl = document.getElementById("summaryCards");
    cardsEl.innerHTML = "";
    cards.forEach((c, i) => {
      const div = document.createElement("div");
      div.className = "summary-card";
      div.style.borderTop = `3px solid ${SUMMARY_CARD_ACCENTS[i % SUMMARY_CARD_ACCENTS.length]}`;
      div.innerHTML = `<div class="summary-card-topic">${escapeHtml(c.topic)}</div><div class="summary-card-text">${escapeHtml(c.summary)}</div>`;
      cardsEl.appendChild(div);
    });
    document.getElementById("summaryUsage").innerHTML =
      `<span>Input tokens: ${fmtNum(result.usage.inputTokens)}</span><span>Output tokens: ${fmtNum(result.usage.outputTokens)}</span>`;
    document.getElementById("summaryResult").classList.remove("hidden");
  }

  async function handleSummaryGenerate() {
    const dateKey = summaryState.selectedDateKey;
    if (!dateKey) return;
    const dayMessages = state.allRows.filter((r) => r.date.slice(0, 10) === dateKey);
    if (!dayMessages.length) return;
    summaryState.dayMessages = dayMessages;
    summaryState.loading = true;
    summaryState.result = null;

    const btn = document.getElementById("summaryGenerateBtn");
    btn.disabled = true;
    btn.textContent = "Reading through your messages...";
    document.getElementById("summaryError").classList.add("hidden");
    document.getElementById("summaryResult").classList.add("hidden");

    const conversationText = dayMessages
      .map((m) => `[${m.date.slice(11, 16)}] ${m.name}: ${m.message_content}`)
      .join("\n");
    const dateLabel = formatFullDateLabel(dateKey);

    try {
      const result = await summarizeDay({
        apiKey: summaryState.apiKey,
        model: summaryState.model,
        participants: state.names,
        dateLabel,
        conversationText,
      });
      summaryState.result = result;
      renderSummaryResult(result);
    } catch (e) {
      const errEl = document.getElementById("summaryError");
      errEl.textContent = e instanceof Error ? e.message : "Something went wrong generating the summary.";
      errEl.classList.remove("hidden");
    } finally {
      summaryState.loading = false;
      btn.textContent = "Summarize this day";
      updateSummaryDayCount();
    }
  }

  function handleSummaryDownload() {
    const result = summaryState.result;
    const dateKey = summaryState.selectedDateKey;
    if (!result || !dateKey) return;
    const cards = result.topics.length > 0 ? result.topics : [{ topic: "Summary", summary: result.raw }];
    const body = cards.map((c) => `${c.topic}\n${"-".repeat(c.topic.length)}\n${c.summary}`).join("\n\n");
    const text = `Conversation Summary\nDate: ${dateKey}\nParticipants: ${state.names.join(" and ")}\nMessages: ${summaryState.dayMessages.length}\nModel: ${summaryState.model}\n\n---\n\n${body}\n`;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `summary_${dateKey}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function refreshSummaryDailyCounts() {
    summaryState.dailyCounts = computeDailyCounts(state.allRows);
    renderSummaryBusiestDays();
  }

  function initSummaryPanel() {
    const select = document.getElementById("summaryModel");
    SUMMARY_MODELS.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.value;
      opt.textContent = m.label;
      select.appendChild(opt);
    });
    select.value = summaryState.model;
    select.addEventListener("change", (e) => {
      summaryState.model = e.target.value;
    });

    document.getElementById("summaryApiKey").addEventListener("input", (e) => {
      summaryState.apiKey = e.target.value;
      const hasKey = summaryState.apiKey.length > 0;
      document.getElementById("summaryControls").classList.toggle("hidden", !hasKey);
      document.getElementById("summaryKeyNote").classList.toggle("hidden", hasKey);
    });

    document.getElementById("summaryDate").addEventListener("change", (e) => {
      summaryState.selectedDateKey = e.target.value || null;
      renderSummaryBusiestDays();
      updateSummaryDayCount();
    });

    document.getElementById("summaryGenerateBtn").addEventListener("click", handleSummaryGenerate);
    document.getElementById("summaryDownloadBtn").addEventListener("click", handleSummaryDownload);
  }

  // ---------- wiring ----------

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function startApp() {
    const meta = computeMeta(state.allRows);
    renderMetaUI(meta);
    refreshSummaryDailyCounts();
    refreshAll();
  }

  function init() {
    initUploadUI();
    initSummaryPanel();

    const searchInput = document.getElementById("searchInput");
    searchInput.addEventListener("input", debounce(() => {
      state.search = searchInput.value.trim();
      refreshAll();
    }, 300));

    document.getElementById("dateFrom").addEventListener("change", (e) => {
      state.dateFrom = e.target.value;
      refreshAll();
    });
    document.getElementById("dateTo").addEventListener("change", (e) => {
      state.dateTo = e.target.value;
      refreshAll();
    });

    const dateQuick = document.getElementById("dateQuick");
    dateQuick.addEventListener("input", debounce(() => {
      const text = dateQuick.value.trim();
      if (!text) {
        dateQuick.classList.remove("input-invalid");
        return;
      }
      const parsed = parseQuickDate(text);
      if (!parsed) {
        dateQuick.classList.add("input-invalid");
        return;
      }
      dateQuick.classList.remove("input-invalid");
      const { from, to } = quickDateToRange(parsed);
      state.dateFrom = from;
      state.dateTo = to;
      document.getElementById("dateFrom").value = from;
      document.getElementById("dateTo").value = to;
      refreshAll();
    }, 400));

    document.getElementById("clearFilters").addEventListener("click", clearFilters);

    document.getElementById("timelineGranularity").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-value]");
      if (!btn || btn.classList.contains("active")) return;
      document.querySelectorAll("#timelineGranularity button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.timelineGranularity = btn.dataset.value;
      renderTimelineChart(lastTimeline);
    });

    document.getElementById("zoomInBtn").addEventListener("click", () => setTimelineZoom(state.timelineZoom * 1.5));
    document.getElementById("zoomOutBtn").addEventListener("click", () => setTimelineZoom(state.timelineZoom / 1.5));
    document.getElementById("zoomResetBtn").addEventListener("click", () => setTimelineZoom(1));

    function toggleSort() {
      state.sort = state.sort === "asc" ? "desc" : "asc";
      updateSortUI();
      refreshAll();
    }
    document.getElementById("sortDateHeader").addEventListener("click", toggleSort);
    document.getElementById("sortToggle").addEventListener("click", toggleSort);

    document.getElementById("messageBody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-idx]");
      if (!tr) return;
      if (window.getSelection().toString()) return; // don't hijack text selection
      jumpToMessage(Number(tr.dataset.idx));
    });
    document.getElementById("loadEarlier").addEventListener("click", loadEarlierMessages);

    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadMoreMessages();
    }, { rootMargin: "300px" });
    observer.observe(document.getElementById("sentinel"));

    // Chart width now tracks the container in real pixels (to support
    // zoom/scroll), so it needs an explicit re-render on resize.
    window.addEventListener("resize", debounce(() => {
      if (lastTimeline.length) renderTimelineChart(lastTimeline);
    }, 150));

    loadFromCacheOrPrompt();
  }

  init();
})();
