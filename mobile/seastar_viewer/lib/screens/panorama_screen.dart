import 'dart:async';
import 'package:flutter/material.dart';
import 'package:panorama_viewer/panorama_viewer.dart';
import '../config.dart';
import '../models/pin.dart';
import '../services/api_service.dart';
import '../widgets/smart_image.dart';

/// 360° 파노라마 뷰어 화면.
/// drawing_screen 의 핀 클릭 → THETA 360 이미지를 전방위로 표시.
/// 핀의 imageUrl(인라인 dataURL/절대 URL) 우선, 없으면 imageId 로 백엔드에서 가져옴.
class PanoramaScreen extends StatefulWidget {
  final Pin pin;
  const PanoramaScreen({super.key, required this.pin});

  @override
  State<PanoramaScreen> createState() => _PanoramaScreenState();
}

class _PanoramaScreenState extends State<PanoramaScreen> {
  final _api = ApiService();
  bool _loading = true;
  bool _error = false;
  String _errMsg = '';
  ImageProvider? _provider;
  bool _info = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = false;
      _errMsg = '';
    });
    try {
      // 1) 이미지 소스(dataURL/URL) 결정
      String? src;
      final inline = widget.pin.panoUrl(AppConfig.kApiBaseUrl);
      if (inline != null &&
          (inline.startsWith('data:') || inline.startsWith('http'))) {
        src = inline;
      } else if (widget.pin.imageId != null &&
          widget.pin.imageId!.isNotEmpty) {
        // imageId → 백엔드에서 image_data(dataURL) fetch
        src = await _api.fetchPanoImageData(widget.pin.imageId!);
      }
      if (src == null || src.isEmpty) {
        setState(() {
          _loading = false;
          _error = true;
          _errMsg = '연결된 파노라마 이미지가 없습니다';
        });
        return;
      }

      // 2) 이미지 디코드 후 로딩/에러 상태 확정
      final provider = panoImageProvider(src);
      final stream = provider.resolve(const ImageConfiguration());
      final completer = _ImageLoadCompleter();
      late final ImageStreamListener listener;
      listener = ImageStreamListener(
        (img, _) => completer.done(),
        onError: (e, st) => completer.fail(),
      );
      stream.addListener(listener);
      await completer.future;
      stream.removeListener(listener);
      if (!mounted) return;
      setState(() {
        _provider = provider;
        _loading = false;
        _error = completer.failed;
        if (completer.failed) _errMsg = '이미지를 표시할 수 없습니다';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = true;
        _errMsg = '불러오기 실패: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: const Color(AppConfig.kDeepBlue),
        foregroundColor: Colors.white,
        title: Text(
          widget.pin.label.isEmpty ? '360° 파노라마' : widget.pin.label,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        actions: [
          if (widget.pin.hasInfo)
            IconButton(
              tooltip: '정보',
              icon: Icon(_info ? Icons.info : Icons.info_outline),
              onPressed: () => setState(() => _info = !_info),
            ),
        ],
      ),
      body: Stack(
        children: [
          Positioned.fill(child: _buildViewer()),
          if (_info && widget.pin.hasInfo) _buildInfoCard(),
          if (!_loading && !_error)
            const Positioned(
              left: 0,
              right: 0,
              bottom: 14,
              child: IgnorePointer(
                child: Center(
                  child: Text(
                    '드래그하여 둘러보기  ·  핀치로 확대',
                    style: TextStyle(
                      color: Colors.white60,
                      fontSize: 12,
                      shadows: [Shadow(color: Colors.black, blurRadius: 6)],
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildViewer() {
    if (_loading) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(
                strokeWidth: 2.5, color: Color(AppConfig.kGold)),
            SizedBox(height: 16),
            Text('파노라마 불러오는 중…',
                style: TextStyle(color: Colors.white70, fontSize: 13)),
          ],
        ),
      );
    }
    if (_error || _provider == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.broken_image_outlined,
                  color: Colors.white24, size: 56),
              const SizedBox(height: 14),
              Text(_errMsg.isEmpty ? '파노라마를 불러올 수 없습니다' : _errMsg,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white70, fontSize: 14)),
              const SizedBox(height: 6),
              const Text('연결 상태 또는 이미지 주소를 확인하세요',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white38, fontSize: 12)),
              const SizedBox(height: 18),
              OutlinedButton.icon(
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.white,
                  side: const BorderSide(color: Colors.white24),
                ),
                onPressed: _load,
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('다시 시도'),
              ),
            ],
          ),
        ),
      );
    }
    return PanoramaViewer(
      sensitivity: 1.4,
      sensorControl: SensorControl.none,
      child: Image(image: _provider!),
    );
  }

  Widget _buildInfoCard() {
    final p = widget.pin;
    return Positioned(
      left: 14,
      right: 14,
      top: 14,
      child: Material(
        color: Colors.transparent,
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: const Color(0xEE0A2540),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: const Color(0x33C9A227)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  const Icon(Icons.place,
                      color: Color(AppConfig.kGold), size: 18),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      p.label.isEmpty ? '핀 정보' : p.label,
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 15,
                          fontWeight: FontWeight.w700),
                    ),
                  ),
                  if (p.has3D)
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: const Color(0x331B75BB),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: const Text('🧊 3D',
                          style: TextStyle(
                              color: Color(0xFF6FB7E8), fontSize: 11)),
                    ),
                ],
              ),
              if ((p.note ?? '').isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(p.note!,
                    style: const TextStyle(
                        color: Colors.white70, fontSize: 13, height: 1.5)),
              ],
              if (p.has3D && (p.flsName ?? '').isNotEmpty) ...[
                const SizedBox(height: 10),
                Row(
                  children: [
                    const Icon(Icons.view_in_ar,
                        color: Color(0xFF6FB7E8), size: 15),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        '${p.flsName!}\n(3D 포인트클라우드는 데스크톱 웹 뷰어에서 표시)',
                        style: const TextStyle(
                            color: Colors.white54, fontSize: 12, height: 1.4),
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 이미지 로딩 완료/실패를 한 번만 처리하는 헬퍼
class _ImageLoadCompleter {
  bool _completed = false;
  bool failed = false;
  final Completer<void> _c = Completer<void>();
  Future<void> get future => _c.future;

  void done() {
    if (_completed) return;
    _completed = true;
    _c.complete();
  }

  void fail() {
    if (_completed) return;
    _completed = true;
    failed = true;
    _c.complete();
  }
}
