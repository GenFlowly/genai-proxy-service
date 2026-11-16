import SwiftUI

// MARK: - Formatting (usageFormat.ts)

enum UsageFormat {
    /// Costs are tracked to fractions of a cent: 4 decimals under $1, 2 from $1 up.
    static func usd(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        let digits = abs(value) < 1 ? 4 : 2
        formatter.minimumFractionDigits = digits
        formatter.maximumFractionDigits = digits
        return formatter.string(from: NSNumber(value: value)) ?? "$\(value)"
    }

    static func count(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
}

// MARK: - DateRangePicker (component library)

/// Local days on the device, as `yyyy-MM-dd`. Usage is requested with `utcDays`.
struct UsageDateRange: Equatable {
    var from: String
    var to: String

    private static let utc = TimeZone(identifier: "UTC") ?? .gmt

    private static func formatter(_ timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    private static func calendar(_ timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    static func iso(_ date: Date, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        formatter(timeZone).string(from: date)
    }

    /// The start of that day in `timeZone`.
    static func date(_ iso: String, timeZone: TimeZone = .autoupdatingCurrent) -> Date? {
        formatter(timeZone).date(from: iso).map { calendar(timeZone).startOfDay(for: $0) }
    }

    /// Inclusive trailing window of `days` local days ending today. Calendar days, so a clock
    /// change inside the window doesn't move its start.
    static func trailing(days: Int, now: Date = Date(), timeZone: TimeZone = .autoupdatingCurrent) -> UsageDateRange {
        let calendar = calendar(timeZone)
        let today = calendar.startOfDay(for: now)
        let start = calendar.date(byAdding: .day, value: -(days - 1), to: today) ?? today
        return UsageDateRange(from: iso(start, timeZone: timeZone), to: iso(today, timeZone: timeZone))
    }

    /// `toUtcUsageRange` on the web. Usage is stored per whole UTC day and a local day overlaps
    /// two of them, so this asks for every UTC day the range touches: usage is never left out,
    /// though totals can include a few hours at each end.
    func utcDays(timeZone: TimeZone = .autoupdatingCurrent) -> UsageDateRange {
        guard let start = Self.date(from, timeZone: timeZone),
              let lastDay = Self.date(to, timeZone: timeZone),
              let nextDay = Self.calendar(timeZone).date(byAdding: .day, value: 1, to: lastDay) else { return self }
        return UsageDateRange(
            from: Self.iso(start, timeZone: Self.utc),
            to: Self.iso(nextDay.addingTimeInterval(-1), timeZone: Self.utc)
        )
    }
}

struct DateRangePicker: View {
    @Binding var range: UsageDateRange

    private var presets: [(id: String, label: String, days: Int)] {
        [
            ("7d", L("settingsPage.usageCommon.dateRangeLast7Days"), 7),
            ("30d", L("settingsPage.usageCommon.dateRangeLast30Days"), 30),
            ("90d", L("settingsPage.usageCommon.dateRangeLast90Days"), 90)
        ]
    }

    /// A preset is active only while the value is exactly the range it computes today.
    private var activePreset: String? {
        presets.first { UsageDateRange.trailing(days: $0.days) == range }?.id
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            DateRangePresets(
                options: presets.map { .init(id: $0.id, label: $0.label) },
                selected: activePreset,
                onSelect: { id in
                    if let preset = presets.first(where: { $0.id == id }) {
                        range = .trailing(days: preset.days)
                    }
                }
            )
            HStack(alignment: .bottom, spacing: 8) {
                WebDateInput(label: L("settingsPage.usageCommon.dateRangeFrom"), value: range.from, upperBound: range.to) { next in
                    // Keep the range coherent: "from" can never land after "to".
                    range = UsageDateRange(from: next, to: next > range.to ? next : range.to)
                }
                Text("–")
                    .webText(16)
                    .foregroundStyle(AppTheme.textMuted)
                    .padding(.bottom, 9.6)
                WebDateInput(label: L("settingsPage.usageCommon.dateRangeTo"), value: range.to, lowerBound: range.from, upperBound: UsageDateRange.iso(Date())) { next in
                    range = UsageDateRange(from: next < range.from ? next : range.from, to: next)
                }
            }
        }
    }
}

/// `.presets` in DateRangePicker.module.scss: one row of equal pills at any phone width. Wrapped,
/// the last pill gets a row of its own, where corners meant for a single row look broken.
private struct DateRangePresets: View {
    let options: [RadioButtonGroup.Option]
    let selected: String?
    let onSelect: (String) -> Void

