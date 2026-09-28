import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class CustomTextEdit extends StatefulWidget {
  CustomTextEdit({
    super.key,
    required this.child,
    required this.onInsert,
    required this.onDelete,
    required this.onComposing,
    required this.onAction,
    required this.onKeyEvent,
    required this.focusNode,
    this.autofocus = false,
    this.readOnly = false,
    // this.initEditingState = TextEditingValue.empty,
    this.inputType = TextInputType.text,
    this.inputAction = TextInputAction.newline,
    this.keyboardAppearance = Brightness.light,
    this.deleteDetection = false,
  });

  final Widget child;

  final void Function(String) onInsert;

  final void Function() onDelete;

  final void Function(String?) onComposing;

  final void Function(TextInputAction) onAction;

  final KeyEventResult Function(FocusNode, KeyEvent) onKeyEvent;

  final FocusNode focusNode;

  final bool autofocus;

  final bool readOnly;

  final TextInputType inputType;

  final TextInputAction inputAction;

  final Brightness keyboardAppearance;

  final bool deleteDetection;

  @override
  CustomTextEditState createState() => CustomTextEditState();
}

class CustomTextEditState extends State<CustomTextEdit> with TextInputClient {
  TextInputConnection? _connection;

  @override
  void initState() {
    widget.focusNode.addListener(_onFocusChange);
    super.initState();
  }

  @override
  void didUpdateWidget(CustomTextEdit oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.focusNode != oldWidget.focusNode) {
      oldWidget.focusNode.removeListener(_onFocusChange);
      widget.focusNode.addListener(_onFocusChange);
    }

