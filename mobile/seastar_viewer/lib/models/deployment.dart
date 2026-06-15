import 'dart:convert';
import 'pin.dart';

/// 배포본(도면 스냅샷 + 핀들) 모델
class Deployment {
  final String id;
  final String title;
  final String? fileName;
  final int createdAt;
  final List<String> pagesData; // 페이지별 이미지 dataURL/URL
  final List<Pin> pins;

  Deployment({
    required this.id,
    required this.title,
    this.fileName,
    this.createdAt = 0,
    this.pagesData = const [],
    this.pins = const [],
  });

  /// 목록용(가벼운) 파싱 — pages_data/pins 없이 메타만
  factory Deployment.summary(Map<String, dynamic> j) {
    int toI(dynamic v) =>
        v == null ? 0 : (v is num ? v.toInt() : int.tryParse('$v') ?? 0);
    return Deployment(
      id: '${j['id'] ?? ''}',
      title: '${j['title'] ?? j['file_name'] ?? '제목 없음'}',
      fileName: j['file_name']?.toString(),
      createdAt: toI(j['created_at']),
    );
  }

  /// 상세 파싱 — pages_data, pins(문자열일 수 있음) 안전 처리
  factory Deployment.detail(Map<String, dynamic> j) {
    int toI(dynamic v) =>
        v == null ? 0 : (v is num ? v.toInt() : int.tryParse('$v') ?? 0);

    List<String> pages = [];
    final pd = j['pages_data'] ?? j['pagesData'];
    if (pd is List) {
      pages = pd.map((e) => '$e').toList();
    } else if (pd is String && pd.isNotEmpty) {
      try {
        final dec = jsonDecode(pd);
        if (dec is List) pages = dec.map((e) => '$e').toList();
      } catch (_) {
        pages = [pd];
      }
    }

    List<Pin> pins = [];
    final raw = j['pins'];
    dynamic pinsJson = raw;
    if (raw is String && raw.isNotEmpty) {
      try {
        pinsJson = jsonDecode(raw);
      } catch (_) {
        pinsJson = [];
      }
    }
    if (pinsJson is List) {
      pins = pinsJson
          .whereType<Map<String, dynamic>>()
          .map((m) => Pin.fromJson(m))
          .toList();
    }

    return Deployment(
      id: '${j['id'] ?? ''}',
      title: '${j['title'] ?? j['file_name'] ?? '제목 없음'}',
      fileName: j['file_name']?.toString(),
      createdAt: toI(j['created_at']),
      pagesData: pages,
      pins: pins,
    );
  }

  int get pageCount => pagesData.length;
  List<Pin> pinsOnPage(int page) => pins.where((p) => p.page == page).toList();
}
