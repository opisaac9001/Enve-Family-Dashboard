import SwiftUI

struct ServerSetupView: View {
    @Environment(AppModel.self) private var model
    @State private var address = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(AppModel.defaultServer, text: $address)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(connect)
                } header: {
                    Text("Server Address")
                } footer: {
                    Text("The simulator reaches a server on this Mac at \(AppModel.defaultServer). On a phone, use the Enve device's network address (for example http://192.168.1.20:4317). Complete first-run setup on the device before signing in here.")
                }

                Section {
                    Button("Connect", action: connect)
                        .disabled(AppModel.serverURL(from: address) == nil)
                }
            }
            .navigationTitle("Enve Family")
            .onAppear { address = model.serverAddress }
        }
    }

    private func connect() {
        Task { await model.connect(to: address) }
    }
}
