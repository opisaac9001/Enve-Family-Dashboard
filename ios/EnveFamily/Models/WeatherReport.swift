import Foundation

struct WeatherReport: Hashable, Sendable {
    let temperature: Double?
    let summary: String?
    let high: Double?
    let low: Double?
    let location: String?
    let unitSymbol: String

    init?(_ json: JSONValue) {
        let root = json["weather"] ?? json
        temperature = root.first("temperature", "temp", "current.temperature", "current.temp", "current.temperature_2m")?.number
        summary = root.first("summary", "description", "condition", "label", "current.summary", "current.description")?.string
        high = root.first("high", "max", "daily.high", "daily.max", "today.high")?.number
        low = root.first("low", "min", "daily.low", "daily.min", "today.low")?.number
        location = root.first("location", "city", "name")?.string ?? json.first("location", "city")?.string
        guard temperature != nil || summary != nil else { return nil }
        let unit = (root.first("units", "unit") ?? json.first("units", "unit"))?.string?.lowercased() ?? ""
        unitSymbol = switch unit {
        case "c", "celsius", "metric", "°c": "°C"
        case "f", "fahrenheit", "imperial", "°f": "°F"
        default: "°"
        }
    }

    func format(_ value: Double) -> String {
        "\(Int(value.rounded()))\(unitSymbol)"
    }
}
