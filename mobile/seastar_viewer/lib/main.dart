import 'package:flutter/material.dart';
import 'config.dart';
import 'screens/home_screen.dart';

void main() => runApp(const SeastarApp());

class SeastarApp extends StatelessWidget {
  const SeastarApp({super.key});

  @override
  Widget build(BuildContext context) {
    final base = ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(AppConfig.kAccentBlue),
        primary: const Color(AppConfig.kDeepBlue),
        secondary: const Color(AppConfig.kGold),
        brightness: Brightness.light,
      ),
      scaffoldBackgroundColor: const Color(0xFFF4F6F9),
      fontFamily: 'Roboto',
    );
    return MaterialApp(
      title: AppConfig.appName,
      debugShowCheckedModeBanner: false,
      theme: base,
      home: const HomeScreen(),
    );
  }
}
