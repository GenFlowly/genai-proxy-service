import Testing
import Foundation
import ImageIO
import UniformTypeIdentifiers
@testable import AI_Wrapper

struct ImageDownscaleTests {
    /// Random pixels: the worst case for PNG, so the first size guess is too big.
    private func noise(width: Int, height: Int, as type: UTType, orientation: Int? = nil) throws -> Data {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        pixels.withUnsafeMutableBytes { arc4random_buf($0.baseAddress, $0.count) }
        let context = try #require(CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        let image = try #require(context.makeImage())
        let output = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(output, type.identifier as CFString, 1, nil))
        var properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 1.0]
        if let orientation { properties[kCGImagePropertyOrientation] = orientation }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return output as Data
    }

    private func info(_ data: Data) throws -> (type: String, width: Int, height: Int) {
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        return (
            CGImageSourceGetType(source) as String? ?? "",
            try #require(properties[kCGImagePropertyPixelWidth] as? Int),
            try #require(properties[kCGImagePropertyPixelHeight] as? Int)
        )
    }

    @Test func aLargePhotoBecomesAPNGUnderTheLimitWithItsAspectRatio() throws {
        let original = try noise(width: 3000, height: 2000, as: .png)
        #expect(original.count > ImageDownscale.maxBytes)

        let png = try #require(ImageDownscale.png(from: original))
        #expect(png.count <= ImageDownscale.maxBytes)
        let out = try info(png)
        #expect(out.type == UTType.png.identifier)
        #expect(out.width < 3000)
        #expect(abs(Double(out.width) / Double(out.height) - 1.5) < 0.01)
    }

    @Test func exifOrientationIsAppliedToThePixels() throws {
        let original = try noise(width: 3000, height: 2000, as: .jpeg, orientation: 6)
        #expect(original.count > ImageDownscale.maxBytes)

        let out = try info(try #require(ImageDownscale.png(from: original)))
        #expect(out.height > out.width)
    }

    @Test func anImageWithinTheLimitIsLeftAlone() throws {
        let small = try noise(width: 400, height: 300, as: .png)
        #expect(ImageDownscale.png(from: small) == nil)
    }

    @Test func bytesImageIOCannotReadAreLeftForTheBackend() {
        let junk = Data(repeating: 0x42, count: ImageDownscale.maxBytes + 1)
        #expect(ImageDownscale.png(from: junk) == nil)
    }

    @Test func theNameKeepsItsBaseAndTakesAPNGExtension() {
        #expect(ImageDownscale.pngName("IMG_0001.HEIC") == "IMG_0001.png")
        #expect(ImageDownscale.pngName("image.jpg") == "image.png")
        #expect(ImageDownscale.pngName("") == "image.png")
    }
}
