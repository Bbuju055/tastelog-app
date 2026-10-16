// NavProbe: Build 5 Class B native-Back diagnostic probe.
// Authority: docs/build5-classb-native-back-diagnostic-plan.md, section 5.
// INTERNAL TESTFLIGHT DIAGNOSTIC ONLY, NEVER PROMOTE TO CUSTOMER RELEASE.
//
// Read-only observation of react-native-screens 4.16.0 on iOS 26:
//   - instance hooks on RNSNavigationController
//     `navigationBar:shouldPopItem:` / `navigationBar:didPopItem:` (5.4)
//   - class hook on `+[RNSScreenStackHeaderConfig
//     updateViewController:withConfig:animated:]` (5.5)
//   - main-queue UIKit snapshots (5.3) and a main-queue-confined fixed native
//     ring (5.7).
// Every hook calls the retained original implementation and returns its
// result unchanged; nothing here alters navigation behaviour.

import ExpoModulesCore
import ObjectiveC.runtime
import QuartzCore
import UIKit

// MARK: - Records returned to JS (5.1 / 5.3)

struct NavProbeEnableResult: Record {
  @Field var popHooks: String = "absent"
  @Field var headerHook: String = "absent"
  @Field var ios26: Bool = false
  @Field var navId: String? = nil
  @Field var nativeTimebaseAnchorS: Double = 0
}

struct NavProbeSnapshot: Record {
  @Field var navId: String? = nil
  @Field var vcCount: Int = 0
  @Field var topVCClass: String? = nil
  @Field var topIsBeingDismissed: Bool = false
  @Field var coordinatorPresent: Bool = false
  @Field var coordinatorInteractive: Bool = false
  @Field var coordinatorCancelled: Bool = false
  @Field var navBarEnabled: Bool = false
  @Field var windowEnabled: Bool = false
  @Field var contentViewFound: Bool = false
  @Field var wrapperFound: Bool = false
  @Field var wrapperClass: String? = nil
  @Field var wrapperToken: String? = nil
  @Field var wrapperEnabled: Bool = false
  @Field var wrapperSuperEnabled: Bool = false
  @Field var hidesBackButton: Bool = false
  @Field var leftItemPresent: Bool = false
  @Field var rightItemPresent: Bool = false
  @Field var titleViewPresent: Bool = false
  @Field var presentedVCClass: String? = nil
  @Field var popGestureState: Int = -1
  @Field var contentPopGestureState: Int = -1
  @Field var nativeTimeS: Double = 0
}

struct NavProbeRecordOut: Record {
  @Field var kind: String = ""
  @Field var nativeTimeS: Double = 0
  @Field var navId: String = ""
  @Field var itemToken: String = ""
  @Field var wrapperToken: String = ""
  @Field var vcToken: String = ""
  @Field var coordinatorPresent: Bool = false
  @Field var wrapperFound: Bool = false
  @Field var wrapperEnabledBefore: Bool = false
  @Field var wrapperEnabledAfter: Bool = false
  @Field var result: Bool = false
  @Field var animated: Bool = false
}

struct NavProbeDrainResult: Record {
  @Field var records: [NavProbeRecordOut] = []
  @Field var overflow: Int = 0
}

// MARK: - Native ring (5.7): fixed-shape structs, written by index on the
// main queue only; no strings, dictionaries or allocations in the hooks.

private struct NativeRingRecord {
  /// 0 empty, 1 shouldPop, 2 didPop, 3 headerUpdate.
  var kind: UInt8 = 0
  var timeS: Double = 0
  var navId: UInt = 0
  var itemToken: UInt = 0
  var wrapperToken: UInt = 0
  var vcToken: UInt = 0
  var coordinatorPresent: Bool = false
  var wrapperFound: Bool = false
  var wrapperEnabledBefore: Bool = false
  var wrapperEnabledAfter: Bool = false
  var result: Bool = false
  var animated: Bool = false
}

private enum NavProbeRing {
  static let capacity = 2048
  static var buffer = [NativeRingRecord](repeating: NativeRingRecord(), count: capacity)
  static var writeIndex = 0
  static var count = 0
  static var overflow = 0

