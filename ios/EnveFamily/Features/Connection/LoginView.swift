import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var username = ""
    @State private var password = ""
    @State private var errorMessage: String?
    @State private var isSigningIn = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Sign-in name (optional for shared sign-in)", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .onSubmit(signIn)
                } header: {
                    Text("Household Sign-In")
                } footer: {
                    Text(errorMessage ?? "Use the password chosen during setup. If adults have individual sign-ins, enter your sign-in name too. Saved securely on this phone.")
                        .foregroundStyle(errorMessage == nil ? Color.secondary : Color.red)
                }

                Section {
                    Button(action: signIn) {
                        if isSigningIn { ProgressView() } else { Text("Sign In") }
                    }
                    .disabled(password.isEmpty || isSigningIn)
                    Button("Change Server") { model.changeServer() }
                }
            }
            .navigationTitle("Sign In")
        }
    }

    private func signIn() {
        guard !password.isEmpty, !isSigningIn else { return }
        isSigningIn = true
        errorMessage = nil
        Task {
            do {
                try await model.signIn(username: username.isEmpty ? nil : username, password: password)
            } catch {
                errorMessage = error.localizedDescription
            }
            isSigningIn = false
        }
    }
}
