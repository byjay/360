package work.seastar.scan360;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * THETA/OSC(Open Spherical Camera) 카메라 전용 네트워크 I/O.
 *
 * 🔴 [마스터 현장 이슈 2026-10-19] "THETA 와이파이에 연결하면 인터넷이 완전히 끊긴다" — 카메라
 * AP(192.168.1.1)에는 인터넷이 없어 OS 가 그 와이파이를 "기본 네트워크"로 승격시키면 앱의 다른
 * 요청(서버 업로드)까지 모두 끊긴다. 해법은 ConnectivityManager.bindProcessToNetwork(앱 전체를
 * 그 네트워크에 묶음 — 금지, 업로드까지 끊긴다)가 아니라 **Network#openConnection(URL)으로 "이
 * 요청 하나만" 그 네트워크로 보내는 것**(공식 API, android.net.Network, API 23+). 앱의 나머지
 * fetch()(scan.seastar.work 업로드 등)는 시스템 기본 네트워크(셀룰러/기존 와이파이)를 그대로 쓴다
 * — 그래서 이 플러그인은 WebView의 fetch 를 가로채지 않고(CapacitorHttp 미사용) 카메라 I/O 만
 * 전담한다. WifiNetworkSpecifier 로 연 네트워크는 addTransportType(WIFI)+removeCapability(
 * NET_CAPABILITY_INTERNET) 로 요청해 "로컬 전용(인터넷 없음)" 네트워크로 명시한다(공식 패턴 —
 * 인터넷 자격 없이 요청해야 OS 가 "쓸모없는 네트워크"로 판단해 끊지 않는다).
 *
 * cleartext(http://192.168.1.1): AndroidManifest의 android:networkSecurityConfig(
 * network_security_config.xml)가 그 IP 하나만 허용한다 — 이 플러그인의 HttpURLConnection 은
 * WebView 와 무관한 별도 네트워크 스택이라 WebView mixed-content 정책의 영향을 받지 않지만,
 * 앱 전역 cleartext 정책(usesCleartextTraffic/network_security_config)은 여전히 적용된다.
 *
 * 메서드: connect/disconnect/status(연결) · request(JSON·바이너리 1회 요청) ·
 *   startPreview/stopPreview(MJPEG, notifyListeners("previewFrame"/"previewError")로 push).
 *
 * 🔴 실기기 미검증 — .tmp/theta-sc-fieldtest.md 참조. 컴파일(gradlew assembleDebug)까지만 확인됨.
 */
@CapacitorPlugin(name = "OscCamera")
public class OscCameraPlugin extends Plugin {

    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final String BOUNDARY_HEADER = "boundary=";
    private static final int MAX_BACKOFF_MS = 30000;

    private ConnectivityManager.NetworkCallback networkCallback;
    private Network cameraNetwork;
    private final AtomicBoolean previewRunning = new AtomicBoolean(false);
    private Thread previewThread;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private WifiManager.WifiLock wifiLock;

    // 🔴 [마스터 현장 이슈 2026-10-20] "와이파이가 자주 끊긴다" — onLost/onUnavailable 이 오면
    // 사용자 조작 없이 지수 백오프(1,2,4,8,16,30s 캡 — JS 73_ThetaOSC.js backoffDelayMs 와 같은
    // 공식, 값만 각자 보관)로 requestNetwork 를 다시 건다. 상태는 status() 로 노출해 JS 상태줄이
    // "카메라 재연결 중…(n회)" 를 보이게 한다.
    private String lastSsid, lastPassword;
    private volatile boolean reconnecting = false;
    private volatile int reconnectAttempt = 0;
    private boolean autoReconnect = true; // disconnect() 호출 시 false — 사용자가 끈 연결은 자동 재시도하지 않는다

