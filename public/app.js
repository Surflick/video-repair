/* Video Repair — batch + preview + native resolution */

const $ = (sel) => document.querySelector(sel);

const els = {
  panelUpload: $("#panel-upload"),
  panelWorkspace: $("#panel-workspace"),
  dropzone: $("#dropzone"),
  fileInput: $("#file-input"),
  fileInputMore: $("#file-input-more"),
  btnBrowse: $("#btn-browse"),
  btnAddMore: $("#btn-add-more"),
  queueList: $("#queue-list"),
  queueCount: $("#queue-count"),
  detailTitle: $("#detail-title"),
  thumb: $("#thumb"),
  thumbPlaceholder: $("#thumb-placeholder"),
  thumbMode: $("#thumb-mode"),
  playerMode: $("#player-mode"),
  previewVideo: $("#preview-video"),
  nativeResBadge: $("#native-res-badge"),
  progressRingWrap: $("#progress-ring-wrap"),
  ringFg: $("#ring-fg"),
  ringPct: $("#ring-pct"),
  fileName: $("#file-name"),
  fileStatus: $("#file-status"),
  metaSize: $("#meta-size"),
  metaRes: $("#meta-res"),
  metaDur: $("#meta-dur"),
  metaCodecs: $("#meta-codecs"),
  sampleDropzone: $("#sample-dropzone"),
  sampleInput: $("#sample-input"),
  btnSampleBrowse: $("#btn-sample-browse"),
  sampleEmpty: $("#sample-empty"),
  sampleLoaded: $("#sample-loaded"),
  sampleThumb: $("#sample-thumb"),
  sampleThumbPlaceholder: $("#sample-thumb-placeholder"),
  sampleName: $("#sample-name"),
  sampleSize: $("#sample-size"),
  sampleRes: $("#sample-res"),
  sampleDur: $("#sample-dur"),
  sampleCodecs: $("#sample-codecs"),
  sampleStatus: $("#sample-status"),
  btnSampleChange: $("#btn-sample-change"),
  barFill: $("#bar-fill"),
  barGlow: $("#bar-glow"),
  bigPct: $("#big-pct"),
  stageNow: $("#stage-now"),
  stagesList: $("#stages-list"),
  formatGroup: $("#format-group"),
  formatHint: $("#format-hint"),
  btnNew: $("#btn-new"),
  btnCancel: $("#btn-cancel"),
  btnRepairAll: $("#btn-repair-all"),
  btnRepairOne: $("#btn-repair-one"),
  btnDownload: $("#btn-download"),
  btnDownloadAll: $("#btn-download-all"),
  resultBanner: $("#result-banner"),
  logPre: $("#log-pre"),
  healthStatus: $("#health-status"),
  toast: $("#toast"),
  graph: $("#progress-graph"),
  steps: document.querySelectorAll(".step"),
};

const RING_CIRC = 2 * Math.PI * 52;

const state = {
  jobs: [],
  activeId: null,
  sharedSample: null,
  formatPref: "auto",
  eventSource: null,
  progressHistory: [],
  batchRunning: false,
};

function toast(msg, ms = 2800) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  requestAnimationFrame(() => els.toast.classList.add("show"));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    els.toast.classList.remove("show");
    setTimeout(() => els.toast.classList.add("hidden"), 250);
  }, ms);
}