    if (!_shouldCreateInputConnection) {
      _closeInputConnectionIfNeeded();
    } else {
      if (oldWidget.readOnly && widget.focusNode.hasFocus) {
        _openInputConnection();
      }
    }
  }

  @override
  void dispose() {
    widget.focusNode.removeListener(_onFocusChange);
    _closeInputConnectionIfNeeded();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Focus(
      focusNode: widget.focusNode,
      autofocus: widget.autofocus,
      onKeyEvent: _onKeyEvent,
      child: widget.child,
    );
  }

  bool get hasInputConnection => _connection != null && _connection!.attached;

  void requestKeyboard() {
    if (widget.focusNode.hasFocus) {
      _openInputConnection();
    } else {
      widget.focusNode.requestFocus();
    }
  }

  void closeKeyboard() {
    if (hasInputConnection) {
      _connection?.close();
    }
  }

  void setEditingState(TextEditingValue value) {
    _currentEditingState = value;
    _connection?.setEditingState(value);
  }

  void setEditableRect(Rect rect, Rect caretRect) {
    if (!hasInputConnection) {
      return;
    }

    _connection?.setEditableSizeAndTransform(
      rect.size,
      Matrix4.translationValues(0, 0, 0),
    );

    _connection?.setCaretRect(caretRect);
  }

  void _onFocusChange() {
    _openOrCloseInputConnectionIfNeeded();
  }

  KeyEventResult _onKeyEvent(FocusNode focusNode, KeyEvent event) {
    if (_currentEditingState.composing.isCollapsed) {
      return widget.onKeyEvent(focusNode, event);
    }

    return KeyEventResult.skipRemainingHandlers;
  }

  void _openOrCloseInputConnectionIfNeeded() {
    if (widget.focusNode.hasFocus && widget.focusNode.consumeKeyboardToken()) {
      _openInputConnection();
    } else if (!widget.focusNode.hasFocus) {
      _closeInputConnectionIfNeeded();
    }
  }

  bool get _shouldCreateInputConnection => kIsWeb || !widget.readOnly;

  void _openInputConnection() {
    if (!_shouldCreateInputConnection) {
      return;
    }

    if (hasInputConnection) {
      _connection!.show();
    } else {
      final config = TextInputConfiguration(
        inputType: widget.inputType,
        inputAction: widget.inputAction,
        keyboardAppearance: widget.keyboardAppearance,
        autocorrect: false,
        enableSuggestions: false,
        enableIMEPersonalizedLearning: false,
      );

      _connection = TextInput.attach(this, config);

      _connection!.show();

      // setEditableRect(Rect.zero, Rect.zero);

      // WEB-TERMINAL PATCH (#283): a fresh connection starts from an empty
      // buffer, so nothing of it has been sent. A word left composing when the
      // last one closed stays typed in the terminal, as it was already shown.
      _sent = '';
      _currentEditingState = _initEditingState.copyWith();
      _connection!.setEditingState(_initEditingState);
    }
  }

  void _closeInputConnectionIfNeeded() {
    if (_connection != null && _connection!.attached) {
      _connection!.close();
      _connection = null;
    }
  }

  TextEditingValue get _initEditingState => widget.deleteDetection
      ? const TextEditingValue(
          text: '  ',
          selection: TextSelection.collapsed(offset: 2),
        )
      : const TextEditingValue(
          text: '',
          selection: TextSelection.collapsed(offset: 0),
        );

  late var _currentEditingState = _initEditingState.copyWith();

  @override
  TextEditingValue? get currentTextEditingValue {
    return _currentEditingState;
  }

  @override
  AutofillScope? get currentAutofillScope {
    return null;
  }

  // WEB-TERMINAL PATCH (#283): what of the IME buffer (the text past
  // [_initEditingState]) has already been forwarded to the terminal. Stock sent
  // nothing until the composing region collapsed, so on a soft keyboard with
  // suggestions the word being typed never reached the PTY: it was painted as an
  // overlay at a cursor that did not move until Space committed it.
  String _sent = '';

  // WEB-TERMINAL PATCH (#283): make the terminal hold [target] where it now
  // holds [_sent] — backspace over whatever follows their common prefix, then
  // type the rest. One rule covers typing, a suggestion tap, autocorrect on
  // commit and a dictation rewrite. Counted in grapheme clusters: one DEL per
  // visible character, which is what Claude's TUI erases and never more than a
  // readline rubout does (a ZWJ emoji can take readline several).
  //
  // `_sent` is recorded BEFORE anything is emitted: a consumer that writes to
  // the terminal from inside the callback (a sticky modifier) calls
  // [finishComposing], and that reset must survive this call returning.
  void _mirror(String target) {
    final sent = _sent.characters.toList();
    final next = target.characters.toList();
    var common = 0;
    while (common < sent.length &&
        common < next.length &&
        sent[common] == next[common]) {
      common++;
    }
    _sent = target;
    for (var i = common; i < sent.length; i++) {
      widget.onDelete();
    }
    if (common < next.length) {
      widget.onInsert(next.sublist(common).join());
    }
  }

  /// WEB-TERMINAL PATCH (#283): the terminal is about to receive input that
  /// did not come from the IME (a key-strip key, a paste, a sticky modifier).
  /// [_mirror] assumes the characters before the cursor are exactly [_sent];
  /// after such a write they are not, and the next rewrite of the composing
  /// word would backspace over text that word never typed. So the word is
  /// left as typed — it is already in the terminal — and the IME starts over.
  ///
  /// Only an ATTACHED connection is told. `closeKeyboard` closes one without
  /// nulling it, and a detached `TextInputConnection.setEditingState` asserts
  /// in debug and in release reaches whichever client is attached NOW - the
  /// compose bar, whose draft it would silently empty.
  void finishComposing() {
    _sent = '';
    final init = _initEditingState;
    if (_currentEditingState.text == init.text &&
        _currentEditingState.composing.isCollapsed) {
      return;
    }
    _currentEditingState = init.copyWith();
    if (hasInputConnection) {
      _connection!.setEditingState(init);
    }
  }

  @override
  void updateEditingValue(TextEditingValue value) {
    _currentEditingState = value;

    // WEB-TERMINAL PATCH (#283): the composing word is forwarded as it changes
    // (see [_mirror]) instead of being painted as an overlay, so no overlay is
    // ever shown. The IME keeps its buffer until it commits.
    widget.onComposing(null);

    final text = _currentEditingState.text;
    final init = _initEditingState.text;
    if (!_currentEditingState.composing.isCollapsed) {
      if (text.startsWith(init)) {
        _mirror(text.substring(init.length));
      }
      return;
    }

    if (text.length < init.length) {
      _mirror('');
      widget.onDelete();
    } else {
      _mirror(text.substring(init.length));
    }
    _sent = '';

    // Reset editing state if composing is done
    if (_currentEditingState.composing.isCollapsed &&
        _currentEditingState.text != _initEditingState.text) {
      _connection!.setEditingState(_initEditingState);
    }
  }

  @override
  void performAction(TextInputAction action) {
    // print('performAction $action');
    widget.onAction(action);
  }

  @override
  void updateFloatingCursor(RawFloatingCursorPoint point) {
    // print('updateFloatingCursor $point');
  }

  @override
  void showAutocorrectionPromptRect(int start, int end) {
    // print('showAutocorrectionPromptRect');
  }

  @override
  void connectionClosed() {
    // print('connectionClosed');
  }

  @override
  void performPrivateCommand(String action, Map<String, dynamic> data) {
    // print('performPrivateCommand $action');
  }

  @override
  void insertTextPlaceholder(Size size) {
    // print('insertTextPlaceholder');
  }

  @override
  void removeTextPlaceholder() {
    // print('removeTextPlaceholder');
  }

  @override
  void showToolbar() {
    // print('showToolbar');
  }
}