    @Environment(\.windowWidth) private var windowWidth

    /// `clamp(0.8125rem, 4.4vw, 1rem)`
    private var fontSize: CGFloat { min(max(13, windowWidth * 0.044), 16) }

    var body: some View {
        HStack(spacing: -1) {
            ForEach(Array(options.enumerated()), id: \.element.id) { index, option in
                let isActive = selected == option.id
                let shape = RadioButtonGroup.shape(index: index, count: options.count)
                Button { onSelect(option.id) } label: {
                    Text(option.label)
                        .webText(arial: fontSize, lineHeight: fontSize * 1.5)
                        .foregroundStyle(isActive ? Color.white : AppTheme.textPrimary)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 5)
                        .padding(.vertical, 9)
                        .frame(maxWidth: .infinity)
                        .background(isActive ? AppTheme.primaryPressed : Color.clear)
                        .clipShape(shape)
                        .overlay(shape.strokeBorder(isActive ? AppTheme.primary : AppTheme.border, lineWidth: 1))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .zIndex(isActive ? 2 : 0)
                .accessibilityAddTraits(isActive ? .isSelected : [])
            }
        }
    }
}

/// `<input type="date">`: the value + calendar glyph, opening the system calendar.
private struct WebDateInput: View {
    let label: String
    let value: String
    var lowerBound: String?
    var upperBound: String?
    let onChange: (String) -> Void

    @State private var isPickerOpen = false

    private static let display: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateFormat = "MM/dd/yyyy"
        return formatter
    }()

    /// `MM/dd/yyyy` split into numbers and separators.
    private var segments: [String] {
        let shown = UsageDateRange.date(value).map { Self.display.string(from: $0) } ?? value
        return shown.split(separator: "/").map(String.init).flatMap { ["/", $0] }.dropFirst().map { $0 }
    }

    private var selection: Binding<Date> {
        Binding(
            get: { UsageDateRange.date(value) ?? Date() },
            set: { onChange(UsageDateRange.iso($0)) }
        )
    }

