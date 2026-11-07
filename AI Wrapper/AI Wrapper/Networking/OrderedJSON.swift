import Foundation

/// A JSON value that keeps object key order. JSONDecoder and JSONSerialization both
/// lose it, and the thinking box prints tool-call arguments in the order the model
/// wrote them (`web_search(days=30, query="…", topic="general")`).
indirect enum JSONValue {
    case null
    case bool(Bool)
    case number(String)
    case string(String)
    case array([JSONValue])
    case object([(String, JSONValue)])

    subscript(key: String) -> JSONValue? {
        if case .object(let pairs) = self { return pairs.first { $0.0 == key }?.1 }
        return nil
    }

    var string: String? { if case .string(let s) = self { return s }; return nil }
    var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    var pairs: [(String, JSONValue)]? { if case .object(let p) = self { return p }; return nil }
    var isNull: Bool { if case .null = self { return true }; return false }

    var int: Int? {
        if case .number(let n) = self { return Int(n) ?? Double(n).map { Int($0) } }
        return nil
    }

    var double: Double? {
        if case .number(let n) = self { return Double(n) }
        return nil
    }

    var boolean: Bool? { if case .bool(let b) = self { return b }; return nil }

    /// `JSON.stringify` output (compact, key order preserved).
    var jsonString: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return n
        case .string(let s): return Self.quote(s)
        case .array(let items): return "[" + items.map(\.jsonString).joined(separator: ",") + "]"
        case .object(let pairs):
            return "{" + pairs.map { Self.quote($0.0) + ":" + $0.1.jsonString }.joined(separator: ",") + "}"
        }
    }

    private static func quote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    static func parse(_ data: Data) -> JSONValue? {
        var parser = Parser(bytes: [UInt8](data))
        return parser.parseValue()
    }

    static func parse(_ text: String) -> JSONValue? {
        parse(Data(text.utf8))
    }

    private struct Parser {
        let bytes: [UInt8]
        var i = 0

        init(bytes: [UInt8]) { self.bytes = bytes }

        mutating func skipWhitespace() {
            while i < bytes.count, bytes[i] == 0x20 || bytes[i] == 0x0A || bytes[i] == 0x0D || bytes[i] == 0x09 { i += 1 }
        }

        mutating func parseValue() -> JSONValue? {
            skipWhitespace()
            guard i < bytes.count else { return nil }
            switch bytes[i] {
            case UInt8(ascii: "{"): return parseObject()
            case UInt8(ascii: "["): return parseArray()
            case UInt8(ascii: "\""): return parseString().map { .string($0) }
            case UInt8(ascii: "t"): return consume("true") ? .bool(true) : nil
            case UInt8(ascii: "f"): return consume("false") ? .bool(false) : nil
            case UInt8(ascii: "n"): return consume("null") ? .null : nil
            default: return parseNumber()
            }
        }

        mutating func consume(_ word: String) -> Bool {
            let w = Array(word.utf8)
            guard i + w.count <= bytes.count, Array(bytes[i..<(i + w.count)]) == w else { return false }
            i += w.count
            return true
        }

        mutating func parseObject() -> JSONValue? {
            i += 1
            var pairs: [(String, JSONValue)] = []
            skipWhitespace()
            if i < bytes.count, bytes[i] == UInt8(ascii: "}") { i += 1; return .object(pairs) }
            while i < bytes.count {
                skipWhitespace()
                guard i < bytes.count, bytes[i] == UInt8(ascii: "\""), let key = parseString() else { return nil }
                skipWhitespace()
                guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { return nil }
                i += 1
                guard let value = parseValue() else { return nil }
                pairs.append((key, value))
                skipWhitespace()
                guard i < bytes.count else { return nil }
                if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(pairs) }
                return nil
            }
            return nil
        }

        mutating func parseArray() -> JSONValue? {
            i += 1
            var items: [JSONValue] = []
            skipWhitespace()
            if i < bytes.count, bytes[i] == UInt8(ascii: "]") { i += 1; return .array(items) }
            while i < bytes.count {
                guard let value = parseValue() else { return nil }
                items.append(value)
                skipWhitespace()
                guard i < bytes.count else { return nil }
                if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(items) }
                return nil
            }
            return nil
        }

        mutating func parseString() -> String? {
            i += 1
            var out: [UInt8] = []
            while i < bytes.count {
                let c = bytes[i]
                if c == UInt8(ascii: "\"") {
                    i += 1
                    return String(decoding: out, as: UTF8.self)
                }
                if c == UInt8(ascii: "\\") {
                    i += 1
                    guard i < bytes.count else { return nil }
                    let e = bytes[i]
                    i += 1
                    switch e {
                    case UInt8(ascii: "n"): out.append(0x0A)
                    case UInt8(ascii: "r"): out.append(0x0D)
                    case UInt8(ascii: "t"): out.append(0x09)
                    case UInt8(ascii: "b"): out.append(0x08)
                    case UInt8(ascii: "f"): out.append(0x0C)
                    case UInt8(ascii: "u"):
                        guard var scalar = hex4() else { return nil }
                        if (0xD800..<0xDC00).contains(scalar), i + 1 < bytes.count, bytes[i] == UInt8(ascii: "\\"), bytes[i + 1] == UInt8(ascii: "u") {
                            i += 2
                            guard let low = hex4() else { return nil }
                            scalar = 0x10000 + ((scalar - 0xD800) << 10) + (low - 0xDC00)
                        }
                        if let u = Unicode.Scalar(scalar) { out.append(contentsOf: Array(String(Character(u)).utf8)) }
                    default: out.append(e)
                    }
                    continue
                }
                out.append(c)
                i += 1
            }
            return nil
        }

        mutating func hex4() -> UInt32? {
            guard i + 4 <= bytes.count, let value = UInt32(String(decoding: bytes[i..<(i + 4)], as: UTF8.self), radix: 16) else { return nil }
            i += 4
            return value
        }

        mutating func parseNumber() -> JSONValue? {
            let start = i
            while i < bytes.count, "+-0123456789.eE".utf8.contains(bytes[i]) { i += 1 }
            guard i > start else { return nil }
            return .number(String(decoding: bytes[start..<i], as: UTF8.self))
        }
    }
}

extension JSONValue: Encodable {
    private struct DynamicKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .null:
            var container = encoder.singleValueContainer()
            try container.encodeNil()
        case .bool(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .number(let text):
            var container = encoder.singleValueContainer()
            if let int = Int(text) {
                try container.encode(int)
            } else {
                try container.encode(Double(text) ?? 0)
            }
        case .string(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .array(let items):
            var container = encoder.unkeyedContainer()
            for item in items { try container.encode(item) }
        case .object(let pairs):
            var container = encoder.container(keyedBy: DynamicKey.self)
            for (key, value) in pairs { try container.encode(value, forKey: DynamicKey(stringValue: key)) }
        }
    }
}
