import Foundation

/// Which files can be attached, decided before uploading so a file the backend can't use
/// doesn't fail a whole message. Mirrors the library's `attachmentFormat.ts`.
enum AttachmentFormat {
    enum Verdict { case supported, unsupported }

    /// For the unsupported-format message.
    static let supportedNames = [
        "JPEG", "PNG", "GIF", "WebP", "HEIC/HEIF", "AVIF", "TIFF", "BMP", "PSD", "JPEG 2000", "TGA", "PPM", "QOI",
        "camera RAW (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW, X3F, …)"
    ]

    /// Extensions of the formats above, for files whose bytes aren't recognised.
    private static let supportedExtensions = [
        ".jpg", ".jpeg", ".jpe", ".jfif", ".png", ".apng", ".gif", ".webp", ".heic", ".heif", ".avif",
        ".tif", ".tiff", ".bmp", ".dib", ".psd", ".jp2", ".j2k", ".jpf", ".jpx", ".tga", ".ppm", ".pgm",
        ".pbm", ".pnm", ".qoi", ".dng", ".cr2", ".cr3", ".crw", ".nef", ".nrw", ".arw", ".srf", ".sr2",
        ".raf", ".orf", ".rw2", ".rwl", ".pef", ".srw", ".erf", ".x3f", ".3fr", ".fff", ".iiq", ".mrw", ".kdc"
    ]

    /// image/* types the backend can't use.
    private static let unsupportedTypes: Set<String> = [
        "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon", "image/icns", "image/x-icns", "image/jxl",
        "image/x-xcf", "image/x-exr", "image/vnd.radiance", "image/x-eps", "image/vnd.adobe.photoshop.large",
        "image/vnd.ms-photo", "image/jxr", "image/x-emf", "image/emf", "image/x-wmf", "image/wmf", "image/x-pcx",
        "image/vnd.zbrush.pcx", "image/sgi", "image/x-sgi", "image/x-xbitmap", "image/x-xpixmap", "image/x-pict",
        "image/x-portable-arbitrarymap", "image/x-cmu-raster", "image/x-sun-raster", "image/vnd.wap.wbmp", "image/x-jng"
    ]

    /// ISO-BMFF brands (bytes 8-11): HEIF/HEIC, AVIF, Canon CR3.
    private static let imageBrands: Set<String> = [
        "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "avif", "avis", "crx "
    ]

    /// ISO-BMFF brands of videos and audio, Live Photo movies among them.
    private static let mediaBrands: Set<String> = [
        "qt  ", "isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "mp4v", "M4V ", "M4A ", "M4B ",
        "f4v ", "3gp4", "3gp5", "3gp6", "3g2a", "avc1", "dash"
    ]