function formatBytes(n) {
  if (n == null || isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function formatDur(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return "—";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setSteps(n) {
  els.steps.forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle("active", s === n);
    el.classList.toggle("done", s < n);
  });
}

function setPercent(p) {
  const pct = Math.max(0, Math.min(100, Math.round(p || 0)));
  els.bigPct.textContent = String(pct);
  els.ringPct.textContent = String(pct);
  els.barFill.style.width = `${pct}%`;
  els.barGlow.style.left = `${pct}%`;
  els.ringFg.style.strokeDashoffset = String(RING_CIRC - (pct / 100) * RING_CIRC);
  els.ringFg.style.strokeDasharray = String(RING_CIRC);
  const now = performance.now();
  state.progressHistory.push({ t: now, p: pct });
  state.progressHistory = state.progressHistory.filter((s) => s.t >= now - 90000);
  drawGraph();
}

function drawGraph() {
  const canvas = els.graph;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = canvas.clientHeight || 88;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cssW;
  const h = cssH;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h / 4) * i);
    ctx.lineTo(w, (h / 4) * i);
    ctx.stroke();
  }
  const samples = state.progressHistory;
  if (samples.length < 2) {
    ctx.fillStyle = "rgba(139,147,167,0.5)";
    ctx.font = "11px DM Sans, sans-serif";
    ctx.fillText("Progress graph — starts when repair begins", 12, h / 2 + 4);
    return;
  }
  const t0 = samples[0].t;
  const span = Math.max(samples[samples.length - 1].t - t0, 1);
  const pts = samples.map((s) => ({
    x: ((s.t - t0) / span) * (w - 8) + 4,
    y: h - 8 - (s.p / 100) * (h - 16),
  }));
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(91,140,255,0.35)");
  grad.addColorStop(1, "rgba(91,140,255,0.02)");
  ctx.beginPath();
  ctx.moveTo(pts[0].x, h);
  for (const pt of pts) ctx.lineTo(pt.x, pt.y);
  ctx.lineTo(pts[pts.length - 1].x, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = "#7c9fff";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function renderStages(stages) {
  els.stagesList.innerHTML = (stages || [])
    .map(
      (s) => `<li class="${s.status || "pending"}">
      <span class="stage-icon">${s.status === "done" ? "✓" : ""}</span>
      <span>${escapeHtml(s.label)}</span>
      <span class="stage-weight">${s.weight}%</span>
    </li>`
    )
    .join("");
}

function activeJob() {
  return state.jobs.find((j) => j.id === state.activeId) || state.jobs[0] || null;
}

function upsertJobs(list) {
  const map = new Map(state.jobs.map((j) => [j.id, j]));
  for (const j of list) map.set(j.id, j);
  state.jobs = [...map.values()];
  if (!state.activeId || !map.has(state.activeId)) {
    state.activeId = state.jobs[0]?.id || null;
  }
}

function fillProbe(probe, resEl, durEl, codecsEl) {
  if (probe?.width && probe?.height) {
    resEl.textContent = `${probe.width}×${probe.height}`;
  } else {
    resEl.textContent = probe?.ok === false ? "Index missing" : "—";
  }
  durEl.textContent = formatDur(probe?.duration);
  const parts = [probe?.videoCodec, probe?.audioCodec].filter(Boolean);
  if (probe?.fps) parts.push(`${Number(probe.fps).toFixed(2)} fps`);
  codecsEl.textContent = parts.join(" + ") || "—";
}

function renderQueue() {
  els.queueCount.textContent = String(state.jobs.length);
  els.queueList.innerHTML = state.jobs
    .map((j) => {
      const active = j.id === state.activeId ? "active" : "";
      const st = j.status || "";
      const thumb = j.thumbnailUrl
        ? `<img class="q-thumb" src="${j.thumbnailUrl}" alt="" />`
        : `<div class="q-thumb ph">VID</div>`;
      const pct = j.status === "repairing" ? ` ${j.percent || 0}%` : "";
      return `<li class="queue-item ${active} ${st}" data-id="${j.id}">
        ${thumb}
        <div>
          <div class="q-name" title="${escapeHtml(j.originalName)}">${escapeHtml(j.originalName)}</div>
          <div class="q-meta">${formatBytes(j.size)}</div>
          <div class="q-status">${escapeHtml(st.replace(/_/g, " "))}${pct}</div>
        </div>
      </li>`;
    })
    .join("");
}

function renderSample() {
  const s = state.sharedSample;
  const has = !!s;
  els.sampleEmpty.classList.toggle("hidden", has);
  els.sampleLoaded.classList.toggle("hidden", !has);
  if (!has) {
    els.sampleStatus.textContent = "Needed";
    els.sampleStatus.className = "status-pill needs";
    return;
  }
  els.sampleStatus.textContent = "Shared";
  els.sampleStatus.className = "status-pill ready";
  els.sampleName.textContent = s.name || "Sample";
  els.sampleSize.textContent = formatBytes(s.size);
  fillProbe(s.probe, els.sampleRes, els.sampleDur, els.sampleCodecs);
  if (s.thumbnailUrl) {
    els.sampleThumb.src = s.thumbnailUrl;
    els.sampleThumb.classList.remove("hidden");
    els.sampleThumbPlaceholder.classList.add("hidden");
  }
}

function showPreviewPlayer(job) {
  const url = job.result?.previewUrl || job.result?.downloadUrl;
  if (!url || job.status !== "done") {
    els.playerMode.classList.add("hidden");
    els.thumbMode.classList.remove("hidden");
    return;
  }
  els.thumbMode.classList.add("hidden");
  els.playerMode.classList.remove("hidden");
  const w = job.result.width;
  const h = job.result.height;
  els.nativeResBadge.textContent =
    w && h ? `Native ${w}×${h}` : "Native resolution";
  // Only reload if src changed
  const abs = url.startsWith("http") ? url : url;
  if (els.previewVideo.dataset.jobId !== job.id) {
    els.previewVideo.dataset.jobId = job.id;
    els.previewVideo.src = abs;
    els.previewVideo.load();
  }
}

function renderDetail() {
  const job = activeJob();
  if (!job) return;

  els.panelUpload.classList.add("hidden");
  els.panelWorkspace.classList.remove("hidden");

  const hasSample = !!state.sharedSample || job.hasSample;
  const anyDone = state.jobs.some((j) => j.status === "done");
  const anyRepairing = state.jobs.some((j) => j.status === "repairing");
  if (anyDone || anyRepairing) setSteps(3);
  else if (hasSample) setSteps(3);
  else setSteps(2);

  els.detailTitle.textContent = "Selected file";
  els.fileName.textContent = job.originalName || "—";
  els.metaSize.textContent = formatBytes(job.size);
  fillProbe(job.probe, els.metaRes, els.metaDur, els.metaCodecs);

  const st = job.status || "ready";
  els.fileStatus.textContent = st.replace(/_/g, " ");
  els.fileStatus.className = `status-pill ${st === "needs_sample" ? "needs_sample" : st}`;

  if (job.thumbnailUrl && job.status !== "done") {
    els.thumb.src = job.thumbnailUrl;
    els.thumb.classList.remove("hidden");
    els.thumbPlaceholder.classList.add("hidden");
  } else if (job.thumbnailUrl && job.status === "done") {
    // thumb still available under player
  } else {
    els.thumb.classList.add("hidden");
    els.thumbPlaceholder.classList.remove("hidden");
  }

  showPreviewPlayer(job);

  setPercent(job.percent || 0);
  els.stageNow.textContent = job.stageLabel || "—";
  if (job.stages) renderStages(job.stages);

  const repairing = st === "repairing" || state.batchRunning;
  const done = st === "done";
  const readyCount = state.jobs.filter(
    (j) =>
      (j.status === "ready" || j.status === "error" || j.status === "cancelled") &&
      (j.hasSample || state.sharedSample)
  ).length;
  const doneCount = state.jobs.filter((j) => j.status === "done").length;

  els.progressRingWrap.classList.toggle("hidden", st !== "repairing");
  els.barGlow.classList.toggle("active", repairing);
  els.btnRepairAll.disabled = readyCount === 0 || state.batchRunning;
  els.btnRepairOne.disabled =
    !(job.hasSample || state.sharedSample) ||
    st === "repairing" ||
    st === "done" ||
    st === "needs_sample";
  els.btnCancel.classList.toggle("hidden", st !== "repairing");
  els.btnDownload.classList.toggle("hidden", !done || !job.result?.downloadUrl);
  els.btnDownloadAll.classList.toggle("hidden", doneCount < 1);

  if (done && job.result) {
    els.btnDownload.href = job.result.downloadUrl;
    els.btnDownload.setAttribute("download", job.result.filename || "repaired.mp4");
    els.resultBanner.classList.remove("hidden", "err");
    els.resultBanner.classList.add("ok");
    const res =
      job.result.width && job.result.height
        ? `${job.result.width}×${job.result.height}`
        : "native";
    els.resultBanner.innerHTML = `
      <strong>Ready to save.</strong> Preview above first.
      · <code>.${escapeHtml(job.result.format)}</code>
      · <strong>${escapeHtml(res)}</strong> (native)
      · ${formatBytes(job.result.size)}
      · ${formatDur(job.result.duration)}
      <br/><span style="opacity:.85">Strategy: ${escapeHtml(job.result.strategy || "advanced")}</span>
    `;
  } else if (st === "error") {
    els.resultBanner.classList.remove("hidden", "ok");
    els.resultBanner.classList.add("err");
    els.resultBanner.innerHTML = `<strong>Failed.</strong> ${escapeHtml(job.error || "")}`;
  } else if (!hasSample) {
    els.resultBanner.classList.remove("hidden", "ok", "err");
    els.resultBanner.style.background = "rgba(251,191,36,0.1)";
    els.resultBanner.style.border = "1px solid rgba(251,191,36,0.25)";
    els.resultBanner.style.color = "#fde68a";
    els.resultBanner.innerHTML =
      "<strong>Sample required</strong> for the batch — same camera as the damaged files.";
  } else {
    els.resultBanner.classList.add("hidden");
    els.resultBanner.style.background = "";
    els.resultBanner.style.border = "";
    els.resultBanner.style.color = "";
  }

  els.formatHint.textContent =
    state.formatPref === "auto"
      ? "Original container · native resolution preserved"
      : `Save as .${state.formatPref} · native resolution preserved`;

  renderQueue();
  renderSample();
}

function openBatchSSE() {
  if (state.eventSource) state.eventSource.close();
  const es = new EventSource("/api/batch/events");
  state.eventSource = es;
  es.addEventListener("snapshot", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.jobs) upsertJobs(data.jobs);
      if (data.sharedSample !== undefined) state.sharedSample = data.sharedSample;
      state.batchRunning = !!data.batchRunning;
      renderDetail();
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("progress", (e) => {
    try {
      const data = JSON.parse(e.data);
      const job = data.job || data;
      if (job?.id) {
        upsertJobs([job]);
        if (job.id === state.activeId) {
          if (job.logs?.length) {
            /* keep log from events */
          }
          renderDetail();
        } else {
          renderQueue();
        }
      }
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("log", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (!data.jobId || data.jobId === state.activeId) {
        els.logPre.textContent += (els.logPre.textContent ? "\n" : "") + data.line;
        els.logPre.scrollTop = els.logPre.scrollHeight;
      }
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("done", (e) => {
    try {
      const data = JSON.parse(e.data);
      const job = data.job || data;
      if (job?.id) {
        upsertJobs([job]);
        renderDetail();
        if (job.status === "done" && job.id === state.activeId) {
          toast("Repair done — preview before downloading");
        }
      }
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("batch_done", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.jobs) upsertJobs(data.jobs);
      state.batchRunning = false;
      renderDetail();
      toast("Batch repair finished");
    } catch {
      /* ignore */
    }
  });
  es.onerror = () => {};
}

async function uploadDamaged(fileList) {
  const files = [...fileList].filter((f) => {
    const ext = (f.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
    return [".mp4", ".mov"].includes(ext);
  });
  if (!files.length) {
    toast("Only .mp4 and .mov supported");
    return;
  }
  toast(`Uploading ${files.length} file${files.length > 1 ? "s" : ""}…`);
  const fd = new FormData();
  for (const f of files) fd.append("video", f);
  fd.append("formatPref", state.formatPref);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    upsertJobs(data.jobs || [data.job]);
    if (data.sharedSample) state.sharedSample = data.sharedSample;
    state.activeId = (data.jobs || [data.job])[0].id;
    state.progressHistory = [];
    els.logPre.textContent = "";
    openBatchSSE();
    renderDetail();
    toast(
      state.sharedSample
        ? "Files added — ready to repair"
        : "Files added — upload a sample next"
    );
  } catch (err) {
    toast(err.message || "Upload failed");
  }
}

async function uploadSample(file) {
  const ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  if (![".mp4", ".mov"].includes(ext)) {
    toast("Sample must be .mp4 or .mov");
    return;
  }
  toast("Uploading sample for batch…");
  const fd = new FormData();
  fd.append("sample", file);
  try {
    const res = await fetch("/api/batch/sample", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Sample failed");
    state.sharedSample = data.sharedSample;
    if (data.jobs) upsertJobs(data.jobs);
    renderDetail();
    toast("Sample applied to entire batch");
  } catch (err) {
    toast(err.message);
  } finally {
    if (els.sampleInput) els.sampleInput.value = "";
  }
}

async function setFormat(pref) {
  state.formatPref = pref;
  els.formatGroup.querySelectorAll(".seg").forEach((b) => {
    b.classList.toggle("active", b.dataset.format === pref);
  });
  try {
    const res = await fetch("/api/batch/format", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formatPref: pref }),
    });
    const data = await res.json();
    if (data.jobs) upsertJobs(data.jobs);
    renderDetail();
  } catch {
    /* ignore */
  }
}

async function repairAll() {
  state.progressHistory = [{ t: performance.now(), p: 0 }];
  els.logPre.textContent = "";
  try {
    const res = await fetch("/api/batch/repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formatPref: state.formatPref }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Batch repair failed");
    state.batchRunning = true;
    toast(`Queued ${data.count} file(s)`);
    openBatchSSE();
  } catch (err) {
    toast(err.message);
  }
}

async function repairOne() {
  const job = activeJob();
  if (!job) return;
  state.progressHistory = [{ t: performance.now(), p: 0 }];
  els.logPre.textContent = "";
  try {
    const res = await fetch(`/api/jobs/${job.id}/repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formatPref: state.formatPref }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Repair failed");
    if (data.job) upsertJobs([data.job]);
    openBatchSSE();
    renderDetail();
    toast("Advanced repair started");
  } catch (err) {
    toast(err.message);
  }
}

async function cancelRepair() {
  const job = activeJob();
  if (!job) return;
  await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
  toast("Cancelling…");
}

async function clearBatch() {
  if (state.eventSource) state.eventSource.close();
  await fetch("/api/batch", { method: "DELETE" }).catch(() => {});
  state.jobs = [];
  state.activeId = null;
  state.sharedSample = null;
  state.progressHistory = [];
  els.logPre.textContent = "";
  els.previewVideo.removeAttribute("src");
  els.previewVideo.load();
  els.panelWorkspace.classList.add("hidden");
  els.panelUpload.classList.remove("hidden");
  els.fileInput.value = "";
  setPercent(0);
  setSteps(1);
}

function downloadAll() {
  const done = state.jobs.filter((j) => j.status === "done" && j.result?.downloadUrl);
  if (!done.length) {
    toast("No repaired files yet");
    return;
  }
  // sequential downloads (browser may block many at once)
  let i = 0;
  const next = () => {
    if (i >= done.length) return;
    const a = document.createElement("a");
    a.href = done[i].result.downloadUrl;
    a.download = done[i].result.filename || "repaired.mp4";
    document.body.appendChild(a);
    a.click();
    a.remove();
    i += 1;
    setTimeout(next, 400);
  };
  next();
  toast(`Downloading ${done.length} file(s)…`);
}

// Events
els.btnBrowse.addEventListener("click", (e) => {
  e.stopPropagation();
  els.fileInput.click();
});
els.dropzone.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files?.length) uploadDamaged(els.fileInput.files);
});
els.btnAddMore?.addEventListener("click", () => els.fileInputMore.click());
els.fileInputMore?.addEventListener("change", () => {
  if (els.fileInputMore.files?.length) uploadDamaged(els.fileInputMore.files);
  els.fileInputMore.value = "";
});

["dragenter", "dragover"].forEach((ev) => {
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((ev) => {
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragover");
  });
});
els.dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer?.files?.length) uploadDamaged(e.dataTransfer.files);
});

els.queueList.addEventListener("click", (e) => {
  const item = e.target.closest(".queue-item");
  if (!item) return;
  state.activeId = item.dataset.id;
  els.logPre.textContent = "";
  renderDetail();
});

function wireSample(zone) {
  if (!zone) return;
  ["dragenter", "dragover"].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
    });
  });
  zone.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) uploadSample(f);
  });
  zone.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    els.sampleInput.click();
  });
}
wireSample(els.sampleDropzone);
els.btnSampleBrowse?.addEventListener("click", (e) => {
  e.stopPropagation();
  els.sampleInput.click();
});
els.sampleInput?.addEventListener("change", () => {
  const f = els.sampleInput.files?.[0];
  if (f) uploadSample(f);
});
els.btnSampleChange?.addEventListener("click", () => els.sampleInput.click());

els.formatGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg");
  if (!btn) return;
  setFormat(btn.dataset.format);
});

els.btnRepairAll.addEventListener("click", repairAll);
els.btnRepairOne.addEventListener("click", repairOne);
els.btnCancel.addEventListener("click", cancelRepair);
els.btnNew.addEventListener("click", clearBatch);
els.btnDownloadAll.addEventListener("click", downloadAll);

window.addEventListener("resize", drawGraph);

async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.ffmpeg && data.ffprobe !== false) {
      els.healthStatus.innerHTML =
        '<span class="ok">FFmpeg ready</span> · Batch advanced · native res';
      if (data.stages) renderStages(data.stages.map((s) => ({ ...s, status: "pending" })));
    } else {
      els.healthStatus.textContent = "";
      const bad = document.createElement("span");
      bad.className = "bad";
      bad.textContent = "FFmpeg missing";
      els.healthStatus.append(bad);
      if (data.ffmpegHint) {
        els.healthStatus.append(document.createTextNode(` · ${data.ffmpegHint}`));
      }
    }
  } catch {
    els.healthStatus.innerHTML = '<span class="bad">Server offline</span>';
  }
}

els.ringFg.style.strokeDasharray = String(RING_CIRC);
els.ringFg.style.strokeDashoffset = String(RING_CIRC);
setSteps(1);
drawGraph();
checkHealth();
