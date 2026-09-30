/**
 * Advanced video repair engine (always-on advanced mode).
 * Requires a healthy sample/reference video from the same device
 * (Wondershare Repairit Advanced-style workflow).
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const {
  fileMissingMoov,
  recoverMissingMoov,
} = require("./moovRecover");
const { FFMPEG, FFPROBE } = require("./binaries");

const STAGES = [
  { id: "analyze", label: "Analyzing damaged file", weight: 10 },
  { id: "sample", label: "Matching sample reference", weight: 12 },
  { id: "extract", label: "Extracting media streams", weight: 13 },
  { id: "scan", label: "Scanning frames & errors", weight: 15 },
  { id: "reconstruct", label: "Reconstructing with sample template", weight: 18 },
  { id: "recover", label: "Advanced frame recovery", weight: 22 },
  { id: "finalize", label: "Writing & finalizing output", weight: 10 },
];

function run(cmd, args, { onStderr, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timer;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
        reject(new Error(`Timed out after ${timeoutMs}ms: ${cmd}`));
      }, timeoutMs);
    }

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killed) return;
      resolve({ code, stdout, stderr });
    });
  });
}

function parseFrameRate(rate) {
  if (!rate || rate === "0/0") return null;
  if (typeof rate === "number") return rate > 0 && rate < 1000 ? rate : null;
  const parts = String(rate).split("/");
  if (parts.length === 2) {
    const n = parseFloat(parts[0]);
    const d = parseFloat(parts[1]);
    if (d) {
      const v = n / d;
      return v > 0 && v < 1000 ? v : null;
    }
  }
  const v = parseFloat(rate);
  return v > 0 && v < 1000 ? v : null;
}

function summarizeProbe(probe) {
  if (!probe) return null;
  return {
    ok: !!probe.ok,
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
    fps: probe.fps,
    pixFmt: probe.pixFmt,
    profile: probe.profile,
    level: probe.level,
    sampleRate: probe.sampleRate,
    channels: probe.channels,
    bitRate: probe.bitRate,
    hasVideo: probe.hasVideo,
    hasAudio: probe.hasAudio,
  };
}

async function probeFile(filePath) {
  const args = [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-show_error",
    filePath,
  ];
  try {
    const { code, stdout } = await run(FFPROBE, args, { timeoutMs: 60000 });
    if (code !== 0 || !stdout.trim()) {
      return {
        ok: false,
        raw: null,
        duration: 0,
        hasVideo: false,
        hasAudio: false,
      };
    }
    const raw = JSON.parse(stdout);
    const streams = raw.streams || [];
    const v = streams.find((s) => s.codec_type === "video");
    const a = streams.find((s) => s.codec_type === "audio");
    const duration =
      parseFloat(raw.format?.duration || v?.duration || a?.duration || 0) || 0;
    const fps =
      parseFrameRate(v?.r_frame_rate) ||
      parseFrameRate(v?.avg_frame_rate) ||
      null;

    return {
      ok: true,
      raw,
      duration,
      hasVideo: !!v,
      hasAudio: !!a,
      formatName: raw.format?.format_name || "",
      size: parseInt(raw.format?.size || "0", 10) || 0,
      bitRate: parseInt(raw.format?.bit_rate || "0", 10) || 0,
      videoCodec: v?.codec_name,
      audioCodec: a?.codec_name,
      width: v?.width,
      height: v?.height,
      fps,
      pixFmt: v?.pix_fmt,
      profile: v?.profile,
      level: v?.level,
      sampleRate: a?.sample_rate ? parseInt(a.sample_rate, 10) : null,
      channels: a?.channels || null,
      timeBase: v?.time_base,
      codecTag: v?.codec_tag_string,
    };
  } catch {
    return {
      ok: false,
      raw: null,
      duration: 0,
      hasVideo: false,
      hasAudio: false,
    };
  }
}

/**
 * Build encode args from sample for timing/audio only.
 * NEVER force-scale to sample resolution — preserve native stream resolution.
 * Optional damagedProbe supplies native width/height when re-encode needs a size.
 */
