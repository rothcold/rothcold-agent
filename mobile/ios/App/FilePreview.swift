import AVKit
import SwiftUI
import UniformTypeIdentifiers

struct FilePreview: View {
    let file: DownloadedFile
    let palette: Palette
    let authorizeExport: @MainActor () async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var exporting = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    WorkspaceHeading(file.attachment.filename, palette: palette)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(file.attachment.size), countStyle: .file))
                        .foregroundStyle(palette.secondary)
                    preview
                    Button("Save to Files", systemImage: "square.and.arrow.down") {
                        Task { if await authorizeExport() { exporting = true } }
                    }
                        .buttonStyle(ActionStyle(palette: palette, primary: true))
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(palette.canvas.ignoresSafeArea())
            .foregroundStyle(palette.body)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .sheet(isPresented: $exporting) { FileExport(url: file.url) }
    }

    @ViewBuilder private var preview: some View {
        let item = file.attachment
        if item.kind == "image", ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(item.mime),
           let bitmap = UIImage(contentsOfFile: file.url.path) {
            Image(uiImage: bitmap).resizable().scaledToFit()
                .frame(maxHeight: 440)
                .accessibilityLabel("Image preview")
        } else if item.kind == "video" && item.mime.hasPrefix("video/") ||
                  item.kind == "audio" && item.mime.hasPrefix("audio/") {
            LocalPlayer(url: file.url, audio: item.kind == "audio")
        } else {
            Label("Download only. This file won’t be previewed.", systemImage: "doc")
                .foregroundStyle(palette.secondary)
        }
    }
}

private struct LocalPlayer: View {
    @State private var player: AVPlayer
    let audio: Bool

    init(url: URL, audio: Bool) {
        _player = State(initialValue: AVPlayer(url: url))
        self.audio = audio
    }

    var body: some View {
        VideoPlayer(player: player)
            .frame(height: audio ? 136 : 240)
            .onDisappear { player.pause() }
            .accessibilityLabel(audio ? "Audio player" : "Video player")
        Text("Playback depends on the codecs supported by this iPhone. You can save the original file.")
            .font(.caption)
    }
}

private struct FileExport: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        UIDocumentPickerViewController(forExporting: [url], asCopy: true)
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}
}
