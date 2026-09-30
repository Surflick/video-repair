#!/usr/bin/env node
/**
 * Cross-platform opener for macOS and Windows.
 *   node scripts/launch.js           foreground (Ctrl+C stops the server)
 *   node scripts/launch.js --detach  background (used by the Mac app)
 *   node scripts/launch.js --stop    stop a detached server
 *   node scripts/launch.js --check   print ffmpeg/ffprobe and exit
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 47821;
const URL = `http://127.0.0.1:${PORT}`;
const STATE_DIR = path.join(os.homedir(), ".video-repair");
const PID_FILE = path.join(STATE_DIR, "server.pid");
const LOG_FILE = path.join(STATE_DIR, "server.log");

const detach = process.argv.includes("--detach");
const stop = process.argv.includes("--stop");
const check = process.argv.includes("--check");

function alert(title, message) {
  console.error(`\n${title}\n${message}\n`);
  if (process.platform === "darwin" && detach) {
    const esc = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    spawnSync(
      "osascript",
      ["-e", `display alert "${esc(title)}" message "${esc(message)}" as critical`],
      { stdio: "ignore" }
    );
  }
}

function openBrowser(url) {
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function health() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/health`, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(res.statusCode === 200 && data.ok === true && data.mode === "advanced");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForHealth(tries = 50) {
  return new Promise((resolve) => {
    let left = tries;
    const tick = async () => {
      if (await health()) {
        resolve(true);
        return;
      }
      left -= 1;
      if (left <= 0) {
        resolve(false);
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function readPid() {
  try {
    return Number(fs.readFileSync(PID_FILE, "utf8").trim());
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureDeps() {
  if (fs.existsSync(path.join(ROOT, "node_modules", "express"))) return true;
  console.log("First run: installing dependencies…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["install", "--no-fund", "--no-audit"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return result.status === 0;
}

if (stop) {
  const pid = readPid();
  if (pidAlive(pid)) {
    try {
      process.kill(pid);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    console.log("Stopped Video Repair.");
  } else {
    console.log("Video Repair is not running.");
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* already gone */
  }
  process.exit(0);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 18) {
  alert(
    "Node.js 18 or newer is required",
    `This computer is running Node ${process.versions.node}. Install the current version from https://nodejs.org and try again.`
  );
  process.exit(1);
}

const { FFMPEG, FFPROBE, ffmpegOk, ffprobeOk, installHint } = require("../server/binaries");

if (check) {
  const ok = ffmpegOk() && ffprobeOk();
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        ffmpeg: FFMPEG,
        ffprobe: FFPROBE,
        ffmpegOk: ffmpegOk(),
        ffprobeOk: ffprobeOk(),
        install: installHint(),
      },
      null,
      2
    )
  );
  process.exit(ok ? 0 : 1);
}

if (!ffmpegOk() || !ffprobeOk()) {
  alert(
    "FFmpeg is required",
    `Video Repair needs both ffmpeg and ffprobe.\n\nInstall:\n  ${installHint()}\n\nThen open the app again. On Windows, open a new window after installing so PATH updates.`
  );
  process.exit(1);
}

if (!ensureDeps()) {
  alert(
    "Could not install dependencies",
    "Open a terminal in this folder and run: npm install"
  );
  process.exit(1);
}

async function main() {
  if (await health()) {
    openBrowser(URL);
    console.log(`Video Repair is already running at ${URL}`);
    return;
  }

  const env = {
    ...process.env,
    FFMPEG_PATH: FFMPEG,
    FFPROBE_PATH: FFPROBE,
  };
  const serverScript = path.join(ROOT, "server", "index.js");

  if (detach) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const logFd = fs.openSync(LOG_FILE, "a");
    const child = spawn(process.execPath, [serverScript], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    fs.closeSync(logFd);
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    const ready = await waitForHealth();
    if (!ready) {
      alert("Video Repair failed to start", `See the log:\n${LOG_FILE}`);
      process.exit(1);
    }
    openBrowser(URL);
    if (process.platform === "darwin") {
      spawnSync(
        "osascript",
        ["-e", 'display notification "Advanced repair is ready" with title "Video Repair"'],
        { stdio: "ignore" }
      );
    }
    console.log(`Video Repair running at ${URL}`);
    console.log(`Log: ${LOG_FILE}`);
    return;
  }

  const child = spawn(process.execPath, [serverScript], {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });
  waitForHealth().then((ready) => {
    if (ready) openBrowser(URL);
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.on("exit", (code) => {
    process.exit(code == null ? 1 : code);
  });
}

main().catch((err) => {
  alert("Video Repair failed to start", err.message || String(err));
  process.exit(1);
});
