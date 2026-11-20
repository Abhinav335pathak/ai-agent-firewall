import 'package:flutter/material.dart';

// Shared visual language with the web firewall console.
abstract final class FirewallColors {
  static const background = Color(0xFF0E1116);
  static const surface = Color(0xFF161B22);
  static const elevated = Color(0xFF1D2530);
  static const border = Color(0xFF2A313C);
  static const text = Color(0xFFE6EDF3);
  static const muted = Color(0xFFA5B0BC);
  static const blue = Color(0xFF58A6FF);
  static const green = Color(0xFF3FB950);
  static const amber = Color(0xFFD29922);
  static const red = Color(0xFFF85149);
}

ThemeData firewallTheme() {
  final scheme = const ColorScheme.dark(
    primary: FirewallColors.blue,
    onPrimary: FirewallColors.background,
    secondary: FirewallColors.blue,
    onSecondary: FirewallColors.background,
    surface: FirewallColors.surface,
    onSurface: FirewallColors.text,
    error: FirewallColors.red,
    onError: FirewallColors.background,
    outline: FirewallColors.border,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    scaffoldBackgroundColor: FirewallColors.background,
    dividerColor: FirewallColors.border,
    appBarTheme: const AppBarTheme(
      backgroundColor: FirewallColors.background,
      foregroundColor: FirewallColors.text,
      elevation: 0,
    ),
    cardTheme: CardThemeData(
      color: FirewallColors.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: FirewallColors.border),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: FirewallColors.surface,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: FirewallColors.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: FirewallColors.border),
      ),
    ),
    navigationBarTheme: const NavigationBarThemeData(
      backgroundColor: FirewallColors.surface,
      indicatorColor: FirewallColors.elevated,
      elevation: 0,
    ),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: FirewallColors.elevated,
      contentTextStyle: TextStyle(color: FirewallColors.text),
    ),
  );
}
