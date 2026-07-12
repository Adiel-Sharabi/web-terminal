/// Compose-first input bar — mirrors the web app's mobile compose bar
/// (`composeMode` in `C:\dev\web-terminal-shadow\app.html`): a real,
/// IME-capable multiline `TextField` pinned above the key strip, replacing
/// direct typing into the xterm view (which has none of the platform's
/// autocomplete/swipe/IME support). See `SessionScreen` for the send/history/
/// live-streaming logic that drives this bar.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_theme.dart';
import '../theme/status_colors.dart';

/// Whether the compose field is driven by a soft (on-screen) keyboard, i.e.
/// mobile. On a soft keyboard the field is single-line with a native "send"
/// action so Enter submits directly: a multi-line field makes Android insert a
/// newline on Enter and ignore [TextInputAction.send], and worse, a buffer with
/// a newline is sent as a bracketed paste whose trailing submit-CR the Claude/
/// Codex TUI absorbs (so it never runs). Single-line keeps every submit a plain
/// `text\r` — the one form both TUIs act on — and lets the IME's own onSubmitted
/// clear the field cleanly (rewriting the field mid-keystroke desynced Gboard and
/// left the text stuck). Desktop has a hardware Enter, so it keeps the multi-line
/// field + the _SendIntent shortcut and Shift/Alt+Enter for newlines. Pure/testable.
bool composeUsesSoftKeyboard(TargetPlatform platform) =>
    platform == TargetPlatform.android || platform == TargetPlatform.iOS;

class _SendIntent extends Intent {
  const _SendIntent();
}

class _PasteImageIntent extends Intent {
  const _PasteImageIntent();
}

class _EscapeIntent extends Intent {
  const _EscapeIntent();
}

class _ArrowIntent extends Intent {
  const _ArrowIntent(this.seq);
  final String seq;
}

class _TabIntent extends Intent {
  const _TabIntent();
}

class _BackspaceIntent extends Intent {
  const _BackspaceIntent();
}

/// Sends an arrow key to the terminal when the compose field is empty (you're
/// driving Claude, not editing text) OR while a live '/' line is streaming (so
/// hardware ↑/↓ navigate Claude's slash menu even though the field has text).
/// When disabled the key falls through to the field's normal caret/line nav.
class _ArrowAction extends Action<_ArrowIntent> {
  _ArrowAction(this.controller, this.onArrow, this.isLive);
  final TextEditingController controller;
  final void Function(String seq)? onArrow;
  final bool isLive;

  @override
  bool isEnabled(_ArrowIntent intent) =>
      onArrow != null && (controller.text.isEmpty || isLive);

  @override
  Object? invoke(_ArrowIntent intent) {
    onArrow?.call(intent.seq);
    return null;
  }
}

/// Sends Tab to the terminal ONLY while a live '/' line is streaming, so Tab
/// autocompletes the highlighted slash command in Claude's menu. Disabled
/// otherwise, so a normal Tab keeps its default focus-traversal behavior.
class _TabAction extends Action<_TabIntent> {
  _TabAction(this.onTab, this.isLive);
  final VoidCallback? onTab;
  final bool isLive;

  @override
  bool isEnabled(_TabIntent intent) => onTab != null && isLive;

  @override
  Object? invoke(_TabIntent intent) {
    onTab?.call();
    return null;
  }
}

/// Sends a backspace to the terminal when a live '/' line is streaming AND the
/// compose field is already empty. Tab-completing a slash command adds chars to
/// Claude's input line that the field never tracked, so once the field empties
/// the leftover completion can't be deleted through it — this forwards further
/// backspaces raw so the whole line clears. While the field still has text,
/// backspace edits it normally (the stream sends the DELs). Disabled otherwise.
class _BackspaceAction extends Action<_BackspaceIntent> {
  _BackspaceAction(this.controller, this.onBackspace, this.isLive);
  final TextEditingController controller;
  final VoidCallback? onBackspace;
  final bool isLive;

  @override
  bool isEnabled(_BackspaceIntent intent) =>
      onBackspace != null && isLive && controller.text.isEmpty;

  @override
  Object? invoke(_BackspaceIntent intent) {
    onBackspace?.call();
    return null;
  }
}

