"""Run the desktop interaction checks on an unlocked Apple Silicon Mac with Chrome and Accessibility."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

here = Path(__file__).resolve().parent
root = here.parent.parent
hosts = subprocess.run(["ps", "-A", "-o", "comm="], check=True, capture_output=True, text=True).stdout.splitlines()
if any(host.strip().endswith("/NuPhy Lab.app/Contents/MacOS/AirStudio") for host in hosts):
    enabled = subprocess.run(["defaults", "read", "local.airstudio.desktop", "NuPhyLab.desktopTools.desktop-shelf"],
                             capture_output=True, text=True)
    if enabled.stdout.strip().lower() in {"1", "true", "yes"}:
        sys.exit("An enabled personal shelf could receive fixture drops. Run the drag checks with the personal app closed.")
stage = Path(tempfile.mkdtemp(prefix="nuphylab-desktop-check-"))
print("Test results:", stage, flush=True)

def run(*args, **options):
    return subprocess.run(args, cwd=root, check=True, **options)

sources = sorted(str(p) for p in (root / "native").rglob("*.swift") if p.name not in {"main.swift", "HIDBridge.swift"})
sparkle = root / "vendor/sparkle"
run("swiftc", "-target", "arm64-apple-macosx13.0", "-swift-version", "5", "-whole-module-optimization",
    "-import-objc-header", "native/AppBridge.h", *sources, str(here.parent / "DesktopToolsChecks.swift"),
    str(here / "WebSettings.swift"), str(here / "TransferCheck.swift"), str(here / "FixtureWindow.swift"), str(here / "CollectionCheck.swift"), str(here / "ClearCheck.swift"),
    "bin/SelectionAudioBoundary.o", "bin/libwebp.a", "-larchive.2", "-F", str(sparkle), "-framework", "Sparkle",
    "-framework", "Quartz", "-framework", "CoreServices", "-Xlinker", "-rpath", "-Xlinker", str(sparkle), "-o", str(stage / "qa"))
run("swiftc", str(here / "DragFixture.swift"), "-o", str(stage / "drag-fixture"))
folder = stage / "Finder fixtures"
folder.mkdir()
(folder / "NuPhy-R54-Finder.txt").write_text("NuPhy Lab Finder test")
web = stage / "web-settings"
web.mkdir()
run("node", str(here / "web-run.mjs"), env={**os.environ,"NUPHY_QA_STAGE":str(web),"NUPHY_QA_EXECUTABLE":str(stage / "qa")})
page = None
server = subprocess.Popen([sys.executable, str(here / "browser_fixture.py"), str(stage)], cwd=root)
try:
    portfile = stage / "webport"
    for _ in range(100):
        if portfile.exists():
            break
        time.sleep(0.05)
    page = "http://127.0.0.1:" + str(int(portfile.read_text())) + "/"
    chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    run(chrome, "--new-window", page)
    time.sleep(0.8)
    # Only read the PID, and never interact when the active window does not have our fixture title.
    script = 'tell application "System Events" to get unix id of first application process whose bundle identifier is "com.google.Chrome"'
    pid = int(run("osascript", "-e", script, capture_output=True, text=True).stdout.strip())
    (stage / "actual-browser-pid").write_text(str(pid))
    for name, args in [("main", []), ("transfer", ["transfer"]), ("clear", ["clear"])]:
        result = subprocess.run([str(stage / "qa"), str(stage), *args], cwd=root)
        (stage / "checks.json").replace(stage / (name + ".json"))
        if result.returncode:
            raise SystemExit(result.returncode)
finally:
    if page:
        close = """
            on run arguments
                set prefixURL to item 1 of arguments
                tell application "Google Chrome"
                    repeat with w in (get every window)
                        repeat with t in (get every tab of w)
                            try
                                if (URL of t starts with prefixURL) and (title of t contains "NuPhy R54 fixture") then close t
                            end try
                        end repeat
                    end repeat
                end tell
            end run
        """
        try:
            subprocess.run(["osascript", "-e", close, page], check=False, timeout=8,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            pass
    server.terminate()
    server.wait()
