/**
 * Video Repair App — local server
 * Advanced batch repair for corrupted .mov / .mp4
 * Requires a healthy sample from the same device (Repairit-style).
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const {
  RepairJob,
  probeFile,
  generateThumbnail,
  resolveOutputFormat,
  summarizeProbe,
  compareToSample,
  STAGES,
} = require("./repair");
const { ffmpegOk, ffprobeOk, installHint } = require("./binaries");

const PORT = Number(process.env.PORT) || 47821;
const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const UPLOADS = path.join(DATA, "uploads");
const OUTPUTS = path.join(DATA, "outputs");
const THUMBS = path.join(DATA, "thumbs");
const WORK = path.join(DATA, "work");

for (const d of [DATA, UPLOADS, OUTPUTS, THUMBS, WORK]) {
  fs.mkdirSync(d, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC));
app.use("/thumbs", express.static(THUMBS));
// Range requests for video preview
app.use(
  "/outputs",
  express.static(OUTPUTS, {
    acceptRanges: true,
    setHeaders(res, filePath) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".mov") res.setHeader("Content-Type", "video/quicktime");
      if (ext === ".mp4") res.setHeader("Content-Type", "video/mp4");
    },
  })
);

const jobs = new Map();
/** Shared sample applied to the whole batch */
let sharedSample = null;
/** Sequential batch repair queue */
let batchQueue = Promise.resolve();
let batchRunning = false;

function publicJob(job) {
  const hasOut = Boolean(job.outputPath && fs.existsSync(job.outputPath));
  return {
    id: job.id,
    status: job.status,
    originalName: job.originalName,
    inputExt: job.inputExt,
    size: job.size,
    formatPref: job.formatPref,
    outputFormat: job.outputFormat,
    percent: job.percent,
    stageIndex: job.stageIndex,
    stageLabel: job.stageLabel,
    stages: job.stages,
    thumbnailUrl: job.thumbnailUrl,
    probe: summarizeProbe(job.probe),
    hasSample: Boolean(job.samplePath && fs.existsSync(job.samplePath)),
    sampleName: job.sampleName || null,
    sampleSize: job.sampleSize || null,
    sampleThumbnailUrl: job.sampleThumbnailUrl || null,
    sampleProbe: summarizeProbe(job.sampleProbe),
    sampleMatch: job.sampleMatch || null,
    result: job.result
      ? {
          ...job.result,
          previewUrl: hasOut ? `/api/jobs/${job.id}/preview` : null,
          // native resolution from repaired output
          nativeWidth: job.result.width,
          nativeHeight: job.result.height,
        }
      : null,
    error: job.error,
    createdAt: job.createdAt,
    logs: job.logs?.slice(-40) || [],
  };
}

function publicSharedSample() {
  if (!sharedSample) return null;
  return {
    path: true,
    name: sharedSample.name,
    size: sharedSample.size,
    thumbnailUrl: sharedSample.thumbnailUrl,
    probe: summarizeProbe(sharedSample.probe),
  };
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  filename: (_req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname).toLowerCase() || ".mp4";
    cb(null, `${id}${ext}`);
  },
});

function videoFileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const ok =
    [".mp4", ".mov"].includes(ext) ||
    /video\/(mp4|quicktime|x-m4v)/i.test(file.mimetype) ||
    file.mimetype === "application/octet-stream";
  if (!ok) {
    cb(new Error("Only .mp4 and .mov files are supported"));
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 * 1024 },
  fileFilter: videoFileFilter,
});