function encodeArgsFromSample(sample, damagedProbe = null) {
  const args = [];
  const fps = sample?.fps || damagedProbe?.fps;
  const pix = sample?.pixFmt && sample.pixFmt !== "unknown" ? sample.pixFmt : "yuv420p";

  // Video — high quality re-encode, native resolution (no scale filter)
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18");
  args.push("-pix_fmt", "yuv420p");
  // Preserve source dimensions; only set SAR if needed
  args.push("-vf", "setsar=1");

  if (fps) {
    args.push("-r", String(Math.round(fps * 1000) / 1000));
  }

  // Audio matched to sample when possible
  args.push("-c:a", "aac", "-b:a", "192k");
  if (sample?.sampleRate) {
    args.push("-ar", String(sample.sampleRate));
  } else if (damagedProbe?.sampleRate) {
    args.push("-ar", String(damagedProbe.sampleRate));
  }
  if (sample?.channels) {
    args.push("-ac", String(Math.min(sample.channels, 2)));
  } else if (damagedProbe?.channels) {
    args.push("-ac", String(Math.min(damagedProbe.channels, 2)));
  }
  args.push("-af", "aresample=async=1:first_pts=0");
  args.push("-max_muxing_queue_size", "1024");
  args.push("-avoid_negative_ts", "make_zero");

  return args;
}

function parseTime(str) {
  if (!str) return 0;
  const parts = str.trim().split(":");
  if (parts.length === 3) {
    return (
      parseFloat(parts[0]) * 3600 +
      parseFloat(parts[1]) * 60 +
      parseFloat(parts[2])
    );
  }
  return parseFloat(str) || 0;
}

function parseProgressLine(line, durationSec) {
  const timeMatch = line.match(/time=(\S+)/);
  if (!timeMatch) return null;
  const t = parseTime(timeMatch[1]);
  if (!durationSec || durationSec <= 0) {
    return Math.min(0.95, t > 0 ? 0.3 + Math.min(t / 120, 0.6) : 0.1);
  }
  return Math.max(0, Math.min(0.99, t / durationSec));
}

function extOf(filePath) {
  return path.extname(filePath).toLowerCase();
}

function resolveOutputFormat(inputPath, formatPref) {
  if (formatPref === "mp4") return "mp4";
  if (formatPref === "mov") return "mov";
  const e = extOf(inputPath);
  if (e === ".mov") return "mov";
  return "mp4";
}

function outputArgsForFormat(format) {
  if (format === "mov") {
    return ["-f", "mov", "-movflags", "+faststart"];
  }
  return ["-f", "mp4", "-movflags", "+faststart"];
}

function compareToSample(damaged, sample) {
  const notes = [];
  const warnings = [];
  if (!sample?.ok) {
    return { notes: ["Sample could not be probed"], warnings: ["Invalid sample"], matchScore: 0 };
  }
  if (!damaged?.ok) {
    notes.push("Damaged file is not probeable — sample will supply all structure");
  }
  if (sample.width && damaged?.width && sample.width !== damaged.width) {
    warnings.push(
      `Resolution differs (sample ${sample.width}×${sample.height} vs damaged ${damaged.width}×${damaged.height}) — sample size will be used`
    );
  } else if (sample.width) {
    notes.push(`Resolution template: ${sample.width}×${sample.height}`);
  }
  if (sample.fps) {
    notes.push(`Frame rate template: ${sample.fps.toFixed(3)} fps`);
  }
  if (sample.videoCodec) {
    notes.push(`Video codec template: ${sample.videoCodec}${sample.profile ? ` (${sample.profile})` : ""}`);
    if (damaged?.videoCodec && damaged.videoCodec !== sample.videoCodec) {
      warnings.push(
        `Codec mismatch (sample ${sample.videoCodec} vs damaged ${damaged.videoCodec}) — ensure sample is from the same camera`
      );
    }
  }
  if (sample.audioCodec) {
    notes.push(`Audio codec template: ${sample.audioCodec}`);
  }
  if (sample.sampleRate) {
    notes.push(`Audio rate template: ${sample.sampleRate} Hz`);
  }

  // Rough match score for UI
  let score = 40; // baseline for having a valid sample
  if (damaged?.ok) {
    if (sample.width && damaged.width === sample.width) score += 20;
    if (sample.height && damaged.height === sample.height) score += 10;
    if (sample.videoCodec && damaged.videoCodec === sample.videoCodec) score += 20;
    if (sample.fps && damaged.fps && Math.abs(sample.fps - damaged.fps) < 0.5) score += 10;
  } else {
    score += 20; // sample is critical when damaged is unreadable
  }
  return { notes, warnings, matchScore: Math.min(100, score) };
}

