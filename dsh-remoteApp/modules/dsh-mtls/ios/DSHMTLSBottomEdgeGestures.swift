// DSHMTLSBottomEdgeGestures.swift
// DSH Remote — iOS 底部边缘系统手势（上滑回主屏）defer。
//
// 背景：DSH 手机壳页面里有可自由拖动的悬浮挂件（DSH 页面插件，position: fixed）。
// 挂件被拖到屏幕最底边（Home 指示条区域）后，再从最底边起手拖动时，触摸会被 iOS 的
// 「上滑回主屏」系统手势抢走：页面收不到拖动，App 直接被切到后台。
//
// UIKit 没有「关闭」该系统手势的 API，但按 Apple 的公开约定可以 **defer** 指定屏幕
// 边缘的系统手势（`UIViewController.preferredScreenEdgesDeferringSystemGestures`）：
//   - 开：底部边缘上滑第一次只高亮 Home 指示条，触摸交给 App/页面，再次上滑才回主屏；
//   - 关：系统默认（一次上滑即回主屏）。
//
// 实现说明：该属性是 UIViewController 的只读属性，正常只能在子类里 override；本 App 的
// 根 ViewController 由 Expo/RN 创建，业务侧无法子类化。因此这里用 Objective-C runtime
// **替换基类实现**（只用公开 API，进程内生效，不改系统、不写文件）：
//   - 开启时返回 `.bottom`（defer 底部边缘手势）；
//   - 关闭时返回 `.none`（UIViewController 默认值，不改变系统行为）。
// 由 JS 在「进入主机 WebView 可见时」打开、离开时关闭，避免影响主页/设置页的
// 正常「一次上滑回主屏」。

import ObjectiveC
import UIKit

enum DSHMTLSBottomEdgeGestures {
  /// 当前是否 defer 底部边缘系统手势。只在主线程读写：
  /// `setEnabled` 由主队列调用，替换实现的 block 也只在主线程被系统查询。
  private(set) static var isEnabled = false
  private static var didInstallReplacement = false

  /// 打开/关闭底部边缘系统手势 defer（幂等，可随时切换；切到主线程执行）。
  static func setEnabled(_ enabled: Bool) {
    if enabled { installReplacementIfNeeded() }
    isEnabled = enabled
    DispatchQueue.main.async {
      notifySystemPreferenceChanged()
    }
  }

  /// 通知系统重新读取边缘手势偏好。
  private static func notifySystemPreferenceChanged() {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    for window in scenes.flatMap({ $0.windows }) {
      window.rootViewController?.setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
    }
  }

  /**
   * 用 block 替换 `-[UIViewController preferredScreenEdgesDeferringSystemGestures]` 的
   * 基类实现：开启时返回 `.bottom`，否则返回 `.none`（UIViewController 的默认值）。

   * 注意：只替换一次（首次启用时安装）；未启用时行为与系统默认一致，因此对 App 内
   * 其它页面没有影响。
   */
  private static func installReplacementIfNeeded() {
    guard !didInstallReplacement else { return }
    didInstallReplacement = true

    let selector = NSSelectorFromString("preferredScreenEdgesDeferringSystemGestures")
    guard let method = class_getInstanceMethod(UIViewController.self, selector) else { return }

    // 方法签名：`- (UIRectEdge)preferredScreenEdgesDeferringSystemGestures`。
    // UIRectEdge 是 NSUInteger（64 位），block 的 self 用 AnyObject 表示，_cmd 由
    // imp_implementationWithBlock 自动忽略。
    let replacement: @convention(block) (AnyObject) -> UInt = { _ in
      DSHMTLSBottomEdgeGestures.isEnabled ? UIRectEdge.bottom.rawValue : UIRectEdge().rawValue
    }
    let implementation = imp_implementationWithBlock(unsafeBitCast(replacement, to: AnyObject.self))
    class_replaceMethod(UIViewController.self, selector, implementation, method_getTypeEncoding(method))
  }
}