async function createJobFromFile(file, formatPref = "auto") {
  const id = path.basename(file.filename, path.extname(file.filename));
  const inputExt = path.extname(file.originalname).toLowerCase() || ".mp4";
  const outputFormat = resolveOutputFormat(file.path, formatPref);

  const job = {
    id,
    status: "needs_sample",
    originalName: file.originalname,
    inputPath: file.path,
    inputExt,
    size: file.size,
    formatPref,
    outputFormat,
    outputPath: path.join(OUTPUTS, `${id}_repaired.${outputFormat}`),
    workDir: path.join(WORK, id),
    percent: 0,
    stageIndex: 0,
    stageLabel: "Add a sample video to continue",
    stages: STAGES.map((s) => ({ ...s, status: "pending" })),
    thumbnailUrl: null,
    probe: null,
    samplePath: null,
    sampleName: null,
    sampleSize: null,
    sampleThumbnailUrl: null,
    sampleProbe: null,
    sampleMatch: null,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    logs: [],
    engine: null,
    clients: new Set(),
  };
  fs.mkdirSync(job.workDir, { recursive: true });
  jobs.set(id, job);

  const probe = await probeFile(job.inputPath);
  job.probe = probe;

  const thumbName = `${id}.jpg`;
  const thumbPath = path.join(THUMBS, thumbName);
  const at = probe.duration > 2 ? Math.min(probe.duration * 0.15, 10) : 0.5;
  if (await generateThumbnail(job.inputPath, thumbPath, { atSec: at })) {
    job.thumbnailUrl = `/thumbs/${thumbName}?t=${Date.now()}`;
  }

  // Auto-apply shared sample if present
  if (sharedSample?.path && fs.existsSync(sharedSample.path)) {
    applySampleToJob(job, sharedSample);
  }

  return job;
}

function applySampleToJob(job, sample) {
  job.samplePath = sample.path;
  job.sampleName = sample.name;
  job.sampleSize = sample.size;
  job.sampleProbe = sample.probe;
  job.sampleThumbnailUrl = sample.thumbnailUrl;
  job.sampleMatch = compareToSample(job.probe, sample.probe);
  if (job.status !== "done" && job.status !== "repairing") {
    job.status = "ready";
    job.stageLabel = "Sample matched — ready for Advanced Repair";
    job.error = null;
  }
}

function broadcast(job, event, data) {
  for (const res of job.clients) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      job.clients.delete(res);
    }
  }
  // Also broadcast to batch listeners
  for (const res of batchClients) {
    try {
      res.write(
        `event: ${event}\ndata: ${JSON.stringify({ jobId: job.id, job: data })}\n\n`
      );
    } catch {
      batchClients.delete(res);
    }
  }
}

const batchClients = new Set();

app.get("/api/health", async (_req, res) => {
  const ffmpegReady = ffmpegOk();
  const ffprobeReady = ffprobeOk();
  res.json({
    ok: true,
    mode: "advanced",
    requiresSample: true,
    batch: true,
    platform: process.platform,
    ffmpeg: ffmpegReady,
    ffprobe: ffprobeReady,
    ffmpegHint: ffmpegReady && ffprobeReady ? null : installHint(),
    stages: STAGES,
    jobCount: jobs.size,
    batchRunning,
  });
});

/** List all jobs in the session */
app.get("/api/jobs", (_req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map(publicJob);
  res.json({
    jobs: list,
    sharedSample: publicSharedSample(),
    batchRunning,
  });
});

/** Batch SSE for multi-job progress */
app.get("/api/batch/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("snapshot", {
    jobs: [...jobs.values()].map(publicJob),
    sharedSample: publicSharedSample(),
    batchRunning,
  });
  batchClients.add(res);
  req.on("close", () => batchClients.delete(res));
});

