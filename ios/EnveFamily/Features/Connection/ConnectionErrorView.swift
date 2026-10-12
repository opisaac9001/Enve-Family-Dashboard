import SwiftUI

struct ConnectionErrorView: View {
    @Environment(AppModel.self) private var model
    let message: String

    var body: some View {
        ContentUnavailableView {
            Label("Can't Connect", systemImage: "wifi.exclamationmark")
        } description: {
            Text(message)
        } actions: {
            Button("Try Again") { Task { await model.retry() } }
                .buttonStyle(.borderedProminent)
            Button("Change Server") { model.changeServer() }
        }
    }
}
