import Foundation

enum APIError: LocalizedError {
    case unreachable(URLError)
    case unauthorized(String)
    case locked
    case server(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .unreachable(let error) where error.code == .timedOut:
            "The server took too long to respond. Check that Enve Family is running, then try again."
        case .unreachable(let error):
            "Couldn't reach the Enve Family server (\(error.localizedDescription)). Check the address and that this phone can reach it."
        case .unauthorized(let message), .server(let message):
            message
        case .locked:
            "Edits are locked. Enter the household edit PIN to continue."
        case .invalidResponse:
            "The server's response wasn't recognized. Check that the address points to Enve Family."
        }
    }

    /// True only when the connection failed before the request could reach the server, so sending it later can't duplicate it.
    var requestWasNotSent: Bool {
        guard case .unreachable(let error) = self else { return false }
        let notSent: Set<URLError.Code> = [
            .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
            .dataNotAllowed, .internationalRoamingOff, .callIsActive,
        ]
        return notSent.contains(error.code)
    }
}
