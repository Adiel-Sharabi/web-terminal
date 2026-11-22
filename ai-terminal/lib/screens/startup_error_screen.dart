import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// What the app shows when startup fails before its first real frame (#486).
///
/// The Windows runner only reveals its window after Flutter draws a frame, so
/// an exception that ends `main()` before `runApp` leaves a live process with
/// no window and no error. This is the frame drawn instead: the error, in
/// words the person can copy into an issue.
class StartupErrorApp extends StatelessWidget {
  const StartupErrorApp({super.key, required this.error});

  final Object error;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AiTerminal',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.dark,
      home: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('AiTerminal could not start',
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
                const SizedBox(height: 12),
                const Text('Reading the saved settings failed. Copy the error '
                    'below into an issue; closing and reopening the app will '
                    'not fix it on its own.'),
                const SizedBox(height: 16),
                Expanded(
                  child: SingleChildScrollView(
                    child: SelectableText('$error',
                        style: const TextStyle(fontFamily: 'monospace')),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
