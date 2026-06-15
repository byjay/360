import 'package:flutter/material.dart';
import 'package:photo_view/photo_view.dart';
import '../config.dart';
import '../models/deployment.dart';
import '../models/pin.dart';
import '../services/api_service.dart';
import '../widgets/smart_image.dart';
import 'panorama_screen.dart';

class DrawingScreen extends StatefulWidget {
  final String deploymentId;
  final String title;
  const DrawingScreen({super.key, required this.deploymentId, required this.title});
  @override
  State<DrawingScreen> createState() => _DrawingScreenState();
}

class _DrawingScreenState extends State<DrawingScreen> {
  final _api = ApiService();
  Deployment? _dep;
  int _page = 1;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await _api.fetchDeployment(widget.deploymentId);
      setState(() => _dep = d);
    } catch (e) {
      setState(() => _error = e.toString());
    }
  }

  void _openPin(Pin pin) {
    if (pin.hasMedia) {
      // imageUrl(인라인 dataURL/절대URL) 우선, 없으면 imageId 로 PanoramaScreen 이 fetch
      Navigator.push(context, MaterialPageRoute(
          builder: (_) => PanoramaScreen(pin: pin)));
    } else {
      _showInfoSheet(pin);
    }
  }

  void _showInfoSheet(Pin pin) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              const Icon(Icons.push_pin, color: Color(AppConfig.kAccentBlue)),
              const SizedBox(width: 8),
              Expanded(child: Text(pin.label,
                  style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
            ]),
            const SizedBox(height: 12),
            if (pin.note != null && pin.note!.isNotEmpty)
              Text(pin.note!, style: TextStyle(color: Colors.grey.shade800)),
            if (pin.has3D) ...[
              const SizedBox(height: 10),
              Row(children: [
                const Icon(Icons.view_in_ar, size: 18, color: Color(AppConfig.kGold)),
                const SizedBox(width: 6),
                Expanded(child: Text('3D 포인트 클라우드: ${pin.flsName ?? "연결됨"}\n(데스크톱 웹 뷰어에서 3D 표시)',
                    style: const TextStyle(fontSize: 12.5, color: Colors.black54))),
              ]),
            ],
            if (!pin.hasMedia && !pin.hasInfo)
              const Text('표시할 콘텐츠가 없습니다.', style: TextStyle(color: Colors.grey)),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0E1A28),
      appBar: AppBar(
        backgroundColor: const Color(AppConfig.kDeepBlue),
        foregroundColor: Colors.white,
        title: Text(widget.title, style: const TextStyle(fontSize: 16)),
      ),
      body: _error != null
          ? Center(child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text('불러오기 실패\n$_error',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white70)),
            ))
          : _dep == null
              ? const Center(child: CircularProgressIndicator())
              : _buildViewer(_dep!),
      bottomNavigationBar: _dep != null && _dep!.pageCount > 1
          ? _pageBar(_dep!)
          : null,
    );
  }

  Widget _buildViewer(Deployment d) {
    if (d.pageCount == 0) {
      return const Center(child: Text('도면 이미지가 없습니다', style: TextStyle(color: Colors.white54)));
    }
    final src = d.pagesData[(_page - 1).clamp(0, d.pageCount - 1)];
    final pins = d.pinsOnPage(_page);
    return LayoutBuilder(builder: (context, constraints) {
      return Stack(
        children: [
          // 줌/팬 가능한 도면 + 핀 오버레이 (PhotoView custom child)
          PhotoView.customChild(
            backgroundDecoration: const BoxDecoration(color: Color(0xFF0E1A28)),
            minScale: PhotoViewComputedScale.contained,
            maxScale: PhotoViewComputedScale.covered * 6,
            initialScale: PhotoViewComputedScale.contained,
            child: AspectRatio(
              aspectRatio: 1.414, // A4 가로 기본 (이미지가 채움)
              child: Stack(
                fit: StackFit.expand,
                children: [
                  SmartImage(src, fit: BoxFit.contain),
                  ...pins.map((p) => _pinMarker(p)),
                ],
              ),
            ),
          ),
          Positioned(
            left: 12, bottom: 12,
            child: _legend(pins.length),
          ),
        ],
      );
    });
  }

  Widget _pinMarker(Pin pin) {
    return Align(
      alignment: Alignment(
        (pin.x / 50) - 1, // 0~100% → -1~1
        (pin.y / 50) - 1,
      ),
      child: GestureDetector(
        onTap: () => _openPin(pin),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: Colors.black.withOpacity(.6),
                borderRadius: BorderRadius.circular(5),
              ),
              child: Text(pin.label,
                  style: const TextStyle(color: Colors.white, fontSize: 8.5),
                  maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
            Icon(Icons.location_on,
                color: pin.hasMedia ? const Color(AppConfig.kGold) : Colors.lightBlueAccent,
                size: 26,
                shadows: const [Shadow(color: Colors.black54, blurRadius: 3)]),
          ],
        ),
      ),
    );
  }

  Widget _legend(int count) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: Colors.black.withOpacity(.55),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text('핀 $count개 · 탭하여 360° 보기',
            style: const TextStyle(color: Colors.white70, fontSize: 11)),
      );

  Widget _pageBar(Deployment d) => Container(
        color: const Color(AppConfig.kDeepBlue),
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            IconButton(
              onPressed: _page > 1 ? () => setState(() => _page--) : null,
              icon: const Icon(Icons.chevron_left, color: Colors.white),
            ),
            Text('$_page / ${d.pageCount}',
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
            IconButton(
              onPressed: _page < d.pageCount ? () => setState(() => _page++) : null,
              icon: const Icon(Icons.chevron_right, color: Colors.white),
            ),
          ],
        ),
      );
}
