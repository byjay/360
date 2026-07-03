/// 도면 위 핀(포인트) 모델 — 백엔드 pins JSON 과 매핑
class Pin {
  final String id;
  final double x; // 0~100 (%)
  final double y; // 0~100 (%)
  final int page; // 1부터
  final String label;
  final String? imageId;
  final String? imageUrl;
  final String? note;
  final bool isVideo;
  final bool has3D;
  final String? flsName;
  final List<dynamic> attachments;

  Pin({
    required this.id,
    required this.x,
    required this.y,
    required this.page,
    required this.label,
    this.imageId,
    this.imageUrl,
    this.note,
    this.isVideo = false,
    this.has3D = false,
    this.flsName,
    this.attachments = const [],
  });

  factory Pin.fromJson(Map<String, dynamic> j) {
    double toD(dynamic v) =>
        v == null ? 0.0 : (v is num ? v.toDouble() : double.tryParse('$v') ?? 0.0);
    int toI(dynamic v) =>
        v == null ? 1 : (v is num ? v.toInt() : int.tryParse('$v') ?? 1);
    return Pin(
      id: '${j['id'] ?? ''}',
      x: toD(j['x']),
      y: toD(j['y']),
      page: toI(j['page'] ?? 1),
      label: '${j['label'] ?? '위치'}',
      imageId: j['imageId']?.toString(),
      imageUrl: j['imageUrl']?.toString(),
      note: j['note']?.toString(),
      isVideo: j['isVideo'] == true,
      has3D: j['has3D'] == true || j['flsName'] != null || j['flsUrl'] != null,
      flsName: j['flsName']?.toString(),
      attachments: (j['attachments'] is List) ? j['attachments'] as List : const [],
    );
  }

  /// 360 파노라마 이미지 표시용 URL 결정 (imageUrl 우선, 없으면 imageId 기반)
  String? panoUrl(String baseUrl) {
    if (imageUrl != null && imageUrl!.isNotEmpty) return imageUrl;
    if (imageId != null && imageId!.isNotEmpty) {
      return '$baseUrl/tables/images/$imageId';
    }
    return null;
  }

  bool get hasMedia =>
      (imageId != null && imageId!.isNotEmpty) ||
      (imageUrl != null && imageUrl!.isNotEmpty);
  bool get hasInfo => (note != null && note!.isNotEmpty) || has3D || attachments.isNotEmpty;
  bool get hasContent => hasMedia || hasInfo;
}
