"""PWA 아이콘(512x512 PNG, 전체 배경 채워진 정사각) -> Android 런처/어댑티브/알림/스플래시 생성.
사용: 아래 SRC_ICON / RES 경로 두 줄만 프로젝트에 맞게 바꾼 뒤 `python generate_icons.py`.
요구: pip install pillow (또는 Android Studio 번들 환경에 이미 있을 수 있음)
"""
from pathlib import Path
from PIL import Image, ImageDraw

# 창고 13-misc-app-parts/capacitor-local-bundle-android/generate_icons.py 반출본 - 경로만 이 레포에 맞춤.
HERE = Path(__file__).resolve().parent
SRC_ICON = HERE.parents[1] / "public" / "images" / "icon-maskable-512.png"  # 기존 PWA maskable 아이콘 재사용(SoT, 배경까지 채워진 정사각)
RES = HERE.parent / "android" / "app" / "src" / "main" / "res"
NOTIF_ICON_NAME = "ic_stat_app"  # capacitor.config.json 의 LocalNotifications.smallIcon 과 맞출 것

LEGACY_SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FOREGROUND_CANVAS = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
NOTIF_SIZES = {"mdpi": 24, "hdpi": 36, "xhdpi": 48, "xxhdpi": 72, "xxxhdpi": 96}
FOREGROUND_SCALE = 0.84  # maskable 은 자체 안전영역(지름 80%)이 있어 0.66 이면 이중 축소 - 80%→어댑티브 가시영역 66.7% 로 맞춤  # 어댑티브 아이콘 안전영역(72dp/108dp) — 이보다 크게 하면 각 OEM 마스크에 잘려나감

SPLASH_TARGETS = {
    "drawable/splash.png": (480, 320),
    "drawable-land-hdpi/splash.png": (800, 480),
    "drawable-land-mdpi/splash.png": (480, 320),
    "drawable-land-xhdpi/splash.png": (1280, 720),
    "drawable-land-xxhdpi/splash.png": (1600, 960),
    "drawable-land-xxxhdpi/splash.png": (1920, 1280),
    "drawable-port-hdpi/splash.png": (480, 800),
    "drawable-port-mdpi/splash.png": (320, 480),
    "drawable-port-xhdpi/splash.png": (720, 1280),
    "drawable-port-xxhdpi/splash.png": (960, 1600),
    "drawable-port-xxxhdpi/splash.png": (1280, 1920),
}


def main():
    src = Image.open(SRC_ICON).convert("RGBA")
    bg_color = src.getpixel((2, 2))
    bg_hex = "#%02X%02X%02X" % bg_color[:3]
    print("background color:", bg_hex)

    for density, px in LEGACY_SIZES.items():
        resized = src.resize((px, px), Image.LANCZOS)
        for name in ("ic_launcher.png", "ic_launcher_round.png"):
            out = RES / f"mipmap-{density}" / name
            out.parent.mkdir(parents=True, exist_ok=True)
            resized.save(out)

    for density, canvas_px in FOREGROUND_CANVAS.items():
        icon_px = round(canvas_px * FOREGROUND_SCALE)
        resized = src.resize((icon_px, icon_px), Image.LANCZOS)
        canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
        offset = ((canvas_px - icon_px) // 2, (canvas_px - icon_px) // 2)
        canvas.paste(resized, offset, resized)
        canvas.save(RES / f"mipmap-{density}" / "ic_launcher_foreground.png")

    bgfile = RES / "values" / "ic_launcher_background.xml"
    bgfile.parent.mkdir(parents=True, exist_ok=True)
    bgfile.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">{bg_hex}</color>\n</resources>\n',
        encoding="utf-8",
    )

    # 알림 아이콘은 만들지 않는다 - 이 앱은 LocalNotifications 플러그인을 쓰지 않는다(YAGNI).

    for rel, (w, h) in SPLASH_TARGETS.items():
        canvas = Image.new("RGBA", (w, h), bg_color)
        icon_px = round(min(w, h) * 0.42)
        resized = src.resize((icon_px, icon_px), Image.LANCZOS)
        offset = ((w - icon_px) // 2, (h - icon_px) // 2)
        canvas.paste(resized, offset, resized)
        out = RES / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        canvas.convert("RGB").save(out)

    print("OK: icons + splash generated")


if __name__ == "__main__":
    main()
