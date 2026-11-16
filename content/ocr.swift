// 智译 CLI — tiny OCR helper using macOS Vision (no extra installs).
// Build: swiftc -O ocr.swift -o clitrans-ocr
// Usage: clitrans-ocr <image.png> [<image.png> ...]
// Prints one JSON object per image: {"file": ..., "lines": [{"text": ..., "box": [x0, y0, x1, y1], "conf": ...}]}
// Boxes are normalized to [0,1] with the origin at the TOP-left.
import Foundation
import Vision
import AppKit

func recognize(_ path: String) -> [[String: Any]] {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return [] }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    req.recognitionLanguages = ["en-US"]
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch { return [] }
    var out: [[String: Any]] = []
    for obs in req.results ?? [] {
        guard let cand = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        out.append([
            "text": cand.string,
            "conf": Double(cand.confidence),
            "box": [Double(b.minX), Double(1 - b.maxY), Double(b.maxX), Double(1 - b.minY)],
        ])
    }
    return out
}

for path in CommandLine.arguments.dropFirst() {
    let obj: [String: Any] = ["file": path, "lines": recognize(path)]
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    }
}
