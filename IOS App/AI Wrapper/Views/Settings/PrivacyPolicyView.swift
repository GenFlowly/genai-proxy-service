import SwiftUI

/// /privacy-policy: the web app's published policy file, so both apps show the
/// same text, rendered in a card like the web page's.
struct PrivacyPolicyView: View {
    @EnvironmentObject var router: AppRouter

    var body: some View {
        DetailScaffold(
            title: L("privacyPolicy.title"),
            backLabel: L("settingsPage.settingsSidebar.title"),
            onLeading: { router.openWithL2Menu(.settings(.account)) }
        ) {
            PrivacyPolicyContent()
        }
    }
}

/// The loaded policy, shared by the page and the consent screen's sheet.
struct PrivacyPolicyContent: View {
    private enum Load: Equatable {
        case loading
        case loaded(String)
        case failed
    }

    @State private var load = Load.loading

    var body: some View {
        Group {
            switch load {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
            case .loaded(let text):
                DetailCard {
                    ReaderFriendlyMarkdownView(text: text, options: MarkdownParser.Options(listIndent: 24))
                }
            case .failed:
                VStack(alignment: .leading, spacing: 12) {
                    Text(L("privacyPolicy.loadError"))
                        .webText(16)
                        .foregroundStyle(AppTheme.textSecondary)
                    PillButton(style: .secondary, action: { Task { await fetch() } }) {
                        Text(L("privacyPolicy.retry"))
                    }
                }
            }
        }
        .task { await fetch() }
    }

    private func fetch() async {
        load = .loading
        let url = AppConfig.webAppURL.appendingPathComponent("privacy-policy.md")
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let text = String(data: data, encoding: .utf8) else {
                load = .failed
                return
            }
            load = .loaded(text)
        } catch {
            load = .failed
        }
    }
}
