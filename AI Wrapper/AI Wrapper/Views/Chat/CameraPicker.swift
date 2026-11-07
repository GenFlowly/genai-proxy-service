import SwiftUI
import UIKit

/// The system camera, which is what Take Photo opens from a phone browser's file input.
struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let parent: CameraPicker

        init(parent: CameraPicker) {
            self.parent = parent
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onCapture(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

/// The menu a phone browser opens for a file input. UIKit, because a menu lines up with the
/// control it opens from: Safari's opens from around the tap and stops at the screen's edge. The
/// control is that small area in the middle of the button, and takes the button's touches.
struct AttachMenuButton: UIViewRepresentable {
    let onPhotoLibrary: () -> Void
    let onTakePhoto: (() -> Void)?
    let onChooseFiles: () -> Void

    final class Container: UIView {
        private static let menuSourceSize: CGFloat = 20

        let button = Button(type: .custom)

        override init(frame: CGRect) {
            super.init(frame: frame)
            addSubview(button)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override func layoutSubviews() {
            super.layoutSubviews()
            let size = Self.menuSourceSize
            button.frame = CGRect(x: bounds.midX - size / 2, y: bounds.midY - size / 2, width: size, height: size)
        }

        override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
            bounds.contains(point) ? button : nil
        }
    }

    final class Button: UIButton {
        override func point(inside point: CGPoint, with event: UIEvent?) -> Bool { true }

        override func menuAttachmentPoint(for configuration: UIContextMenuConfiguration) -> CGPoint {
            CGPoint(x: bounds.midX, y: bounds.midY - 32)
        }
    }

    func makeUIView(context: Context) -> Container {
        let container = Container()
        container.button.showsMenuAsPrimaryAction = true
        container.button.tintColor = .label
        container.button.preferredMenuElementOrder = .fixed
        container.button.accessibilityLabel = L("conversation.request.addAttachment")
        return container
    }

    func updateUIView(_ container: Container, context: Context) {
        var actions = [
            UIAction(title: L("conversation.request.attachPhotoLibrary"), image: UIImage(systemName: "photo.on.rectangle")) { _ in onPhotoLibrary() }
        ]
        if let onTakePhoto {
            actions.append(UIAction(title: L("conversation.request.attachTakePhoto"), image: UIImage(systemName: "camera")) { _ in onTakePhoto() })
        }
        actions.append(UIAction(title: L("conversation.request.attachChooseFiles"), image: UIImage(systemName: "folder")) { _ in onChooseFiles() })
        container.button.menu = UIMenu(children: actions)
    }
}
