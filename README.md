# Video Repair

Local repair for corrupted **.mp4** and **.mov** files. A healthy sample clip from the same camera guides the repair, the same way Wondershare Repairit’s advanced mode does. Files stay on your computer. Nothing is uploaded.

Works on **macOS** and **Windows**.

## Features

- Batch repair — several damaged videos, one sample for the whole queue
- Preview in the app, then save when it looks right
- Keeps the original resolution (no forced scale-down to the sample size)
- Recovers clips that lost their `moov` atom (camera power-loss style)
- Progress, stages, and a repair log
- Save as Original (default), MP4, or MOV

## Requirements

- [Node.js](https://nodejs.org) 18 or newer
- [FFmpeg](https://ffmpeg.org) (includes `ffprobe`)

| | Install FFmpeg |
|---|---|
| macOS | `brew install ffmpeg` |
| Windows | `winget install -e --id Gyan.FFmpeg` |

On Windows, close and reopen the window after installing FFmpeg so the new PATH is picked up. You can also unzip a build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) and add its `bin` folder to PATH.

## Open the app

### macOS

1. Clone or download this folder.
2. Double-click **Video Repair.app** (or **Open Video Repair.command**).
3. The first launch installs dependencies, starts a local server, and opens the browser.

Keep `Video Repair.app` inside this folder. Copying the app out by itself will not work.

If macOS blocks a downloaded app, right-click it, choose **Open**, then **Open** again.

### Windows

1. Clone or download this folder.
2. Double-click **Open Video Repair.bat**.
3. Leave that window open while you use the app. Closing it stops the server.

### Either platform, from a terminal

```bash
cd video-repair
npm install
npm start
```

Then open http://127.0.0.1:47821

`npm run open` does the same thing as the double-click launchers. `npm run stop` stops a background server started by the Mac app. `npm run check` prints whether FFmpeg was found.

## How to repair a file

1. Add the damaged `.mp4` or `.mov`.
2. Add one healthy clip from the **same device** (same phone, drone, or camera, similar settings).
3. Repair, preview, then download.

A sample from a different camera lowers the chance of a good recovery. Badly damaged files can lose audio or drop broken segments. Some files cannot be recovered.

## Privacy

Uploads, thumbnails, and repaired files stay in the `data/` folder next to the app. The server listens on `127.0.0.1` only.

## License

MIT. See [LICENSE](LICENSE).
