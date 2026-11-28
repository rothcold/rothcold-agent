import SwiftUI

@main
struct RothcoldApp: App {
    @State private var workspace = Workspace()
    @AppStorage("appearance") private var appearance = "System"

    var body: some Scene {
        WindowGroup {
            WorkspaceView(workspace: workspace)
                .preferredColorScheme(appearance == "Light" ? .light : appearance == "Dark" ? .dark : nil)
        }
    }
}

private struct WorkspaceView: View {
    let workspace: Workspace
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var address = ""
    @State private var pin = ""
    @State private var owner = ""
    @State private var deviceName = "iPhone"
    @FocusState private var focus: Field?
    private enum Field: Hashable { case address, pin, owner, label }
    private var palette: Palette { Palette(dark: colorScheme == .dark) }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        feedback
                        switch workspace.screen {
                        case .connect: connectForm
                        case .signIn: signInForm
                        case .workspace: workspacePanel
                        case .reconnect: reconnectForm
                        }
                    }
                    .padding()
                    .frame(maxWidth: 560)
                    .frame(maxWidth: .infinity)
                    .id(workspace.panel)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: workspace.turns.map(\.id)) { _, ids in
                    if let target = workspace.replyTarget, ids.contains(target) { proxy.scrollTo(target) }
                }
            }
        }
        .foregroundStyle(palette.body)
        .background(palette.canvas.ignoresSafeArea())
        .tint(palette.accent)
        .task {
            address = workspace.lastAddress
            pin = workspace.lastPin
            await workspace.restoreSelection()
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else {
                if scenePhase == .background {
                    owner = ""
                    workspace.suspendForBackground()
                }
                else { workspace.suspendReadReceipts() }
                return
            }
            await workspace.refreshForeground()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(500)) } catch { break }
                await workspace.tick()
            }
        }
        .sheet(item: Binding(get: { workspace.file }, set: { if $0 == nil { workspace.dismissFile() } })) { file in
            FilePreview(file: file, palette: palette, authorizeExport: { await workspace.authorizeFileExport(file) })
        }
    }

    private var topBar: some View {
        HStack(spacing: 8) {
            if workspace.screen == .workspace {
                Button { Task { await workspace.navigate(.directory) } } label: {
                    Text("Rothcold Agent").font(.title3.bold()).foregroundStyle(palette.title)
                        .lineLimit(1).minimumScaleFactor(0.75)
                }
                .accessibilityLabel("Workspace directory")
                .disabled(workspace.busy)
                Spacer(minLength: 0)
                if workspace.busy && !workspace.transferring { ProgressView().accessibilityLabel("Working") }
                topButton("Inbox", icon: "tray", panel: .inbox)
                topButton("Settings", icon: "gearshape", panel: .settings)
            } else {
                Text("Rothcold Agent").font(.title2.bold()).foregroundStyle(palette.title)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 56)
        .background(alignment: .top) { palette.navigation.ignoresSafeArea(edges: .top) }
    }

    private func topButton(_ label: String, icon: String, panel: Workspace.Panel) -> some View {
        Button { Task { await workspace.navigate(panel) } } label: {
            Image(systemName: icon).font(.title3).frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(label)
        .disabled(workspace.busy)
    }

    private var connectForm: some View {
        Group {
            WorkspaceHeading("Connect to a server", palette: palette)
            Text("Use a private LAN or VPN address. Get the Noise public pin from your operator through a separate, trusted channel.")
                .foregroundStyle(palette.secondary)
            fieldLabel("Server address")
            TextField("Server address", text: $address, prompt: Text("192.168.1.10:8768").foregroundStyle(palette.secondary))
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focus, equals: .address)
                .modifier(InputStyle(palette: palette, focused: focus == .address))
                .accessibilityIdentifier("serverAddress")
            HStack {
                fieldLabel("Trusted server pin")
                Spacer(minLength: 0)
                if !pin.isEmpty {
                    Button("Clear pin") { pin = "" }
                        .font(.callout)
                        .frame(minHeight: 44)
                }
            }
            .frame(minHeight: 44)
            TextField("Trusted server pin", text: $pin, prompt: Text("64 hexadecimal characters").foregroundStyle(palette.secondary),
                      axis: .vertical)
                .font(.callout.monospaced())
                .lineLimit(2...3)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focus, equals: .pin)
                .modifier(InputStyle(palette: palette, focused: focus == .pin))
                .accessibilityIdentifier("serverPin")
            Button("Verify and connect") {
                focus = nil
                Task { await workspace.connect(address: address, pin: pin) }
            }
            .buttonStyle(ActionStyle(palette: palette, primary: true))
            .disabled(address.isEmpty || pin.isEmpty)
        }
        .disabled(workspace.busy)
    }

    private var signInForm: some View {
        Group {
            WorkspaceHeading("Sign in", palette: palette)
            selectionLabel(verified: true)
            fieldLabel("Device name")
            TextField("Device name", text: $deviceName)
                .focused($focus, equals: .label)
                .modifier(InputStyle(palette: palette, focused: focus == .label))
            fieldLabel("Owner token")
            SecureField("Owner token", text: $owner, prompt: Text("Owner token").foregroundStyle(palette.secondary))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focus, equals: .owner)
                .modifier(InputStyle(palette: palette, focused: focus == .owner))
            Button("Sign in") {
                focus = nil
                let token = owner.trimmingCharacters(in: .whitespacesAndNewlines)
                owner = ""
                Task { await workspace.signIn(owner: token, name: deviceName) }
            }
            .buttonStyle(ActionStyle(palette: palette, primary: true))
            .disabled(owner.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || deviceName.isEmpty)
            changeServer
        }
        .disabled(workspace.busy)
    }

    private var reconnectForm: some View {
        Group {
            WorkspaceHeading("Reconnect", palette: palette)
            selectionLabel(verified: false)
            Text("Reconnect with the same trusted pin. An interrupted send is never retried automatically.")
                .foregroundStyle(palette.secondary)
            Button("Verify and reconnect") { Task { await workspace.reconnect() } }
                .buttonStyle(ActionStyle(palette: palette, primary: true))
            changeServer
        }
        .disabled(workspace.busy)
    }

    private var changeServer: some View {
        Button("Change server") {
            focus = nil
            owner = ""
            address = workspace.lastAddress
            pin = workspace.lastPin
            Task { await workspace.changeServer() }
        }
        .buttonStyle(ActionStyle(palette: palette))
    }

    @ViewBuilder private var workspacePanel: some View {
        switch workspace.panel {
        case .directory: DirectoryView(workspace: workspace, palette: palette)
        case .category(let id): CategoryView(workspace: workspace, palette: palette, id: id)
        case .thread(let id):
            ConversationView(workspace: workspace, palette: palette, chat: id,
                             foreground: scenePhase == .active && workspace.file == nil)
        case .inbox: InboxView(workspace: workspace, palette: palette)
        case .settings: SettingsView(workspace: workspace, palette: palette, changeServer: changeServer)
        }
    }

    @ViewBuilder private var feedback: some View {
        if workspace.transferring {
            ProgressView("Transferring over Noise…")
            Button("Cancel transfer", role: .destructive) { Task { await workspace.cancelTransfer() } }
                .buttonStyle(ActionStyle(palette: palette))
        } else if workspace.busy && workspace.screen != .workspace {
            ProgressView("Working…").foregroundStyle(palette.secondary)
        }
        if let message = workspace.message {
            Label(message, systemImage: "info.circle")
                .foregroundStyle(palette.error)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.errorSurface, in: RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier("workspaceMessage")
        }
    }

    private func fieldLabel(_ value: String) -> some View {
        Text(value).font(.headline).accessibilityHidden(true)
    }

    @ViewBuilder private func selectionLabel(verified: Bool) -> some View {
        if let selection = workspace.selection {
            Label(selection.address, systemImage: verified ? "checkmark.shield" : "network")
                .font(.callout.monospaced()).foregroundStyle(palette.secondary)
        }
        if verified { Text("Noise server identity verified.").foregroundStyle(palette.secondary) }
    }
}

