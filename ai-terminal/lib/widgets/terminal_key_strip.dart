/// Compact key strip shown above the keyboard in [SessionScreen]: Esc, Tab, a
/// sticky Ctrl modifier, arrow keys, `/` and `|`, then a raw-mode toggle, a
/// Paste and an Image action. Raw-sequence keys emit the bytes the PTY
/// expects via [onKey] (compose mode intercepts some of these — see
/// `SessionScreen._handleKeyStripKeyPress` — before they ever reach the PTY);
/// the sticky Ctrl transform (`charCode & 0x1f`) is applied by the caller, not
/// here. Paste, Image and the raw-mode toggle are multi-step/stateful
/// actions, so they're plain [VoidCallback]s instead.
library;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

class TerminalKeyStrip extends StatelessWidget {
  const TerminalKeyStrip({
    super.key,
    required this.onKey,
    required this.ctrlActive,
    required this.onToggleCtrl,
    required this.altActive,
    required this.onToggleAlt,
    required this.onPaste,
    required this.onImage,
    required this.rawMode,
    required this.onToggleRawMode,
    this.showRawToggle = true,
  });

  /// Called with the raw sequence a key sends (e.g. `'\x1b'`, `'\x1b[A'`).
  final void Function(String sequence) onKey;

  /// Whether the sticky Ctrl modifier is currently armed.
  final bool ctrlActive;

  final VoidCallback onToggleCtrl;

  /// Whether the sticky Alt/Meta modifier is currently armed (next char is
  /// sent ESC-prefixed).
  final bool altActive;

  final VoidCallback onToggleAlt;

  /// Pastes the system clipboard's text (into the compose field, or straight
  /// into the terminal in raw mode — the caller decides which).
  final VoidCallback onPaste;

  /// Picks an image and sends it to the session.
  final VoidCallback onImage;

  /// Whether raw mode (direct terminal keyboard input) is currently active.
  final bool rawMode;

  final VoidCallback onToggleRawMode;

  /// Whether to show the raw-mode (on-screen "keyboard") toggle. Hidden on
  /// desktop (#30/#11): there a physical keyboard makes it redundant, and
  /// toggling raw ON there switched to the Terminal lens and hid the compose
  /// bar — stranding the user with nowhere to type. On desktop input follows
  /// the lens instead (Chat = compose, Terminal = raw terminal).
  final bool showRawToggle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // A wrapping 2-row grid so EVERY key is visible at once — no hidden,
    // horizontally-scrolled-off keys (Paste/Image were getting lost off the
    // right edge of the old single scroll row).
    return Container(
      width: double.infinity,
      color: theme.colorScheme.surfaceContainer,
      padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
      child: Wrap(
        spacing: 4,
        runSpacing: 4,
        children: [
          _KeyButton(label: 'Esc', onTap: () => onKey('\x1b')),
          _KeyButton(label: 'Tab', onTap: () => onKey('\t')),
          _KeyButton(label: 'Ctrl', active: ctrlActive, onTap: onToggleCtrl),
          _KeyButton(label: 'Alt', active: altActive, onTap: onToggleAlt),
          _KeyButton(icon: Icons.keyboard_arrow_up, onTap: () => onKey('\x1b[A')),
          _KeyButton(icon: Icons.keyboard_arrow_down, onTap: () => onKey('\x1b[B')),
          _KeyButton(icon: Icons.keyboard_arrow_left, onTap: () => onKey('\x1b[D')),
          _KeyButton(icon: Icons.keyboard_arrow_right, onTap: () => onKey('\x1b[C')),
          _KeyButton(label: '/', onTap: () => onKey('/')),
          _KeyButton(label: '|', onTap: () => onKey('|')),
          _KeyButton(
            icon: Icons.keyboard_return,
            tooltip: 'Enter',
            onTap: () => onKey('\r'),
          ),
          _KeyButton(
            icon: Icons.content_paste_rounded,
            tooltip: 'Paste',
            onTap: onPaste,
          ),
          _KeyButton(
            icon: Icons.image_outlined,
            tooltip: 'Send image',
            onTap: onImage,
          ),
          if (showRawToggle)
            _KeyButton(
              icon: Icons.keyboard_rounded,
              tooltip: 'Raw keyboard mode',
              active: rawMode,
              onTap: onToggleRawMode,
            ),
        ],
      ),
    );
  }
}

class _KeyButton extends StatelessWidget {
  const _KeyButton({
    this.label,
    this.icon,
    this.tooltip,
    required this.onTap,
    this.active = false,
  });

  final String? label;
  final IconData? icon;
  final String? tooltip;
  final VoidCallback onTap;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = active
        ? theme.colorScheme.primary
        : theme.colorScheme.onSurfaceVariant;
    final button = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 3),
      child: Material(
        color: active ? theme.colorScheme.primaryContainer : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppShape.small),
          side: BorderSide(color: color.withValues(alpha: active ? 1 : 0.4)),
        ),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppShape.small),
          child: Container(
            width: 36,
            alignment: Alignment.center,
            child: icon != null
                ? Icon(icon, size: 18, color: color)
                : Text(
                    label ?? '',
                    style: theme.textTheme.labelLarge?.copyWith(color: color),
                  ),
          ),
        ),
      ),
    );
    return tooltip == null ? button : Tooltip(message: tooltip!, child: button);
  }
}
