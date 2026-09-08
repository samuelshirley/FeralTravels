// Frame-by-frame measurement of a simulator recording, with nothing installed:
// no ffmpeg, no Python imaging. Used on 2026-09-08 to test the border-lag
// hypothesis in docs/bugs/native-ui-fabric-artifacts.md.
//
//   xcrun simctl io "$UDID" recordVideo --codec h264 --force out.mov &
//   ... drive the transition (Maestro, or by hand) ...
//   kill -INT %1
//   swiftc -O -o sim-frames scripts/sim-frames.swift
//   ./sim-frames out.mov frames/ <x_px> <y_from_px> <y_to_px> [dump]
//
// For every video frame it scans ONE pixel column (x, from y_from to y_to,
// top to bottom) and prints, tab-separated: frame index, presentation time in
// ms, the first row matching the code-box BORDER colour, the first row matching
// the code-box FILL colour, the first row of light "glyph" pixels BELOW that
// border, and the last border/fill rows. With `dump` every frame is also
// written as f0000.png … into the output directory.
//
// The colours are the Nocturne tokens for `codeBox` in mobile/app/sign-in.tsx
// (border #595D6C = theme.borderStrong, fill #1F2130 = theme.surfaceMuted);
// change the three `near(...)` calls to measure a different element. Read the
// numbers, not a live simulator: a lag of a few frames is invisible to the eye
// and obvious in a column of integers.
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 6 else {
  FileHandle.standardError.write("usage: frames <video> <outdir> <x> <yFrom> <yTo> [dump]\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(fileURLWithPath: args[1])
let outdir = URL(fileURLWithPath: args[2])
let x = Int(args[3])!, yFrom = Int(args[4])!, yTo = Int(args[5])!
let dump = args.count > 6 && args[6] == "dump"
try? FileManager.default.createDirectory(at: outdir, withIntermediateDirectories: true)

func near(_ r: Int, _ g: Int, _ b: Int, _ tr: Int, _ tg: Int, _ tb: Int, tol: Int = 18) -> Bool {
  return abs(r - tr) <= tol && abs(g - tg) <= tol && abs(b - tb) <= tol
}

let asset = AVURLAsset(url: url)
let reader = try! AVAssetReader(asset: asset)
let track = asset.tracks(withMediaType: .video).first!
let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
])
reader.add(output)
reader.startReading()
print("frame\tt_ms\tborderTop\tfillTop\tglyphTop\tborderBottom\tfillBottom")
var i = 0
while let sb = output.copyNextSampleBuffer() {
  let t = CMSampleBufferGetPresentationTimeStamp(sb)
  guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
  CVPixelBufferLockBaseAddress(pb, .readOnly)
  let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
  let bpr = CVPixelBufferGetBytesPerRow(pb)
  let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
  var borderTop = -1, fillTop = -1, glyphTop = -1, borderBottom = -1, fillBottom = -1
  if x < w {
    for y in max(0, yFrom)..<min(h, yTo) {
      let p = base + y * bpr + x * 4
      let b = Int(p[0]), g = Int(p[1]), r = Int(p[2])
      if near(r, g, b, 0x59, 0x5D, 0x6C) { if borderTop < 0 { borderTop = y }; borderBottom = y }
      else if near(r, g, b, 0x1F, 0x21, 0x30) { if fillTop < 0 { fillTop = y }; fillBottom = y }
      else if r > 200 && g > 200 && b > 200 { if glyphTop < 0 && borderTop >= 0 && y > borderTop { glyphTop = y } }
    }
  }
  print("\(i)\t\(Int(CMTimeGetSeconds(t) * 1000))\t\(borderTop)\t\(fillTop)\t\(glyphTop)\t\(borderBottom)\t\(fillBottom)")
  if dump {
    let cs = CGColorSpaceCreateDeviceRGB()
    let ctx = CGContext(data: base, width: w, height: h, bitsPerComponent: 8, bytesPerRow: bpr, space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    if let img = ctx.makeImage() {
      let dest = CGImageDestinationCreateWithURL(outdir.appendingPathComponent(String(format: "f%04d.png", i)) as CFURL, UTType.png.identifier as CFString, 1, nil)!
      CGImageDestinationAddImage(dest, img, nil)
      CGImageDestinationFinalize(dest)
    }
  }
  CVPixelBufferUnlockBaseAddress(pb, .readOnly)
  i += 1
}
