import ObjectiveC
import UIKit
import WebKit

extension WKWebView {
    /// 去掉聚焦输入框时键盘上方的表单辅助条（上一项 / 下一项 / 完成）。
    /// WebKit 没有公开开关，这里只把本实例的内容视图换成一个重写 `inputAccessoryView` 返回 nil 的运行时子类：
    /// 不改全局 WKContentView，不调用私有方法；输入法候选栏、听写、外接键盘都不走这个视图，不受影响。
    func hideFormInputAccessoryView() {
        guard let contentView = scrollView.subviews.first(where: {
            NSStringFromClass(object_getClass($0) ?? UIView.self).hasPrefix("WKContent")
        }), let baseClass = object_getClass(contentView) else { return }

        let suffix = "_EnsoNoFormAccessory"
        let baseName = NSStringFromClass(baseClass)
        if baseName.hasSuffix(suffix) { return }

        let subclassName = baseName + suffix
        if let existing = NSClassFromString(subclassName) {
            object_setClass(contentView, existing)
            return
        }
        let selector = #selector(getter: UIResponder.inputAccessoryView)
        guard let subclass = objc_allocateClassPair(baseClass, subclassName, 0),
              let method = class_getInstanceMethod(UIResponder.self, selector) else { return }
        let noAccessory: @convention(block) (AnyObject) -> UIView? = { _ in nil }
        class_addMethod(subclass, selector, imp_implementationWithBlock(noAccessory), method_getTypeEncoding(method))
        objc_registerClassPair(subclass)
        object_setClass(contentView, subclass)
    }
}
