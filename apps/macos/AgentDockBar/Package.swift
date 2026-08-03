// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "AgentDockBar",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AgentDockBar", targets: ["AgentDockBar"]),
    ],
    targets: [
        .executableTarget(
            name: "AgentDockBar",
            path: "Sources/AgentDockBar"
        ),
    ]
)
