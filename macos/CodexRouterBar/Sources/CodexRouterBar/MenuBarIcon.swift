import AppKit

enum MenuBarIcon {
    private static let canvasSize = NSSize(width: 18, height: 18)

    static func make() -> NSImage {
        let image = NSImage(size: canvasSize, flipped: false) { _ in
            NSGraphicsContext.current?.shouldAntialias = true
            NSColor.black.setStroke()
            NSColor.black.setFill()

            let center = NSPoint(x: 9, y: 8.2)
            let top = NSPoint(x: 9, y: 15.1)
            let bottom = NSPoint(x: 9, y: 2.4)
            let left = NSPoint(x: 3.4, y: 14)
            let right = NSPoint(x: 14.6, y: 14)

            let routes = NSBezierPath()
            routes.lineWidth = 1.8
            routes.lineCapStyle = .round
            routes.lineJoinStyle = .round
            routes.move(to: bottom)
            routes.line(to: top)
            routes.move(to: center)
            routes.curve(
                to: left,
                controlPoint1: NSPoint(x: 5.4, y: 8.2),
                controlPoint2: NSPoint(x: 3.4, y: 10.7)
            )
            routes.move(to: center)
            routes.curve(
                to: right,
                controlPoint1: NSPoint(x: 12.6, y: 8.2),
                controlPoint2: NSPoint(x: 14.6, y: 10.7)
            )
            routes.stroke()

            for point in [top, bottom, left, right] {
                NSBezierPath(
                    ovalIn: NSRect(x: point.x - 1.25, y: point.y - 1.25, width: 2.5, height: 2.5)
                ).fill()
            }
            NSBezierPath(
                ovalIn: NSRect(x: center.x - 1.5, y: center.y - 1.5, width: 3, height: 3)
            ).fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Codex Router"
        return image
    }
}