    private var bounds: ClosedRange<Date> {
        let lower = lowerBound.flatMap { UsageDateRange.date($0) } ?? .distantPast
        let upper = upperBound.flatMap { UsageDateRange.date($0) } ?? .distantFuture
        return lower...max(lower, upper)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .webText(12.8)
                .foregroundStyle(AppTheme.textMuted)
            Button { isPickerOpen = true } label: {
                // Chrome's date fields carry 1pt of padding each side of every number.
                HStack(spacing: 1) {
                    ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                        Text(segment)
                            .webText(mono: 14.4)
                            .foregroundStyle(AppTheme.textPrimary)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                    .padding(.leading, 14)
                    .frame(width: 137.4, height: 36.4, alignment: .leading)
                    .overlay(alignment: .trailing) {
                        CalendarPickerIndicator()
                            .fill(AppTheme.textPrimary, style: FillStyle(eoFill: true))
                            .frame(width: 14.4, height: 14.4)
                            .padding(.trailing, 14.8)
                    }
                    .background(AppTheme.backgroundSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                    .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityValue(value)
            .popover(isPresented: $isPickerOpen) {
                DatePicker("", selection: selection, in: bounds, displayedComponents: .date)
                    .labelsHidden()
                    .datePickerStyle(.graphical)
                    .frame(width: 320)
                    .padding(8)
                    .presentationCompactAdaptation(.popover)
            }
        }
    }
}

/// The glyph of Chrome's `::-webkit-calendar-picker-indicator` (a 24-unit viewBox).
private struct CalendarPickerIndicator: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 20, y: 3))
        path.addLine(to: CGPoint(x: 19, y: 3))
        path.addLine(to: CGPoint(x: 19, y: 1))
        path.addLine(to: CGPoint(x: 17, y: 1))
        path.addLine(to: CGPoint(x: 17, y: 3))
        path.addLine(to: CGPoint(x: 7, y: 3))
        path.addLine(to: CGPoint(x: 7, y: 1))
        path.addLine(to: CGPoint(x: 5, y: 1))
        path.addLine(to: CGPoint(x: 5, y: 3))
        path.addLine(to: CGPoint(x: 4, y: 3))
        path.addCurve(to: CGPoint(x: 2, y: 5), control1: CGPoint(x: 2.9, y: 3), control2: CGPoint(x: 2, y: 3.9))
        path.addLine(to: CGPoint(x: 2, y: 21))
        path.addCurve(to: CGPoint(x: 4, y: 23), control1: CGPoint(x: 2, y: 22.1), control2: CGPoint(x: 2.9, y: 23))
        path.addLine(to: CGPoint(x: 20, y: 23))
        path.addCurve(to: CGPoint(x: 22, y: 21), control1: CGPoint(x: 21.1, y: 23), control2: CGPoint(x: 22, y: 22.1))
        path.addLine(to: CGPoint(x: 22, y: 5))
        path.addCurve(to: CGPoint(x: 20, y: 3), control1: CGPoint(x: 22, y: 3.9), control2: CGPoint(x: 21.1, y: 3))
        path.closeSubpath()
        path.move(to: CGPoint(x: 20, y: 21))
        path.addLine(to: CGPoint(x: 4, y: 21))
        path.addLine(to: CGPoint(x: 4, y: 8))
        path.addLine(to: CGPoint(x: 20, y: 8))
        path.closeSubpath()
        let scale = min(rect.width, rect.height) / 24
        return path.applying(CGAffineTransform(scaleX: scale, y: scale).translatedBy(x: rect.minX / scale, y: rect.minY / scale))
    }
}

// MARK: - Page chrome shared by the four usage pages

private struct UsageStatusText: View {
    let text: String
    var isError = false

    var body: some View {
        Text(text)
            .webText(14.4)
            .foregroundStyle(isError ? AppTheme.error : AppTheme.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct UsageStatTile: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5.6) {
            Text(label)
                .webText(12.8)
                .foregroundStyle(AppTheme.textMuted)
            Text(value)
                .webText(28, 600)
                .kerning(-0.28)
                .foregroundStyle(AppTheme.textPrimary)
        }
        .padding(.horizontal, 25)
        .padding(.vertical, 21)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.lg).strokeBorder(AppTheme.border, lineWidth: 1))
        .shadow(color: AppTheme.shadowSmall, radius: 1, y: 1)
    }
}

private struct UsageBreakdown<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .webText(16, 600)
                .foregroundStyle(AppTheme.textPrimary)
            content
        }
    }
}

/// Banner above real data (`.noCostNote` / `.estimateBanner`).
private struct UsageNote: View {
    let text: String

    var body: some View {
        Text(text)
            .webText(13.6)
            .foregroundStyle(AppTheme.textMuted)
            .padding(.horizontal, 15.4)
            .padding(.vertical, 10.6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
            .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
    }
}

/// Shared empty state for a category whose instrumentation hasn't shipped.
private struct UsageNotTrackedYet: View {
    var body: some View {
        VStack(spacing: 8) {
            Text(L("settingsPage.usageCommon.notTrackedYetTitle"))
                .webText(16.8, 600)
                .foregroundStyle(AppTheme.textPrimary)
            Text(L("settingsPage.usageCommon.notTrackedYetBody"))
                .webText(14.4)
                .foregroundStyle(AppTheme.textMuted)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 33)
        .padding(.vertical, 49)
        .frame(maxWidth: .infinity)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.lg).strokeBorder(AppTheme.border, lineWidth: 1))
        .shadow(color: AppTheme.shadowSmall, radius: 1, y: 1)
    }
}

