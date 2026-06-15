import 'package:flutter/material.dart';
import '../config.dart';
import '../models/deployment.dart';
import '../services/api_service.dart';
import 'drawing_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _api = ApiService();
  late Future<List<Deployment>> _future;

  @override
  void initState() {
    super.initState();
    _future = _api.fetchDeployments();
  }

  Future<void> _refresh() async {
    setState(() => _future = _api.fetchDeployments());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: const Color(AppConfig.kDeepBlue),
        foregroundColor: Colors.white,
        elevation: 0,
        title: Row(
          children: [
            Container(
              width: 26, height: 26,
              decoration: BoxDecoration(
                color: const Color(AppConfig.kGold),
                borderRadius: BorderRadius.circular(6),
              ),
              child: const Icon(Icons.anchor, size: 16, color: Color(AppConfig.kDeepBlue)),
            ),
            const SizedBox(width: 10),
            const Text('SEASTAR 뷰어',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
          ],
        ),
        actions: [
          IconButton(onPressed: _refresh, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: FutureBuilder<List<Deployment>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState == ConnectionState.waiting) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snap.hasError) {
              return _errorView(snap.error.toString());
            }
            final list = snap.data ?? [];
            if (list.isEmpty) return _emptyView();
            return ListView.separated(
              padding: const EdgeInsets.all(14),
              itemCount: list.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (_, i) => _card(list[i]),
            );
          },
        ),
      ),
    );
  }

  Widget _card(Deployment d) {
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => Navigator.push(context,
          MaterialPageRoute(builder: (_) => DrawingScreen(deploymentId: d.id, title: d.title))),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          boxShadow: [BoxShadow(color: Colors.black.withOpacity(.06), blurRadius: 10, offset: const Offset(0, 3))],
        ),
        child: Row(
          children: [
            Container(
              width: 46, height: 46,
              decoration: BoxDecoration(
                color: const Color(AppConfig.kAccentBlue).withOpacity(.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(Icons.map_outlined, color: Color(AppConfig.kAccentBlue)),
            ),
            const SizedBox(width: 13),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(d.title,
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                      maxLines: 1, overflow: TextOverflow.ellipsis),
                  const SizedBox(height: 3),
                  Text(d.fileName ?? '도면',
                      style: TextStyle(color: Colors.grey.shade600, fontSize: 12.5),
                      maxLines: 1, overflow: TextOverflow.ellipsis),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: Colors.grey),
          ],
        ),
      ),
    );
  }

  Widget _emptyView() => ListView(children: [
        const SizedBox(height: 120),
        Icon(Icons.inbox_outlined, size: 56, color: Colors.grey.shade400),
        const SizedBox(height: 12),
        const Center(child: Text('배포된 도면이 없습니다', style: TextStyle(color: Colors.grey))),
      ]);

  Widget _errorView(String msg) => ListView(children: [
        const SizedBox(height: 110),
        const Icon(Icons.cloud_off, size: 52, color: Colors.redAccent),
        const SizedBox(height: 12),
        const Center(child: Text('서버에 연결할 수 없습니다', style: TextStyle(fontWeight: FontWeight.w600))),
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 30),
          child: Text(msg, textAlign: TextAlign.center,
              style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
        ),
        const SizedBox(height: 16),
        Center(
          child: OutlinedButton.icon(
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
            label: const Text('다시 시도'),
          ),
        ),
      ]);
}