  /// Writes into the next slot (overwriting the oldest on overflow) and
  /// returns the slot index so the same record can be completed later.
  @discardableResult
  static func write(_ record: NativeRingRecord) -> Int {
    let index = writeIndex
    buffer[index] = record
    writeIndex = (writeIndex + 1) % capacity
    if count < capacity {
      count += 1
    } else {
      overflow += 1
    }
    return index
  }

  static func update(_ index: Int, _ mutate: (inout NativeRingRecord) -> Void) {
    mutate(&buffer[index])
  }

  /// Oldest-first copy plus the overflow count; then both are reset.
  static func drain() -> ([NativeRingRecord], Int) {
    var out: [NativeRingRecord] = []
    out.reserveCapacity(count)
    let start = (writeIndex - count + capacity) % capacity
    for i in 0..<count {
      out.append(buffer[(start + i) % capacity])
    }
    let drainedOverflow = overflow
    writeIndex = 0
    count = 0
    overflow = 0
    return (out, drainedOverflow)
  }
}

// MARK: - Identity and lookup helpers (5.2 / 5.3)

private enum NavProbeIdentity {
  static let navigationControllerClass: AnyClass? = NSClassFromString("RNSNavigationController")
  static let screenClass: AnyClass? = NSClassFromString("RNSScreen")

  /// Process-local pointer token; never compared across launches (5.3).
  static func token(of object: AnyObject) -> UInt {
    return UInt(bitPattern: Unmanaged.passUnretained(object).toOpaque())
  }

  static func hex(_ token: UInt) -> String {
    return "0x" + String(token, radix: 16)
  }

  static func keyWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap { $0.windows }
    return windows.first { $0.isKeyWindow } ?? windows.first
  }

  /// 5.2: the RNSNavigationController with a window, not presented modally,
  /// containing the top-most non-modal RNSScreen (deepest such controller on
  /// the non-presented view-controller tree).
  static func findAppNavigationController() -> UINavigationController? {
    guard let navClass = navigationControllerClass,
          let root = keyWindow()?.rootViewController else {
      return nil
    }
    var best: (controller: UINavigationController, depth: Int)? = nil

    func visit(_ vc: UIViewController, depth: Int, presented: Bool) {
      if !presented,
         let nav = vc as? UINavigationController,
         vc.isKind(of: navClass),
         nav.view.window != nil,
         nav.presentingViewController == nil,
         let top = nav.topViewController,
         screenClass.map({ top.isKind(of: $0) }) ?? true {
        if let current = best {
          if depth >= current.depth {
            best = (nav, depth)
          }
        } else {
          best = (nav, depth)
        }
      }
      for child in vc.children {
        visit(child, depth: depth + 1, presented: presented)
      }
      if let modal = vc.presentedViewController {
        visit(modal, depth: depth + 1, presented: true)
      }
    }

    visit(root, depth: 0, presented: false)
    return best?.controller
  }
}

/// Mirrors UINavigationBar+RNSUtility.mm (react-native-screens 4.16.0):
/// content view class "UIKit.NavigationBarContentView" on iOS 26
/// ("_UINavigationBarContentView" before), first "_UIButtonBarButton"
/// descendant (recursive on iOS 26, direct children before).
private enum NavProbeWrapperLookup {
  static let contentViewClass: AnyClass? = {
    if #available(iOS 26.0, *) {
      return NSClassFromString("UIKit.NavigationBarContentView")
    }
    return NSClassFromString("_UINavigationBarContentView")
  }()
  static let buttonWrapperClass: AnyClass? = NSClassFromString("_UIButtonBarButton")

  static func findContentView(in bar: UINavigationBar) -> UIView? {
    guard let contentClass = contentViewClass else { return nil }
    let subviews = bar.subviews
    if subviews.count > 1, subviews[1].isKind(of: contentClass) {
      return subviews[1]
    }
    for view in subviews where view.isKind(of: contentClass) {
      return view
    }
    return nil
  }

  static func findBackButtonWrapper(in bar: UINavigationBar) -> UIView? {
    guard let contentView = findContentView(in: bar),
          let wrapperClass = buttonWrapperClass else {
      return nil
    }
    if #available(iOS 26.0, *) {
      return findDescendant(wrapperClass, from: contentView)
    }
    for view in contentView.subviews where view.isKind(of: wrapperClass) {
      return view
    }
    return nil
  }

  private static func findDescendant(_ wrapperClass: AnyClass, from view: UIView) -> UIView? {
    if view.isKind(of: wrapperClass) {
      return view
    }
    for subview in view.subviews {
      if let found = findDescendant(wrapperClass, from: subview) {
        return found
      }
    }
    return nil
  }
}

