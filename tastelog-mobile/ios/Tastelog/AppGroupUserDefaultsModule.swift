import Foundation
import React

@objc(AppGroupUserDefaultsModule)
final class AppGroupUserDefaultsModule: NSObject {
  private let suiteName = "group.com.tastelog.app"

  @objc
  func setString(_ key: String, value: String) {
    guard let defaults = UserDefaults(suiteName: suiteName) else { return }
    defaults.set(value, forKey: key)
    defaults.synchronize()
  }

  @objc(getString:resolve:reject:)
  func getString(_ key: String, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    guard let defaults = UserDefaults(suiteName: suiteName) else {
      resolve(NSNull())
      return
    }
    let value = defaults.string(forKey: key)
    resolve(value as Any)
  }

  @objc
  func remove(_ key: String) {
    guard let defaults = UserDefaults(suiteName: suiteName) else { return }
    defaults.removeObject(forKey: key)
    defaults.synchronize()
  }

  @objc
  static func requiresMainQueueSetup() -> Bool { false }
}
