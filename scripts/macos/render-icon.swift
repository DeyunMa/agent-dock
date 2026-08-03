#!/usr/bin/env swift

import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: render-macos-icon.swift <input> <output>\n".utf8))
    exit(2)
}

let inputPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
let pixels = 1024
let canvas = NSRect(x: 0, y: 0, width: pixels, height: pixels)

guard let source = NSImage(contentsOfFile: inputPath) else {
    FileHandle.standardError.write(Data("unable to read icon source: \(inputPath)\n".utf8))
    exit(1)
}

guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: pixels,
    pixelsHigh: pixels,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bitmapFormat: [],
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    FileHandle.standardError.write(Data("unable to allocate icon bitmap\n".utf8))
    exit(1)
}

guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    FileHandle.standardError.write(Data("unable to create icon graphics context\n".utf8))
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.shouldAntialias = true
context.imageInterpolation = .high

NSColor.clear.setFill()
canvas.fill()

// Keep the source artwork within the standard macOS app-icon silhouette so its
// corners remain clean on both light and dark desktops.
let maskRect = canvas.insetBy(dx: 14, dy: 14)
NSBezierPath(roundedRect: maskRect, xRadius: 208, yRadius: 208).addClip()
source.draw(
    in: canvas,
    from: NSRect(origin: .zero, size: source.size),
    operation: .sourceOver,
    fraction: 1,
    respectFlipped: false,
    hints: [.interpolation: NSImageInterpolation.high]
)

context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write(Data("unable to encode icon PNG\n".utf8))
    exit(1)
}

try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
