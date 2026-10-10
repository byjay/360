@echo off
rem SEASTAR 360 APK release build. All caches/temp go under <repo>\.tmp (CLAUDE.md G-5: never write to C:).
rem JDK 21 = Android Studio bundled JBR (warehouse recipe). Override with SEA_JAVA_HOME. Android SDK is used read-only.
setlocal
set "ROOT=%~dp0.."
set "TMPROOT=%~dp0..\..\.tmp"
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
if not "%SEA_JAVA_HOME%"=="" set "JAVA_HOME=%SEA_JAVA_HOME%"
if "%ANDROID_HOME%"=="" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "GRADLE_USER_HOME=%TMPROOT%\gradle-home"
set "ANDROID_USER_HOME=%TMPROOT%\android-user-home"
set "TEMP=%TMPROOT%"
set "TMP=%TMPROOT%"
set "JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=%TMPROOT% -XX:-UsePerfData"
cd /d "%ROOT%\android"
call "%ROOT%\android\gradlew.bat" --no-daemon assembleRelease
exit /b %ERRORLEVEL%
