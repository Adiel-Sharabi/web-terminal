/// Compact key strip shown above the keyboard in [SessionScreen]: Esc, Tab, a
/// sticky Ctrl modifier, arrow keys, `/` and `|`, then a raw-mode toggle, a
/// Paste and an Image action. Raw-sequence keys emit the bytes the PTY
/// expects via [onKey] (compose mode intercepts some of these — see
/// `SessionScreen._handleKeyStripKeyPress` — before they ever reach the PTY);
/// the sticky Ctrl transform (`charCode & 0x1f`) is applied by the caller, not
/// here. Paste, Image and the raw-mode toggle are multi-step/stateful
/// actions, so they're plain [VoidCallback]s instead.
library;

import 'dart:async';

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
          _KeyButton(
            icon: Icons.keyboard_arrow_up,
            onTap: () => onKey('\x1b[A'),
            repeatable: true,
          ),
          _KeyButton(
            icon: Icons.keyboard_arrow_down,
            onTap: () => onKey('\x1b[B'),
            repeatable: true,
          ),
          _KeyButton(
            icon: Icons.keyboard_arrow_left,
            onTap: () => onKey('\x1b[D'),
            repeatable: true,
          ),
          _KeyButton(
            icon: Icons.keyboard_arrow_right,
            onTap: () => onKey('\x1b[C'),
            repeatable: true,
          ),
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

class _KeyButton extends StatefulWidget {
  const _KeyButton({
    this.label,
    this.icon,
    this.tooltip,
    required this.onTap,
    this.active = false,
    this.repeatable = false,
  });

  final String? label;
  final IconData? icon;
  final String? tooltip;
  final VoidCallback onTap;
  final bool active;

  /// Auto-repeats [onTap] while held, mirroring OS key-repeat (issue #67).
  /// Set only on the four arrow keys — every other key stays tap-once.
  final bool repeatable;

  @override
  State<_KeyButton> createState() => _KeyButtonState();
}

class _KeyButtonState extends State<_KeyButton> {
  static const _initialDelay = Duration(milliseconds: 450);
  static const _repeatInterval = Duration(milliseconds: 55);

  // Key for the Listener's own RenderBox, so a slide-off can be measured
  // against this button's bounds specifically (not some ancestor's).
  final _pointerAreaKey = GlobalKey();
  Timer? _delayTimer;
  Timer? _repeatTimer;

  void _stopRepeat() {
    _delayTimer?.cancel();
    _delayTimer = null;
    _repeatTimer?.cancel();
    _repeatTimer = null;
  }

  void _startRepeat() {
    // Defensive reset in case a previous press's up/cancel was missed.
    _stopRepeat();
    widget.onTap(); // fire immediately — a quick tap must emit exactly once
    _delayTimer = Timer(_initialDelay, () {
      _repeatTimer = Timer.periodic(_repeatInterval, (_) => widget.onTap());
    });
  }

  void _handlePointerMove(PointerMoveEvent event) {
    final box = _pointerAreaKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null) return;
    if (!(Offset.zero & box.size).contains(event.localPosition)) {
      _stopRepeat(); // slid off the button — stop like a pointer-leave
    }
  }

  @override
  void dispose() {
    _stopRepeat();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final active = widget.active;
    final color = active
        ? theme.colorScheme.primary
        : theme.colorScheme.onSurfaceVariant;
    final content = Container(
      width: 36,
      alignment: Alignment.center,
      child: widget.icon != null
          ? Icon(widget.icon, size: 18, color: color)
          : Text(
              widget.label ?? '',
              style: theme.textTheme.labelLarge?.copyWith(color: color),
            ),
    );
    // Repeatable buttons drive the emit entirely from raw pointer events
    // (down = fire + arm repeat, up/cancel/move-off = stop) so InkWell's own
    // tap callback stays a no-op — it only keeps the ink splash visual, it
    // must never also call onTap or a tap would fire twice.
    final inkWell = InkWell(
      onTap: widget.repeatable ? () {} : widget.onTap,
      borderRadius: BorderRadius.circular(AppShape.small),
      child: content,
    );
    final tappable = widget.repeatable
        ? Listener(
            key: _pointerAreaKey,
            behavior: HitTestBehavior.opaque,
            onPointerDown: (_) => _startRepeat(),
            onPointerUp: (_) => _stopRepeat(),
            onPointerCancel: (_) => _stopRepeat(),
            onPointerMove: _handlePointerMove,
            child: inkWell,
          )
        : inkWell;
    final button = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 3),
      child: Material(
        color: active ? theme.colorScheme.primaryContainer : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppShape.small),
          side: BorderSide(color: color.withValues(alpha: active ? 1 : 0.4)),
        ),
        child: tappable,
      ),
    );
    return widget.tooltip == null
        ? button
        : Tooltip(message: widget.tooltip!, child: button);
  }
}
