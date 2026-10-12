import Foundation

enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case patch = "PATCH"
    case delete = "DELETE"
}

enum ChangeSignal: Sendable {
    case connected
    case refresh
}

actor APIClient {
    let baseURL: URL
    private let session: URLSession
    // The server's session and PIN cookies are SameSite=Strict, so they are carried by hand rather than via HTTPCookieStorage.
    private var cookies: [String: String] = [:]

    init(baseURL: URL) {
        self.baseURL = baseURL
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration)
    }

    func request<Response: Decodable & Sendable>(
        _ method: HTTPMethod = .get,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable & Sendable)? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> Response {
        let data = try await perform(method, path, query: query, body: try body.map { try JSONEncoder().encode($0) }, timeout: timeout)
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw APIError.invalidResponse
        }
    }

    func send(_ method: HTTPMethod, _ path: String, query: [URLQueryItem] = [], body: (any Encodable & Sendable)? = nil) async throws {
        _ = try await perform(method, path, query: query, body: try body.map { try JSONEncoder().encode($0) })
    }

    /// Sends an already-encoded JSON document as the request body.
    func send(_ method: HTTPMethod, _ path: String, json: Data, timeout: TimeInterval? = nil) async throws {
        _ = try await perform(method, path, query: [], body: json, timeout: timeout)
    }

    func data(_ path: String, query: [URLQueryItem] = [], timeout: TimeInterval? = nil) async throws -> Data {
        try await perform(.get, path, query: query, body: nil, timeout: timeout)
    }

    func streamChanges(_ onSignal: @Sendable (ChangeSignal) async -> Void) async throws {
        // The server sends a keepalive every 25 seconds; allow for one to arrive late.
        var request = try makeRequest(.get, "/api/changes", query: [], body: nil, timeout: 70)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
            storeCookies(from: http)
            try validate(http, data: Data())
            await onSignal(.connected)
            for try await line in bytes.lines where line == "data: refresh" {
                await onSignal(.refresh)
            }
        } catch let error as URLError {
            throw APIError.unreachable(error)
        }
    }

    func clearSession() {
        cookies.removeAll()
    }

    static func pathComponent(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private func perform(_ method: HTTPMethod, _ path: String, query: [URLQueryItem], body: Data?,
                         timeout: TimeInterval? = nil) async throws -> Data {
        let request = try makeRequest(method, path, query: query, body: body, timeout: timeout)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw APIError.unreachable(error)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        storeCookies(from: http)
        try validate(http, data: data)
        return data
    }

    private func makeRequest(_ method: HTTPMethod, _ path: String, query: [URLQueryItem], body: Data?,
                             timeout: TimeInterval?) throws -> URLRequest {
        var request = URLRequest(url: url(for: path, query: query))
        request.httpMethod = method.rawValue
        if let timeout { request.timeoutInterval = timeout }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if !cookies.isEmpty {
            request.setValue(cookies.map { "\($0.key)=\($0.value)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie")
        }
        return request
    }

    private func validate(_ response: HTTPURLResponse, data: Data) throws {
        switch response.statusCode {
        case 200..<300:
            return
        case 401:
            throw APIError.unauthorized(message(in: data) ?? "Sign in to continue.")
        case 423:
            throw APIError.locked
        default:
            throw APIError.server(message(in: data) ?? "The server returned status \(response.statusCode).")
        }
    }

    private func url(for path: String, query: [URLQueryItem]) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.percentEncodedPath += path
        components.queryItems = query.isEmpty ? nil : query
        return components.url!
    }

    private func storeCookies(from response: HTTPURLResponse) {
        guard let url = response.url, let header = response.value(forHTTPHeaderField: "Set-Cookie") else { return }
        for cookie in HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: url) {
            cookies[cookie.name] = cookie.value.isEmpty ? nil : cookie.value
        }
    }

    private func message(in data: Data) -> String? {
        struct ErrorBody: Decodable { let error: String }
        return try? JSONDecoder().decode(ErrorBody.self, from: data).error
    }
}
