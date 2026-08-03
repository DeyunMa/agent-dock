import AppKit

enum MenuBarIcon {
    private static let canvasSize = NSSize(width: 18, height: 18)

    static func make() -> NSImage {
        let image = NSImage(size: canvasSize, flipped: false) { _ in
            NSGraphicsContext.current?.shouldAntialias = true
            NSColor.black.setStroke()
            NSColor.black.setFill()

            let cat = NSBezierPath()
            cat.move(to: NSPoint(x: 3.35, y: 9.1))
            cat.line(to: NSPoint(x: 2.8, y: 15.1))
            cat.curve(
                to: NSPoint(x: 3.45, y: 15.45),
                controlPoint1: NSPoint(x: 2.76, y: 15.55),
                controlPoint2: NSPoint(x: 3.04, y: 15.7)
            )
            cat.line(to: NSPoint(x: 7.0, y: 12.65))
            cat.curve(
                to: NSPoint(x: 11.0, y: 12.65),
                controlPoint1: NSPoint(x: 8.18, y: 12.2),
                controlPoint2: NSPoint(x: 9.82, y: 12.2)
            )
            cat.line(to: NSPoint(x: 14.55, y: 15.45))
            cat.curve(
                to: NSPoint(x: 15.2, y: 15.1),
                controlPoint1: NSPoint(x: 14.96, y: 15.7),
                controlPoint2: NSPoint(x: 15.24, y: 15.55)
            )
            cat.line(to: NSPoint(x: 14.65, y: 9.1))
            cat.curve(
                to: NSPoint(x: 12.85, y: 4.2),
                controlPoint1: NSPoint(x: 14.62, y: 6.68),
                controlPoint2: NSPoint(x: 13.94, y: 5.1)
            )
            cat.curve(
                to: NSPoint(x: 9, y: 2.15),
                controlPoint1: NSPoint(x: 11.86, y: 2.94),
                controlPoint2: NSPoint(x: 10.46, y: 2.15)
            )
            cat.curve(
                to: NSPoint(x: 5.15, y: 4.2),
                controlPoint1: NSPoint(x: 7.54, y: 2.15),
                controlPoint2: NSPoint(x: 6.14, y: 2.94)
            )
            cat.curve(
                to: NSPoint(x: 3.35, y: 9.1),
                controlPoint1: NSPoint(x: 4.06, y: 5.1),
                controlPoint2: NSPoint(x: 3.38, y: 6.68)
            )
            cat.close()

            cat.append(NSBezierPath(ovalIn: NSRect(x: 5.25, y: 7.15, width: 2.15, height: 1.1)))
            cat.append(NSBezierPath(ovalIn: NSRect(x: 10.6, y: 7.15, width: 2.15, height: 1.1)))

            let diamond = NSBezierPath()
            diamond.move(to: NSPoint(x: 9, y: 10.95))
            diamond.line(to: NSPoint(x: 9.63, y: 10.02))
            diamond.line(to: NSPoint(x: 9, y: 9.1))
            diamond.line(to: NSPoint(x: 8.37, y: 10.02))
            diamond.close()
            cat.append(diamond)

            cat.windingRule = .evenOdd
            cat.fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Agent Dock pet"
        return image
    }
}