/** Upload one or many damaged videos */
app.post("/api/upload", upload.array("video", 50), async (req, res) => {
  try {
    const files = req.files?.length
      ? req.files
      : req.file
        ? [req.file]
        : [];
    if (!files.length) {
      res.status(400).json({ error: "No damaged video uploaded" });
      return;
    }
    const formatPref = (req.body.formatPref || "auto").toLowerCase();
    const created = [];
    for (const file of files) {
      const job = await createJobFromFile(file, formatPref);
      created.push(job);
    }
    res.json({
      jobs: created.map(publicJob),
      job: publicJob(created[0]), // backward compat
      sharedSample: publicSharedSample(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

/** Shared sample for the whole batch */
app.post("/api/batch/sample", upload.single("sample"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No sample video uploaded" });
      return;
    }
    const probe = await probeFile(req.file.path);
    if (!probe.ok || !probe.hasVideo) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
      res.status(400).json({
        error:
          "Sample is not a valid playable video. Upload a healthy clip from the same camera.",
      });
      return;
    }

    // Clean previous shared sample file if different
    if (sharedSample?.path && sharedSample.path !== req.file.path) {
      // Don't delete if any job still references it as unique path — jobs share the path
    }

    const thumbName = `shared_sample_${Date.now()}.jpg`;
    const thumbPath = path.join(THUMBS, thumbName);
    const at = probe.duration > 2 ? Math.min(probe.duration * 0.15, 10) : 0.5;
    let thumbnailUrl = null;
    if (await generateThumbnail(req.file.path, thumbPath, { atSec: at })) {
      thumbnailUrl = `/thumbs/${thumbName}?t=${Date.now()}`;
    }

    sharedSample = {
      path: req.file.path,
      name: req.file.originalname,
      size: req.file.size,
      probe,
      thumbnailUrl,
    };

    // Apply to all jobs not currently repairing
    for (const job of jobs.values()) {
      if (job.status === "repairing") continue;
      applySampleToJob(job, sharedSample);
    }

    res.json({
      ok: true,
      sharedSample: publicSharedSample(),
      jobs: [...jobs.values()].map(publicJob),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

/** Per-job sample (override) */
app.post("/api/jobs/:id/sample", upload.single("sample"), async (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (job.status === "repairing") {
      res.status(409).json({ error: "Cannot change sample while repairing" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No sample video uploaded" });
      return;
    }

    const sampleProbe = await probeFile(req.file.path);
    if (!sampleProbe.ok || !sampleProbe.hasVideo) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
      res.status(400).json({
        error:
          "Sample is not a valid playable video. Upload a healthy clip from the same camera.",
        job: publicJob(job),
      });
      return;
    }

    const thumbName = `${job.id}_sample.jpg`;
    const thumbPath = path.join(THUMBS, thumbName);
    const at =
      sampleProbe.duration > 2 ? Math.min(sampleProbe.duration * 0.15, 10) : 0.5;
    let sampleThumbnailUrl = null;
    if (await generateThumbnail(req.file.path, thumbPath, { atSec: at })) {
      sampleThumbnailUrl = `/thumbs/${thumbName}?t=${Date.now()}`;
    }

    applySampleToJob(job, {
      path: req.file.path,
      name: req.file.originalname,
      size: req.file.size,
      probe: sampleProbe,
      thumbnailUrl: sampleThumbnailUrl,
    });

    res.json({ job: publicJob(job) });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.delete("/api/jobs/:id/sample", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (job.status === "repairing") {
    res.status(409).json({ error: "Cannot remove sample while repairing" });
    return;
  }
  job.samplePath = null;
  job.sampleName = null;
  job.sampleSize = null;
  job.sampleProbe = null;
  job.sampleThumbnailUrl = null;
  job.sampleMatch = null;
  if (job.status === "ready" || job.status === "done") {
    if (job.status !== "done") {
      job.status = "needs_sample";
      job.stageLabel = "Add a sample video to continue";
    }
  }
  res.json({ job: publicJob(job) });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({ job: publicJob(job) });
});

app.get("/api/jobs/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("snapshot", publicJob(job));
  job.clients.add(res);
  req.on("close", () => job.clients.delete(res));
});

function startRepairJob(job, formatPref) {
  return new Promise((resolve) => {
    if (job.status === "repairing") {
      resolve({ ok: false, error: "already repairing" });
      return;
    }
    if (!job.samplePath || !fs.existsSync(job.samplePath)) {
      resolve({ ok: false, error: "sample required" });
      return;
    }

    if (formatPref) {
      job.formatPref = String(formatPref).toLowerCase();
      job.outputFormat = resolveOutputFormat(job.inputPath, job.formatPref);
      job.outputPath = path.join(OUTPUTS, `${job.id}_repaired.${job.outputFormat}`);
    }

    job.status = "repairing";
    job.percent = 0;
    job.error = null;
    job.result = null;
    job.logs = [];

    const engine = new RepairJob({
      jobId: job.id,
      inputPath: job.inputPath,
      outputPath: job.outputPath,
      formatPref: job.formatPref,
      workDir: job.workDir,
      samplePath: job.samplePath,
    });
    job.engine = engine;

    engine.on("progress", (p) => {
      job.percent = p.percent;
      job.stageIndex = p.stageIndex;
      job.stageLabel = p.stageLabel;
      job.stages = p.stages;
      broadcast(job, "progress", publicJob(job));
    });
    engine.on("log", (line) => {
      job.logs.push(line);
      broadcast(job, "log", { line, jobId: job.id });
    });

    (async () => {
      try {
        await engine.run();
        job.status = "done";
        job.percent = 100;
        const st = fs.existsSync(job.outputPath) ? fs.statSync(job.outputPath) : null;
        const outProbe = await probeFile(job.outputPath);
        const downloadName =
          path.basename(job.originalName, path.extname(job.originalName)) +
          `_repaired.${job.outputFormat}`;
        job.result = {
          outputPath: job.outputPath,
          downloadUrl: `/api/jobs/${job.id}/download`,
          previewUrl: `/api/jobs/${job.id}/preview`,
          filename: downloadName,
          format: job.outputFormat,
          size: st?.size || outProbe.size || 0,
          duration: outProbe.duration,
          width: outProbe.width,
          height: outProbe.height,
          videoCodec: outProbe.videoCodec,
          audioCodec: outProbe.audioCodec,
          strategy: engine.strategy,
          nativeResolution:
            outProbe.width && outProbe.height
              ? `${outProbe.width}×${outProbe.height}`
              : null,
        };

        const thumbName = `${job.id}_out.jpg`;
        const thumbPath = path.join(THUMBS, thumbName);
        const at = outProbe.duration > 2 ? Math.min(outProbe.duration * 0.15, 10) : 0.5;
        if (await generateThumbnail(job.outputPath, thumbPath, { atSec: at })) {
          job.thumbnailUrl = `/thumbs/${thumbName}?t=${Date.now()}`;
        }

        broadcast(job, "done", publicJob(job));
        resolve({ ok: true, job: publicJob(job) });
      } catch (err) {
        job.status = "error";
        job.error = err.message || String(err);
        broadcast(job, "done", publicJob(job));
        resolve({ ok: false, error: job.error, job: publicJob(job) });
      }
    })();
  });
}

app.post("/api/jobs/:id/repair", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (job.status === "repairing") {
    res.status(409).json({ error: "Repair already in progress" });
    return;
  }
  if (!job.samplePath || !fs.existsSync(job.samplePath)) {
    res.status(400).json({
      error:
        "Advanced Repair requires a sample video from the same camera. Upload a healthy reference clip first.",
    });
    return;
  }

  res.json({ ok: true, job: publicJob(job) });
  // Fire and forget — progress via SSE
  startRepairJob(job, req.body?.formatPref);
});

/** Repair all ready jobs sequentially (batch) */
app.post("/api/batch/repair", async (req, res) => {
  const formatPref = req.body?.formatPref;
  const ids = Array.isArray(req.body?.jobIds) ? req.body.jobIds : null;
  const targets = [...jobs.values()].filter((j) => {
    if (ids && !ids.includes(j.id)) return false;
    return j.status === "ready" || j.status === "error" || j.status === "cancelled";
  });

  const missing = targets.filter((j) => !j.samplePath || !fs.existsSync(j.samplePath));
  if (missing.length === targets.length && targets.length > 0) {
    res.status(400).json({
      error: "All selected jobs need a sample video first.",
    });
    return;
  }

  const queue = targets.filter((j) => j.samplePath && fs.existsSync(j.samplePath));
  if (!queue.length) {
    res.status(400).json({
      error: "No jobs ready to repair. Upload damaged files + a sample first.",
    });
    return;
  }

  batchRunning = true;
  res.json({
    ok: true,
    queued: queue.map((j) => j.id),
    count: queue.length,
  });

  batchQueue = batchQueue.then(async () => {
    for (const job of queue) {
      if (job.status === "repairing") continue;
      await startRepairJob(job, formatPref || job.formatPref);
    }
    batchRunning = false;
    for (const resClient of batchClients) {
      try {
        resClient.write(
          `event: batch_done\ndata: ${JSON.stringify({
            jobs: [...jobs.values()].map(publicJob),
          })}\n\n`
        );
      } catch {
        batchClients.delete(resClient);
      }
    }
  });
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (job.engine) job.engine.cancel();
  if (job.status === "repairing") {
    job.status = "cancelled";
    job.error = "Cancelled by user";
    broadcast(job, "done", publicJob(job));
  }
  res.json({ ok: true });
});

/** Stream repaired video for in-app preview (before download commit) */
app.get("/api/jobs/:id/preview", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    res.status(404).json({ error: "Preview not available — repair first" });
    return;
  }
  const ext = path.extname(job.outputPath).toLowerCase();
  const type = ext === ".mov" ? "video/quicktime" : "video/mp4";
  const stat = fs.statSync(job.outputPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunk = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunk,
      "Content-Type": type,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(job.outputPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(job.outputPath).pipe(res);
  }
});

app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    res.status(404).json({ error: "Output not available" });
    return;
  }
  const name =
    path.basename(job.originalName, path.extname(job.originalName)) +
    `_repaired.${job.outputFormat}`;
  res.download(job.outputPath, name);
});

app.patch("/api/jobs/:id/format", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (job.status === "repairing") {
    res.status(409).json({ error: "Cannot change format while repairing" });
    return;
  }
  const formatPref = String(req.body.formatPref || "auto").toLowerCase();
  job.formatPref = formatPref;
  job.outputFormat = resolveOutputFormat(job.inputPath, formatPref);
  if (job.status !== "done") {
    job.outputPath = path.join(OUTPUTS, `${job.id}_repaired.${job.outputFormat}`);
  }
  res.json({ job: publicJob(job) });
});

/** Set format for all jobs */
app.patch("/api/batch/format", (req, res) => {
  const formatPref = String(req.body.formatPref || "auto").toLowerCase();
  for (const job of jobs.values()) {
    if (job.status === "repairing") continue;
    job.formatPref = formatPref;
    job.outputFormat = resolveOutputFormat(job.inputPath, formatPref);
    if (job.status !== "done") {
      job.outputPath = path.join(OUTPUTS, `${job.id}_repaired.${job.outputFormat}`);
    }
  }
  res.json({ jobs: [...jobs.values()].map(publicJob) });
});

app.delete("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (job.engine) job.engine.cancel();
  for (const p of [job.inputPath, job.outputPath]) {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(job.workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  jobs.delete(job.id);
  res.json({ ok: true });
});

/** Clear entire batch session */
app.delete("/api/batch", (_req, res) => {
  for (const job of jobs.values()) {
    if (job.engine) job.engine.cancel();
  }
  jobs.clear();
  sharedSample = null;
  res.json({ ok: true });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC, "index.html"));
});

function checkBinaries() {
  if (!ffmpegOk()) {
    console.error(`ERROR: ffmpeg not found. Install it, then restart:\n  ${installHint()}`);
    process.exit(1);
  }
  if (!ffprobeOk()) {
    console.error(`ERROR: ffprobe not found. Install it, then restart:\n  ${installHint()}`);
    process.exit(1);
  }
  console.log("ffmpeg/ffprobe OK");
}

checkBinaries();

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Video Repair App running at http://127.0.0.1:${PORT}`);
  console.log(`Mode: Advanced Batch Repair (sample required)`);
  console.log(`Data: ${DATA}`);
});
