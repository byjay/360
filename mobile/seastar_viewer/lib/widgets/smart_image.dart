import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';

/// dataURL(base64) 또는 네트워크 URL 을 자동 판별해 표시
class SmartImage extends StatelessWidget {
  final String src;
  final BoxFit fit;
  const SmartImage(this.src, {super.key, this.fit = BoxFit.contain});

  bool get _isData => src.startsWith('data:');

  Uint8List? get _bytes {
    try {
      final i = src.indexOf(',');
      if (i < 0) return null;
      return base64Decode(src.substring(i + 1));
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isData) {
      final b = _bytes;
      if (b == null) return _err();
      return Image.memory(b, fit: fit, gaplessPlayback: true,
          errorBuilder: (_, __, ___) => _err());
    }
    return CachedNetworkImage(
      imageUrl: src,
      fit: fit,
      placeholder: (_, __) => const Center(
          child: CircularProgressIndicator(strokeWidth: 2)),
      errorWidget: (_, __, ___) => _err(),
    );
  }

  Widget _err() => Container(
        color: const Color(0xFF13202F),
        child: const Center(
          child: Icon(Icons.broken_image_outlined,
              color: Colors.white24, size: 40),
        ),
      );
}

/// 360 파노라마용 ImageProvider 반환 (dataURL/네트워크 모두 지원)
ImageProvider panoImageProvider(String src) {
  if (src.startsWith('data:')) {
    final i = src.indexOf(',');
    return MemoryImage(base64Decode(src.substring(i + 1)));
  }
  return CachedNetworkImageProvider(src);
}
