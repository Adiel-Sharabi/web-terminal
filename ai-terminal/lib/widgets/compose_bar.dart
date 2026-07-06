/// Compose-first input bar — mirrors the web app's mobile compose bar
/// (`composeMode` in `C:\dev\web-terminal-shadow\app.html`): a real,
/// IME-capable multiline `TextField` pinned above the key strip, replacing
/// direct typing into the xterm view (which has none of the platform's
/// autocomplete/swipe/IME support). See `SessionScreen` for the send/history/
/// live-streaming logic that drives this bar.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_theme.dart';
import '../theme/status_colors.dart';

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

/// Sends an arrow key to the terminal, but ONLY while the compose field is
/// empty (you're driving Claude, not editing text). When it's disabled the key
/// falls through to the field's normal caret/line navigation.
class _ArrowAction extends Action<_ArrowIntent> {
  _ArrowAction(this.controller, this.onArrow);
  final TextEditingController controller;
  final void Function(String seq)? onArrow;

  @override
  bool isEnabled(_ArrowIntent intent) =>
      onArrow != null && controller.text.isEmpty;

  @override
  Object? invoke(_ArrowIntent intent) {
    onArrow?.call(intent.seq);
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
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final VoidCallback onSend;

  /// Paste an image from the clipboard (Alt+V). `null` disables the shortcut.
  final VoidCallback? onPasteImage;

  /// Hardware Esc → send ESC to the terminal (always). `null` disables it.
  final VoidCallback? onEscape;

  /// Hardware arrows → send the escape sequence to the terminal, but only when
  /// the compose field is empty. `null` disables it.
  final void Function(String seq)? onArrow;

  /// True while the buffer is a `/`-prefixed line streaming live to the
  /// terminal so Claude's own slash-command menu can render. Tints the
  /// field's border to signal "this is live, not just a local draft".
  final bool isLive;

  bool get _canSend => controller.text.isNotEmpty || isLive;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final liveColor = StatusColor.serverNeedsAuth;
    final borderColor = isLive ? liveColor : theme.colorScheme.outlineVariant;

    return Container(
      color: theme.colorScheme.surfaceContainer,
      padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
      child: Row(
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
                  _ArrowIntent: _ArrowAction(controller, onArrow),
                },
                child: TextField(
                  controller: controller,
                  focusNode: focusNode,
                  minLines: 1,
                  maxLines: 5,
                  keyboardType: TextInputType.multiline,
                  // Alt/Shift+Enter inserts a newline (see Shortcuts above); the
                  // send button and bare Enter submit. A raw Enter key on the
                  // terminal key strip sends a bare '\r' to the PTY.
                  textInputAction: TextInputAction.newline,
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
              final enabled = controller.text.isNotEmpty || isLive;
              return IconButton.filled(
                onPressed: enabled ? onSend : null,
                icon: const Icon(Icons.send),
              );
            },
          ),
        ],
      ),
    );
  }
}