class ComposeBar extends StatelessWidget {
  const ComposeBar({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.onSend,
    required this.isLive,
    this.onPasteImage,
    this.onEscape,
    this.onArrow,
    this.onTab,
    this.onBackspace,
    this.attachments = const <Uint8List>[],
    this.onRemoveAttachment,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final VoidCallback onSend;

  /// Pasted/added image attachments (#29), as thumbnail bytes, shown as a strip
  /// of removable chips above the field. The underlying file paths live in
  /// `SessionScreen` and are sent to the PTY on submit; only the preview is here.
  final List<Uint8List> attachments;

  /// Remove the attachment at `index` (the chip's ✕). `null` disables removal.
  final void Function(int index)? onRemoveAttachment;

  /// Paste an image from the clipboard (Alt+V). `null` disables the shortcut.
  final VoidCallback? onPasteImage;

  /// Hardware Esc → send ESC to the terminal (always). `null` disables it.
  final VoidCallback? onEscape;

  /// Hardware arrows → send the escape sequence to the terminal, when the field
  /// is empty or while a live '/' line is streaming (slash-menu nav). `null`
  /// disables it.
  final void Function(String seq)? onArrow;

  /// Hardware Tab → send Tab to the terminal, only while a live '/' line is
  /// streaming (autocomplete the highlighted slash command). `null` disables it.
  final VoidCallback? onTab;

  /// Hardware Backspace → send a backspace to the terminal, only while a live
  /// '/' line is streaming AND the field is already empty (clears the leftover
  /// of a Tab-completed command). `null` disables it.
  final VoidCallback? onBackspace;

  /// True while the buffer is a `/`-prefixed line streaming live to the
  /// terminal so Claude's own slash-command menu can render. Tints the
  /// field's border to signal "this is live, not just a local draft".
  final bool isLive;

  bool get _canSend =>
      controller.text.isNotEmpty || isLive || attachments.isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final liveColor = StatusColor.serverNeedsAuth;
    final borderColor = isLive ? liveColor : theme.colorScheme.outlineVariant;
    final softKeyboard = composeUsesSoftKeyboard(defaultTargetPlatform);

    return Container(
      color: theme.colorScheme.surfaceContainer,
      padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (attachments.isNotEmpty) _attachmentStrip(theme),
          Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Shortcuts(
              shortcuts: <ShortcutActivator, Intent>{
                // Bare Enter sends; Alt/Shift+Enter fall through to the field's
                // own newline handling. Soft-keyboard Enter on mobile doesn't
                // emit these key events, so it still inserts a newline there.
                const SingleActivator(LogicalKeyboardKey.enter):
                    const _SendIntent(),
                const SingleActivator(LogicalKeyboardKey.numpadEnter):
                    const _SendIntent(),
                if (onPasteImage != null)
                  const SingleActivator(LogicalKeyboardKey.keyV, alt: true):
                      const _PasteImageIntent(),
                if (onEscape != null)
                  const SingleActivator(LogicalKeyboardKey.escape):
                      const _EscapeIntent(),
                if (onArrow != null) ...const {
                  SingleActivator(LogicalKeyboardKey.arrowUp): _ArrowIntent(
                    '\x1b[A',
                  ),
                  SingleActivator(LogicalKeyboardKey.arrowDown): _ArrowIntent(
                    '\x1b[B',
                  ),
                  SingleActivator(LogicalKeyboardKey.arrowRight): _ArrowIntent(
                    '\x1b[C',
                  ),
                  SingleActivator(LogicalKeyboardKey.arrowLeft): _ArrowIntent(
                    '\x1b[D',
                  ),
                },
                if (onTab != null)
                  const SingleActivator(LogicalKeyboardKey.tab): _TabIntent(),
                if (onBackspace != null)
                  const SingleActivator(LogicalKeyboardKey.backspace):
                      _BackspaceIntent(),
              },
              child: Actions(
                actions: <Type, Action<Intent>>{
                  _SendIntent: CallbackAction<_SendIntent>(
                    onInvoke: (_) {
                      if (_canSend) onSend();
                      return null;
                    },
                  ),
                  _PasteImageIntent: CallbackAction<_PasteImageIntent>(
                    onInvoke: (_) {
                      onPasteImage?.call();
                      return null;
                    },
                  ),
                  _EscapeIntent: CallbackAction<_EscapeIntent>(
                    onInvoke: (_) {
                      onEscape?.call();
                      return null;
                    },
                  ),
                  _ArrowIntent: _ArrowAction(controller, onArrow, isLive),
                  _TabIntent: _TabAction(onTab, isLive),
                  _BackspaceIntent: _BackspaceAction(
                    controller,
                    onBackspace,
                    isLive,
                  ),
                },
                child: TextField(
                  controller: controller,
                  focusNode: focusNode,
                  minLines: 1,
                  // Mobile: single-line with a native Send action, so Enter fires
                  // onSubmitted (submits) and never inserts a newline — the only
                  // combination Android honors, and it keeps every submit a plain
                  // `text\r` the TUI acts on. Desktop: multi-line; a bare Enter is
                  // caught by the _SendIntent shortcut and Shift/Alt+Enter inserts
                  // a newline. A raw Enter on the terminal key strip sends '\r'.
                  maxLines: softKeyboard ? 1 : 5,
                  keyboardType: softKeyboard
                      ? TextInputType.text
                      : TextInputType.multiline,
                  textInputAction: softKeyboard
                      ? TextInputAction.send
                      : TextInputAction.newline,
                  onSubmitted: (_) {
                    if (_canSend) onSend();
                  },
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 14,
                color: AppColors.onSurface,
              ),
              decoration: InputDecoration(
                isDense: true,
                hintText: 'Message — / for commands',
                hintStyle: TextStyle(
                  color: theme.colorScheme.onSurfaceVariant,
                  fontSize: 14,
                ),
                filled: true,
                fillColor: theme.colorScheme.surface,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppShape.medium),
                  borderSide: BorderSide(color: borderColor),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppShape.medium),
                  borderSide: BorderSide(color: borderColor),
                ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(AppShape.medium),
                      borderSide: BorderSide(
                        color: isLive ? liveColor : theme.colorScheme.primary,
                        width: isLive ? 2 : 1,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          AnimatedBuilder(
            animation: controller,
            builder: (context, _) {
              final enabled = controller.text.isNotEmpty ||
                  isLive ||
                  attachments.isNotEmpty;
              return IconButton.filled(
                onPressed: enabled ? onSend : null,
                icon: const Icon(Icons.send),
              );
            },
          ),
        ],
          ),
        ],
      ),
    );
  }

  /// Horizontal strip of removable image-attachment thumbnails, shown above the
  /// text field when there are attachments (#29).
  Widget _attachmentStrip(ThemeData theme) {
    return Container(
      height: 60,
      margin: const EdgeInsets.only(bottom: 8),
      alignment: Alignment.centerLeft,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: attachments.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, i) => _AttachmentThumb(
          bytes: attachments[i],
          onRemove:
              onRemoveAttachment == null ? null : () => onRemoveAttachment!(i),
        ),
      ),
    );
  }
}

