/// App-wide theme: dark Material 3, dynamic color OFF, palette pinned to
/// `../docs/COMPANION-APP-UI-SPEC.md` §0.1 (mirrors the web terminal's own palette).
library;

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

/// Raw palette tokens — spec §0.1. Kept as plain [Color] constants (not just
/// baked into [ColorScheme]) so widgets can reach a token the M3
/// [ColorScheme] has no slot for (e.g. [onSurfaceDisabled]).
abstract final class AppColors {
  static const background = Color(0xFF121622);
  static const surface = Color(0xFF16213E);
  static const surfaceContainer = Color(0xFF192743);
  static const surfaceContainerHigh = Color(0xFF1E3050);
  static const outline = Color(0xFF24405F);
  static const outlineVariant = Color(0xFF0F3460);
  static const onSurface = Color(0xFFE0E0E0);
  static const onSurfaceVariant = Color(0xFF8899AA);
  static const onSurfaceDisabled = Color(0xFF4A5568);
  static const primary = Color(0xFF00D4AA);
  static const onPrimary = Color(0xFF1A1A2E);
  static const primaryContainer = Color(0xFF0D2E29);
  static const onPrimaryContainer = Color(0xFF00D4AA);
  static const error = Color(0xFFFF2D4B);
  static const errorContainer = Color(0xFF2B0F16);
}

/// 4dp-grid spacing tokens — spec §0.4.
abstract final class AppSpacing {
  static const grid = 4.0;
  static const screenPadding = 16.0;
  static const cardPadding = 16.0;
  static const listRowVertical = 12.0;
  static const listRowHorizontal = 16.0;
}

/// Corner radii — spec §0.4 (Large: sheets/dialogs, Medium: cards/banners,
/// Small: chips/badges).
abstract final class AppShape {
  static const large = 12.0;
  static const medium = 8.0;
  static const small = 4.0;
}

/// Builds the app's single dark [ThemeData]. Dynamic color is intentionally
/// never wired in — the palette above is always used verbatim.
class AppTheme {
  AppTheme._();

  static ThemeData get dark {
    final colorScheme = const ColorScheme.dark().copyWith(
      brightness: Brightness.dark,
      surface: AppColors.surface,
      onSurface: AppColors.onSurface,
      onSurfaceVariant: AppColors.onSurfaceVariant,
      surfaceContainer: AppColors.surfaceContainer,
      surfaceContainerHigh: AppColors.surfaceContainerHigh,
      outline: AppColors.outline,
      outlineVariant: AppColors.outlineVariant,
      primary: AppColors.primary,
      onPrimary: AppColors.onPrimary,
      primaryContainer: AppColors.primaryContainer,
      onPrimaryContainer: AppColors.onPrimaryContainer,
      // Single-accent app: alias secondary/tertiary onto the same teal so no
      // stock M3 widget introduces an off-brand purple.
      secondary: AppColors.primary,
      onSecondary: AppColors.onPrimary,
      secondaryContainer: AppColors.primaryContainer,
      onSecondaryContainer: AppColors.onPrimaryContainer,
      tertiary: AppColors.primary,
      onTertiary: AppColors.onPrimary,
      tertiaryContainer: AppColors.primaryContainer,
      onTertiaryContainer: AppColors.onPrimaryContainer,
      error: AppColors.error,
      onError: Colors.white,
      errorContainer: AppColors.errorContainer,
      onErrorContainer: AppColors.error,
      // Flat surfaces everywhere — no M3 primary-tinted elevation overlay.
      surfaceTint: Colors.transparent,
    );

    final baseText = ThemeData(
      brightness: Brightness.dark,
      useMaterial3: true,
    ).textTheme;
    final textTheme = baseText
        .copyWith(
          titleLarge: baseText.titleLarge?.copyWith(
            fontSize: 22,
            fontWeight: FontWeight.w500,
          ),
          titleMedium: baseText.titleMedium?.copyWith(
            fontSize: 16,
            fontWeight: FontWeight.w600,
          ),
          bodyLarge: baseText.bodyLarge?.copyWith(
            fontSize: 16,
            fontWeight: FontWeight.w400,
          ),
          bodyMedium: baseText.bodyMedium?.copyWith(
            fontSize: 14,
            fontWeight: FontWeight.w400,
          ),
          bodySmall: baseText.bodySmall?.copyWith(
            fontSize: 12,
            fontWeight: FontWeight.w400,
          ),
          labelLarge: baseText.labelLarge?.copyWith(
            fontSize: 14,
            fontWeight: FontWeight.w500,
          ),
          labelSmall: baseText.labelSmall?.copyWith(
            fontSize: 11,
            fontWeight: FontWeight.w500,
          ),
        )
        .apply(
          bodyColor: AppColors.onSurface,
          displayColor: AppColors.onSurface,
        );

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: AppColors.background,
      textTheme: textTheme,
      dividerColor: AppColors.outlineVariant,
      appBarTheme: AppBarTheme(
        backgroundColor: AppColors.background,
        foregroundColor: AppColors.onSurface,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: textTheme.titleLarge,
      ),
      cardTheme: CardThemeData(
        color: AppColors.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppShape.medium),
          side: const BorderSide(color: AppColors.outlineVariant),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: AppColors.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppShape.large),
        ),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: AppColors.surface,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(AppShape.large),
          ),
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: AppColors.surfaceContainer,
        side: const BorderSide(color: AppColors.outlineVariant),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppShape.small),
        ),
        labelStyle: textTheme.labelSmall,
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: AppColors.surfaceContainerHigh,
        surfaceTintColor: Colors.transparent,
      ),
      snackBarTheme: const SnackBarThemeData(
        backgroundColor: AppColors.surfaceContainerHigh,
        contentTextStyle: TextStyle(color: AppColors.onSurface),
      ),
      floatingActionButtonTheme: const FloatingActionButtonThemeData(
        backgroundColor: AppColors.primary,
        foregroundColor: AppColors.onPrimary,
      ),
      dividerTheme: const DividerThemeData(color: AppColors.outlineVariant),
    );
  }

  /// [TerminalTheme] for the native `xterm` view in `SessionScreen`, tuned to
  /// sit inside the same dark palette rather than xterm's stock defaults.
  static const TerminalTheme terminal = TerminalTheme(
    cursor: AppColors.primary,
    selection: Color(0x4D00D4AA), // primary @ 30%
    foreground: AppColors.onSurface,
    background: AppColors.background,
    black: Color(0xFF2E3440),
    red: Color(0xFFE94560),
    green: Color(0xFF44AA44),
    yellow: Color(0xFFDDAA44),
    blue: Color(0xFF4A9EFF),
    magenta: Color(0xFFAA44AA),
    cyan: AppColors.primary,
    white: AppColors.onSurface,
    brightBlack: AppColors.onSurfaceDisabled,
    brightRed: AppColors.error,
    brightGreen: Color(0xFF66CC66),
    brightYellow: Color(0xFFFFCC66),
    brightBlue: Color(0xFF66AAFF),
    brightMagenta: Color(0xFFCC66CC),
    brightCyan: Color(0xFF33E0C0),
    brightWhite: Colors.white,
    searchHitBackground: AppColors.primaryContainer,
    searchHitBackgroundCurrent: AppColors.primary,
    searchHitForeground: AppColors.onPrimary,
  );
}
