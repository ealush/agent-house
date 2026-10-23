#!/usr/bin/env python3
"""Portable scaffold/provenance checks. This never compiles or evaluates Swift."""
from __future__ import annotations

import argparse
import hashlib
import json
import plistlib
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
IGNORED = {".git", ".build", ".swiftpm", "DerivedData", "node_modules", "__pycache__"}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ignored(path: Path) -> bool:
    return any(
        part in IGNORED or part.endswith((".xcodeproj", ".xcresult", ".xcworkspace"))
        for part in path.relative_to(ROOT).parts
    )


def check(source: Path | None) -> list[str]:
    problems: list[str] = []
    required = [
        "AUDIT.md", "SPEC.md", "SOURCE.json", "README.md", "AGENTS.md", "project.yml",
        "Config/Info.plist", "App/AppDelegate.swift", "App/SceneDelegate.swift",
        "App/AppCoordinator.swift", "Sources/Persistence/SceneStore.swift",
        "Sources/Features/HostSetup/HostSetupModel.swift",
        "Sources/Features/HostSetup/HostSetupView.swift",
        "Tests/Core/HostEndpointTests.swift", "Tests/Unit/SceneStoreTests.swift",
        "Tests/Core/TerminalInputTests.swift", "Tests/UI/HostSetupUITests.swift",
        "Package.swift", "Sources/Networking/HubStateDTO.swift",
        "Sources/Networking/HubStateReducer.swift", "Sources/Networking/ServerSentEvents.swift",
        "Tests/Core/HubStateReducerTests.swift", "Tests/Core/ServerSentEventParserTests.swift",
        "docs/native/ARCHITECTURE.md", "docs/native/PARITY.md",
        "docs/native/DECISIONS.md", "docs/native/RISKS.md", "docs/native/TEST-MATRIX.md",
        "scripts/bootstrap.sh", "scripts/verify.sh", ".github/workflows/native.yml",
    ]
    for name in required:
        if not (ROOT / name).is_file():
            problems.append(f"Missing scaffold file: {name}")

    files = sorted(p for p in ROOT.rglob("*") if p.is_file() and not ignored(p))
    hashes: dict[str, list[str]] = defaultdict(list)
    paths: dict[str, list[str]] = defaultdict(list)
    for path in files:
        relative = path.relative_to(ROOT).as_posix()
        paths[relative.casefold()].append(relative)
        if path.stat().st_size:
            hashes[digest(path)].append(relative)
        if path.suffix == ".swift" and "Tests" not in path.parts:
            text = path.read_text()
            if re.search(r"^import (Combine|SwiftData|CoreData|SQLiteData)\b|@(Published|StateObject|ObservedObject)\b|\bObservableObject\b", text, re.M):
                problems.append(f"Conflicting state/persistence stack: {relative}")
        if path.suffix == ".md":
            for match in re.finditer(r"\[[^\]]*\]\(([^)]+)\)", path.read_text()):
                target = match[1].strip().strip("<>")
                parsed = urlsplit(target)
                if parsed.scheme or not parsed.path or parsed.path.startswith("/"):
                    continue
                linked = (path.parent / unquote(parsed.path)).resolve()
                # Sibling backend references are optional in a standalone clone.
                if linked.is_relative_to(ROOT) and not linked.exists():
                    problems.append(f"Broken native document link in {relative}: {target}")
    for group in hashes.values():
        if len(group) > 1:
            problems.append("Exact duplicate files: " + ", ".join(group))
    for group in paths.values():
        if len(group) > 1:
            problems.append("Case-colliding paths (unsafe on macOS): " + ", ".join(group))

    try:
        with (ROOT / "Config/Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
        scenes = info["UIApplicationSceneManifest"]
        if scenes["UIApplicationSupportsMultipleScenes"] is not True:
            problems.append("Multi-scene support is disabled")
        if "NSAppTransportSecurity" in info:
            problems.append("Unexpected App Transport Security override")
    except (OSError, KeyError, ValueError, plistlib.InvalidFileException) as error:
        problems.append(f"Invalid scene Info.plist: {error}")

    try:
        provenance = json.loads((ROOT / "SOURCE.json").read_text())
        if provenance["schemaVersion"] != 1:
            problems.append("Unsupported source manifest version")
        for item in provenance["imports"]:
            if not (ROOT / item["destination"]).is_file():
                problems.append(f"Missing imported document: {item['destination']}")
        parity = (ROOT / "docs/native/PARITY.md").read_text()
        command_ids = re.findall(r"^\| `([^`]+)` \|", parity, re.M)
        if len(command_ids) != 89 or len(set(command_ids)) != 89:
            problems.append("Expected 89 distinct keyboard command rows")
        if source:
            try:
                current = subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], cwd=source, text=True,
                    stderr=subprocess.STDOUT,
                ).strip()
                if current != provenance["sourceCommit"]:
                    problems.append(f"Source commit drift: {current}")
            except (OSError, subprocess.CalledProcessError) as error:
                problems.append(f"Cannot inspect source Git revision: {error}")
            for name, expected in provenance["sourceFiles"].items():
                path = source / name
                if not path.is_file() or digest(path) != expected:
                    problems.append(f"Audited source file changed or missing: {name}")
            for item in provenance["imports"]:
                path = source / item["source"]
                if not path.is_file() or digest(path) != item["sha256"]:
                    problems.append(f"Original port document changed or missing: {item['source']}")
            archive = source / provenance["archive"]["source"]
            if not archive.is_file() or digest(archive) != provenance["archive"]["sha256"]:
                problems.append("Original port archive changed or missing")
            else:
                with ZipFile(archive) as zipped:
                    for item in provenance["imports"]:
                        member_hash = hashlib.sha256(zipped.read(item["archive_member"])).hexdigest()
                        if member_hash != item["sha256"]:
                            problems.append(f"Archive member differs: {item['archive_member']}")
    except (OSError, KeyError, ValueError) as error:
        problems.append(f"Invalid provenance or parity metadata: {error}")

    print(f"Scanned {len(files)} native workspace files; checked scaffold, links, plist, provenance and 89 command rows.")
    if source:
        print("Compared audited source hashes and archive members against " + str(source))
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Optional original ah checkout for provenance/drift checks")
    args = parser.parse_args()
    problems = check(args.source.resolve() if args.source else None)
    if problems:
        for problem in problems:
            print("FAIL: " + problem, file=sys.stderr)
        return 1
    print("PASS: no exact duplicates, case collisions or scaffold/provenance errors. Swift/Xcode validation is separate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
