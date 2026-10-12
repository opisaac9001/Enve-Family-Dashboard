import SwiftUI

struct ProfileFilterBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.state?.profiles ?? []) { profile in
                    let visible = model.isVisible(profileId: profile.id)
                    Button {
                        if visible { model.hiddenProfiles.insert(profile.id) } else { model.hiddenProfiles.remove(profile.id) }
                    } label: {
                        HStack(spacing: 6) {
                            Circle().fill(Color(hex: profile.color)).frame(width: 8, height: 8)
                            Text(profile.name).font(.subheadline.weight(.medium))
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(visible ? Color(hex: profile.color).opacity(0.2) : Color.clear, in: Capsule())
                        .overlay(Capsule().strokeBorder(Color(hex: profile.color).opacity(visible ? 0 : 0.6)))
                        .foregroundStyle(visible ? Color.primary : Color.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(visible ? .isSelected : [])
                }
            }
        }
    }
}

struct ProfilePicker: View {
    @Environment(AppModel.self) private var model
    @Binding var selection: String

    var body: some View {
        Picker("Person", selection: $selection) {
            ForEach(model.state?.profiles ?? []) { profile in
                Text(profile.name).tag(profile.id)
            }
        }
    }
}

struct ProfileLabel: View {
    let profile: Profile?

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Color(hex: profile?.color ?? "#F5921A")).frame(width: 8, height: 8)
            Text(profile?.name ?? "Unknown")
        }
    }
}