struct WorkspaceHeading: View {
    let title: String
    let palette: Palette
    init(_ title: String, palette: Palette) { self.title = title; self.palette = palette }
    var body: some View {
        Text(title).font(.title.bold()).foregroundStyle(palette.title).accessibilityAddTraits(.isHeader)
    }
}
struct Palette {
    let dark: Bool
    var navigation: Color { pair(light: 0xDCE7EB, dark: 0x2C4052) }
    var canvas: Color { pair(light: 0xFCFBF7, dark: 0x1C242B) }
    var input: Color { pair(light: 0xFFFFFF, dark: 0x28343D) }
    var border: Color { pair(light: 0x667984, dark: 0x889BA8) }
    var title: Color { pair(light: 0x1B2A33, dark: 0xEFECE3) }
    var body: Color { pair(light: 0x26343C, dark: 0xE4E1D8) }
    var secondary: Color { pair(light: 0x4B5D66, dark: 0xB6B9B4) }
    var accent: Color { pair(light: 0x14556A, dark: 0xA8CFDC) }
    var actionText: Color { pair(light: 0xFFFBF3, dark: 0x20272B) }
    var action: Color { pair(light: 0x875823, dark: 0xE7C68F) }
    var actionPressed: Color { pair(light: 0x643B14, dark: 0xCEAF79) }
    var error: Color { pair(light: 0x9A342C, dark: 0xECA59A) }
    var errorSurface: Color { pair(light: 0xFBE9E5, dark: 0x3C2929) }

    private func pair(light: Int, dark: Int) -> Color {
        let rgb = self.dark ? dark : light
        return Color(red: Double((rgb >> 16) & 255) / 255,
                     green: Double((rgb >> 8) & 255) / 255,
                     blue: Double(rgb & 255) / 255)
    }
}

struct ActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    let palette: Palette
    var primary = false

    func makeBody(configuration: Configuration) -> some View {
        let active = primary && enabled
        let destructive = enabled && configuration.role == .destructive
        let foreground = active ? palette.actionText : destructive ? palette.error : enabled ? palette.body : palette.secondary
        let surface = active ? (configuration.isPressed ? palette.actionPressed : palette.action)
            : destructive ? palette.errorSurface : palette.input
        let outline = active ? Color.clear : configuration.isPressed ? palette.accent : palette.border
        return configuration.label
            .font(.headline)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity)
            .foregroundStyle(foreground)
            .background(surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8).strokeBorder(outline, lineWidth: 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct InputStyle: ViewModifier {
    let palette: Palette
    let focused: Bool

    func body(content: Content) -> some View {
        content
            .padding(12)
            .frame(minHeight: 44)
            .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(focused ? palette.accent : palette.border, lineWidth: focused ? 2 : 1)
                    .allowsHitTesting(false)
            }
    }
}
