import SwiftUI

// MARK: - Date range (usageDateRange.ts)

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



extension UsageDateRange {
    static let presets: [(id: String, labelKey: String, days: Int)] = [
        ("7d", "settingsPage.usageCommon.dateRangeLast7Days", 7),
        ("30d", "settingsPage.usageCommon.dateRangeLast30Days", 30),
        ("90d", "settingsPage.usageCommon.dateRangeLast90Days", 90)
    ]

    /// usageRangeLabel: "Last 30 days" for a preset ending today, else the two local dates.
    var label: String {
        if let preset = Self.presets.first(where: { Self.trailing(days: $0.days) == self }) { return L(preset.labelKey) }
        let shown = { (iso: String) in Self.date(iso).map { $0.formatted(date: .numeric, time: .omitted) } ?? iso }
        return "\(shown(from)) – \(shown(to))"
    }
}

// MARK: - DateRangePicker variant="toolbar" at phone width (UsageRangePanel.tsx)

/// The date range every usage page starts with, in a headerless card: a segmented control of
/// presets, then the From and To fields, each with its label in a bar above the date.
struct UsageRangePanel: View {
    @Binding var range: UsageDateRange

    var body: some View {
        SettingsCard {
            VStack(spacing: 10) {
                HStack(spacing: 2) {
                    ForEach(UsageDateRange.presets, id: \.id) { preset in
                        let isOn = UsageDateRange.trailing(days: preset.days) == range
                        Button { range = .trailing(days: preset.days) } label: {
                            Text(L(preset.labelKey))
                                .webText(12.5, 500)
                                .foregroundStyle(isOn ? AppTheme.textPrimary : AppTheme.textMuted)
                                .lineLimit(1)
                                .padding(.horizontal, 6)
                                .frame(maxWidth: .infinity)
                                .frame(height: 28)
                                .background(isOn ? AppTheme.backgroundSecondary : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                                .shadow(color: isOn ? .black.opacity(0.08) : .clear, radius: 1, y: 1)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(isOn ? .isSelected : [])
                        .accessibilityIdentifier("usage-date-range-preset-\(preset.id)")
                    }
                }
                .padding(3)
                .background(AppTheme.backgroundTertiary, in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(AppTheme.sidebarHairline, lineWidth: 1))
                .accessibilityElement(children: .contain)
                .accessibilityLabel(L("settingsPage.usageCommon.dateRangePresetsLabel"))

                UsageDateField(label: L("settingsPage.usageCommon.dateRangeFrom"), value: range.from, upperBound: range.to) { next in
                    range = UsageDateRange(from: next, to: next > range.to ? next : range.to)
                }
                UsageDateField(label: L("settingsPage.usageCommon.dateRangeTo"), value: range.to, lowerBound: range.from, upperBound: UsageDateRange.iso(Date())) { next in
                    range = UsageDateRange(from: next < range.from ? next : range.from, to: next)
                }
            }
        }
    }
}

/// `.prefixedField` stacked: the label in a 28pt bar, the date (as `<input type="date">` draws
/// it, "MM/DD/YYYY" with the calendar glyph) in a 44pt row; tapping opens the system calendar.
private struct UsageDateField: View {
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

    private var selection: Binding<Date> {
        Binding(get: { UsageDateRange.date(value) ?? Date() }, set: { onChange(UsageDateRange.iso($0)) })
    }

    private var bounds: ClosedRange<Date> {
        let lower = lowerBound.flatMap { UsageDateRange.date($0) } ?? .distantPast
        let upper = upperBound.flatMap { UsageDateRange.date($0) } ?? .distantFuture
        return lower...max(lower, upper)
    }

    var body: some View {
        Button { isPickerOpen = true } label: {
            VStack(spacing: 0) {
                Text(label)
                    .webText(12, 500)
                    .foregroundStyle(AppTheme.textSecondary)
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, minHeight: 27, alignment: .leading)
                    .background(AppTheme.backgroundTertiary)
                    .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.border).frame(height: 1).offset(y: 1) }
                    .padding(.bottom, 1)
                HStack(spacing: 0) {
                    Text(UsageDateRange.date(value).map { Self.display.string(from: $0) } ?? value)
                        .webText(15)
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    CalendarPickerIndicator()
                        .fill(AppTheme.textPrimary, style: FillStyle(eoFill: true))
                        .frame(width: 15, height: 15)
                }
                .padding(.horizontal, 12)
                .frame(height: 44)
            }
            .padding(1)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(AppTheme.border, lineWidth: 1))
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

// MARK: - Shared pieces

/// Loads one usage summary for the picked local range (sent as the UTC days it touches) and
/// again whenever the range changes. A nil summary means the category isn't tracked yet.
private struct UsageLoadState<Summary> {
    var summary: Summary?
    var loading = true
    var failed = false
}

private struct UsageStatusLine: View {
    let text: String
    var isError = false

