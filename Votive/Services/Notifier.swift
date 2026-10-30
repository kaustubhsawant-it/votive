import AppKit
import UserNotifications

/// Posts a native, named notification when a session flips to a notable state (done / needs-you
/// / error / stopped). Clicking the notification focuses that agent's terminal window.
///
/// The banner tells you *which* session and
/// *what happened*. Fully optional: if authorization is denied, notify() is a no-op and
/// reports it, so `DialogAlerter` can take over as the guaranteed delivery path.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    /// Both are written on main (setup's callbacks bounce there) and read on main by notify().
    private var authorized = false
    /// Set when the notification system refused to even answer — the usual case for an
    /// ad-hoc–signed app, which never registers with Notification Centre at all.
    private(set) var unavailable = false
    private(set) var authError: Error?

    func setup() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // Ask what we already have first: a grant made after the first launch (or in a
        // previous install) is otherwise never noticed, since requestAuthorization only
        // re-prompts once and then reports the stored answer.
        center.getNotificationSettings { [weak self] settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional:
                DispatchQueue.main.async { self?.authorized = true }
            case .denied:
                DispatchQueue.main.async { self?.authorized = false }
            default:
                center.requestAuthorization(options: [.alert]) { granted, error in
                    DispatchQueue.main.async {
                        self?.authorized = granted
                        if let error {
                            self?.authError = error
                            self?.unavailable = true
                        }
                    }
                }
            }
        }
    }

    /// Enqueue a banner. Returns true only if a request actually went to Notification
    /// Centre — false when unauthorized or unregistered, which is the caller's cue to fall
    /// back to a dialog.
    @discardableResult
    func notify(sessionId: String, pid: Int32, title: String, body: String) -> Bool {
        guard authorized, !unavailable else { return false }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if pid > 0 { content.userInfo = ["pid": Int(pid)] }
        let request = UNNotificationRequest(
            identifier: sessionId + "-" + UUID().uuidString,
            content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
        return true
    }

    // Clicking a banner → jump to that agent's terminal window.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let pid = response.notification.request.content.userInfo["pid"] as? Int, pid > 0 {
            TerminalFocus.focus(sessionPID: Int32(pid))
        }
        completionHandler()
    }

    // Show the banner even though we're a background accessory app.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner])
    }
}
