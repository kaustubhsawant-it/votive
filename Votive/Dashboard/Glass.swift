import SwiftUI

/// The window's surfaces. Liquid Glass on macOS 26 and later, the closest system material before that, so the window
/// looks right on macOS 14 and 15 and gets the new look on 26 without a second set of views.
///
/// Glass is for the navigation layer (the sidebar and toolbar get it from the system) and for one hero panel per page.
/// Content sits on plain grouped surfaces: stacking glass on glass makes text hard to read, and Apple's own guidance is
/// to keep it to controls and navigation.
extension View {
    /// A content surface: the grouped background of the system, with a hairline edge.
    func contentPanel(cornerRadius: CGFloat = 14) -> some View {
        background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
    }

    /// The one hero panel of a page: glass on macOS 26 (tinted when `tint` is given), a material before.
    @ViewBuilder
    func heroPanel(tint: Color? = nil, cornerRadius: CGFloat = 22) -> some View {
        if #available(macOS 26, *) {
            glassEffect(tint.map { Glass.regular.tint($0.opacity(0.22)) } ?? Glass.regular, in: .rect(cornerRadius: cornerRadius))
        } else {
            background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).fill((tint ?? .clear).opacity(0.10)))
                .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(Color.primary.opacity(0.10)))
        }
    }

    /// A secondary button: the glass style on macOS 26, the bordered style before.
    @ViewBuilder
    func softButton() -> some View {
        if #available(macOS 26, *) { buttonStyle(.glass) } else { buttonStyle(.bordered) }
    }
}