class RepairJob extends EventEmitter {
  constructor({
    jobId,
    inputPath,
    outputPath,
    formatPref = "auto",
    workDir,
    samplePath = null,
  }) {
    super();
    this.jobId = jobId;
    this.inputPath = inputPath;
    this.outputPath = outputPath;
    this.formatPref = formatPref;
    this.workDir = workDir;
    this.samplePath = samplePath;
    this.cancelled = false;
    this.percent = 0;
    this.stageIndex = 0;
    this.stageLabel = STAGES[0].label;
    this.logs = [];
    this.probe = null;
    this.sampleProbe = null;
    this.strategy = null;
    this.success = false;
    this.error = null;
  }

  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    this.logs.push(line);
    this.emit("log", line);
  }

  setProgress(stageIndex, stageFraction = 0) {
    let base = 0;
    for (let i = 0; i < stageIndex; i++) base += STAGES[i].weight;
    const weight = STAGES[stageIndex]?.weight || 0;
    const frac = Math.min(1, Math.max(0, stageFraction));
    const p = Math.min(100, Math.round(base + weight * frac));
    this.stageIndex = stageIndex;
    this.stageLabel = STAGES[stageIndex]?.label || "Working…";
    this.percent = p;
    const complete = p >= 100 && frac >= 1 && stageIndex >= STAGES.length - 1;
    this.emit("progress", {
      percent: this.percent,
      stageIndex: this.stageIndex,
      stageId: STAGES[stageIndex]?.id,
      stageLabel: complete ? "Repair complete" : this.stageLabel,
      stages: STAGES.map((s, i) => ({
        ...s,
        status:
          complete || i < stageIndex
            ? "done"
            : i === stageIndex
              ? "active"
              : "pending",
      })),
    });
  }

  cancel() {
    this.cancelled = true;
    if (this._currentChild) {
      try {
        this._currentChild.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  assertNotCancelled() {
    if (this.cancelled) throw new Error("Repair cancelled");
  }

  async runFfmpeg(args, { stageIndex, durationHint = 0, label = "ffmpeg" } = {}) {
    this.log(`${label}: ffmpeg ${args.slice(0, 24).join(" ")}${args.length > 24 ? " …" : ""}`);
    return new Promise((resolve, reject) => {
      const child = spawn(FFMPEG, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";

      child.stderr.on("data", (d) => {
        const s = d.toString();
        stderr += s;
        const lines = s.split(/\r|\n/);
        for (const line of lines) {
          const frac = parseProgressLine(line, durationHint);
          if (frac != null && stageIndex != null) {
            this.setProgress(stageIndex, frac);
          }
        }
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (this.cancelled) {
          reject(new Error("Repair cancelled"));
          return;
        }
        resolve({ code, stderr });
      });

      this._currentChild = child;
    });
  }

  async fileLooksValid(filePath) {
    if (!fs.existsSync(filePath)) return false;
    const st = fs.statSync(filePath);
    if (st.size < 1024) return false;
    const p = await probeFile(filePath);
    return p.ok && (p.hasVideo || p.hasAudio) && p.duration > 0.05;
  }

  async run() {
    const started = Date.now();
    try {
      if (!this.samplePath || !fs.existsSync(this.samplePath)) {
        throw new Error(
          "Advanced Repair requires a sample video from the same camera/device. Upload a healthy reference clip first."
        );
      }

      this.setProgress(0, 0.1);
      this.log("Starting Advanced Repair Mode (sample-guided)");
      this.assertNotCancelled();

      // --- Stage 0: Analyze damaged ---
      const missingMoov = fileMissingMoov(this.inputPath);
      this.probe = await probeFile(this.inputPath);
      this.setProgress(0, 0.8);
      if (missingMoov) {
        this.log("CRITICAL: moov atom missing — file is not openable by normal players");
        this.log("Will use sample-guided mdat recovery (Repairit-style advanced path)");
      } else if (this.probe.ok) {
        this.log(
          `Damaged probe — duration=${this.probe.duration.toFixed(2)}s video=${this.probe.videoCodec || "n/a"} audio=${this.probe.audioCodec || "n/a"} ${this.probe.width || "?"}x${this.probe.height || "?"}`
        );
      } else {
        this.log("Damaged file not fully probeable — sample will define structure");
      }
      this.setProgress(0, 1);

      // --- Stage 1: Match sample reference ---
      this.setProgress(1, 0.15);
      this.sampleProbe = await probeFile(this.samplePath);
      if (!this.sampleProbe.ok || !this.sampleProbe.hasVideo) {
        throw new Error(
          "Sample video is not a valid playable video. Choose a healthy clip recorded with the same device."
        );
      }
      this.setProgress(1, 0.5);
      const cmp = compareToSample(this.probe, this.sampleProbe);
      for (const n of cmp.notes) this.log(`Sample: ${n}`);
      for (const w of cmp.warnings) this.log(`Warning: ${w}`);
      this.log(`Sample match score: ${cmp.matchScore}%`);
      this.setProgress(1, 1);

      const format = resolveOutputFormat(this.inputPath, this.formatPref);
      const duration = this.probe.duration || 0;
      const containerArgs = outputArgsForFormat(format);
      const sampleEncode = encodeArgsFromSample(this.sampleProbe, this.probe);

      fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
      fs.mkdirSync(this.workDir, { recursive: true });
      if (fs.existsSync(this.outputPath)) fs.unlinkSync(this.outputPath);

      // ========== PRIMARY PATH: missing moov (real-world camera corruption) ==========
      if (missingMoov || !this.probe.ok) {
        this.setProgress(2, 0.1);
        this.log("Entering moov-less recovery pipeline…");
        this.assertNotCancelled();

        // Stage 2–5 handled inside recoverMissingMoov with progress mapping
        const moovOut = path.join(this.workDir, `moov_recovered.${format}`);
        try {
          const rec = await recoverMissingMoov({
            damagedPath: this.inputPath,
            samplePath: this.samplePath,
            outputPath: moovOut,
            workDir: this.workDir,
            format,
            onLog: (m) => this.log(m),
            onProgress: (frac) => {
              // Map 0–1 across stages 2–5
              if (frac < 0.25) this.setProgress(2, frac / 0.25);
              else if (frac < 0.5) this.setProgress(3, (frac - 0.25) / 0.25);
              else if (frac < 0.8) this.setProgress(4, (frac - 0.5) / 0.3);
              else this.setProgress(5, (frac - 0.8) / 0.2);
            },
          });
          this.strategy = rec.strategy || "moov-recover";
          this.log(
            `Moov recovery: ${rec.frames} frames` +
              (rec.hasAudio ? " + audio" : " (video only)") +
              ` @ ${rec.fps?.toFixed?.(2) || "?"} fps`
          );

          // Finalize
          this.setProgress(6, 0.2);
          if (!(await this.fileLooksValid(moovOut))) {
            throw new Error("Moov recovery produced an unreadable file");
          }
          fs.copyFileSync(moovOut, this.outputPath);
          this.setProgress(6, 0.7);
          const outProbe = await probeFile(this.outputPath);
          if (!outProbe.ok) throw new Error("Output file failed validation");
          this.setProgress(6, 1);

          this.success = true;
          const elapsed = ((Date.now() - started) / 1000).toFixed(1);
          this.log(`Repair complete in ${elapsed}s → ${this.outputPath}`);
          this.emit("done", {
            success: true,
            outputPath: this.outputPath,
            strategy: this.strategy,
            format,
            duration: outProbe.duration,
            size: outProbe.size,
            width: outProbe.width,
            height: outProbe.height,
            videoCodec: outProbe.videoCodec,
            audioCodec: outProbe.audioCodec,
            elapsedSec: parseFloat(elapsed),
            sampleMatchScore: cmp.matchScore,
          });
          return { success: true, outputPath: this.outputPath };
        } catch (moovErr) {
          this.log(`Moov recovery failed: ${moovErr.message}`);
          // If probe was ok somehow, fall through to standard path; else rethrow
          if (missingMoov && !this.probe.ok) {
            throw moovErr;
          }
          this.log("Falling back to standard FFmpeg repair path…");
        }
      }

      // ========== STANDARD PATH: file still somewhat openable ==========
      const remuxPath = path.join(this.workDir, `remux.${format}`);
      const recoverPath = path.join(this.workDir, `recover.${format}`);
      const deepPath = path.join(this.workDir, `deep.${format}`);
      const sampleGuidedPath = path.join(this.workDir, `sample_guided.${format}`);

      // --- Stage 2: Extract / soft remux ---
      this.setProgress(2, 0.05);
      this.assertNotCancelled();
      let remuxOk = false;
      {
        const args = [
          "-y",
          "-hide_banner",
          "-err_detect",
          "ignore_err",
          "-fflags",
          "+genpts+igndts+discardcorrupt+flush_packets",
          "-i",
          this.inputPath,
          "-map",
          "0",
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          ...containerArgs,
          remuxPath,
        ];
        const { code } = await this.runFfmpeg(args, {
          stageIndex: 2,
          durationHint: duration,
          label: "soft-remux",
        });
        remuxOk = code === 0 && (await this.fileLooksValid(remuxPath));
        this.log(
          remuxOk
            ? "Soft remux succeeded"
            : "Soft remux insufficient — continuing sample-guided path"
        );
      }
      this.setProgress(2, 1);

      // --- Stage 3: Scan ---
      this.setProgress(3, 0.1);
      this.assertNotCancelled();
      let errorHints = 0;
      if (this.probe.ok || remuxOk) {
        const scanTarget = remuxOk ? remuxPath : this.inputPath;
        const scanArgs = [
          "-hide_banner",
          "-err_detect",
          "aggressive",
          "-fflags",
          "+discardcorrupt",
          "-i",
          scanTarget,
          "-t",
          "3",
          "-f",
          "null",
          "-",
        ];
        const { stderr } = await this.runFfmpeg(scanArgs, {
          stageIndex: 3,
          durationHint: 3,
          label: "error-scan",
        });
        const errMatches = stderr.match(/error|corrupt|invalid|missing|damaged/gi) || [];
        errorHints = errMatches.length;
        this.log(`Frame scan found ~${errorHints} error indicators`);
      } else {
        this.log("Skipping scan — source unreadable");
        for (let i = 1; i <= 5; i++) {
          this.setProgress(3, i / 5);
          await sleep(40);
        }
      }
      this.setProgress(3, 1);

      // --- Stage 4: Reconstruct ---
      this.setProgress(4, 0.05);
      this.assertNotCancelled();
      let reconstructed = remuxOk ? remuxPath : null;

      if (!remuxOk) {
        // Try moov recovery even if we thought moov existed (partial damage)
        try {
          this.log("Attempting mdat-level recovery as reconstruct step…");
          const moovOut = path.join(this.workDir, `moov_fallback.${format}`);
          const rec = await recoverMissingMoov({
            damagedPath: this.inputPath,
            samplePath: this.samplePath,
            outputPath: moovOut,
            workDir: this.workDir,
            format,
            onLog: (m) => this.log(m),
            onProgress: (frac) => this.setProgress(4, frac),
          });
          if (await this.fileLooksValid(moovOut)) {
            reconstructed = moovOut;
            this.strategy = rec.strategy || "moov-recover";
            this.log("Mdat recovery reconstruct succeeded");
          }
        } catch (e) {
          this.log(`Mdat reconstruct skipped: ${e.message}`);
        }
      }

      if (!reconstructed) {
        this.log("Building sample-guided re-encode…");
        const src = remuxOk ? remuxPath : this.inputPath;
        const args = [
          "-y",
          "-hide_banner",
          "-err_detect",
          "ignore_err",
          "-fflags",
          "+genpts+igndts+discardcorrupt+flush_packets",
          "-i",
          src,
          "-map",
          "0:v:0?",
          "-map",
          "0:a:0?",
          ...sampleEncode,
          ...containerArgs,
          sampleGuidedPath,
        ];
        const { code } = await this.runFfmpeg(args, {
          stageIndex: 4,
          durationHint: duration || this.sampleProbe.duration || 0,
          label: "sample-guided",
        });
        if (code === 0 && (await this.fileLooksValid(sampleGuidedPath))) {
          reconstructed = sampleGuidedPath;
          this.strategy = "sample-guided";
          this.log("Sample-guided reconstruction succeeded");
        }
      } else if (!this.strategy) {
        this.strategy = remuxOk ? "container-repair+sample" : "reconstruct";
        for (let i = 1; i <= 4; i++) {
          this.setProgress(4, i / 4);
          await sleep(30);
        }
      }
      this.setProgress(4, 1);

      // --- Stage 5: Deep recovery if needed ---
      this.setProgress(5, 0.05);
      this.assertNotCancelled();
      let finalSource = reconstructed;

      if (!finalSource) {
        this.strategy = "sample-deep-recover";
        this.log("Deep recovery with sample template");
        const args = [
          "-y",
          "-hide_banner",
          "-err_detect",
          "ignore_err",
          "-fflags",
          "+genpts+igndts+discardcorrupt+flush_packets",
          "-i",
          this.inputPath,
          "-map",
          "0:v:0?",
          "-map",
          "0:a:0?",
          ...sampleEncode,
          ...containerArgs,
          deepPath,
        ];
        const { code } = await this.runFfmpeg(args, {
          stageIndex: 5,
          durationHint: duration || 0,
          label: "deep-recover",
        });
        if (code === 0 && (await this.fileLooksValid(deepPath))) {
          finalSource = deepPath;
        } else {
          throw new Error(
            "Advanced repair could not recover playable media. Use a healthy sample from the SAME camera (same resolution & settings). Your damaged file may be missing its index (moov) — the sample is required to rebuild it."
          );
        }
      } else {
        for (let i = 1; i <= 6; i++) {
          this.setProgress(5, i / 6);
          await sleep(30);
        }
      }
      this.setProgress(5, 1);

      // --- Stage 6: Finalize ---
      this.setProgress(6, 0.2);
      this.assertNotCancelled();
      if (!finalSource || !fs.existsSync(finalSource)) {
        throw new Error("No repaired output produced");
      }
      fs.copyFileSync(finalSource, this.outputPath);
      this.setProgress(6, 0.7);

      const outProbe = await probeFile(this.outputPath);
      if (!outProbe.ok) {
        throw new Error("Output file failed validation");
      }
      this.setProgress(6, 1);

      this.success = true;
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      this.log(`Repair complete in ${elapsed}s → ${this.outputPath}`);
      this.emit("done", {
        success: true,
        outputPath: this.outputPath,
        strategy: this.strategy,
        format,
        duration: outProbe.duration,
        size: outProbe.size,
        width: outProbe.width,
        height: outProbe.height,
        videoCodec: outProbe.videoCodec,
        audioCodec: outProbe.audioCodec,
        elapsedSec: parseFloat(elapsed),
        sampleMatchScore: cmp.matchScore,
      });
      return { success: true, outputPath: this.outputPath };
    } catch (err) {
      this.success = false;
      this.error = err.message || String(err);
      this.log(`ERROR: ${this.error}`);
      this.emit("done", { success: false, error: this.error });
      throw err;
    } finally {
      this._currentChild = null;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function generateThumbnail(inputPath, outputPng, { atSec = 1 } = {}) {
  fs.mkdirSync(path.dirname(outputPng), { recursive: true });
  const attempts = [atSec, 0.5, 0, 2];
  for (const t of attempts) {
    const args = [
      "-y",
      "-hide_banner",
      "-err_detect",
      "ignore_err",
      "-fflags",
      "+genpts+discardcorrupt",
      "-ss",
      String(Math.max(0, t)),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=480:-2",
      "-q:v",
      "3",
      outputPng,
    ];
    try {
      const { code } = await run(FFMPEG, args, { timeoutMs: 30000 });
      if (code === 0 && fs.existsSync(outputPng) && fs.statSync(outputPng).size > 100) {
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

module.exports = {
  STAGES,
  RepairJob,
  probeFile,
  generateThumbnail,
  resolveOutputFormat,
  summarizeProbe,
  compareToSample,
  FFMPEG,
  FFPROBE,
};
