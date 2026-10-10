package work.seastar.scan360;

import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;

/**
 * SEASTAR 360 앱 전용 네이티브 기능 2가지.
 *
 * 1) 공유 받기 - 갤러리/THETA 앱 "공유 -> SEASTAR 360" (ACTION_SEND / SEND_MULTIPLE, image/*).
 *    웹(PWA)의 manifest share_target 은 설치된 WebAPK 에만 적용되므로 APK 는 네이티브로 받는다.
 *    받은 스트림을 앱 캐시(cache/shared/)에 복사해 두고, 웹은 takeShared() 로 경로를 받아
 *    Capacitor.convertFileSrc(path) 로 읽는다(원격 URL 모드에서도 /_capacitor_file_/ 는 로컬 서버가 처리).
 *    실행 중 새로 들어오면 window 이벤트 "seastarshared" 를 쏜다.
 *
 * 2) THETA 앱 열기 - 웹이 location.href = "intent://...;package=X;S.browser_fallback_url=...;end" 로 이동하면
 *    Capacitor 기본 처리(Intent.ACTION_VIEW)는 intent: 스킴을 해석하지 못해 조용히 실패한다.
 *    보안: 파싱한 Intent 를 그대로 startActivity 하지 않는다(임의 컴포넌트/extras 주입 경로가 된다).
 *    패키지명만 뽑아 그 앱의 런처 Intent 로 연다. 없으면 https fallback URL -> Play 스토어 상세 순.
 *    패키지 가시성(Android 11+)은 AndroidManifest <queries> 에 선언한 패키지만 보인다.
 */
@CapacitorPlugin(name = "SeastarNative")
public class SeastarNativePlugin extends Plugin {

    private static final String SHARED_DIR = "shared";
    private final List<JSObject> pending = new ArrayList<>();

    @Override
    public void load() {
        super.load();
        if (getActivity() != null) handleShareIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (handleShareIntent(intent)) {
            getBridge().triggerWindowJSEvent("seastarshared");
        }
    }

    /** 공유 Intent 면 파일을 캐시에 복사해 pending 에 쌓고 true. 처리 후 action 을 바꿔 재처리(회전/재생성)를 막는다. */
    private boolean handleShareIntent(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        intent.setAction(Intent.ACTION_MAIN);
        int added = 0;
        for (Uri u : uris) {
            JSObject f = copyToCache(u);
            if (f != null) {
                synchronized (pending) { pending.add(f); }
                added++;
            }
        }
        return added > 0;
    }

    private JSObject copyToCache(Uri uri) {
        if (uri == null) return null;
        // content:// 만 받는다 - file:// 은 다른 앱이 우리 앱 내부 파일을 가리키게 만드는 경로가 될 수 있다.
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) return null;
        ContentResolver cr = getContext().getContentResolver();
        String type = cr.getType(uri);
        if (type == null || !type.startsWith("image/")) return null;
        String name = displayName(cr, uri);
        File dir = new File(getContext().getCacheDir(), SHARED_DIR);
        if (!dir.exists() && !dir.mkdirs()) return null;
        String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
        File out = new File(dir, System.currentTimeMillis() + "-" + safe);
        try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (in == null) return null;
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        } catch (Exception e) {
            Logger.error("SeastarNative", "share copy failed", e);
            return null;
        }
        JSObject f = new JSObject();
        f.put("path", out.getAbsolutePath());
        f.put("name", name);
        f.put("type", type);
        f.put("size", out.length());
        return f;
    }

    private static String displayName(ContentResolver cr, Uri uri) {
        try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) {}
        String last = uri.getLastPathSegment();
        return (last == null || last.isEmpty()) ? "shared.jpg" : last;
    }

    /** 웹이 부팅 직후와 "seastarshared" 이벤트 때 호출 - 쌓인 공유 파일 목록을 꺼내며 비운다(1회성). */
    @PluginMethod
    public void takeShared(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (pending) {
            for (JSObject f : pending) arr.put(f);
            pending.clear();
        }
        JSObject ret = new JSObject();
        ret.put("files", arr);
        call.resolve(ret);
    }

    /** 웹이 다 읽은 뒤 캐시 사본을 지운다(경로는 반드시 cache/shared/ 바로 아래여야 한다 - 그 밖은 무시). */
    @PluginMethod
    public void releaseShared(PluginCall call) {
        JSArray paths = call.getArray("paths");
        int removed = 0;
        try {
            File base = new File(getContext().getCacheDir(), SHARED_DIR).getCanonicalFile();
            if (paths != null) {
                for (int i = 0; i < paths.length(); i++) {
                    File f = new File(paths.getString(i)).getCanonicalFile();
                    if (base.equals(f.getParentFile()) && f.delete()) removed++;
                }
            }
        } catch (Exception e) {
            Logger.error("SeastarNative", "release failed", e);
        }
        JSObject ret = new JSObject();
        ret.put("removed", removed);
        call.resolve(ret);
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (url == null || !"intent".equalsIgnoreCase(url.getScheme())) return null;
        String pkg = null;
        String fallback = null;
        try {
            Intent parsed = Intent.parseUri(url.toString(), Intent.URI_INTENT_SCHEME);
            pkg = parsed.getPackage();
            fallback = parsed.getStringExtra("browser_fallback_url");
        } catch (URISyntaxException e) {
            Logger.error("SeastarNative", "bad intent uri", e);
        }
        if (pkg != null && !pkg.equals(getContext().getPackageName())) {
            Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
            if (launch != null) {
                try {
                    getActivity().startActivity(launch);
                    return true;
                } catch (ActivityNotFoundException ignored) {}
            }
        }
        String target = null;
        if (fallback != null && fallback.startsWith("https://")) target = fallback;
        else if (pkg != null) target = "https://play.google.com/store/apps/details?id=" + Uri.encode(pkg);
        if (target != null) {
            try {
                getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target)));
            } catch (ActivityNotFoundException ignored) {}
        }
        return true; // intent: 는 어떤 경우에도 WebView 로 로드하지 않는다
    }
}
