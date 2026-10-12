import SwiftUI

extension Color {
    static let enveOrange = Color(red: 245 / 255, green: 146 / 255, blue: 26 / 255)

    init(hex: String) {
        let value = UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0xF5921A
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }

    /// `#RRGGBB` in sRGB, the form the server stores profile colors in.
    var hexString: String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0
        _ = UIColor(self).getRed(&red, green: &green, blue: &blue, alpha: nil)
        let channel = { (value: CGFloat) in Int((min(max(value, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", channel(red), channel(green), channel(blue))
    }
}

private struct EnveAccentKey: EnvironmentKey {
    static let defaultValue = Color.enveOrange
}

extension EnvironmentValues {
    var enveAccent: Color {
        get { self[EnveAccentKey.self] }
        set { self[EnveAccentKey.self] = newValue }
    }
}