// MARK: - Hooks (5.4 / 5.5)

private enum NavProbeHooks {
  // Retained original IMP types (with selector) and replacement block types
  // (self, then the method arguments; no selector), 5.4 / 5.5 / 5.6.
  // Object arguments are optional: the ABI is the same nullable pointer and
  // a nil passed through the ObjC path can never trap the block.
  typealias ShouldPopIMP = @convention(c) (AnyObject, Selector, UINavigationBar, UINavigationItem) -> ObjCBool
  typealias ShouldPopBlock = @convention(block) (AnyObject, UINavigationBar, UINavigationItem) -> ObjCBool
  typealias DidPopIMP = @convention(c) (AnyObject, Selector, UINavigationBar, UINavigationItem) -> Void
  typealias DidPopBlock = @convention(block) (AnyObject, UINavigationBar, UINavigationItem) -> Void
  typealias HeaderUpdateIMP = @convention(c) (AnyObject, Selector, UIViewController?, AnyObject?, ObjCBool) -> Void
  typealias HeaderUpdateBlock = @convention(block) (AnyObject, UIViewController?, AnyObject?, ObjCBool) -> Void

  static let shouldPopSelector = NSSelectorFromString("navigationBar:shouldPopItem:")
  static let didPopSelector = NSSelectorFromString("navigationBar:didPopItem:")
  static let headerUpdateSelector = NSSelectorFromString("updateViewController:withConfig:animated:")

  static var popInstalled = false
  static var headerInstalled = false
  static var popState = "absent"
  static var headerState = "absent"

  static var shouldPopMethod: Method?
  static var didPopMethod: Method?
  static var headerUpdateMethod: Method?
  static var originalShouldPop: IMP?
  static var originalDidPop: IMP?
  static var originalHeaderUpdate: IMP?
  static var replacementShouldPop: IMP?
  static var replacementDidPop: IMP?
  static var replacementHeaderUpdate: IMP?

  /// Idempotent; returns "installed", "absent" (method not compiled in) or "failed".
  static func installPopHooks() -> String {
    if popInstalled { return popState }
    guard let navClass = NavProbeIdentity.navigationControllerClass,
          let shouldMethod = class_getInstanceMethod(navClass, shouldPopSelector),
          let didMethod = class_getInstanceMethod(navClass, didPopSelector) else {
      popState = "absent"
      return popState
    }

    let shouldOriginal = method_getImplementation(shouldMethod)
    let didOriginal = method_getImplementation(didMethod)

    let shouldBlock: ShouldPopBlock = { target, bar, item in
      var record = NativeRingRecord()
      record.kind = 1
      record.timeS = CACurrentMediaTime()
      record.navId = NavProbeIdentity.token(of: target)
      record.itemToken = NavProbeIdentity.token(of: item)
      record.coordinatorPresent = (target as? UINavigationController)?.transitionCoordinator != nil
      // ONE wrapper lookup; the after-state is read on the same reference.
      let wrapper = NavProbeWrapperLookup.findBackButtonWrapper(in: bar)
      if let wrapper = wrapper {
        record.wrapperFound = true
        record.wrapperToken = NavProbeIdentity.token(of: wrapper)
        record.wrapperEnabledBefore = wrapper.isUserInteractionEnabled
      }
      let slot = NavProbeRing.write(record)

      let original = unsafeBitCast(shouldOriginal, to: ShouldPopIMP.self)
      let result = original(target, shouldPopSelector, bar, item)

      let enabledAfter = wrapper?.isUserInteractionEnabled ?? false
      NavProbeRing.update(slot) { rec in
        rec.result = result.boolValue
        rec.wrapperEnabledAfter = enabledAfter
      }
      return result
    }

    let didBlock: DidPopBlock = { target, bar, item in
      var record = NativeRingRecord()
      record.kind = 2
      record.timeS = CACurrentMediaTime()
      record.navId = NavProbeIdentity.token(of: target)
      record.itemToken = NavProbeIdentity.token(of: item)
      let wrapper = NavProbeWrapperLookup.findBackButtonWrapper(in: bar)
      if let wrapper = wrapper {
        record.wrapperFound = true
        record.wrapperToken = NavProbeIdentity.token(of: wrapper)
        record.wrapperEnabledBefore = wrapper.isUserInteractionEnabled
      }
      let slot = NavProbeRing.write(record)

      let original = unsafeBitCast(didOriginal, to: DidPopIMP.self)
      original(target, didPopSelector, bar, item)

      let enabledAfter = wrapper?.isUserInteractionEnabled ?? false
      NavProbeRing.update(slot) { rec in
        rec.wrapperEnabledAfter = enabledAfter
      }
    }

    let shouldReplacement = imp_implementationWithBlock(shouldBlock)
    let didReplacement = imp_implementationWithBlock(didBlock)

    shouldPopMethod = shouldMethod
    didPopMethod = didMethod
    originalShouldPop = shouldOriginal
    originalDidPop = didOriginal
    replacementShouldPop = shouldReplacement
    replacementDidPop = didReplacement
    method_setImplementation(shouldMethod, shouldReplacement)
    method_setImplementation(didMethod, didReplacement)

    popInstalled = true
    popState = "installed"
    return popState
  }