    private ConnectivityManager cm() {
        return (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
    }
    private static long backoffMs(int attempt) {
        long ms = 1000L << Math.max(0, Math.min(attempt, 5)); // 1,2,4,8,16,32→캡
        return Math.min(MAX_BACKOFF_MS, ms);
    }

    /** 카메라 와이파이 연결 — 앱 전용 로컬 네트워크(인터넷 없음, 기본 네트워크 대체 안 함). */
    @PluginMethod
    public void connect(PluginCall call) {
        String ssid = call.getString("ssid");
        String password = call.getString("password");
        if (ssid == null || password == null) { call.reject("ssid/password 필요", "BAD_ARGS"); return; }
        if (Build.VERSION.SDK_INT < 29) { call.reject("Android 10 미만 — WifiNetworkSpecifier 미지원, 수동 연결 필요", "UNSUPPORTED_SDK"); return; }
        lastSsid = ssid; lastPassword = password; autoReconnect = true; reconnectAttempt = 0;
        requestCameraNetwork(ssid, password, call);
    }

    private void requestCameraNetwork(String ssid, String password, PluginCall call) {
        disconnectInternal(false);
        WifiNetworkSpecifier specifier = new WifiNetworkSpecifier.Builder()
            .setSsid(ssid)
            .setWpa2Passphrase(password)
            .build();
        NetworkRequest request = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) // 인터넷 없는 로컬 네트워크임을 명시 — 기본 네트워크 승격 방지
            .setNetworkSpecifier(specifier)
            .build();
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                cameraNetwork = network;
                reconnecting = false; reconnectAttempt = 0;
                acquireWifiLock();
                if (call != null) { JSObject ret = new JSObject(); ret.put("ok", true); try { call.resolve(ret); } catch (Exception ignored) {} }
            }
            @Override public void onUnavailable() {
                if (call != null) { try { call.reject("카메라 와이파이 연결 실패(타임아웃) — 수동 연결 필요", "UNAVAILABLE"); } catch (Exception ignored) {} }
                scheduleReconnect();
            }
            @Override public void onLost(Network network) {
                if (network.equals(cameraNetwork)) { cameraNetwork = null; releaseWifiLock(); scheduleReconnect(); }
            }
        };
        cm().requestNetwork(request, networkCallback, CONNECT_TIMEOUT_MS);
    }

    /** 끊김 자동 복구 — 사용자 조작 0, 백오프로 재시도. 사용자가 disconnect() 를 부르면(autoReconnect=false) 멈춘다. */
    private void scheduleReconnect() {
        if (!autoReconnect || lastSsid == null) return;
        reconnecting = true;
        final int attempt = reconnectAttempt++;
        mainHandler.postDelayed(() -> {
            if (!autoReconnect || lastSsid == null) return;
            requestCameraNetwork(lastSsid, lastPassword, null);
        }, backoffMs(attempt));
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        autoReconnect = false;
        disconnectInternal(true);
        call.resolve();
    }
    private void disconnectInternal(boolean full) {
        stopPreviewInternal();
        if (networkCallback != null) {
            try { cm().unregisterNetworkCallback(networkCallback); } catch (Exception ignored) {}
            networkCallback = null;
        }
        cameraNetwork = null;
        releaseWifiLock();
        if (full) { reconnecting = false; reconnectAttempt = 0; lastSsid = null; lastPassword = null; }
    }

    /** WifiManager.WifiLock — 세션 동안 와이파이 레이디오가 절전으로 끊기지 않게(API 수준별 모드). */
    private void acquireWifiLock() {
        try {
            if (wifiLock != null) return;
            WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return;
            int mode = (Build.VERSION.SDK_INT >= 29) ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wm.createWifiLock(mode, "SeastarThetaLock");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        } catch (Exception ignored) {}
    }
    private void releaseWifiLock() {
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
        wifiLock = null;
    }

    /** 세션 중 화면 꺼짐 방지(옵션) — 꺼지면 OS 가 와이파이도 절전으로 끊을 수 있다. */
    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        try {
            if (getActivity() != null) {
                if (enabled) getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("connected", cameraNetwork != null);
        ret.put("reconnecting", reconnecting);
        ret.put("attempt", reconnectAttempt);
        call.resolve(ret);
    }

    /** 1회 요청(JSON·바이너리 공용) — 카메라 네트워크로만 보낸다. 응답은 base64(bodyBase64)로 돌린다. */
    @PluginMethod
    public void request(PluginCall call) {
        if (cameraNetwork == null) { call.reject("카메라 네트워크 미연결 — connect 먼저 호출", "NOT_CONNECTED"); return; }
        String method = call.getString("method", "GET");
        String url = call.getString("url");
        String bodyBase64 = call.getString("bodyBase64");
        JSObject headers = call.getObject("headers");
        if (url == null) { call.reject("url 필요", "BAD_ARGS"); return; }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) cameraNetwork.openConnection(new URL(url)); // §헤더주석 핵심 — 이 요청만 카메라 네트워크로
            conn.setRequestMethod(method);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            if (headers != null) {
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) { String k = keys.next(); conn.setRequestProperty(k, headers.getString(k)); }
            }
            if (bodyBase64 != null) {
                byte[] body = Base64.decode(bodyBase64, Base64.DEFAULT);
                conn.setDoOutput(true);
                try (OutputStream os = conn.getOutputStream()) { os.write(body); }
            }
            int status = conn.getResponseCode();
            InputStream is = (status >= 200 && status < 400) ? conn.getInputStream() : conn.getErrorStream();
            byte[] respBytes = readAll(is);
            JSObject ret = new JSObject();
            ret.put("status", status);
            ret.put("bodyBase64", Base64.encodeToString(respBytes, Base64.NO_WRAP));
            String contentType = conn.getHeaderField("Content-Type");
            ret.put("contentType", contentType == null ? "" : contentType);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("카메라 요청 실패: " + e.getMessage(), "REQUEST_FAILED");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static byte[] readAll(InputStream is) throws Exception {
        if (is == null) return new byte[0];
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[32 * 1024];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    /** MJPEG 미리보기 시작 — 백그라운드 스레드에서 멀티파트를 직접 파싱해 프레임마다 "previewFrame" 이벤트. */
    @PluginMethod
    public void startPreview(PluginCall call) {
        if (cameraNetwork == null) { call.reject("카메라 네트워크 미연결", "NOT_CONNECTED"); return; }
        String url = call.getString("url");
        if (url == null) { call.reject("url 필요", "BAD_ARGS"); return; }
        stopPreviewInternal();
        previewRunning.set(true);
        final Network net = cameraNetwork;
        previewThread = new Thread(() -> runPreviewLoop(net, url));
        previewThread.setDaemon(true);
        previewThread.start();
        call.resolve();
    }

    @PluginMethod
    public void stopPreview(PluginCall call) {
        stopPreviewInternal();
        call.resolve();
    }
    private void stopPreviewInternal() {
        previewRunning.set(false);
        if (previewThread != null) { try { previewThread.interrupt(); } catch (Exception ignored) {} previewThread = null; }
    }

    private void runPreviewLoop(Network net, String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) net.openConnection(new URL(url));
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setConnectTimeout(8000);
            conn.setDoOutput(true);
            try (OutputStream os = conn.getOutputStream()) {
                os.write("{\"name\":\"camera.getLivePreview\",\"parameters\":{}}".getBytes("UTF-8"));
            }
            String contentType = conn.getHeaderField("Content-Type");
            String boundary = parseBoundary(contentType);
            if (boundary == null) {
                notifyListeners("previewError", errObj("라이브뷰 미지원(멀티파트 아님)"));
                return;
            }
            InputStream is = conn.getInputStream();
            readMjpegFrames(is, boundary);
        } catch (Exception e) {
            if (previewRunning.get()) notifyListeners("previewError", errObj("스트림 오류: " + e.getMessage()));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String parseBoundary(String contentType) {
        if (contentType == null) return null;
        int i = contentType.indexOf(BOUNDARY_HEADER);
        if (i < 0) return null;
        String b = contentType.substring(i + BOUNDARY_HEADER.length());
        int semi = b.indexOf(';');
        if (semi >= 0) b = b.substring(0, semi);
        return b.trim().replaceAll("^\"|\"$", "");
    }

    /** JS 73_ThetaOSC.js _mjpegFrames 와 동일한 규칙(마커 + Content-Length) — SoT 는 각자(네이티브/JS)
     *  진입점이 다르지만 알고리즘은 같다. 변경 시 양쪽 모두 고친다. */
    private void readMjpegFrames(InputStream is, String boundary) throws Exception {
        byte[] marker = ("--" + boundary).getBytes("UTF-8");
        byte[] crlfcrlf = "\r\n\r\n".getBytes("UTF-8");
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while (previewRunning.get() && (n = is.read(chunk)) > 0) {
            buf.write(chunk, 0, n);
            byte[] data = buf.toByteArray();
            for (;;) {
                int mi = indexOf(data, marker, 0);
                if (mi < 0) break;
                int headerStart = mi + marker.length;
                int hdrEnd = indexOf(data, crlfcrlf, headerStart);
                if (hdrEnd < 0) break;
                String headerText = new String(data, headerStart, hdrEnd - headerStart, "UTF-8");
                int len = -1;
                for (String line : headerText.split("\r\n")) {
                    if (line.toLowerCase().startsWith("content-length:")) { len = Integer.parseInt(line.substring(line.indexOf(':') + 1).trim()); break; }
                }
                int bodyStart = hdrEnd + crlfcrlf.length;
                if (len < 0) break; // Content-Length 없는 변형은 처리하지 않음(보수적)
                if (data.length < bodyStart + len) break;
                byte[] frame = new byte[len];
                System.arraycopy(data, bodyStart, frame, 0, len);
                notifyListeners("previewFrame", frameObj(frame));
                byte[] rest = new byte[data.length - (bodyStart + len)];
                System.arraycopy(data, bodyStart + len, rest, 0, rest.length);
                buf.reset(); buf.write(rest, 0, rest.length);
                data = buf.toByteArray();
            }
        }
    }

    private static int indexOf(byte[] hay, byte[] needle, int from) {
        outer:
        for (int i = from; i <= hay.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) if (hay[i + j] != needle[j]) continue outer;
            return i;
        }
        return -1;
    }
    private static JSObject frameObj(byte[] jpeg) {
        JSObject o = new JSObject();
        o.put("dataBase64", Base64.encodeToString(jpeg, Base64.NO_WRAP));
        return o;
    }
    private static JSObject errObj(String msg) {
        JSObject o = new JSObject();
        o.put("message", msg);
        return o;
    }

    @Override
    protected void handleOnDestroy() {
        autoReconnect = false;
        disconnectInternal(true);
        super.handleOnDestroy();
    }
}
