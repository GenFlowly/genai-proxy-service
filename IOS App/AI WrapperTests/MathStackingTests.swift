import CoreGraphics
import SwiftMath
import Testing
import UIKit
@testable import AI_Wrapper

@MainActor
struct MathStackingTests {
    private func render(_ latex: String, display: Bool = true) -> UIImage? {
        MathRenderer.image(latex: latex, fontSize: 19.2, display: display, color: .black)
    }

    /// The leftmost and rightmost inked pixel columns within a horizontal band of the
    /// image, given as fractions of its height measured from the top.
    private func inkColumns(_ image: UIImage, band: ClosedRange<CGFloat>) throws -> ClosedRange<Int> {
        let cgImage = try #require(image.cgImage)
        let width = cgImage.width, height = cgImage.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try #require(CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        var left = Int.max, right = Int.min
        for row in Int(band.lowerBound * CGFloat(height))..<Int(band.upperBound * CGFloat(height)) {
            for column in 0..<width where pixels[(row * width + column) * 4 + 3] > 64 {
                left = min(left, column)
                right = max(right, column)
            }
        }
        try #require(left <= right)
        return left...right
    }

    @Test func latexWithoutStackingCommandsIsLeftAlone() {
        #expect(MathStacking.prepare(#"E = mc^2"#) == nil)
        #expect(MathStacking.prepare(#"a \\underbrace"#) == nil)
        #expect(MathStacking.prepare(#"\overbraces{a}"#) == nil)
    }

    @Test(arguments: [
        #"\underbrace{\text{Revenue lost} + \text{Customers angered}}_{\text{Cost to copy}} \;>\; \underbrace{\text{Value of your market}}_{\text{Benefit of copying}}"#,
        #"y = \overbrace{p+q}^{k} - 1"#,
        #"a \overset{\text{def}}{=} b"#,
        #"\underset{x \to 0}{\lim} f(x) = L"#,
        #"A \stackrel{?}{=} B"#,
        #"\underbrace{a + \underbrace{b + c}_{\text{inner}} + d}_{\text{outer}}"#,
        #"\frac{\underbrace{a+b}_{n}}{c} = 1"#,
        #"\begin{aligned} E &= \underbrace{m g h}_{\text{potential}} \\ &= x \end{aligned}"#,
        #"\begin{pmatrix} \underbrace{a}_{1} & b \\ c & d \end{pmatrix}"#,
        #"\left( \underbrace{a+b}_{n} \right)^2"#,
        #"\underbrace{a+b} = c"#,
    ])
    func stackingCommandsRender(_ latex: String) {
        #expect(render(latex) != nil)
        #expect(render(latex, display: false) != nil)
    }

    @Test func theFormulaRowKeepsItsWidthAndTheLabelAddsHeight() throws {
        let plain = try #require(render(#"x = a+b+c + d"#))
        let stacked = try #require(render(#"x = \underbrace{a+b+c}_{n} + d"#))
        #expect(abs(stacked.size.width - plain.size.width) <= 1)
        #expect(stacked.size.height > plain.size.height + 5)
    }

    @Test func anAlignedBlockKeepsItsWidth() throws {
        let plain = try #require(render(#"\begin{aligned} E &= m g h + k \\ &= x \end{aligned}"#))
        let stacked = try #require(render(#"\begin{aligned} E &= \underbrace{m g h}_{p} + k \\ &= x \end{aligned}"#))
        #expect(abs(stacked.size.width - plain.size.width) <= 1)
    }

    /// MTMathUILabel runs SwiftMath's mathListToString on every list it is given, and
    /// that deletes the empty atom that gives an aligned row's `&=` its space.
    @Test func alignedRowsKeepTheirSpacerThroughTheLabel() throws {
        let prepared = try #require(MathStacking.prepare(#"\begin{aligned} E &= \underbrace{m g h}_{p} \\ &= x \end{aligned}"#))
        let list = try #require(MTMathListBuilder.build(fromString: prepared))
        let label = MTMathUILabel()
        let outcome = MathStacking.restructure(list, style: .display) { measured in
            label.mathList = measured
            return label.intrinsicContentSize.width
        }
        #expect(outcome != nil)
        label.mathList = list
        let table = try #require(list.atoms.first as? MTMathTable)
        let spacers = table.cells.filter { row in
            row.count > 1 && row[1].atoms.first.map { $0.type == .ordinary && $0.nucleus.isEmpty } == true
        }
        #expect(spacers.count == 2)
    }

    @Test func aLabelUnderItsBaseIsCentred() throws {
        let image = try #require(render(#"\underbrace{a+b+c}_{\text{n}}"#))
        let label = try inkColumns(image, band: 0.65...1)
        let centre = CGFloat(label.lowerBound + label.upperBound) / 2
        #expect(abs(centre - CGFloat(image.cgImage!.width) / 2) <= image.scale * 1.5)
    }

    @Test func aLabelOverItsBaseIsCentred() throws {
        let image = try #require(render(#"\overbrace{a+b+c}^{\text{n}}"#))
        let label = try inkColumns(image, band: 0...0.3)
        let centre = CGFloat(label.lowerBound + label.upperBound) / 2
        #expect(abs(centre - CGFloat(image.cgImage!.width) / 2) <= image.scale * 1.5)
    }

    /// Where SwiftMath puts a formula's baseline in an image it renders, from the top
    /// and from the bottom.
    private func plainBaseline(_ latex: String) throws -> (fromTop: CGFloat, fromBottom: CGFloat) {
        var math = MathImage(latex: latex, fontSize: 19.2, textColor: .black, labelMode: .text, textAlignment: .left)
        let (_, rendered, layout) = math.asImage()
        let image = try #require(rendered), info = try #require(layout)
        let fromBottom = (image.size.height - (info.ascent + info.descent)) / 2 + info.descent
        return (image.size.height - fromBottom, fromBottom)
    }

    @Test func inlineFormulasStayOnTheTextBaseline() throws {
        let under = try #require(render(#"x = \underbrace{a+b}_{n} + c"#, display: false))
        let underPlain = try plainBaseline(#"x = a+b + c"#)
        let underBaseline = try #require(under.baselineOffsetFromBottom)
        #expect(abs((under.size.height - underBaseline) - underPlain.fromTop) <= 0.5)

        let over = try #require(render(#"y = \overbrace{p+q}^{k} - 1"#, display: false))
        let overPlain = try plainBaseline(#"y = p+q - 1"#)
        let overBaseline = try #require(over.baselineOffsetFromBottom)
        #expect(abs(overBaseline - overPlain.fromBottom) <= 0.5)

        let inline = MathRenderer.inlineAttachment(latex: #"x = \underbrace{a+b}_{n} + c"#, fontSize: 19.2)
        let attachment = try #require(inline.attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment)
        let baseline = try #require(attachment.image?.baselineOffsetFromBottom)
        #expect(attachment.bounds.origin.y == -baseline)
    }

    @Test func brokenLatexStillFallsBack() {
        #expect(render(#"\underbrace{a"#) == nil)
    }
}
