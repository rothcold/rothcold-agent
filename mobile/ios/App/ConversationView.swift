import SwiftUI
import UniformTypeIdentifiers

struct ConversationView: View {
    let workspace: Workspace
    let palette: Palette
    let chat: String
    let foreground: Bool
    @State private var rename: EditName?
    @State private var release: Turn?
    @State private var pickerOpen = false

    private var thread: DirectoryThread? { workspace.directory?.threads.first { $0.id == chat } }
    private var allowsRead: Bool { foreground && rename == nil && release == nil && !pickerOpen }

    var body: some View {
        Button("Back", systemImage: "chevron.left") { Task { await workspace.backFromThread() } }
            .disabled(workspace.busy)
        if let thread {
            if let category = workspace.directory?.categories.first(where: { $0.id == thread.channel }) {
                Text(category.name).font(.callout).foregroundStyle(palette.secondary)
            }
            WorkspaceHeading(thread.title, palette: palette)
            if workspace.directory?.isArchived(thread) == true {
                Text("Archived thread").foregroundStyle(palette.secondary)
            }
            threadActions(thread)
        }
        ForEach(workspace.turns) { turn in
            turnCard(turn).id(turn.id)
        }
        Button("Refresh conversation") { Task { await workspace.refresh() } }
            .buttonStyle(ActionStyle(palette: palette)).disabled(workspace.busy)
        if let thread, workspace.directory?.isArchived(thread) == false {
            ComposerView(workspace: workspace, palette: palette, scope: .thread(chat), title: "Send reply",
                         pickerChanged: { pickerOpen = $0 })
        } else {
            Text("Restore this thread and its category before sending a reply.")
                .font(.callout).foregroundStyle(palette.secondary)
        }
    }

    private func threadActions(_ thread: DirectoryThread) -> some View {
        DisclosureGroup("Manage thread") {
            VStack(spacing: 8) {
                Button("Rename thread") {
                    rename = EditName(title: "Rename thread", value: thread.title) { title in
                        await workspace.mutate(.renameThread(id: chat, title: title), .threadRenamed)
                    }
                }
                .buttonStyle(ActionStyle(palette: palette))
                if workspace.directory?.isArchived(thread) == false {
                    DisclosureGroup("Move thread") {
                        ForEach(workspace.directory?.categories.filter { !$0.archived && $0.id != thread.channel } ?? []) { category in
                            Button(category.name) {
                                Task { await workspace.mutate(.moveThread(id: chat, channel: category.id), .threadMoved) }
                            }
                            .buttonStyle(ActionStyle(palette: palette))
                        }
                    }
                    .frame(minHeight: 44)
                }
                Button(thread.archived ? "Restore thread" : "Archive thread") {
                    Task { await workspace.mutate(.archiveThread(id: chat, archived: !thread.archived), .archived) }
                }
                .buttonStyle(ActionStyle(palette: palette))
                Button("Mark whole thread read") { Task { await workspace.mutate(.readThread(chat: chat), .ok) } }
                    .buttonStyle(ActionStyle(palette: palette))
            }
            .padding(.vertical, 8)
        }
        .editName($rename)
        .disabled(workspace.busy)
        .onChange(of: allowsRead) { _, allowed in if !allowed { workspace.suspendReadReceipts() } }
    }

    private func turnCard(_ turn: Turn) -> some View {
        WorkspaceCard(palette: palette) {
            if !turn.text.isEmpty {
                Text("You").font(.caption.bold()).foregroundStyle(palette.secondary)
                Text(verbatim: turn.text).textSelection(.enabled)
            }
            ForEach(turn.attachments) { file in
                Button("Open \(file.filename)", systemImage: "paperclip") { Task { await workspace.download(file.id) } }
                    .multilineTextAlignment(.leading)
                    .frame(minHeight: 44)
                    .disabled(workspace.busy)
            }
            Text(stateLabel(turn.state))
                .font(.caption).foregroundStyle(palette.secondary)
                .accessibilityIdentifier("turnState-\(turn.state.rawValue)")
            ForEach(workspace.updates[turn.id] ?? []) { update in updateCard(update) }
            if turn.state == .unknown {
                Button("Stop waiting for this turn", role: .destructive) { release = turn }
                    .buttonStyle(ActionStyle(palette: palette)).disabled(workspace.busy)
                    .confirmationDialog("Release this turn?", isPresented: Binding(
                        get: { release?.id == turn.id }, set: { if !$0 { release = nil } }
                    ), titleVisibility: .visible) {
                        Button("Stop waiting", role: .destructive) {
                            Task { await workspace.mutate(.releaseTurn(chat: chat, id: turn.id), .ok) }
                        }
                    } message: {
                        Text("This unblocks the queue. It doesn’t cancel, replay, or move a late reply.")
                    }
            }
            if let answer = turn.answer {
                FinalReply(workspace: workspace, palette: palette, chat: chat, turn: turn.id,
                           answer: answer, eligible: allowsRead)
            }
        }
    }

    private func updateCard(_ update: TurnUpdate) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(update.choices.isEmpty ? update.kind.rawValue.capitalized : "Approval requested")
                .font(.caption.bold()).foregroundStyle(palette.secondary)
            Text(verbatim: update.text).font(.callout).textSelection(.enabled)
            ForEach(update.choices) { choice in
                Button(choice.label) { Task { await workspace.decide(chat: chat, id: update.id, choice: choice) } }
                    .buttonStyle(ActionStyle(palette: palette)).disabled(workspace.busy)
            }
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
    }

    private func stateLabel(_ state: Turn.State) -> String {
        switch state {
        case .queued: "Queued"
        case .reserved: "Reserved by backend"
        case .accepted: "Accepted by backend"
        case .unknown: "Delivery unknown · queue paused"
        case .released: "Released from queue"
        case .answered: "Answered"
        }
    }
}

