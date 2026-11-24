import SwiftUI

/// The web's ReaderFriendlyTextContainer: `MarkdownView` in the reading setting every long text
/// in the app shares (see `MarkdownParser.Options.reader`). Citations from `sources` show as
/// chips that open their source in a tooltip; without sources the text reads the same, with
/// no chips.
struct ReaderFriendlyMarkdownView: View {
    /// `--reading-inset-phone`: the conversation's text this far in from the screen's edges (the
    /// editor keeps its own 8pt).
    static let readingInset: CGFloat = 20

    let text: String
    var sources: [WebSource]?
    var options = MarkdownParser.Options()
    var onSelectionChange: ((String?) -> Void)?

    var body: some View {
        var reading = options
        reading.reader = true
        return MarkdownView(
            text: CitationText.linkify(text, sources: sources),
            options: reading,
            onSelectionChange: onSelectionChange
        )
        .environment(\.citationLookup, lookup)
    }

    private var lookup: CitationLookup {
        guard let sources, !sources.isEmpty else { return CitationLookup() }
        return CitationLookup(
            sources: Dictionary(sources.map { ($0.index, $0) }, uniquingKeysWith: { first, _ in first }),
            counts: CitationText.counts(text)
        )
    }
}
