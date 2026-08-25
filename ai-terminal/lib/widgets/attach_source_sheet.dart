import 'package:flutter/material.dart';

/// Where the attach button's files come from (#166).
///
/// A source names a *gesture*, not a file type: every one of them ends in the
/// same staged attachment, and what the chip looks like is decided later from
/// the file's own name (`droppedFileIsImage`).
enum AttachSource { camera, gallery, files }

/// What the attach sheet offers on this platform.
///
/// `files` is **mobile-only, and that is the whole of #166**: the desktop
/// already reaches every file through the drag-and-drop added by #90, so a
/// second door to one capability is exactly what that issue ruled out. The
/// phone had no door at all: its picker is `image_picker`, which cannot see a
/// PDF or a log.
///
/// It is a product decision, NOT a capability limit — `file_selector` endorses
/// `file_selector_windows` (and linux/macos), so `openFiles()` would work on
/// the desktop build. Opening that row there is a one-line change if the drop
/// ever proves not to be enough; nothing here has to be fixed first.
///
/// Camera and Gallery keep their positions. They are muscle memory, and the
/// cost of reshuffling a two-item list people already know is larger than the
/// benefit of any new ordering.
///
/// Pure, so both branches are testable without a platform.
List<AttachSource> attachSourcesFor({required bool desktop}) => desktop
    ? const [AttachSource.camera, AttachSource.gallery]
    : const [AttachSource.camera, AttachSource.gallery, AttachSource.files];

/// The label on a source's row — what the person recognises, not what the code
/// calls it. "Files" is the name Android's own picker goes by; "Document" would
/// be narrower than the truth (an archive is not a document).
String attachSourceLabel(AttachSource source) => switch (source) {
      AttachSource.camera => 'Camera',
      AttachSource.gallery => 'Gallery',
      AttachSource.files => 'Files',
    };

/// The glyph for a source. All three are outlined, matching the two rows that
/// were here first, and each names its *origin* — every row attaches, so a
/// paperclip on any one of them would say nothing the others don't.
IconData attachSourceIcon(AttachSource source) => switch (source) {
      AttachSource.camera => Icons.photo_camera_outlined,
      AttachSource.gallery => Icons.photo_library_outlined,
      AttachSource.files => Icons.folder_outlined,
    };

/// The bottom sheet the attach button opens: one row per offered source, popping
/// the chosen [AttachSource] (or null when dismissed).
///
/// A widget rather than a closure inside the screen so the rows — and the
/// platform rule that decides them — are testable without a session, a server or
/// a PTY. The OS picker behind a row is not testable at all (it is an Activity
/// result); which rows exist and what each one answers is.
class AttachSourceSheet extends StatelessWidget {
  const AttachSourceSheet({super.key, required this.sources});

  final List<AttachSource> sources;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final source in sources)
            ListTile(
              leading: Icon(attachSourceIcon(source)),
              title: Text(attachSourceLabel(source)),
              onTap: () => Navigator.pop(context, source),
            ),
        ],
      ),
    );
  }
}