  /// Idempotent class-method hook (5.5): `class_getClassMethod` is the one
  /// lookup approach; nil means header evidence is unavailable.
  static func installHeaderHook() -> String {
    if headerInstalled { return headerState }
    guard let configClass = NSClassFromString("RNSScreenStackHeaderConfig"),
          let method = class_getClassMethod(configClass, headerUpdateSelector) else {
      headerState = "absent"
      return headerState
    }

    let original = method_getImplementation(method)
    let block: HeaderUpdateBlock = { classObject, vc, config, animated in
      var record = NativeRingRecord()
      record.kind = 3
      record.timeS = CACurrentMediaTime()
      if let vc = vc {
        record.vcToken = NavProbeIdentity.token(of: vc)
        if let nav = vc.navigationController {
          record.navId = NavProbeIdentity.token(of: nav)
        }
      }
      record.animated = animated.boolValue
      NavProbeRing.write(record)

      let originalCall = unsafeBitCast(original, to: HeaderUpdateIMP.self)
      originalCall(classObject, headerUpdateSelector, vc, config, animated)
    }

    let replacement = imp_implementationWithBlock(block)
    headerUpdateMethod = method
    originalHeaderUpdate = original
    replacementHeaderUpdate = replacement
    method_setImplementation(method, replacement)

    headerInstalled = true
    headerState = "installed"
    return headerState
  }

  /// Restores the retained originals and releases the block IMPs.
  static func uninstall() {
    if popInstalled {
      if let method = shouldPopMethod, let original = originalShouldPop {
        method_setImplementation(method, original)
      }
      if let method = didPopMethod, let original = originalDidPop {
        method_setImplementation(method, original)
      }
      if let replacement = replacementShouldPop { imp_removeBlock(replacement) }
      if let replacement = replacementDidPop { imp_removeBlock(replacement) }
      popInstalled = false
      popState = "absent"
    }
    if headerInstalled {
      if let method = headerUpdateMethod, let original = originalHeaderUpdate {
        method_setImplementation(method, original)
      }
      if let replacement = replacementHeaderUpdate { imp_removeBlock(replacement) }
      headerInstalled = false
      headerState = "absent"
    }
  }
}

// MARK: - Snapshot (5.3), main queue only

