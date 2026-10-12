import SwiftUI

struct PinUnlockView: View {
    @Environment(AppModel.self) private var model
    @State private var pin = ""
    @State private var isSubmitting = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("PIN", text: $pin)
                        .keyboardType(.numberPad)
                } footer: {
                    Text(model.pinError ?? "Edits are protected by the household PIN. Unlocking lasts 15 minutes.")
                        .foregroundStyle(model.pinError == nil ? Color.secondary : Color.red)
                }
            }
            .navigationTitle("Unlock Edits")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.cancelPinPrompt() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Unlock") {
                        isSubmitting = true
                        Task {
                            await model.submitPin(pin)
                            isSubmitting = false
                        }
                    }
                    .disabled(pin.count < 4 || isSubmitting)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

private struct PinPromptHost: ViewModifier {
    @Environment(AppModel.self) private var model
    let level: Int

    func body(content: Content) -> some View {
        content
            .onAppear { if level > 0 { model.sheetDepth += 1 } }
            .onDisappear { if level > 0 { model.sheetDepth -= 1 } }
            .sheet(isPresented: Binding(
                get: { model.isPinPromptPresented && model.sheetDepth == level },
                set: { if !$0 { model.cancelPinPrompt() } }
            )) {
                PinUnlockView()
            }
    }
}

extension View {
    /// Presents the edit-PIN prompt from this view when it is the topmost presentation level (0 = tabs, 1 = a sheet).
    func pinPromptHost(level: Int) -> some View {
        modifier(PinPromptHost(level: level))
    }
}