/// One image attachment: a rounded thumbnail with a small ✕ to remove it (#29).
class _AttachmentThumb extends StatelessWidget {
  const _AttachmentThumb({required this.bytes, this.onRemove});

  final Uint8List bytes;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SizedBox(
      width: 52,
      height: 52,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(AppShape.small),
            child: Image.memory(
              bytes,
              width: 52,
              height: 52,
              fit: BoxFit.cover,
              gaplessPlayback: true,
              // A decode failure shouldn't crash the compose bar — show a generic
              // image glyph instead.
              errorBuilder: (_, _, _) => Container(
                width: 52,
                height: 52,
                color: theme.colorScheme.surfaceContainerHigh,
                child: Icon(Icons.image_outlined,
                    color: theme.colorScheme.onSurfaceVariant),
              ),
            ),
          ),
          if (onRemove != null)
            Positioned(
              top: 1,
              right: 1,
              child: GestureDetector(
                onTap: onRemove,
                child: Container(
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surface.withValues(alpha: 0.85),
                    shape: BoxShape.circle,
                    border:
                        Border.all(color: theme.colorScheme.outlineVariant),
                  ),
                  padding: const EdgeInsets.all(1),
                  child: Icon(Icons.close,
                      size: 13, color: theme.colorScheme.onSurface),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
