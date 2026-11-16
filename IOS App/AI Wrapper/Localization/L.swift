import Foundation

/// Localized-string lookup. ALL user-facing text goes through this, using the same
/// keys as the web's `translation.json` (`en.lproj/Localizable.strings` is generated
/// from it), so a string changes in one place per platform and the wording matches.
///
/// Interpolation follows i18next: `{{name}}` placeholders, and a `count` argument
/// selects the `_one` / `_other` plural key the same way the web does.
func L(_ key: String, _ args: [String: CustomStringConvertible] = [:]) -> String {
    var resolvedKey = key
    if let count = args["count"] {
        resolvedKey = key + (String(describing: count) == "1" ? "_one" : "_other")
    }
    var text = NSLocalizedString(resolvedKey, comment: "")
    if text == resolvedKey, resolvedKey != key {
        text = NSLocalizedString(key, comment: "")
    }
    for (name, value) in args {
        text = text.replacingOccurrences(of: "{{\(name)}}", with: String(describing: value))
    }
    return text
}
