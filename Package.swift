// swift-tools-version: 6.0
import PackageDescription

// A portable test harness for the same source files compiled into the iOS app.
// UIKit, Observation feature models and GRDB remain in the Xcode target.
let package = Package(
    name: "AgentHubCore",
    platforms: [.iOS("26.0")],
    products: [.library(name: "AgentHubCore", targets: ["AgentHubCore"])],
    targets: [
        .target(
            name: "AgentHubCore",
            path: "Sources",
            exclude: ["Features", "Persistence", "Terminal/TerminalTransport.swift"],
            sources: ["Domain", "Networking", "Terminal/TerminalInput.swift"]
        ),
        .testTarget(name: "AgentHubCoreTests", dependencies: ["AgentHubCore"], path: "Tests/Core")
    ]
)
