/**
 * Locate ffmpeg and ffprobe on macOS, Windows, and Linux.
 * Honors FFMPEG_PATH / FFPROBE_PATH, then PATH, then common install locations.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function envPath(name) {
  const key = name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  const value = process.env[key];
  if (value && fs.existsSync(value)) return value;
  return null;
}

function which(cmd) {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [cmd], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => fs.existsSync(line)) || null;
}

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function findInTree(root, fileName, maxDepth) {
  if (!root || !fs.existsSync(root)) return null;
  const stack = [{ dir: root, depth: 0 }];
  const target = fileName.toLowerCase();
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) return full;
      if (entry.isDirectory() && depth < maxDepth) {
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return null;
}

function candidates(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  if (process.platform === "darwin") {
    return [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  }
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || "";
    const userProfile = process.env.USERPROFILE || "";
    const programData = process.env.ProgramData || "C:\\ProgramData";
    const list = [
      path.join(programFiles, "ffmpeg", "bin", exe),
      path.join(programFilesX86, "ffmpeg", "bin", exe),
      path.join("C:\\ffmpeg", "bin", exe),
      path.join(programData, "chocolatey", "bin", exe),
    ];
    if (userProfile) {
      list.push(
        path.join(userProfile, "scoop", "shims", exe),
        path.join(userProfile, "scoop", "apps", "ffmpeg", "current", "bin", exe)
      );
    }
    if (localAppData) {
      const winget = findInTree(
        path.join(localAppData, "Microsoft", "WinGet", "Packages"),
        exe,
        4
      );
      if (winget) list.push(winget);
    }
    return list;
  }
  return [`/usr/bin/${name}`, `/usr/local/bin/${name}`];
}

function resolveBinary(name) {
  return envPath(name) || which(name) || firstExisting(candidates(name)) || name;
}

function works(bin) {
  if (!bin) return false;
  const result = spawnSync(bin, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

function installHint() {
  if (process.platform === "darwin") return "brew install ffmpeg";
  if (process.platform === "win32") return "winget install -e --id Gyan.FFmpeg";
  return "install the ffmpeg package (it includes ffprobe), then restart";
}

const FFMPEG = resolveBinary("ffmpeg");
const FFPROBE = resolveBinary("ffprobe");

module.exports = {
  FFMPEG,
  FFPROBE,
  ffmpegOk: () => works(FFMPEG),
  ffprobeOk: () => works(FFPROBE),
  installHint,
};