    var body: some View {
        Text(text)
            .webText(14)
            .foregroundStyle(AppTheme.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// UsageNotTrackedYet.tsx: a card saying this isn't tracked yet, with a related page.
private struct UsageNotTrackedYet: View {
    var link: (label: String, action: () -> Void)?

    var body: some View {
        SettingsCard {
            VStack(spacing: 6) {
                Text(L("settingsPage.usageCommon.notTrackedYetTitle"))
                    .webText(15, 600)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(L("settingsPage.usageCommon.notTrackedYetBody"))
                    .webText(13)
                    .foregroundStyle(AppTheme.textMuted)
                    .multilineTextAlignment(.center)
                if let link {
                    SettingsLink(text: link.label, action: link.action)
                        .padding(.top, 6)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("usage-not-tracked-yet")
    }
}

private enum UsageChart {
    private static let utc = TimeZone(identifier: "UTC") ?? .gmt

    private static func date(_ iso: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = utc
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: iso)
    }

    private static func format(_ iso: String, _ pattern: String) -> String {
        guard let day = date(iso) else { return iso }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.timeZone = utc
        formatter.setLocalizedDateFormatFromTemplate(pattern)
        return formatter.string(from: day)
    }

    /// Days outside the picked range (a local range touches one more UTC day) fold into the
    /// nearest bar so the chart adds up to the tiles.
    static func points(_ byDay: [UsageByDay], range: UsageDateRange) -> (title: String, points: [BarChartPoint]) {
        let clamped = byDay.map { day -> (date: String, value: Double, count: Int) in
            let date = day.date < range.from ? range.from : day.date > range.to ? range.to : day.date
            return (date, day.costUsd, day.requestCount)
        }
        let series = DailySeries.bucket(clamped, from: range.from, to: range.to)
        let points = series.buckets.map { bucket in
            BarChartPoint(
                key: bucket.start,
                value: bucket.value,
                axisLabel: format(bucket.start, "MMMd"),
                tooltipTitle: series.isWeekly ? "\(format(bucket.start, "MMMd")) – \(format(bucket.end, "MMMd"))" : format(bucket.start, "EEEMMMd"),
                tooltipDetail: L("settingsPage.usageCommon.requestsCount", ["count": bucket.count, "formatted": SettingsFormat.compactCount(bucket.count)])
            )
        }
        return (series.isWeekly ? L("settingsPage.usageCommon.costPerWeek") : L("settingsPage.usageCommon.costPerDay"), points)
    }
}

// MARK: - LLM and Embedding usage (UsageCostView.tsx)

/// Date range, headline tiles, cost per day (per week past 60 days), and by-vendor and by-model
/// tables. Own-key customers see the cost as an estimate.
private struct UsageCostView: View {
    @EnvironmentObject var auth: AuthStore
    @ObservedObject private var catalog = ProviderCatalog.shared
    let knowledge: [KnowledgeItem]
    let showCacheTokens: Bool
    let identifier: String
    let load: (String, UsageDateRange) async throws -> LlmUsageSummary?
    var vendorName: ((String) -> String)?

    @State private var range = UsageDateRange.trailing(days: 30)
    @State private var state = UsageLoadState<LlmUsageSummary>()

    var body: some View {
        let costLabel = auth.hasOwnKeys ? L("settingsPage.usageCommon.estCost") : L("settingsPage.usageCommon.totalCost")
        let notTracked = !state.loading && !state.failed && state.summary == nil
        VStack(alignment: .leading, spacing: 12) {
            UsageRangePanel(range: $range)
            if state.loading {
                UsageStatusLine(text: L("settingsPage.usageCommon.loading"))
            } else if state.failed {
                UsageStatusLine(text: L("settingsPage.usageCommon.error"), isError: true)
                    .accessibilityIdentifier("\(identifier)-error")
            } else if let summary = state.summary {
                content(summary, costLabel: costLabel)
            } else {
                UsageNotTrackedYet()
            }
        }
        .settingsPage(status: notTracked ? L("settingsPage.usageCommon.notTrackedYetTitle") : range.label, knowledge: knowledge)
        .task(id: range.from + range.to) {
            state.loading = true
            state.failed = false
            defer { state.loading = false }
            do {
                let token = try await auth.getAccessTokenSilently()
                state.summary = try await load(token, range.utcDays())
            } catch {
                state.failed = !(error is CancellationError)
            }
        }
    }

    @ViewBuilder
    private func content(_ summary: LlmUsageSummary, costLabel: String) -> some View {
        let byVendor = summary.byVendor
        let requests = byVendor.reduce(0) { $0 + $1.requestCount }
        let tokens = byVendor.reduce(0) { $0 + ($1.totalTokens ?? 0) }
        let cache = byVendor.reduce(0) { $0 + ($1.cacheReadTokens ?? 0) + ($1.cacheWriteTokens ?? 0) }
        let chart = UsageChart.points(summary.byDay ?? [], range: range)
        StatTileGrid(tiles: [
            (costLabel, SettingsFormat.usd(summary.totalCostUsd), "\(identifier)-tile-cost"),
            (L("settingsPage.usageCommon.requests"), SettingsFormat.compactCount(requests), "\(identifier)-tile-requests"),
            (L("settingsPage.usageCommon.tokens"), SettingsFormat.compactCount(tokens), "\(identifier)-tile-tokens")
        ] + (showCacheTokens ? [(L("settingsPage.usageCommon.cacheTokens"), SettingsFormat.compactCount(cache), "\(identifier)-tile-cache")] : []))
        SettingsCard(title: chart.title) {
            UsageBarChart(points: chart.points, formatValue: SettingsFormat.chartUsd, accessibilityTitle: chart.title)
        }
        SettingsCard(title: L("settingsPage.usageCommon.byVendor"), flush: true) {
            table(byVendor, showModel: false, costLabel: costLabel)
                .accessibilityIdentifier("\(identifier)-by-vendor")
        }
        SettingsCard(title: L("settingsPage.usageCommon.byModel"), flush: true) {
            table(summary.byModel, showModel: true, costLabel: costLabel)
                .accessibilityIdentifier("\(identifier)-by-model")
        }
    }

    private func table(_ rows: [UsageByDim], showModel: Bool, costLabel: String) -> some View {
        let name = vendorName ?? { catalog.displayName(for: $0) }
        var columns = [SettingsTable.Column(title: L("settingsPage.usageCommon.vendor"))]
        if showModel { columns.append(.init(title: L("settingsPage.usageCommon.model"))) }
        columns += [
            .init(title: costLabel, numeric: true),
            .init(title: L("settingsPage.usageCommon.tokens"), numeric: true),
            .init(title: L("settingsPage.usageCommon.requests"), numeric: true)
        ]
        return SettingsTable(
            columns: columns,
            rows: rows.map { row in
                [name(row.vendor)] + (showModel ? [row.model ?? ""] : [])
                    + [SettingsFormat.usd(row.costUsd), SettingsFormat.compactCount(row.totalTokens ?? 0), SettingsFormat.compactCount(row.requestCount)]
            },
            emptyText: L("settingsPage.usageCommon.noUsage")
        )
    }
}

// MARK: - Pages

/// Cost and Usage › LLM Models.
struct LlmUsageSettingsView: View {
    @EnvironmentObject var auth: AuthStore

    var body: some View {
        UsageCostView(
            knowledge: [
                KnowledgeItem(title: L("settingsPage.usageCommon.countedTitle"), text: L("settingsPage.llmUsageSettings.countedText")),
                KnowledgeItem(title: L("settingsPage.usageCommon.costTitle"), text: auth.hasOwnKeys ? L("settingsPage.usageCommon.costOwnKeys") : L("settingsPage.usageCommon.costAppKeys"))
            ],
            showCacheTokens: true,
            identifier: "llm-usage",
            load: { token, range in try await UsageService.getLlmUsage(token: token, from: range.from, to: range.to) }
        )
    }
}

/// Cost and Usage › Embedding Models.
struct EmbeddingUsageSettingsView: View {
    @EnvironmentObject var auth: AuthStore

    var body: some View {
        UsageCostView(
            knowledge: [
                KnowledgeItem(title: L("settingsPage.usageCommon.countedTitle"), text: L("settingsPage.embeddingUsageSettings.countedText")),
                KnowledgeItem(title: L("settingsPage.usageCommon.costTitle"), text: auth.hasOwnKeys ? L("settingsPage.usageCommon.costOwnKeys") : L("settingsPage.usageCommon.costAppKeys")),
                KnowledgeItem(title: L("settingsPage.embeddingUsageSettings.zeroTitle"), text: L("settingsPage.embeddingUsageSettings.zeroText"))
            ],
            showCacheTokens: false,
            identifier: "embedding-usage",
            load: { token, range in try await UsageService.getEmbeddingUsage(token: token, from: range.from, to: range.to) },
            vendorName: { $0.uppercased() == EmbeddingVendor.voyage ? EmbeddingModelChoice.vendorLabel(EmbeddingVendor.voyage) : ProviderCatalog.shared.displayName(for: $0) }
        )
    }
}

/// Cost and Usage › Vector DB: how often the database saves, searches and deletes. Counts only,
/// never a cost. Any failure reads as "not tracked yet".
struct VectorDbUsageSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @State private var range = UsageDateRange.trailing(days: 30)
    @State private var state = UsageLoadState<VectorDbUsageSummary>()

    var body: some View {
        let notTracked = !state.loading && state.summary == nil
        VStack(alignment: .leading, spacing: 12) {
            UsageRangePanel(range: $range)
            if state.loading {
                UsageStatusLine(text: L("settingsPage.usageCommon.loading"))
            } else if let summary = state.summary {
                SettingsCard(title: L("settingsPage.vectorDbUsageSettings.byOperation"), flush: true) {
                    SettingsTable(
                        columns: [
                            .init(title: L("settingsPage.vectorDbUsageSettings.operation")),
                            .init(title: L("settingsPage.vectorDbUsageSettings.operationCount"), numeric: true)
                        ],
                        rows: summary.breakdown.map { [$0.opType, SettingsFormat.compactCount($0.count)] },
                        emptyText: L("settingsPage.usageCommon.noUsage")
                    )
                    .accessibilityIdentifier("vector-db-usage-table")
                }
            } else {
                UsageNotTrackedYet(link: (L("settingsPage.nav.vectorDb"), { router.navigate(.settings(.vectorDb)) }))
            }
        }
        .settingsPage(
            status: notTracked ? L("settingsPage.usageCommon.notTrackedYetTitle") : range.label,
            knowledge: [
                KnowledgeItem(title: L("settingsPage.vectorDbUsageSettings.countedTitle"), text: L("settingsPage.vectorDbUsageSettings.countedText")),
                KnowledgeItem(title: L("settingsPage.vectorDbUsageSettings.noCostTitle"), text: L("settingsPage.vectorDbUsageSettings.noCostText"))
            ]
        )
        .task(id: range.from + range.to) {
            state.loading = true
            defer { state.loading = false }
            let token = try? await auth.getAccessTokenSilently()
            let days = range.utcDays()
            state.summary = try? await UsageService.getVectorDbUsage(token: token ?? "", from: days.from, to: days.to)
        }
    }
}

/// Cost and Usage › Web Search: each search the assistant ran; its cost is always an estimate.
struct WebSearchUsageSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @State private var range = UsageDateRange.trailing(days: 30)
    @State private var state = UsageLoadState<EstimatedUsageSummary>()

    var body: some View {
        let notTracked = !state.loading && state.summary == nil
        VStack(alignment: .leading, spacing: 12) {
            UsageRangePanel(range: $range)
            if state.loading {
                UsageStatusLine(text: L("settingsPage.usageCommon.loading"))
            } else if let summary = state.summary {
                SettingsCard(title: L("settingsPage.webSearchUsageSettings.byDepth"), flush: true) {
                    SettingsTable(
                        columns: [
                            .init(title: L("settingsPage.webSearchUsageSettings.searchDepth")),
                            .init(title: L("settingsPage.webSearchUsageSettings.credits"), numeric: true),
                            .init(title: L("settingsPage.usageCommon.estCost"), numeric: true)
                        ],
                        rows: summary.breakdown.map { [$0.key, SettingsFormat.compactCount($0.count), SettingsFormat.usd($0.costUsd)] },
                        footer: [L("settingsPage.usageCommon.total"), "", SettingsFormat.usd(summary.totalCostUsd)],
                        emptyText: L("settingsPage.usageCommon.noUsage")
                    )
                    .accessibilityIdentifier("web-search-usage-table")
                }
            } else {
                UsageNotTrackedYet(link: (L("settingsPage.webSearchUsageSettings.changeLimit"), { router.navigate(.settings(.webSearchKey)) }))
            }
        }
        .settingsPage(
            status: notTracked ? L("settingsPage.usageCommon.notTrackedYetTitle") : range.label,
            knowledge: [
                KnowledgeItem(title: L("settingsPage.webSearchUsageSettings.countedTitle"), text: L("settingsPage.webSearchUsageSettings.countedText")),
                KnowledgeItem(title: L("settingsPage.webSearchUsageSettings.spendTitle"), text: L("settingsPage.webSearchUsageSettings.spendText"))
            ]
        )
        .task(id: range.from + range.to) {
            state.loading = true
            defer { state.loading = false }
            let token = try? await auth.getAccessTokenSilently()
            let days = range.utcDays()
            state.summary = try? await UsageService.getWebSearchUsage(token: token ?? "", from: days.from, to: days.to)
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

