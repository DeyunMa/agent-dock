// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "CodexRouterBar",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CodexRouterBar", targets: ["CodexRouterBar"]),
    ],
    targets: [
        .executableTarget(
            name: "CodexRouterBar",
            path: "Sources/CodexRouterBar"
        ),
    ]
)
