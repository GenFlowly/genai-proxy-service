import SafariServices
import UIKit

/// The web app's /support page, the same page the App Store listing links to. iOS shows it in an
/// in-app browser, so the form and its API exist once, on the web.
enum SupportLink {
    static func url(webAppURL: URL = AppConfig.webAppURL, info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> URL {
        var components = URLComponents(url: webAppURL.appendingPathComponent("support"), resolvingAgainstBaseURL: false)
        var items = [URLQueryItem(name: "source", value: "ios")]
        if let version = appVersion(info: info) {
            items.append(URLQueryItem(name: "appVersion", value: version))
        }
        components?.queryItems = items
        return components?.url ?? webAppURL.appendingPathComponent("support")
    }

    /// "1.0 (12)": the version people see, then the build number.
    static func appVersion(info: [String: Any]) -> String? {
        let version = (info["CFBundleShortVersionString"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let build = (info["CFBundleVersion"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        switch (version, build) {
        case let (version?, build?): return "\(version) (\(build))"
        case let (version?, nil): return version
        case let (nil, build?): return "(\(build))"
        default: return nil
        }
    }

    /// Presented from the top view controller, so closing a menu underneath doesn't take it away.
    static func open() {
        guard let presenter = topViewController() else { return }
        let browser = SFSafariViewController(url: url())
        browser.dismissButtonStyle = .done
        presenter.present(browser, animated: true)
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        var top = scene?.keyWindow?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}