    private static let supportedSignatures: [[UInt8]] = [
        [0xFF, 0xD8, 0xFF],
        [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
        ascii("GIF87a"), ascii("GIF89a"),
        ascii("II*\0"), ascii("MM\0*"), ascii("II+\0"), ascii("MM\0+"),
        ascii("IIRO"), ascii("IIRS"), ascii("MMOR"), ascii("IIU\0"),
        ascii("FUJIFILMCCD-RAW"), ascii("FOVb"), ascii("\0MRM"), ascii("IIII"), ascii("MMMM"), ascii("qoif"),
        [0x00, 0x00, 0x00, 0x0C, 0x6A, 0x50, 0x20, 0x20, 0x0D, 0x0A, 0x87, 0x0A],
        [0xFF, 0x4F, 0xFF, 0x51]
    ]

    private static let unsupportedSignatures: [[UInt8]] = [
        ascii("%PDF"), ascii("%!PS"), [0xC5, 0xD0, 0xD3, 0xC6], ascii("icns"), ascii("DDS "), ascii("SIMPLE  ="),
        ascii("BLP1"), ascii("BLP2"), ascii("gimp xcf"), [0xFF, 0x0A],
        [0x00, 0x00, 0x00, 0x0C, 0x4A, 0x58, 0x4C, 0x20], [0x76, 0x2F, 0x31, 0x01],
        ascii("#?RADIANCE"), ascii("#?RGBE"), ascii("PK\u{03}\u{04}"), [0x1A, 0x45, 0xDF, 0xA3], ascii("OggS"), ascii("ID3"),
        [0x1F, 0x8B], ascii("Rar!"), [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C], ascii("II\u{BC}"), [0xD7, 0xCD, 0xC6, 0x9A],
        [0x01, 0xDA], [0x59, 0xA6, 0x6A, 0x95], ascii("\u{8A}MNG"), ascii("\u{8B}JNG"), ascii("P7\n"), ascii("/* XPM */"), ascii("#define")
    ]

    private static let headLength = 512
    private static let whitespace: Set<UInt8> = [0x20, 0x09, 0x0D, 0x0A]

    private static func ascii(_ text: String) -> [UInt8] {
        text.unicodeScalars.map { UInt8($0.value) }
    }

    private static func starts(_ bytes: [UInt8], with prefix: [UInt8], at offset: Int = 0) -> Bool {
        bytes.count >= offset + prefix.count && bytes[offset..<(offset + prefix.count)].elementsEqual(prefix)
    }

    private static func text(_ bytes: [UInt8], _ start: Int, _ end: Int) -> String {
        guard start < bytes.count else { return "" }
        return String(bytes[start..<min(end, bytes.count)].map { Character(UnicodeScalar($0)) })
    }

    /// The verdict from a file's first bytes, or nil when they match no known format.
    static func sniff(_ bytes: [UInt8]) -> Verdict? {
        func byte(_ index: Int) -> Int { index < bytes.count ? Int(bytes[index]) : 0 }

        // Text formats (SVG, HTML, XML, ...) may start with a BOM or whitespace.
        var start = starts(bytes, with: [0xEF, 0xBB, 0xBF]) ? 3 : 0
        while start < bytes.count, whitespace.contains(bytes[start]) { start += 1 }
        // "<" then a letter, "?" or "!": a binary "<", such as a TGA with a 60-byte ID field, is not markup.
        if start < bytes.count, bytes[start] == 0x3C {
            let next = byte(start + 1)
            let isLetter = (0x41...0x5A).contains(next) || (0x61...0x7A).contains(next)
            if isLetter || next == 0x3F || next == 0x21 { return .unsupported }
        }
        if starts(bytes, with: ascii("%PDF"), at: start) { return .unsupported }

        if supportedSignatures.contains(where: { starts(bytes, with: $0) }) { return .supported }
        if unsupportedSignatures.contains(where: { starts(bytes, with: $0) }) { return .unsupported }

        // ICO / CUR: an image count of at least 1 follows. An uncompressed TGA starts
        // 00 00 02 00 too, with 00 00 next.
        if starts(bytes, with: [0, 0, 1, 0]) || starts(bytes, with: [0, 0, 2, 0]), byte(4) | (byte(5) << 8) > 0 {
            return .unsupported
        }
        if starts(bytes, with: [1, 0, 0, 0]), starts(bytes, with: ascii(" EMF"), at: 40) { return .unsupported }
        if starts(bytes, with: ascii("II")) || starts(bytes, with: ascii("MM")), starts(bytes, with: ascii("HEAPCCDR"), at: 6) {
            return .supported
        }
        if starts(bytes, with: ascii("RIFF")) {
            let form = text(bytes, 8, 12)
            if form == "WEBP" { return .supported }
            if form == "AVI " || form == "WAVE" { return .unsupported }
        }
        // Photoshop: version 1 is PSD; version 2 (PSB, "large document") isn't read.
        if starts(bytes, with: ascii("8BPS")) { return byte(5) == 1 ? .supported : .unsupported }
        // BMP: "BM", then a DIB header whose size is one of the known versions.
        if starts(bytes, with: ascii("BM")),
           [12, 40, 52, 56, 64, 108, 124].contains(byte(14) | (byte(15) << 8)), byte(16) == 0, byte(17) == 0 {
            return .supported
        }
        // Netpbm (P1-P6) or grayscale PFM ("Pf"; colour "PF" isn't read), followed by whitespace.
        if byte(0) == 0x50, (0x31...0x36).contains(byte(1)) || byte(1) == 0x66, bytes.count > 2, whitespace.contains(bytes[2]) {
            return .supported
        }
        if text(bytes, 4, 8) == "ftyp" {
            let brand = text(bytes, 8, 12)
            if imageBrands.contains(brand) { return .supported }
            if mediaBrands.contains(brand) { return .unsupported }
        }
        return nil
    }

    /// The verdict from a file's declared type and name alone.
    static func fromTypeAndName(type: String, fileName: String) -> Verdict {
        let mediaType = (type.split(separator: ";", omittingEmptySubsequences: false).first.map(String.init) ?? "")
            .trimmingCharacters(in: .whitespaces)
            .lowercased()
        if unsupportedTypes.contains(mediaType) { return .unsupported }
        if mediaType.hasPrefix("image/") { return .supported }
        let name = fileName.lowercased()
        return supportedExtensions.contains { name.hasSuffix($0) } ? .supported : .unsupported
    }

    /// From the first bytes when they're recognisable, whatever the name or declared type.
    static func check(_ data: Data, type: String, fileName: String) -> Verdict {
        guard !data.isEmpty else { return .unsupported }
        return sniff([UInt8](data.prefix(headLength))) ?? fromTypeAndName(type: type, fileName: fileName)
    }

    /// The PDF type, or a blank or generic type with a .pdf name.
    static func isPDF(type: String, fileName: String) -> Bool {
        if type == AttachmentRef.pdfMediaType { return true }
        guard type.isEmpty || type == AttachmentRef.unknownMediaType else { return false }
        return fileName.lowercased().hasSuffix(".pdf")
    }
}

/// A file on its way into the composer, before the checks below decide if it's attached.
struct PickedAttachment {
    var data: Data
    var fileName: String
    var mediaType: String

    var isPDF: Bool { AttachmentFormat.isPDF(type: mediaType, fileName: fileName) }
}

/// What to attach from one pick, and what to tell the user about the rest. Mirrors the
/// library's `useAttachmentValidation` and `addAttachments`.
struct AttachmentIntake {
    var accepted: [PickedAttachment] = []
    var rejectedNames: [String] = []
    var pdfTooLarge = false
    var pdfLimitReached = false
    var limitReached = false

    init(_ files: [PickedAttachment], pendingCount: Int, pendingPDFs: Int) {
        var supported: [PickedAttachment] = []
        for file in files {
            if file.isPDF {
                if file.data.count > AttachmentRef.maxPDFBytes {
                    pdfTooLarge = true
                } else {
                    supported.append(file)
                }
            } else if AttachmentFormat.check(file.data, type: file.mediaType, fileName: file.fileName) == .supported {
                supported.append(file)
            } else {
                rejectedNames.append(file.fileName)
            }
        }
        var pdfBudget = AttachmentRef.maxPDFsPerMessage - pendingPDFs
        let withinPDFLimit = supported.filter { file in
            guard file.isPDF else { return true }
            guard pdfBudget > 0 else {
                pdfLimitReached = true
                return false
            }
            pdfBudget -= 1
            return true
        }
        let free = max(0, AttachmentRef.maxPerMessage - pendingCount)
        limitReached = withinPDFLimit.count > free
        accepted = Array(withinPDFLimit.prefix(free))
    }
}
