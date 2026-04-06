import UIKit

/// ObjC-compatible bridge to Hammer's EventGenerator.
/// Called from NativeHarness.mm for touch synthesis and text input.
@objc public class HammerBridge: NSObject {

  private static var cachedGenerator: EventGenerator?
  private static var cachedWindow: UIWindow?

  private static func getGenerator(for window: UIWindow) -> EventGenerator? {
    if let cached = cachedGenerator, cachedWindow === window { return cached }
    do {
      let gen = try EventGenerator(window: window)
      cachedGenerator = gen
      cachedWindow = window
      return gen
    } catch {
      NSLog("[HammerBridge] Failed to create EventGenerator: %@", "\(error)")
      return nil
    }
  }

  @objc public static func tap(at point: CGPoint, in window: UIWindow, completion: @escaping (NSError?) -> Void) {
    DispatchQueue.main.async {
      guard let gen = getGenerator(for: window) else {
        completion(NSError(domain: "HammerBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "No EventGenerator"]))
        return
      }
      do {
        try gen.fingerTap(at: point)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) {
          completion(nil)
        }
      } catch {
        completion(error as NSError)
      }
    }
  }

  @objc public static func longPress(at point: CGPoint, duration: TimeInterval, in window: UIWindow, completion: @escaping (NSError?) -> Void) {
    DispatchQueue.main.async {
      guard let gen = getGenerator(for: window) else {
        completion(NSError(domain: "HammerBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "No EventGenerator"]))
        return
      }
      do {
        try gen.fingerLongPress(at: point, duration: duration)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) {
          completion(nil)
        }
      } catch {
        completion(error as NSError)
      }
    }
  }

  @objc public static func typeText(_ text: String, in window: UIWindow, completion: @escaping (NSError?) -> Void) {
    DispatchQueue.main.async {
      guard let gen = getGenerator(for: window) else {
        completion(NSError(domain: "HammerBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "No EventGenerator"]))
        return
      }
      do {
        for char in text {
          try gen.keyType(String(char))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) {
          completion(nil)
        }
      } catch {
        completion(error as NSError)
      }
    }
  }
}
