import AppKit
import SwiftUI

@MainActor
final class DecisionHUDController {
    private let panelSize = NSSize(width: 240, height: 58)
    private let displayDuration: TimeInterval = 4
    private var panel: NSPanel?
    private var hideWorkItem: DispatchWorkItem?
    private var presentationGeneration = 0

    func show(_ decision: LatestDecision) {
        presentationGeneration += 1
        let generation = presentationGeneration
        hideWorkItem?.cancel()
        let panel = panel ?? makePanel()
        panel.contentViewController = NSHostingController(rootView: DecisionHUD(decision: decision))
        panel.setContentSize(panelSize)
        position(panel)
        panel.alphaValue = 0
        panel.orderFrontRegardless()

        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            panel.animator().alphaValue = 1
        }

        let hide = DispatchWorkItem { [weak self, weak panel] in
            guard let self, let panel, self.presentationGeneration == generation else { return }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.22
                panel.animator().alphaValue = 0
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.23) { [weak self, weak panel] in
                guard let self, let panel,
                      self.presentationGeneration == generation else { return }
                panel.orderOut(nil)
                self.hideWorkItem = nil
            }
        }
        hideWorkItem = hide
        DispatchQueue.main.asyncAfter(deadline: .now() + displayDuration, execute: hide)
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: panelSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        self.panel = panel
        return panel
    }

    private func position(_ panel: NSPanel) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let visibleFrame = screen?.visibleFrame else { return }
        panel.setFrameOrigin(
            NSPoint(
                x: visibleFrame.midX - panelSize.width / 2,
                y: visibleFrame.maxY - panelSize.height - 18
            )
        )
    }
}