/// Totals + by-vendor / by-model tables, used by the LLM and embedding pages.
private struct LlmUsageBody: View {
    let summary: LlmUsageSummary
    let emptyText: String

    private var totalRequests: Int { summary.byVendor.reduce(0) { $0 + $1.requestCount } }

    var body: some View {
        VStack(alignment: .leading, spacing: 32) {
            VStack(spacing: 16) {
                UsageStatTile(label: L("settingsPage.usageCommon.totalCost"), value: UsageFormat.usd(summary.totalCostUsd))
                UsageStatTile(label: L("settingsPage.usageCommon.requests"), value: UsageFormat.count(totalRequests))
            }
            if summary.byVendor.isEmpty {
                UsageStatusText(text: emptyText)
            } else {
                UsageBreakdown(title: L("settingsPage.usageCommon.byVendor")) {
                    table(summary.byVendor, showModel: false)
                }
                UsageBreakdown(title: L("settingsPage.usageCommon.byModel")) {
                    table(summary.byModel, showModel: true)
                }
            }
        }
    }

    private func table(_ rows: [UsageByDim], showModel: Bool) -> some View {
        var columns = [WebDataTable.Column(title: L("settingsPage.usageCommon.vendor"))]
        if showModel { columns.append(.init(title: L("settingsPage.usageCommon.model"))) }
        columns += [
            .init(title: L("settingsPage.usageCommon.totalCost"), numeric: true),
            .init(title: L("settingsPage.usageCommon.tokens"), numeric: true),
            .init(title: L("settingsPage.usageCommon.requests"), numeric: true)
        ]
        return WebDataTable(columns: columns, rows: rows.map { row in
            var cells = [row.vendor]
            if showModel { cells.append(row.model ?? "") }
            cells += [UsageFormat.usd(row.costUsd), UsageFormat.count(row.totalTokens ?? 0), UsageFormat.count(row.requestCount)]
            return cells
        })
    }
}

// MARK: - Pages

/// Cost and Usage > LLM Models: the one category that treats a failure as an error.
struct LlmUsageSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @State private var range = UsageDateRange.trailing(days: 30)
    @State private var summary: LlmUsageSummary?
    @State private var isLoading = true
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 32) {
            DateRangePicker(range: $range)
            if isLoading {
                UsageStatusText(text: L("settingsPage.usageCommon.loading"))
            } else if failed {
                UsageStatusText(text: L("settingsPage.usageCommon.error"), isError: true)
            } else if let summary {
                LlmUsageBody(summary: summary, emptyText: L("settingsPage.llmUsageSettings.empty"))
                Text(L("settingsPage.llmUsageSettings.trackedSinceNote"))
                    .webText(12.8)
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task(id: range.from + range.to) {
            isLoading = true
            failed = false
            defer { isLoading = false }
            do {
                let token = try await auth.getAccessTokenSilently()
                summary = try await UsageService.getLlmUsage(token: token, from: range.utcDays().from, to: range.utcDays().to)
            } catch {
                failed = !(error is CancellationError)
            }
        }
    }
}

