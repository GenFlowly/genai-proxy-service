import SwiftUI

/// The body a SidebarWidget holds, as on the web: conversations (Projects, Chats), scopes or
/// categories to pick from (Memory, Agents), grouped navigation (Settings), or content of its
/// own design (the dock's Models, Agent and Tokens cards).
enum SidebarWidgetVariant { case history, directory, menu, custom }

/// What the card paints inside its hairline: the material alone, or the sidebar background.
enum SidebarWidgetSurface { case material, sidebar }

/// SidebarWidget.tsx: one card of the sidebar. History and custom cards are the material alone
/// over the page, with a hairline edge and the drop shadow; their 34pt header holds a 16pt icon,
/// the 12/500 title and actions at the right end, over a hairline, and a collapsible one's
/// header is a toggle with a chevron that folds the card to its header. Directory and menu cards
/// paint the sidebar background, under an uppercase heading.
struct SidebarWidget<Actions: View, Content: View>: View {
    var variant = SidebarWidgetVariant.custom
    var title: String?
    var icon: String?
    var collapsible = false
    var isExpanded = true
    var onToggle: () -> Void = {}
    /// The dock cards pad their body; a list widget's rows reach the card's edges.
    var bodyInsets = EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10)
    /// Overrides the variant's surface (the Settings links card paints the sidebar background).
    var surface: SidebarWidgetSurface?
    var toggleIdentifier: String?
    @ViewBuilder var actions: Actions
    @ViewBuilder var content: Content

    var resolvedSurface: SidebarWidgetSurface {
        surface ?? (variant == .directory || variant == .menu ? .sidebar : .material)
    }

    var body: some View {
        switch resolvedSurface {
        case .material: card.sidebarWidgetCard()
        case .sidebar: card.sidebarCard()
        }
    }

    @ViewBuilder
    private var card: some View {
        switch variant {
        case .history, .custom:
            if let title {
                VStack(alignment: .leading, spacing: 0) {
                    header(title)
                    if isExpanded {
                        content
                            .padding(bodyInsets)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    }
                }
            } else {
                content
            }
        case .directory:
            if let title {
                VStack(spacing: 0) {
                    SectionHeader(title: title, isExpanded: isExpanded, canExpand: true, action: { actions }, onToggle: onToggle)
                    if isExpanded {
                        content
                    }
                }
            } else {
                content
            }
        case .menu:
            if let title {
                VStack(alignment: .leading, spacing: 0) {
                    Text(title.uppercased())
                        .webText(12, 700)
                        .kerning(0.72)
                        .foregroundStyle(AppTheme.textMuted)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 42)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    content
                }
            } else {
                content
            }
        }
    }

    private func header(_ title: String) -> some View {
        HStack(spacing: 8) {
            if collapsible {
                Button(action: onToggle) {
                    HStack(spacing: 8) {
                        Chevron(expanded: isExpanded)
                        headerLabel(title)
                    }
                    .padding(.leading, 8)
                    .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(WebPressStyle())
                .accessibilityLabel(title)
                .accessibilityHint(L(isExpanded ? "layout.chatSidebar.collapseSection" : "layout.chatSidebar.expandSection", ["name": title]))
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier(toggleIdentifier ?? "")
            } else {
                headerLabel(title)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
            }
            actions
        }
        .padding(.leading, collapsible ? 0 : 10)
        .padding(.trailing, 6)
        .frame(height: 34)
        .overlay(alignment: .bottom) {
            if isExpanded {
                Rectangle().fill(AppTheme.sidebarHairline).frame(height: 1)
            }
        }
    }

    private func headerLabel(_ title: String) -> some View {
        HStack(spacing: 8) {
            if let icon {
                WebIcon(name: icon, size: 16, color: AppTheme.textSecondary)
            }
            Text(title)
                .webText(12, 500)
                .foregroundStyle(AppTheme.textSecondary)
                .lineLimit(1)
        }
    }
}

extension SidebarWidget where Actions == EmptyView {
    init(
        variant: SidebarWidgetVariant = .custom,
        title: String? = nil,
        icon: String? = nil,
        collapsible: Bool = false,
        isExpanded: Bool = true,
        onToggle: @escaping () -> Void = {},
        bodyInsets: EdgeInsets = EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10),
        surface: SidebarWidgetSurface? = nil,
        toggleIdentifier: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.init(
            variant: variant, title: title, icon: icon, collapsible: collapsible, isExpanded: isExpanded, onToggle: onToggle,
            bodyInsets: bodyInsets, surface: surface, toggleIdentifier: toggleIdentifier, actions: { EmptyView() }, content: content
        )
    }
}

extension View {
    /// sidebar-card.scss chrome with the sidebar background painted inside the material: the
    /// directory and menu cards.
    fileprivate func sidebarCard() -> some View {
        self
            .frame(maxWidth: .infinity)
            .background(AppTheme.sidebarBackground)
            .padding(1)
            .background(AppTheme.sidebarMaterial)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))
            .overlay(RoundedRectangle(cornerRadius: DSRadius.lg).strokeBorder(AppTheme.sidebarHairline, lineWidth: 1))
            .shadow(color: AppTheme.sidebarShadow, radius: 8, y: 4)
    }

    /// sidebar-card.scss chrome as SidebarWidget draws it: the card material over the page with
    /// nothing painted inside, a hairline edge, 10pt corners and the drop shadow.
    func sidebarWidgetCard() -> some View {
        self
            .frame(maxWidth: .infinity)
            .padding(1)
            .background(AppTheme.sidebarMaterial)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))
            .overlay(RoundedRectangle(cornerRadius: DSRadius.lg).strokeBorder(AppTheme.sidebarHairline, lineWidth: 1))
            .background(OuterShadow(cornerRadius: DSRadius.lg))
    }
}

/// The card's drop shadow, outside the card only, as CSS draws a box-shadow: under the
/// translucent material it would darken the card itself.
private struct OuterShadow: View {
    let cornerRadius: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .fill(Color.black)
            .shadow(color: AppTheme.sidebarShadow, radius: 8, y: 4)
            .mask {
                Rectangle()
                    .padding(-32)
                    .overlay(RoundedRectangle(cornerRadius: cornerRadius).blendMode(.destinationOut))
                    .compositingGroup()
            }
            .allowsHitTesting(false)
    }
}

/// IconButton size sm, as in the dock's headers: a 22pt target around a 14pt glyph.
struct SidebarHeaderAction: View {
    let icon: String
    let label: String
    var disabled = false
    var identifier: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            WebIcon(name: icon, size: 14, color: AppTheme.textMuted)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(WebPressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier ?? "")
    }
}
