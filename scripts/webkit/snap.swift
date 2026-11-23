import Cocoa
import WebKit
// Usage: swift snap.swift <url> <out.png> <seconds> [width] [height] [js-to-run-after-load]
// Loads a page in a real WKWebView (the engine the Mac app uses), waits, saves a snapshot and prints the page title.
class D: NSObject, NSApplicationDelegate {
  var w: NSWindow!; var web: WKWebView!
  func applicationDidFinishLaunching(_ n: Notification) {
    let a = CommandLine.arguments
    let width = a.count > 4 ? Double(a[4])! : 1600, height = a.count > 5 ? Double(a[5])! : 1000
    w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled], backing: .buffered, defer: false)
    let config = WKWebViewConfiguration()
    // Collects console errors and uncaught exceptions so they can be printed at the end.
    let capture = """
    window.__errs = [];
    const keep = (kind, args) => { try { window.__errs.push(kind + ': ' + Array.from(args).map(a => a && a.stack ? a.stack : String(a)).join(' ').slice(0, 600)); } catch (e) {} };
    const ce = console.error.bind(console), cw = console.warn.bind(console);
    console.error = (...a) => { keep('error', a); ce(...a); };
    console.warn = (...a) => { keep('warn', a); cw(...a); };
    window.addEventListener('error', e => keep('uncaught', [e.message + ' @ ' + e.filename + ':' + e.lineno]));
    window.addEventListener('unhandledrejection', e => keep('rejection', [e.reason]));
    """
    config.userContentController.addUserScript(WKUserScript(source: capture, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    web = WKWebView(frame: w.contentView!.bounds, configuration: config); w.contentView!.addSubview(web); w.orderFrontRegardless()
    let target = a[1]
    if target.hasPrefix("http") { web.load(URLRequest(url: URL(string: target)!)) }
    else { let u = URL(fileURLWithPath: target); web.loadFileURL(u, allowingReadAccessTo: u.deletingLastPathComponent()) }
    let wait = Double(a[3])!
    if a.count > 6 { DispatchQueue.main.asyncAfter(deadline: .now() + 6) { self.web.evaluateJavaScript(a[6]) { _, e in if let e = e { print("JS error: \(e)") } } } }
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
      self.web.evaluateJavaScript("JSON.stringify({errs: window.__errs, canvases: Array.from(document.querySelectorAll('canvas')).map(c => c.className + ' ' + c.width + 'x' + c.height), dpr: devicePixelRatio, extra: window.__probe || null})") { r, _ in print("page: \(r ?? "nil")") }
      self.web.takeSnapshot(with: nil) { image, error in
        if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
          try! png.write(to: URL(fileURLWithPath: a[2])); print("saved \(a[2])")
        } else { print("snapshot failed: \(String(describing: error))") }
        print("title: \(self.web.title ?? "")"); exit(0)
      }
    }
  }
}
let app = NSApplication.shared; let d = D(); app.delegate = d; app.setActivationPolicy(.accessory); app.run()
