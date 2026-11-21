import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Every image ImageIO reads (camera JPEG, HEIC, ProRAW DNG, ...) goes up as an upright PNG within
/// `maxBytes` and `maxPixels`, so the retrieval server never decodes a camera original on its small
/// VM. A PNG already within both (a screenshot) goes up as it is. Mirrors the web's
/// `imageDownscale.ts`. ImageIO decodes straight to the target size, so the full-resolution pixels
/// are never held in memory.
nonisolated enum ImageDownscale {
    static let maxBytes = 5 * 1024 * 1024
    /// The retrieval server refuses a decode that doesn't fit in the memory free at that moment,
    /// which on its 1 GB VM can be under 40 MB: a 12 MP phone photo costs ~90 MB there, a 5 MP PNG
    /// ~30 MB. 5 MP is about what Anthropic's high-resolution tier (2576 px long edge) uses anyway.
    static let maxPixels = 5_000_000.0
    /// Anthropic rejects an image with an edge above 8000 px.
    private static let maxEdge = 8000.0
    /// PNG size of a downscaled photo per pixel, for the first guess at the output size.
    private static let pngBytesPerPixel = 2.5
    /// Each retry undershoots the measured ratio a little so it lands under the limit.
    private static let retryMargin = 0.95
    /// A PNG under this share of the limit is retried larger, for the detail the limit allows.
    private static let fillTarget = 0.8
    private static let maxAttempts = 5

    /// The PNG to upload in place of `data`, or nil when `data` is an upright PNG within both limits
    /// already or isn't an image ImageIO reads (it then goes up as-is, for the backend to convert).
    static func png(from data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
              width > 0, height > 0
        else { return nil }

        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        if CGImageSourceGetType(source) as String? == UTType.png.identifier,
           data.count <= maxBytes, width * height <= maxPixels, orientation == 1 {
            return nil
        }

        let longEdge = max(width, height)
        let edgeCap = min(longEdge, maxEdge, longEdge * (maxPixels / (width * height)).squareRoot())
        var edge = min(edgeCap, longEdge * (Double(maxBytes) / (width * height * pngBytesPerPixel)).squareRoot())
        var best: Data?
        for _ in 0..<maxAttempts {
            guard let png = encodePNG(source, longEdge: max(1, Int(edge))) else { return best }
            if png.count <= maxBytes {
                best = png
                if edge >= edgeCap || Double(png.count) >= Double(maxBytes) * fillTarget { return png }
            } else if best != nil {
                return best
            }
            edge = min(edgeCap, edge * (Double(maxBytes) / Double(png.count)).squareRoot() * retryMargin)
        }
        return best
    }

    static func pngName(_ fileName: String) -> String {
        let base = (fileName as NSString).deletingPathExtension
        return "\(base.isEmpty ? "image" : base).png"
    }

    /// EXIF orientation is applied to the pixels; the PNG carries no metadata.
    private static func encodePNG(_ source: CGImageSource, longEdge: Int) -> Data? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: longEdge,
            kCGImageSourceShouldCacheImmediately: true
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? output as Data : nil
    }
}
