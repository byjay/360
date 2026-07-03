import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';
import '../models/deployment.dart';

/// 백엔드 REST API 클라이언트
class ApiService {
  final String baseUrl;
  ApiService({String? base}) : baseUrl = base ?? AppConfig.kApiBaseUrl;

  Map<String, String> get _headers => {'Accept': 'application/json'};

  /// 배포본 목록 — { data: [...] } 또는 [...] 모두 지원
  Future<List<Deployment>> fetchDeployments() async {
    final uri = Uri.parse('$baseUrl/tables/deployments?limit=100');
    final res = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) {
      throw Exception('목록 조회 실패 (HTTP ${res.statusCode})');
    }
    final body = jsonDecode(utf8.decode(res.bodyBytes));
    List list;
    if (body is List) {
      list = body;
    } else if (body is Map && body['data'] is List) {
      list = body['data'];
    } else if (body is Map && body['deployments'] is List) {
      list = body['deployments'];
    } else {
      list = [];
    }
    return list
        .whereType<Map<String, dynamic>>()
        .map((m) => Deployment.summary(m))
        .toList();
  }

  /// 단일 배포본 상세
  Future<Deployment> fetchDeployment(String id) async {
    final uri = Uri.parse('$baseUrl/tables/deployments/$id');
    final res = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 30));
    if (res.statusCode != 200) {
      throw Exception('상세 조회 실패 (HTTP ${res.statusCode})');
    }
    final body = jsonDecode(utf8.decode(res.bodyBytes));
    final map = (body is Map && body['data'] is Map)
        ? body['data'] as Map<String, dynamic>
        : body as Map<String, dynamic>;
    return Deployment.detail(map);
  }

  /// pano_images 단건 조회 → image_data(dataURL) 반환
  /// 핀이 imageUrl(인라인 dataURL) 대신 imageId 만 가진 경우 사용.
  Future<String?> fetchPanoImageData(String imageId) async {
    final uri = Uri.parse('$baseUrl/tables/pano_images/$imageId');
    final res = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 30));
    if (res.statusCode != 200) {
      throw Exception('이미지 조회 실패 (HTTP ${res.statusCode})');
    }
    final body = jsonDecode(utf8.decode(res.bodyBytes));
    final map = (body is Map && body['data'] is Map)
        ? body['data'] as Map<String, dynamic>
        : (body is Map ? body : <String, dynamic>{});
    final data = map['image_data'];
    if (data is String && data.isNotEmpty) return data;
    return null;
  }
}
