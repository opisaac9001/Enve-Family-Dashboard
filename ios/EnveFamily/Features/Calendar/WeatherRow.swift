import SwiftUI

struct WeatherRow: View {
    let report: WeatherReport

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "cloud.sun")
                .symbolRenderingMode(.multicolor)
                .font(.title2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if let temperature = report.temperature {
                        Text(report.format(temperature)).font(.title3.weight(.semibold))
                    }
                    if let summary = report.summary { Text(summary) }
                }
                if let detail {
                    Text(detail).font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var detail: String? {
        var parts: [String] = []
        if let high = report.high, let low = report.low { parts.append("H \(report.format(high))  L \(report.format(low))") }
        if let location = report.location { parts.append(location) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
