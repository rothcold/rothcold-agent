import SwiftUI

struct SettingsView<ChangeServer: View>: View {
    let workspace: Workspace
    let palette: Palette
    let changeServer: ChangeServer
    @AppStorage("appearance") private var appearance = "System"
    @State private var edit: EditName?
    @State private var picking = false
    @State private var avatarRole = Workspace.IdentityRole.owner
    @State private var revoke: Device?
    @State private var signingOut = false

    var body: some View {
        WorkspaceHeading("Settings", palette: palette)
        if let selection = workspace.selection {
            Label(selection.address, systemImage: "checkmark.shield")
                .font(.callout.monospaced()).foregroundStyle(palette.secondary)
        }
        WorkspaceCard(palette: palette) {
            Picker("Appearance", selection: $appearance) {
                ForEach(["System", "Light", "Dark"], id: \.self) { Text($0) }
            }
        }
        accountSection
        deviceSection
        changeServer
    }

    private var accountSection: some View {
        Group {
            if let profile = workspace.profile {
                identityCard(.owner, profile.owner)
                identityCard(.agent, profile.agent)
                backendActions
            }
        }
        .editName($edit)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.image]) { result in
            switch result {
            case .success(let file): Task { await workspace.updateAvatar(avatarRole, url: file) }
            case .failure(let error): workspace.report(error)
            }
        }
        .disabled(workspace.busy)
    }

    private func identityCard(_ role: Workspace.IdentityRole, _ identity: Profile.Identity) -> some View {
        WorkspaceCard(palette: palette) {
            Text(role == .owner ? "Owner profile" : "Agent profile").font(.headline).foregroundStyle(palette.title)
            Text(identity.name.isEmpty ? "Unnamed" : identity.name)
            Button("Edit \(role.rawValue) name") {
                edit = EditName(title: "Edit \(role.rawValue) name", value: identity.name) { name in
                    await workspace.settingsProfile(role, patch: IdentityPatch(name: name))
                }
            }
            .buttonStyle(ActionStyle(palette: palette))
            if let avatar = identity.avatar {
                Button("View \(role.rawValue) avatar", systemImage: "person.crop.circle") { Task { await workspace.download(avatar) } }
                    .buttonStyle(ActionStyle(palette: palette))
                Button("Clear avatar") {
                    Task { await workspace.settingsProfile(role, patch: IdentityPatch(avatar: .clear)) }
                }
                .buttonStyle(ActionStyle(palette: palette))
            }
            Button("Choose \(role.rawValue) avatar") { avatarRole = role; picking = true }
                .buttonStyle(ActionStyle(palette: palette))
        }
    }

    private var backendActions: some View {
        WorkspaceCard(palette: palette) {
            Text("Backend profiles").font(.headline).foregroundStyle(palette.title)
            Button("Sync agent profile") { Task { await workspace.syncProfile(nil) } }
                .buttonStyle(ActionStyle(palette: palette))
            ForEach(workspace.backends) { backend in
                VStack(alignment: .leading, spacing: 6) {
                    Text(backend.name.isEmpty ? backend.id : backend.name)
                    Button("Sync from \(backend.kind)") { Task { await workspace.syncProfile(backend.id) } }
                        .buttonStyle(ActionStyle(palette: palette))
                    if let avatar = backend.avatar {
                        Button("View backend avatar") { Task { await workspace.download(avatar) } }
                            .buttonStyle(ActionStyle(palette: palette))
                    }
                }
            }
        }
    }

    private var deviceSection: some View {
        WorkspaceCard(palette: palette) {
            Text("Device sessions").font(.headline).foregroundStyle(palette.title)
            ForEach(workspace.devices) { device in
                let current = device.id == workspace.device?.id
                VStack(alignment: .leading, spacing: 4) {
                    Text(device.name + (current ? " (this device)" : ""))
                        .font(.callout.bold())
                    Text("Expires \(Date(timeIntervalSince1970: Double(device.expiresAt)), format: .dateTime.month(.abbreviated).day().year())")
                        .font(.caption).foregroundStyle(palette.secondary)
                    if !current {
                        Button("Revoke \(device.name)", role: .destructive) { revoke = device }
                            .buttonStyle(ActionStyle(palette: palette))
                    }
                }
            }
            Button("Sign out this device", role: .destructive) { signingOut = true }
                .buttonStyle(ActionStyle(palette: palette))
        }
        .confirmationDialog(revoke.map { "Revoke \($0.name)?" } ?? "Revoke device?", isPresented: Binding(
            get: { revoke != nil }, set: { if !$0 { revoke = nil } }
        ), titleVisibility: .visible) {
            if let revoke {
                Button("Revoke device", role: .destructive) { Task { await workspace.revoke(revoke.id) } }
            }
        }
        .confirmationDialog("Sign out and revoke this device?", isPresented: $signingOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await workspace.signOut() } }
        }
        .disabled(workspace.busy)
    }
}