private func takeSnapshot() -> NavProbeSnapshot {
  let snapshot = NavProbeSnapshot()
  snapshot.nativeTimeS = CACurrentMediaTime()
  guard let nav = NavProbeIdentity.findAppNavigationController() else {
    return snapshot
  }
  snapshot.navId = NavProbeIdentity.hex(NavProbeIdentity.token(of: nav))
  snapshot.vcCount = nav.viewControllers.count
  if let top = nav.topViewController {
    snapshot.topVCClass = NSStringFromClass(type(of: top))
    snapshot.topIsBeingDismissed = top.isBeingDismissed
    let item = top.navigationItem
    snapshot.hidesBackButton = item.hidesBackButton
    snapshot.leftItemPresent = item.leftBarButtonItem != nil
    snapshot.rightItemPresent = item.rightBarButtonItem != nil
    snapshot.titleViewPresent = item.titleView != nil
  }
  if let coordinator = nav.transitionCoordinator {
    snapshot.coordinatorPresent = true
    snapshot.coordinatorInteractive = coordinator.isInteractive
    snapshot.coordinatorCancelled = coordinator.isCancelled
  }
  let bar = nav.navigationBar
  snapshot.navBarEnabled = bar.isUserInteractionEnabled
  snapshot.windowEnabled = nav.view.window?.isUserInteractionEnabled ?? false
  snapshot.contentViewFound = NavProbeWrapperLookup.findContentView(in: bar) != nil
  if let wrapper = NavProbeWrapperLookup.findBackButtonWrapper(in: bar) {
    snapshot.wrapperFound = true
    snapshot.wrapperClass = NSStringFromClass(type(of: wrapper))
    snapshot.wrapperToken = NavProbeIdentity.hex(NavProbeIdentity.token(of: wrapper))
    snapshot.wrapperEnabled = wrapper.isUserInteractionEnabled
    snapshot.wrapperSuperEnabled = wrapper.superview?.isUserInteractionEnabled ?? false
  }
  if let presented = nav.presentedViewController {
    snapshot.presentedVCClass = NSStringFromClass(type(of: presented))
  }
  snapshot.popGestureState = nav.interactivePopGestureRecognizer?.state.rawValue ?? -1
  if #available(iOS 26.0, *) {
    snapshot.contentPopGestureState = nav.interactiveContentPopGestureRecognizer?.state.rawValue ?? -1
  }
  return snapshot
}

private func convert(_ record: NativeRingRecord) -> NavProbeRecordOut {
  let out = NavProbeRecordOut()
  switch record.kind {
  case 1: out.kind = "shouldPop"
  case 2: out.kind = "didPop"
  case 3: out.kind = "headerUpdate"
  default: out.kind = "unknown"
  }
  out.nativeTimeS = record.timeS
  out.navId = NavProbeIdentity.hex(record.navId)
  out.itemToken = NavProbeIdentity.hex(record.itemToken)
  out.wrapperToken = NavProbeIdentity.hex(record.wrapperToken)
  out.vcToken = NavProbeIdentity.hex(record.vcToken)
  out.coordinatorPresent = record.coordinatorPresent
  out.wrapperFound = record.wrapperFound
  out.wrapperEnabledBefore = record.wrapperEnabledBefore
  out.wrapperEnabledAfter = record.wrapperEnabledAfter
  out.result = record.result
  out.animated = record.animated
  return out
}

// MARK: - Module (5.1): every function is an AsyncFunction on the main queue

public class NavProbeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NavProbe")

    AsyncFunction("enable") { (_ sessionToken: String) -> NavProbeEnableResult in
      let result = NavProbeEnableResult()
      result.nativeTimebaseAnchorS = CACurrentMediaTime()
      if #available(iOS 26.0, *) {
        result.ios26 = true
      }
      result.popHooks = NavProbeHooks.installPopHooks()
      result.headerHook = NavProbeHooks.installHeaderHook()
      if let nav = NavProbeIdentity.findAppNavigationController() {
        result.navId = NavProbeIdentity.hex(NavProbeIdentity.token(of: nav))
      }
      return result
    }.runOnQueue(.main)

    AsyncFunction("snapshot") { (_ reason: String) -> NavProbeSnapshot in
      return takeSnapshot()
    }.runOnQueue(.main)

    AsyncFunction("drain") { () -> NavProbeDrainResult in
      let (records, overflow) = NavProbeRing.drain()
      let result = NavProbeDrainResult()
      result.records = records.map(convert)
      result.overflow = overflow
      return result
    }.runOnQueue(.main)

    AsyncFunction("disable") { () -> Void in
      NavProbeHooks.uninstall()
    }.runOnQueue(.main)
  }
}
