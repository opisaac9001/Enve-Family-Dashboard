import SwiftUI
import UIKit

/// Share extensions can't open their containing app, so this saves the items and tells the person to open Enve Family.
final class ShareViewController: UIViewController {
    private let status = ShareStatus()

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareStatusView(status: status) { [weak self] in self?.finish() })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        Task {
            let outcome = await ShareItemLoader().save(items)
            status.phase = outcome.saved > 0 ? .saved(outcome.saved, outcome.problems) : .failed(outcome.problems)
        }
    }

    private func finish() {
        if case .saved = status.phase {
            extensionContext?.completeRequest(returningItems: nil)
        } else {
            extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
        }
    }
}

@MainActor
@Observable
final class ShareStatus {
    enum Phase {
        case saving
        case saved(Int, [String])
        case failed([String])
    }

    var phase = Phase.saving
}

private struct ShareStatusView: View {
    let status: ShareStatus
    let onDone: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    switch status.phase {
                    case .saving:
                        ProgressView("Saving for Enve Family…")
                            .padding(.top, 40)
                    case .saved(let count, let problems):
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(Color.enveOrange)
                            .accessibilityHidden(true)
                        Text(count == 1 ? "Saved for Enve Family" : "\(count) Items Saved for Enve Family")
                            .font(.title3.bold())
                        Text("Open Enve Family to find drafts and review them. Nothing is added to your calendar, tasks, lists, or recipes until you save it there.")
                        problemList(problems)
                    case .failed(let problems):
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(.orange)
                            .accessibilityHidden(true)
                        Text("Couldn't Save").font(.title3.bold())
                        problemList(problems)
                    }
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(24)
            }
            .navigationTitle("Enve Family")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onDone)
                        .disabled(isSaving)
                }
            }
        }
        .tint(.enveOrange)
    }

    private var isSaving: Bool {
        if case .saving = status.phase { true } else { false }
    }

    private func problemList(_ problems: [String]) -> some View {
        ForEach(Array(problems.enumerated()), id: \.offset) { _, problem in
            Text(problem).font(.callout).foregroundStyle(.secondary)
        }
    }
}
