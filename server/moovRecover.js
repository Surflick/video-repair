/**
 * Recover playable H.264 (and optional PCM) from MOV/MP4 files that lost their moov atom.
 * Uses a healthy sample from the same device for audio interleave layout, fps, and codec params.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { FFMPEG, FFPROBE } = require("./binaries");

const VCL_TYPES = new Set([1, 5]);
const VALID_NAL = new Set([1, 5, 6, 7, 8, 9]);

function run(cmd, args, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Timed out: ${cmd}`));
      }, timeoutMs);
    }
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function readU32(buf, off) {
  return buf.readUInt32BE(off);
}

/**
 * Walk top-level ISO BMFF boxes; return { type, start, headerSize, size }[]
 */
function listTopBoxes(filePath) {
  const fd = fs.openSync(filePath, "r");
  const fileSize = fs.fstatSync(fd).size;
  const boxes = [];
  let pos = 0;
  const hdr = Buffer.alloc(16);
  try {
    while (pos + 8 <= fileSize && boxes.length < 64) {
      fs.readSync(fd, hdr, 0, 8, pos);
      let size = hdr.readUInt32BE(0);
      const type = hdr.slice(4, 8).toString("ascii");
      let headerSize = 8;
      if (size === 1) {
        fs.readSync(fd, hdr, 8, 8, pos + 8);
        size = Number(hdr.readBigUInt64BE(8));
        headerSize = 16;
      } else if (size === 0) {
        size = fileSize - pos;
      }
      if (size < headerSize || pos + size > fileSize) {
        boxes.push({ type, start: pos, headerSize, size, invalid: true });
        break;
      }
      boxes.push({ type, start: pos, headerSize, size, invalid: false });
      pos += size;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { boxes, fileSize };
}

function findMdat(filePath) {
  const { boxes } = listTopBoxes(filePath);
  const mdat = boxes.find((b) => b.type === "mdat" && !b.invalid);
  if (!mdat) return null;
  return {
    dataStart: mdat.start + mdat.headerSize,
    dataSize: mdat.size - mdat.headerSize,
    hasMoov: boxes.some((b) => b.type === "moov" && !b.invalid),
    boxes,
  };
}

function fileMissingMoov(filePath) {
  try {
    const { boxes } = listTopBoxes(filePath);
    const hasMdat = boxes.some((b) => b.type === "mdat" && !b.invalid);
    const hasMoov = boxes.some((b) => b.type === "moov" && !b.invalid);
    return hasMdat && !hasMoov;
  } catch {
    return false;
  }
}

/**
 * Parse sample MOV/MP4 for recovery hints (audio interleave, avcC, fps).
 */
async function analyzeSampleStructure(samplePath) {
  const result = {
    ok: false,
    nalLengthSize: 4,
    sps: null,
    pps: null,
    audioChunkBytes: null,
    audioSampleRate: null,
    audioChannels: null,
    audioCodec: null,
    videoCodec: null,
    width: null,
    height: null,
    fps: null,
    hasPcmAudio: false,
  };

  // Probe via ffprobe for easy fields
  try {
    const { code, stdout } = await run(
      FFPROBE,
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        samplePath,
      ],
      60000
    );
    if (code === 0 && stdout.trim()) {
      const raw = JSON.parse(stdout);
      const v = (raw.streams || []).find((s) => s.codec_type === "video");
      const a = (raw.streams || []).find((s) => s.codec_type === "audio");
      if (v) {
        result.videoCodec = v.codec_name;
        result.width = v.width;
        result.height = v.height;
        const fr = v.r_frame_rate || v.avg_frame_rate;
        if (fr && fr.includes("/")) {
          const [n, d] = fr.split("/").map(Number);
          if (d) result.fps = n / d;
        } else if (fr) {
          result.fps = parseFloat(fr) || null;
        }
      }
      if (a) {
        result.audioCodec = a.codec_name;
        result.audioSampleRate = a.sample_rate ? parseInt(a.sample_rate, 10) : null;
        result.audioChannels = a.channels || null;
        result.hasPcmAudio = /^pcm_/i.test(a.codec_name || "");
      }
    }
  } catch {
    /* continue with box parse */
  }

  // Box-level parse for avcC + audio stsz/stsc chunk size
  try {
    const buf = fs.readFileSync(samplePath);
    const top = listBoxesInBuffer(buf, 0, buf.length);
    const moov = top.find((b) => b.type === "moov");
    if (!moov) {
      result.ok = !!(result.width || result.videoCodec);
      return result;
    }
    const moovKids = listBoxesInBuffer(buf, moov.start + moov.headerSize, moov.start + moov.size);
    for (const trak of moovKids.filter((b) => b.type === "trak")) {
      const trakKids = listBoxesInBuffer(buf, trak.start + trak.headerSize, trak.start + trak.size);
      const mdia = trakKids.find((b) => b.type === "mdia");
      if (!mdia) continue;
      const mdiaKids = listBoxesInBuffer(buf, mdia.start + mdia.headerSize, mdia.start + mdia.size);
      const hdlr = mdiaKids.find((b) => b.type === "hdlr");
      let handler = "";
      if (hdlr) {
        const off = hdlr.start + hdlr.headerSize;
        handler = buf.slice(off + 8, off + 12).toString("ascii");
      }
      const minf = mdiaKids.find((b) => b.type === "minf");
      if (!minf) continue;
      const minfKids = listBoxesInBuffer(buf, minf.start + minf.headerSize, minf.start + minf.size);
      const stbl = minfKids.find((b) => b.type === "stbl");
      if (!stbl) continue;
      const stblKids = listBoxesInBuffer(buf, stbl.start + stbl.headerSize, stbl.start + stbl.size);

      if (handler === "vide") {
        const stsd = stblKids.find((b) => b.type === "stsd");
        if (stsd) {
          const region = buf.slice(stsd.start, stsd.start + stsd.size);
          const avccIdx = region.indexOf(Buffer.from("avcC"));
          if (avccIdx >= 4) {
            const asz = region.readUInt32BE(avccIdx - 4);
            const avcc = region.slice(avccIdx + 4, avccIdx - 4 + asz);
            if (avcc.length >= 7) {
              result.nalLengthSize = (avcc[4] & 3) + 1;
              let p = 5;
              const nSps = avcc[p] & 0x1f;
              p += 1;
              for (let i = 0; i < nSps && p + 2 <= avcc.length; i++) {
                const sl = avcc.readUInt16BE(p);
                p += 2;
                if (i === 0) result.sps = Buffer.from(avcc.slice(p, p + sl));
                p += sl;
              }
              if (p < avcc.length) {
                const nPps = avcc[p];
                p += 1;
                for (let i = 0; i < nPps && p + 2 <= avcc.length; i++) {
                  const sl = avcc.readUInt16BE(p);
                  p += 2;
                  if (i === 0) result.pps = Buffer.from(avcc.slice(p, p + sl));
                  p += sl;
                }
              }
            }
          }
        }
      }

      if (handler === "soun" && result.hasPcmAudio) {
        const stsz = stblKids.find((b) => b.type === "stsz");
        const stsc = stblKids.find((b) => b.type === "stsc");
        let sampleSize = 0;
        let samplesPerChunk = 1;
        if (stsz) {
          const off = stsz.start + stsz.headerSize;
          sampleSize = buf.readUInt32BE(off + 4);
        }
        if (stsc) {
          const off = stsc.start + stsc.headerSize;
          const entryCount = buf.readUInt32BE(off + 4);
          if (entryCount >= 1) {
            // first entry: first_chunk, samples_per_chunk, desc
            samplesPerChunk = buf.readUInt32BE(off + 8 + 4);
          }
        }
        if (sampleSize > 0 && samplesPerChunk > 0) {
          result.audioChunkBytes = sampleSize * samplesPerChunk;
        } else if (result.audioSampleRate && result.audioChannels) {
          // fallback: 20ms of PCM
          const bps = 2;
          result.audioChunkBytes = Math.floor(result.audioSampleRate * 0.02) * result.audioChannels * bps;
        }
      }
    }
    result.ok = true;
  } catch (err) {
    result.parseError = err.message;
    result.ok = !!(result.width || result.videoCodec);
  }

  return result;
}

function listBoxesInBuffer(buf, start, end) {
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString("ascii");
    let headerSize = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = Number(buf.readBigUInt64BE(pos + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) break;
    boxes.push({ type, start: pos, headerSize, size });
    pos += size;
  }
  return boxes;
}

function isLikelyNal(data, off, nalLengthSize, maxNal) {
  if (off + nalLengthSize + 1 > data.length) return false;
  let ln;
  if (nalLengthSize === 4) ln = data.readUInt32BE(off);
  else if (nalLengthSize === 2) ln = data.readUInt16BE(off);
  else if (nalLengthSize === 1) ln = data[off];
  else if (nalLengthSize === 3)
    ln = (data[off] << 16) | (data[off + 1] << 8) | data[off + 2];
  else return false;

  if (ln < 1 || ln > maxNal || off + nalLengthSize + ln > data.length) return false;
  const b0 = data[off + nalLengthSize];
  if (b0 >> 7) return false; // forbidden_zero_bit
  const ntype = b0 & 0x1f;
  return VALID_NAL.has(ntype);
}

function readNalLength(data, off, nalLengthSize) {
  if (nalLengthSize === 4) return data.readUInt32BE(off);
  if (nalLengthSize === 2) return data.readUInt16BE(off);
  if (nalLengthSize === 1) return data[off];
  if (nalLengthSize === 3) return (data[off] << 16) | (data[off + 1] << 8) | data[off + 2];
  return 0;
}

/**
 * Extract annex-B H.264 (+ optional PCM) from a moov-less mdat using sample layout hints.
 */
function extractFromMdat(mdatBuffer, {
  nalLengthSize = 4,
  audioChunkBytes = null,
  maxNal = 500000,
  onProgress = null,
} = {}) {
  const h264 = [];
  const pcm = [];
  let h264Bytes = 0;
  let frames = 0;
  let audioChunks = 0;
  let resyncs = 0;
  let off = 0;
  const data = mdatBuffer;
  const total = data.length;

  const emitProgress = () => {
    if (onProgress) onProgress(Math.min(0.99, off / Math.max(total, 1)), { frames, audioChunks });
  };

  while (off + nalLengthSize + 1 <= data.length) {
    let gotVcl = false;
    let safety = 0;

    // One video sample: leading parameter sets / SEI / AUD, then VCL
    while (off + nalLengthSize + 1 <= data.length && safety < 32) {
      safety += 1;
      if (!isLikelyNal(data, off, nalLengthSize, maxNal)) break;
      const ln = readNalLength(data, off, nalLengthSize);
      const nalStart = off + nalLengthSize;
      const ntype = data[nalStart] & 0x1f;
      h264.push(Buffer.from([0, 0, 0, 1]));
      h264.push(data.subarray(nalStart, nalStart + ln));
      h264Bytes += 4 + ln;
      off = nalStart + ln;
      if (VCL_TYPES.has(ntype)) {
        gotVcl = true;
        frames += 1;
        break;
      }
    }

    if (!gotVcl) {
      // Try audio skip then resync
      if (
        audioChunkBytes &&
        off + audioChunkBytes <= data.length &&
        isLikelyNal(data, off + audioChunkBytes, nalLengthSize, maxNal)
      ) {
        pcm.push(Buffer.from(data.subarray(off, off + audioChunkBytes)));
        off += audioChunkBytes;
        audioChunks += 1;
        continue;
      }
      // Byte search for next valid NAL (limit window)
      let found = -1;
      const limit = Math.min(off + 250000, data.length - nalLengthSize - 1);
      for (let j = off + 1; j < limit; j++) {
        if (isLikelyNal(data, j, nalLengthSize, maxNal)) {
          found = j;
          break;
        }
      }
      if (found < 0) break;
      off = found;
      resyncs += 1;
      if (resyncs % 50 === 0) emitProgress();
      continue;
    }

    // After VCL: skip PCM audio chunk if sample suggests interleave
    if (
      audioChunkBytes &&
      off + audioChunkBytes <= data.length &&
      isLikelyNal(data, off + audioChunkBytes, nalLengthSize, maxNal)
    ) {
      pcm.push(Buffer.from(data.subarray(off, off + audioChunkBytes)));
      off += audioChunkBytes;
      audioChunks += 1;
    } else if (isLikelyNal(data, off, nalLengthSize, maxNal)) {
      // multi-sample video chunk — next VCL
      continue;
    } else if (audioChunkBytes && off + audioChunkBytes <= data.length) {
      // likely audio even if next video NAL check failed (end of stream noise)
      pcm.push(Buffer.from(data.subarray(off, off + audioChunkBytes)));
      off += audioChunkBytes;
      audioChunks += 1;
    } else {
      // resync
      let found = -1;
      const limit = Math.min(off + 250000, data.length - nalLengthSize - 1);
      for (let j = off; j < limit; j++) {
        if (isLikelyNal(data, j, nalLengthSize, maxNal)) {
          found = j;
          break;
        }
      }
      if (found < 0) break;
      if (found !== off) resyncs += 1;
      off = found;
    }

    if (frames % 120 === 0) emitProgress();
  }

  emitProgress();

  return {
    h264: Buffer.concat(h264, h264Bytes),
    pcm: pcm.length ? Buffer.concat(pcm) : Buffer.alloc(0),
    frames,
    audioChunks,
    resyncs,
    bytesConsumed: off,
    totalBytes: total,
  };
}

/**
 * Full moov-less recovery → output mp4/mov path.
 */
async function recoverMissingMoov({
  damagedPath,
  samplePath,
  outputPath,
  workDir,
  format = "mp4",
  onProgress = null,
  onLog = null,
}) {
  const log = (m) => {
    if (onLog) onLog(m);
  };

  const mdatInfo = findMdat(damagedPath);
  if (!mdatInfo) {
    throw new Error("No mdat atom found — file may not be a MOV/MP4 container");
  }
  if (mdatInfo.hasMoov) {
    log("File already has moov — moov-less path not required");
  } else {
    log("Detected missing moov atom — running sample-guided mdat recovery");
  }

  let sampleStruct = {
    nalLengthSize: 4,
    audioChunkBytes: null,
    audioSampleRate: 32000,
    audioChannels: 1,
    hasPcmAudio: false,
    fps: 30,
    width: null,
    height: null,
  };

  if (samplePath && fs.existsSync(samplePath)) {
    log("Analyzing sample structure for device template…");
    sampleStruct = { ...sampleStruct, ...(await analyzeSampleStructure(samplePath)) };
    log(
      `Sample template: ${sampleStruct.width || "?"}x${sampleStruct.height || "?"} @ ${
        sampleStruct.fps ? sampleStruct.fps.toFixed(2) : "?"
      }fps` +
        (sampleStruct.audioChunkBytes
          ? ` · PCM interleave ${sampleStruct.audioChunkBytes}B`
          : "") +
        (sampleStruct.sps ? " · avcC OK" : "")
    );
  } else {
    log("No sample — recovering video-only with defaults (upload a same-device sample for best results)");
  }

  fs.mkdirSync(workDir, { recursive: true });
  log(`Reading mdat (${(mdatInfo.dataSize / 1024 / 1024).toFixed(1)} MB)…`);
  if (onProgress) onProgress(0.05);

  const fd = fs.openSync(damagedPath, "r");
  let mdatBuf;
  try {
    mdatBuf = Buffer.allocUnsafe(mdatInfo.dataSize);
    fs.readSync(fd, mdatBuf, 0, mdatInfo.dataSize, mdatInfo.dataStart);
  } finally {
    fs.closeSync(fd);
  }
  if (onProgress) onProgress(0.15);

  log("Scanning mdat for H.264 NAL units (sample-guided)…");
  const extracted = extractFromMdat(mdatBuf, {
    nalLengthSize: sampleStruct.nalLengthSize || 4,
    audioChunkBytes: sampleStruct.hasPcmAudio ? sampleStruct.audioChunkBytes : null,
    onProgress: (frac) => {
      if (onProgress) onProgress(0.15 + frac * 0.55);
    },
  });
  mdatBuf = null; // free

  log(
    `Extracted ${extracted.frames} video frames` +
      (extracted.audioChunks ? `, ${extracted.audioChunks} audio chunks` : "") +
      (extracted.resyncs ? ` (${extracted.resyncs} resyncs)` : "")
  );

  if (extracted.frames < 1 || extracted.h264.length < 64) {
    throw new Error(
      "Could not extract video frames from mdat. The sample may be from a different device/codec, or the file is not H.264."
    );
  }

  const h264Path = path.join(workDir, "recovered.h264");
  const pcmPath = path.join(workDir, "recovered.pcm");
  fs.writeFileSync(h264Path, extracted.h264);
  const hasPcm = extracted.pcm.length > 0 && sampleStruct.hasPcmAudio;
  if (hasPcm) fs.writeFileSync(pcmPath, extracted.pcm);
  if (onProgress) onProgress(0.75);

  const fps = sampleStruct.fps && sampleStruct.fps > 1 && sampleStruct.fps < 120 ? sampleStruct.fps : 30;
  const containerArgs =
    format === "mov" ? ["-f", "mov", "-movflags", "+faststart"] : ["-f", "mp4", "-movflags", "+faststart"];

  log(`Remuxing recovered stream @ ${fps.toFixed(2)} fps → .${format}`);
  if (onProgress) onProgress(0.8);

  let args;
  if (hasPcm) {
    const ar = sampleStruct.audioSampleRate || 32000;
    const ac = sampleStruct.audioChannels || 1;
    args = [
      "-y",
      "-hide_banner",
      "-fflags",
      "+genpts",
      "-f",
      "h264",
      "-r",
      String(fps),
      "-i",
      h264Path,
      "-f",
      "s16le",
      "-ar",
      String(ar),
      "-ac",
      String(ac),
      "-i",
      pcmPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-avoid_negative_ts",
      "make_zero",
      ...containerArgs,
      outputPath,
    ];
  } else {
    args = [
      "-y",
      "-hide_banner",
      "-fflags",
      "+genpts",
      "-f",
      "h264",
      "-r",
      String(fps),
      "-i",
      h264Path,
      "-c:v",
      "copy",
      "-an",
      "-avoid_negative_ts",
      "make_zero",
      ...containerArgs,
      outputPath,
    ];
  }

  const { code, stderr } = await run(FFMPEG, args, 0);
  if (code !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
    // fallback video-only
    log("A/V mux failed — trying video-only remux");
    const voArgs = [
      "-y",
      "-hide_banner",
      "-fflags",
      "+genpts",
      "-f",
      "h264",
      "-r",
      String(fps),
      "-i",
      h264Path,
      "-c:v",
      "copy",
      "-an",
      ...containerArgs,
      outputPath,
    ];
    const vo = await run(FFMPEG, voArgs, 0);
    if (vo.code !== 0 || !fs.existsSync(outputPath)) {
      throw new Error(`Failed to remux recovered stream: ${(stderr || vo.stderr || "").slice(-400)}`);
    }
  }

  if (onProgress) onProgress(1);
  log(`Moov recovery complete → ${outputPath}`);

  return {
    outputPath,
    frames: extracted.frames,
    hasAudio: hasPcm,
    fps,
    strategy: hasPcm ? "moov-recover-av" : "moov-recover-video",
  };
}

module.exports = {
  fileMissingMoov,
  findMdat,
  analyzeSampleStructure,
  extractFromMdat,
  recoverMissingMoov,
  listTopBoxes,
};
