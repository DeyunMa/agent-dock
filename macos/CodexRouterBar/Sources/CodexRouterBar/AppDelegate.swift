import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private let compactPopoverSize = NSSize(width: 420, height: 570)
    private let expandedPopoverSize = NSSize(width: 420, height: 700)
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let popover = NSPopover()
    private let viewModel = RouterViewModel()
    private let controlServer = ControlServerProcess()
    private var refreshTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureStatusItem()
        configurePopover()
        controlServer.ensureRunning()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
            self?.viewModel.refresh()
        }
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.viewModel.refresh()
            }
        }
        refreshTimer?.tolerance = 1

        if ProcessInfo.processInfo.arguments.contains("--show") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                self?.togglePopover()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        controlServer.stop()
    }

    private func configureStatusItem() {
        guard let button = statusItem.button else { return }
        button.image = MenuBarIcon.make()
        button.imageScaling = .scaleProportionallyDown
        button.toolTip = "Codex Router"
        button.target = self
        button.action = #selector(togglePopover)
    }

    private func configurePopover() {
        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = compactPopoverSize
        popover.contentViewController = NSHostingController(
            rootView: RouterPopoverView(model: viewModel) { [weak self] isExpanded in
                self?.setRouteExpanded(isExpanded)
            }
        )
        popover.delegate = self
    }

    private func setRouteExpanded(_ isExpanded: Bool) {
        popover.contentSize = isExpanded ? expandedPopoverSize : compactPopoverSize
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            viewModel.refresh()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }
}
