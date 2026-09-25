// Finds the front window of the app named in argv[1] and prints its CGWindow id and bounds; the caller then runs
// `screencapture -l <id> -x out.png` (which needs Screen Recording permission for the terminal).
// Usage: swift evals/gate8-shell/winshot.swift jobleft
import Cocoa

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: winshot <owner name>"); exit(2) }
let owner = args[1]
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
    guard (w[kCGWindowOwnerName as String] as? String) == owner, let id = w[kCGWindowNumber as String] as? Int else { continue }
    if let layer = w[kCGWindowLayer as String] as? Int, layer != 0 { continue }
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    print("window \(id) bounds \(b["X"] ?? 0),\(b["Y"] ?? 0) \(b["Width"] ?? 0)x\(b["Height"] ?? 0)")
    exit(0)
}
print("no window")
exit(1)