private struct FinalReply: View {
    let workspace: Workspace
    let palette: Palette
    let chat: String
    let turn: String
    let answer: String
    let eligible: Bool
    @State private var visible = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Agent").font(.caption.bold()).foregroundStyle(palette.secondary)
            Text((try? AttributedString(markdown: answer, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
                 ?? AttributedString(answer))
                .textSelection(.enabled)
                .environment(\.openURL, OpenURLAction { url in
                    ["http", "https"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
                })
                .accessibilityIdentifier("finalReply")
        }
        .onGeometryChange(for: Bool.self) { geometry in
            let frame = geometry.frame(in: .scrollView)
            let viewport = geometry.bounds(of: .scrollView) ?? .zero
            let seen = frame.intersection(CGRect(origin: .zero, size: viewport.size))
            return frame.height > 0 && seen.height >= min(48, frame.height / 2)
        } action: { visible = $0 }
        .task(id: eligible && visible) {
            guard eligible && visible else { workspace.markVisible(chat: chat, turn: turn, visible: false); return }
            do { try await Task.sleep(for: .milliseconds(600)) } catch { return }
            workspace.markVisible(chat: chat, turn: turn, visible: true)
        }
        .onDisappear { workspace.markVisible(chat: chat, turn: turn, visible: false) }
    }
}

struct ComposerView: View {
    let workspace: Workspace
    let palette: Palette
    let scope: Workspace.DraftScope
    let title: String
    var pickerChanged: (Bool) -> Void = { _ in }
    @State private var picker = false
    @State private var discard = false
    @FocusState private var focused: Bool

    private var draft: Workspace.Draft { workspace.draft(scope) }
    private var pending: Bool { workspace.awaitingReceipt(scope) }

    var body: some View {
        WorkspaceCard(palette: palette) {
            HStack {
                Text("Message").font(.headline).foregroundStyle(palette.title)
                Spacer(minLength: 0)
                if focused {
                    Button { focused = false } label: {
                        Image(systemName: "keyboard.chevron.compact.down").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Dismiss keyboard")
                }
            }
            TextEditor(text: Binding(get: { draft.text }, set: { workspace.setText($0, scope: scope) }))
                .scrollContentBackground(.hidden)
                .frame(minHeight: 88)
                .modifier(InputStyle(palette: palette, focused: focused))
                .focused($focused)
                .accessibilityLabel("Message")
                .accessibilityIdentifier("messageEditor")
                .disabled(pending || workspace.busy)
            files
            if !pending { choices }
            if pending {
                Text("No send receipt. Retry the exact same message or unlock the draft if you’ve checked the conversation.")
                    .font(.callout).foregroundStyle(palette.secondary)
                Button("Unlock draft", role: .destructive) { discard = true }
                    .buttonStyle(ActionStyle(palette: palette))
            }
            Button(pending ? "Retry same send" : title) {
                focused = false
                Task { await workspace.send(scope) }
            }
            .buttonStyle(ActionStyle(palette: palette, primary: true))
            .disabled(workspace.busy || !draft.hasContent)
        }
        .confirmationDialog("Unlock the draft?", isPresented: $discard, titleVisibility: .visible) {
            Button("Unlock draft", role: .destructive) { workspace.discardPending(scope) }
        } message: {
            Text("A previous attempt may already be queued. A new send can create a duplicate.")
        }
        .fileImporter(isPresented: $picker, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await workspace.attach(urls, scope: scope) }
            case .failure(let error): workspace.report(error)
            }
        }
        .onChange(of: picker || discard) { _, visible in pickerChanged(visible) }
    }

    private var files: some View {
        Group {
            ForEach(draft.attachments) { item in
                HStack {
                    Label(item.filename, systemImage: "paperclip")
                    Spacer(minLength: 0)
                    Button { workspace.removeAttachment(item.id, scope: scope) } label: {
                        Image(systemName: "xmark.circle").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Remove \(item.filename)")
                    .disabled(pending || workspace.busy)
                }
            }
            Button("Attach files", systemImage: "paperclip") { focused = false; picker = true }
                .buttonStyle(ActionStyle(palette: palette)).disabled(workspace.busy || pending || draft.attachments.count >= 8)
            if workspace.transferring {
                Button("Cancel file transfer", role: .destructive) { Task { await workspace.cancelTransfer() } }
                    .buttonStyle(ActionStyle(palette: palette))
            }
        }
    }

    private var choices: some View {
        Group {
            Button("Load slash commands", systemImage: "command") { Task { await workspace.fetchCatalog() } }
                .disabled(workspace.busy)
            if let catalog = workspace.catalog {
                if catalog.commands.isEmpty && catalog.skills.isEmpty { Text("No commands in this catalog.") }
                slashSection("Commands", items: catalog.commands)
                slashSection("Skills", items: catalog.skills)
            }
        }
    }

    private func slashSection(_ title: String, items: [String]) -> some View {
        DisclosureGroup(title) {
            ForEach(items.filter { !["approve", "deny"].contains($0) }, id: \.self) { item in
                Button("/\(item)") { workspace.setText("/\(item) ", scope: scope) }
                    .frame(minHeight: 44, alignment: .leading)
                    .disabled(workspace.busy)
            }
        }
    }
}