/// Any failure reads the same as "not tracked yet".
struct EmbeddingUsageSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @State private var range = UsageDateRange.trailing(days: 30)
    @State private var summary: LlmUsageSummary?
    @State private var isLoading = true

    var body: some View {
        VStack(alignment: .leading, spacing: 32) {
            DateRangePicker(range: $range)
            if isLoading {
                UsageStatusText(text: L("settingsPage.usageCommon.loading"))
            } else if let summary {
                LlmUsageBody(summary: summary, emptyText: L("settingsPage.embeddingUsageSettings.empty"))
            } else {
                UsageNotTrackedYet()
            }
        }
        .task(id: range.from + range.to) {
            isLoading = true
            defer { isLoading = false }
            let token = try? await auth.getAccessTokenSilently()
            summary = try? await UsageService.getEmbeddingUsage(token: token ?? "", from: range.utcDays().from, to: range.utcDays().to)
        }
    }
}

/// Raw operation counts only: an op count can't become a meaningful dollar estimate.
struct VectorDbUsageSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @State private var range = UsageDateRange.trailing(days: 30)
    @State private var summary: VectorDbUsageSummary?
    @State private var isLoading = true

    var body: some View {
        VStack(alignment: .leading, spacing: 32) {
            DateRangePicker(range: $range)
            if isLoading {
                UsageStatusText(text: L("settingsPage.usageCommon.loading"))
            } else if let summary {
                UsageNote(text: L("settingsPage.vectorDbUsageSettings.noCostNote"))
                if summary.breakdown.isEmpty {
                    UsageStatusText(text: L("settingsPage.vectorDbUsageSettings.empty"))
                } else {
                    UsageBreakdown(title: L("settingsPage.vectorDbUsageSettings.byOperation")) {
                        WebDataTable(
                            columns: [
                                .init(title: L("settingsPage.vectorDbUsageSettings.operation")),
                                .init(title: L("settingsPage.vectorDbUsageSettings.operationCount"), numeric: true)
                            ],
                            rows: summary.breakdown.map { [$0.opType, UsageFormat.count($0.count)] }
                        )
                    }
                }
            } else {
                UsageNotTrackedYet()
            }
        }
        .task(id: range.from + range.to) {
            isLoading = true
            defer { isLoading = false }
            let token = try? await auth.getAccessTokenSilently()
            summary = try? await UsageService.getVectorDbUsage(token: token ?? "", from: range.utcDays().from, to: range.utcDays().to)
        }
    }
}

/// Always an estimate; the disclaimer stays visible whenever real data renders.
struct WebSearchUsageSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @State private var range = UsageDateRange.trailing(days: 30)
    @State private var summary: EstimatedUsageSummary?
    @State private var isLoading = true

    var body: some View {
        VStack(alignment: .leading, spacing: 32) {
            DateRangePicker(range: $range)
            if isLoading {
                UsageStatusText(text: L("settingsPage.usageCommon.loading"))
            } else if let summary {
                UsageNote(text: L("settingsPage.usageCommon.estimateDisclaimer"))
                UsageStatTile(label: L("settingsPage.usageCommon.totalCost"), value: UsageFormat.usd(summary.totalCostUsd))
                if summary.breakdown.isEmpty {
                    UsageStatusText(text: L("settingsPage.webSearchUsageSettings.empty"))
                } else {
                    UsageBreakdown(title: L("settingsPage.webSearchUsageSettings.byDepth")) {
                        WebDataTable(
                            columns: [
                                .init(title: L("settingsPage.webSearchUsageSettings.searchDepth")),
                                .init(title: L("settingsPage.webSearchUsageSettings.credits"), numeric: true),
                                .init(title: L("settingsPage.usageCommon.totalCost"), numeric: true)
                            ],
                            rows: summary.breakdown.map { [$0.key, UsageFormat.count($0.count), UsageFormat.usd($0.costUsd)] }
                        )
                    }
                }
            } else {
                UsageNotTrackedYet()
            }
        }
        .task(id: range.from + range.to) {
            isLoading = true
            defer { isLoading = false }
            let token = try? await auth.getAccessTokenSilently()
            summary = try? await UsageService.getWebSearchUsage(token: token ?? "", from: range.utcDays().from, to: range.utcDays().to)
        }
    }
}
