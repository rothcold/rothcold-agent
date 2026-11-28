import SwiftUI

struct WorkspaceCard<Content: View>: View {
    let palette: Palette
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.navigation, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct EditName: Identifiable {
    var id: String { title }
    let title: String
    var value: String
    let submit: @MainActor (String) async -> Void
}

extension View {
    func editName(_ edit: Binding<EditName?>) -> some View {
        alert(edit.wrappedValue?.title ?? "Edit name", isPresented: Binding(
            get: { edit.wrappedValue != nil }, set: { if !$0 { edit.wrappedValue = nil } }
        )) {
            TextField("Name", text: Binding(get: { edit.wrappedValue?.value ?? "" }, set: { edit.wrappedValue?.value = $0 }))
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                guard let field = edit.wrappedValue else { return }
                let name = field.value.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                Task { await field.submit(name) }
            }
        }
    }
}

struct DirectoryView: View {
    let workspace: Workspace
    let palette: Palette
    @State private var search = ""
    @State private var showArchived = false
    @State private var edit: EditName?

    private var needle: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        WorkspaceHeading("Workspace", palette: palette)
        TextField("Search categories and threads", text: $search,
                  prompt: Text("Search categories and threads").foregroundStyle(palette.secondary))
            .modifier(InputStyle(palette: palette, focused: false))
            .accessibilityIdentifier("directorySearch")
        actions
        if let directory = workspace.directory {
            if needle.isEmpty { categoryList(directory) }
            else { searchResults(directory) }
        }
    }

    private var actions: some View {
        Group {
            Button("New category") {
                edit = EditName(title: "New category", value: "") { name in
                    await workspace.mutate(.createCategory(name: name), .categoryCreated)
                }
            }
            .buttonStyle(ActionStyle(palette: palette))
            Button("Refresh directory") { Task { await workspace.refresh() } }
                .buttonStyle(ActionStyle(palette: palette))
        }
        .editName($edit)
        .disabled(workspace.busy)
    }

    private func categoryList(_ directory: WorkspaceDirectory) -> some View {
        Group {
            ForEach(directory.active, id: \.id) { group in
                WorkspaceCard(palette: palette) {
                    categoryButton(group.name, id: group.id)
                    Text(group.threads.isEmpty ? "No active threads" : "\(group.threads.count) active threads")
                        .font(.caption).foregroundStyle(palette.secondary)
                }
            }
            Toggle("Show archived", isOn: $showArchived)
            if showArchived {
                ForEach(directory.categories.filter(\.archived)) { category in
                    WorkspaceCard(palette: palette) { categoryButton(category.name, id: category.id) }
                }
                ForEach(directory.threads.filter(directory.isArchived)) { thread in
                    ThreadRow(workspace: workspace, palette: palette, thread: thread)
                }
            }
        }
    }

    private func searchResults(_ directory: WorkspaceDirectory) -> some View {
        let categories = directory.active.filter { $0.name.localizedCaseInsensitiveContains(needle) }
        let threads = directory.threads.filter { !directory.isArchived($0) && $0.title.localizedCaseInsensitiveContains(needle) }
        return Group {
            if categories.isEmpty && threads.isEmpty { Text("No matching active entries.").foregroundStyle(palette.secondary) }
            ForEach(categories, id: \.id) { category in categoryButton(category.name, id: category.id) }
            ForEach(threads) { thread in ThreadRow(workspace: workspace, palette: palette, thread: thread) }
        }
    }

    private func categoryButton(_ name: String, id: String) -> some View {
        Button { Task { await workspace.navigate(.category(id)) } } label: {
            HStack {
                Label(name, systemImage: "folder")
                    .font(.headline)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").accessibilityHidden(true)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .disabled(workspace.busy)
    }
}

struct CategoryView: View {
    let workspace: Workspace
    let palette: Palette
    let id: String
    @State private var showArchived = false
    @State private var edit: EditName?

    var body: some View {
        Button("Workspace directory", systemImage: "chevron.left") { Task { await workspace.navigate(.directory) } }
            .disabled(workspace.busy)
        if let directory = workspace.directory, let category = directory.categories.first(where: { $0.id == id }) {
            WorkspaceHeading(category.name, palette: palette)
            if category.archived { Text("Archived category").foregroundStyle(palette.secondary) }
            categoryActions(category)
            if !category.archived {
                ComposerView(workspace: workspace, palette: palette, scope: .category(id), title: "Start thread")
            }
            if !category.archived { Toggle("Show archived threads", isOn: $showArchived) }
            ForEach(directory.threads.filter { $0.channel == id && (category.archived || showArchived || !$0.archived) }) { thread in
                ThreadRow(workspace: workspace, palette: palette, thread: thread)
            }
        }
    }

    private func categoryActions(_ category: DirectoryCategory) -> some View {
        DisclosureGroup("Manage category") {
            VStack(spacing: 8) {
                Button("Rename category") {
                    edit = EditName(title: "Rename category", value: category.name) { name in
                        await workspace.mutate(.renameCategory(id: id, name: name), .categoryRenamed)
                    }
                }
                .buttonStyle(ActionStyle(palette: palette))
                if id != "general" {
                    Button(category.archived ? "Restore category" : "Archive category") {
                        Task { await workspace.mutate(.archiveCategory(id: id, archived: !category.archived), .archived) }
                    }
                    .buttonStyle(ActionStyle(palette: palette))
                }
            }
            .padding(.vertical, 8)
        }
        .editName($edit)
        .disabled(workspace.busy)
    }
}

struct ThreadRow: View {
    let workspace: Workspace
    let palette: Palette
    let thread: DirectoryThread

    var body: some View {
        Button { Task { await workspace.navigate(.thread(thread.id)) } } label: {
            HStack(spacing: 8) {
                Image(systemName: "bubble.left").accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(thread.title).multilineTextAlignment(.leading).font(.headline)
                    if workspace.directory?.isArchived(thread) == true {
                        Text("Archived").font(.caption).foregroundStyle(palette.secondary)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").accessibilityHidden(true)
            }
            .padding(.horizontal, 12).frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .background(palette.navigation, in: RoundedRectangle(cornerRadius: 8))
        .disabled(workspace.busy)
    }
}

struct InboxView: View {
    let workspace: Workspace
    let palette: Palette

    var body: some View {
        WorkspaceHeading("Inbox", palette: palette)
        Button("Refresh inbox") { Task { await workspace.refresh() } }
            .buttonStyle(ActionStyle(palette: palette)).disabled(workspace.busy)
        if workspace.inbox.isEmpty { Text("No replies yet.").foregroundStyle(palette.secondary) }
        ForEach(workspace.inbox) { entry in
            Button {
                Task { await workspace.navigate(.thread(entry.chat), reply: entry.request) }
            } label: {
                WorkspaceCard(palette: palette) {
                    Text(entry.title).font(.headline).foregroundStyle(palette.title)
                    if entry.unread { Label("Unread", systemImage: "circle.fill").font(.caption) }
                    if !entry.preview.isEmpty { Text(entry.preview).font(.callout).foregroundStyle(palette.secondary) }
                }
                .multilineTextAlignment(.leading)
            }
            .disabled(workspace.busy)
        }
    }
}
