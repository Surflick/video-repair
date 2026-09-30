# Video Repair

Local repair for corrupted **.mp4** and **.mov** files. A healthy sample from the same camera guides the repair. Nothing is uploaded.

The download already includes Node and FFmpeg. You do not install anything else.

<p align="center">
  <a href="https://github.com/Surflick/video-repair/releases/download/v1.2.0/Video-Repair-macOS.zip"><strong>Download for Mac</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Surflick/video-repair/releases/download/v1.2.0/Video-Repair-windows.zip"><strong>Download for Windows</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Surflick/video-repair/releases/latest">Releases</a>
</p>

| | File |
| --- | --- |
| **Mac** (Apple Silicon and Intel) | [Video-Repair-macOS.zip](https://github.com/Surflick/video-repair/releases/download/v1.2.0/Video-Repair-macOS.zip) |
| **Windows** (64-bit) | [Video-Repair-windows.zip](https://github.com/Surflick/video-repair/releases/download/v1.2.0/Video-Repair-windows.zip) |

## Mac

1. Unzip **Video-Repair-macOS.zip**. Keep the whole **Video Repair** folder together.
2. Right-click **Video Repair.app** → **Open** → **Open**. macOS warns because the app is not signed by Apple.
3. Or double-click **Open Video Repair.command**.

If macOS still blocks it, double-click **Fix macOS warning** in that same folder, then open the app again.

Video Repair opens in its own window, like any Mac app. It needs no browser and no internet connection. Repaired videos save to your Downloads folder. Quitting the app also stops the repair engine. Works on macOS 11.3 or newer.

## Windows

1. Unzip **Video-Repair-windows.zip**. Keep the whole **Video Repair** folder together.
2. Double-click **Open Video Repair.bat**.
3. If SmartScreen warns, choose **More info** → **Run anyway**. Leave the window open while you use the app.

## Repair a file

1. Add the damaged `.mp4` or `.mov`.
2. Add one healthy clip from the **same device** (same phone, drone, or camera, similar settings).
3. Repair, preview, then save.

A sample from a different camera lowers the chance of a good recovery. Some files cannot be recovered.

## Privacy

Repaired files stay in the `data` folder next to the app. The server listens on `127.0.0.1` only.

## Develop

Your own copy can use the Node and FFmpeg already on this machine. The bundled copies are only inside the download zips.

```bash
npm install
npm start
```

Then open http://127.0.0.1:47821

Rebuild the Mac app (needs Xcode or the Command Line Tools):

```bash
./scripts/build_app.sh
```

Rebuild the zips:

```bash
./scripts/package.sh
```

## License

MIT. See [LICENSE](LICENSE). FFmpeg’s own license is in `THIRD_PARTY.txt` inside the download.
