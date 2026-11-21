// swift-tools-version: 6.0
import PackageDescription

// The portable half of the app, compiled and tested on Linux and macOS: the same
// files XcodeGen compiles into the iOS target (everything under Sources except the
// UIKit/SwiftUI layer in Features and Platform). One module, so both builds share
// the same access control. swift-crypto stands in for CryptoKit off Apple platforms.
let package = Package(
    name: "AgentHubKit",
    platforms: [.iOS("26.0"), .macOS("15.0")],
    products: [.library(name: "AgentHubKit", targets: ["AgentHubKit"])],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift", exact: "7.11.1"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.99.1"),
        .package(url: "https://github.com/apple/swift-crypto", exact: "3.15.1"),
    ],
    targets: [
        .target(
            name: "AgentHubKit",
            dependencies: [
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
                .product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux])),
            ],
            path: "Sources",
            exclude: ["Features", "Platform"]
        ),
        .testTarget(
            name: "AgentHubKitTests",
            dependencies: ["AgentHubKit"],
            path: "Tests",
            exclude: ["UI"],
            // The Linux toolchain's libswiftObservation references swift::threading::fatal,
            // which its runtime doesn't export (only reached on a fatal error path).
            linkerSettings: [.unsafeFlags(["-Xlinker", "--allow-shlib-undefined"], .when(platforms: [.linux]))]
        ),
    ]
)
