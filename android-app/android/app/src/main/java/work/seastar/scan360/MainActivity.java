package work.seastar.scan360;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * SEASTAR 360 — 원격 URL(capacitor.config.json server.url) 래퍼.
 * 앱 전용 네이티브 기능은 SeastarNativePlugin 하나에 모은다(공유 받기, THETA 앱 열기).
 * registerPlugin 은 super.onCreate 보다 먼저 호출해야 브리지가 플러그인을 인식한다.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SeastarNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
