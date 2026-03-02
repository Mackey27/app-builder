const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const shell = require('shelljs');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APK_EXPORT_DIR = path.join(__dirname, 'builds', '_apks');
const DEFAULT_CORDOVA_ANDROID_VERSION = process.env.CORDOVA_ANDROID_VERSION || '13.0.0';
const DEFAULT_ANDROID_COMPILE_SDK_VERSION = process.env.ANDROID_COMPILE_SDK_VERSION || '34';
const DEFAULT_ANDROID_TARGET_SDK_VERSION = process.env.ANDROID_TARGET_SDK_VERSION || '34';
const DEFAULT_ANDROID_BUILD_TOOLS_VERSION = process.env.ANDROID_BUILD_TOOLS_VERSION || '34.0.0';

app.use(cors());
app.use(bodyParser.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // Serve frontend files

// Helper: Generate a unique folder for each build
const getBuildDir = (id) => path.join(__dirname, 'builds', id);
const sanitizeAppName = (name) => (name || 'WebToAPK App').replace(/"/g, '').trim() || 'WebToAPK App';
const getPackageId = (id) => `com.webtoapk.app${id}`;
const normalizeBuildUrl = (rawUrl) => {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
        throw new Error('Website URL is required.');
    }

    let candidate = rawUrl.trim();
    if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(candidate)) {
        candidate = `https://${candidate}`;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(candidate);
    } catch (error) {
        throw new Error('Invalid website URL. Use a full domain like https://example.com');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Only http:// or https:// URLs are supported.');
    }

    if (!parsedUrl.hostname) {
        throw new Error('Invalid website URL hostname.');
    }

    return parsedUrl.toString();
};
const escapeJsString = (value) =>
    String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
const parseDataUrlImage = (dataUrl, label) => {
    if (!dataUrl) return null;
    if (typeof dataUrl !== 'string') {
        throw new Error(`${label} must be a base64 data URL string.`);
    }

    const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,([a-z0-9+/=\s]+)$/i);
    if (!match) {
        throw new Error(`${label} must be PNG, JPG, or WEBP base64 data.`);
    }

    const mime = match[1].toLowerCase();
    const extension = mime === 'image/jpeg' || mime === 'image/jpg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
    if (!buffer.length) {
        throw new Error(`${label} file is empty.`);
    }
    if (buffer.length > 10 * 1024 * 1024) {
        throw new Error(`${label} is too large. Keep it under 10MB.`);
    }

    return { buffer, extension, dataUrl };
};
const safeRemove = (targetPath) => {
    try {
        fs.removeSync(targetPath);
    } catch (cleanupError) {
        console.error(`Cleanup warning for ${targetPath}:`, cleanupError.message);
    }
};
const runOrThrow = (command, label) => {
    return runOrThrowWithRetry(command, label, { retries: 0 });
};
const runOrThrowWithRetry = (command, label, options = {}) => {
    const retries = Number.isInteger(options.retries) && options.retries > 0 ? options.retries : 0;
    const retryOn = typeof options.retryOn === 'function' ? options.retryOn : () => false;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const result = shell.exec(command, { silent: true });
        if (result.code === 0) {
            return result;
        }

        const details = (result.stderr || result.stdout || '').trim();
        const shouldRetry = attempt < retries && retryOn(details);
        if (shouldRetry) {
            console.warn(`${label}: transient failure, retrying (${attempt + 1}/${retries})...`);
            continue;
        }

        throw new Error(details ? `${label}: ${details}` : label);
    }
};
const isGradleWrapperNetworkIssue = (details) =>
    /Test of distribution url .*gradle-[\d.]+-bin\.zip failed/i.test(details || '') ||
    /services\.gradle\.org/i.test(details || '') ||
    /Read timed out/i.test(details || '') ||
    /Connection timed out/i.test(details || '');
const normalizeBuildErrorMessage = (message) => {
    if (isGradleWrapperNetworkIssue(message)) {
        return `${message}\nHint: Gradle could not validate/download distribution from services.gradle.org. Check internet/proxy/firewall and retry.`;
    }
    return message;
};
const ensureAndroidSdkPackages = (androidHome) => {
    const buildToolsPath = path.join(androidHome, 'build-tools', DEFAULT_ANDROID_BUILD_TOOLS_VERSION);
    const platformPath = path.join(androidHome, 'platforms', `android-${DEFAULT_ANDROID_COMPILE_SDK_VERSION}`);
    const missing = [];

    if (!fs.existsSync(buildToolsPath)) {
        missing.push(`build-tools;${DEFAULT_ANDROID_BUILD_TOOLS_VERSION}`);
    }
    if (!fs.existsSync(platformPath)) {
        missing.push(`platforms;android-${DEFAULT_ANDROID_COMPILE_SDK_VERSION}`);
    }

    if (missing.length > 0) {
        const sdkmanagerName = process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager';
        const sdkmanager = path.join(androidHome, 'cmdline-tools', 'latest', 'bin', sdkmanagerName);
        const installCmd = fs.existsSync(sdkmanager)
            ? `"${sdkmanager}" "platform-tools" ${missing.map((pkg) => `"${pkg}"`).join(' ')}`
            : `sdkmanager "platform-tools" ${missing.map((pkg) => `"${pkg}"`).join(' ')}`;
        throw new Error(`Missing Android SDK packages (${missing.join(', ')}). Install them with: ${installCmd}`);
    }
};

const PREVIEW_FETCH_TIMEOUT_MS = 15000;
const IFRAME_BLOCKING_HOSTS = ['google.com', 'youtube.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com'];

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/preview', async (req, res) => {
    const rawUrl = req.query.url;
    let normalizedUrl = '';
    try {
        normalizedUrl = normalizeBuildUrl(String(rawUrl || ''));
    } catch (error) {
        return res.status(400).send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #94a3b8; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .error { text-align: center; padding: 20px; }
        .error-icon { font-size: 48px; margin-bottom: 16px; }
        .error-title { color: #ef4444; font-size: 18px; font-weight: 600; margin-bottom: 8px; }
        .error-text { font-size: 14px; }
    </style>
</head>
<body>
    <div class="error">
        <div class="error-icon">⚠️</div>
        <div class="error-title">Invalid URL</div>
        <div class="error-text">Please enter a valid website URL</div>
    </div>
</body>
</html>`);
    }

    const parsedUrl = new URL(normalizedUrl);
    const hostname = parsedUrl.hostname.toLowerCase();
    const isBlockingHost = IFRAME_BLOCKING_HOSTS.some(h => hostname.includes(h));
    
    if (isBlockingHost) {
        return res.status(403).send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #94a3b8; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .notice { text-align: center; padding: 24px; max-width: 280px; }
        .notice-icon { font-size: 48px; margin-bottom: 16px; }
        .notice-title { color: #f59e0b; font-size: 16px; font-weight: 600; margin-bottom: 12px; }
        .notice-text { font-size: 13px; line-height: 1.5; }
        .hostname { color: #06b6d4; font-weight: 500; }
    </style>
</head>
<body>
    <div class="notice">
        <div class="notice-icon">🔒</div>
        <div class="notice-title">Preview Blocked</div>
        <div class="notice-text">
            <span class="hostname">${hostname}</span> blocks preview embedding.<br><br>
            You can still build an APK - this site will work normally in the app.
        </div>
    </div>
</body>
</html>`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREVIEW_FETCH_TIMEOUT_MS);

    try {
        const upstream = await fetch(normalizedUrl, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'user-agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
                'accept-language': 'en-US,en;q=0.9'
            }
        });
        clearTimeout(timer);

        const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
        if (!upstream.ok) {
            return res.status(502).send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #94a3b8; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .error { text-align: center; padding: 20px; }
        .error-icon { font-size: 48px; margin-bottom: 16px; }
        .error-title { color: #ef4444; font-size: 18px; font-weight: 600; margin-bottom: 8px; }
        .error-text { font-size: 14px; }
    </style>
</head>
<body>
    <div class="error">
        <div class="error-icon">❌</div>
        <div class="error-title">Failed to Load</div>
        <div class="error-text">Server returned ${upstream.status}</div>
    </div>
</body>
</html>`);
        }

        if (!contentType.includes('text/html')) {
            return res.redirect(normalizedUrl);
        }

        let html = await upstream.text();
        const baseTag = `<base href="${normalizedUrl}">`;

        // Remove strict CSP meta tags and X-Frame-Options equivalents
        html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
        html = html.replace(/<meta[^>]+http-equiv=["']X-Frame-Options["'][^>]*>/gi, '');

        // Inject script to suppress CORS errors from the parent
        const suppressScript = `<script>
            (function() {
                // Suppress CORS and fetch errors from the target site
                const originalFetch = window.fetch;
                window.fetch = function(...args) {
                    return originalFetch.apply(this, args).catch(() => new Response('', { status: 0 }));
                };
                window.addEventListener('error', function(e) { e.stopPropagation(); }, true);
            })();
        </script>`;

        if (/<head[^>]*>/i.test(html)) {
            html = html.replace(/<head[^>]*>/i, (match) => `${match}\n${baseTag}\n${suppressScript}`);
        } else {
            html = `<!doctype html><html><head>${baseTag}${suppressScript}</head><body>${html}</body></html>`;
        }

        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        return res.status(200).send(html);
    } catch (error) {
        clearTimeout(timer);
        const isTimeout = error && error.name === 'AbortError';
        const message = isTimeout ? 'Request timed out' : 'Could not load URL';
        const icon = isTimeout ? '⏱️' : '🔌';
        return res.status(502).send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #94a3b8; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .error { text-align: center; padding: 20px; }
        .error-icon { font-size: 48px; margin-bottom: 16px; }
        .error-title { color: #ef4444; font-size: 18px; font-weight: 600; margin-bottom: 8px; }
        .error-text { font-size: 14px; }
    </style>
</head>
<body>
    <div class="error">
        <div class="error-icon">${icon}</div>
        <div class="error-title">${message}</div>
        <div class="error-text">${isTimeout ? 'The website took too long to respond' : 'Check the URL and try again'}</div>
    </div>
</body>
</html>`);
    }
});

app.post('/build', async (req, res) => {
    const { url, appName, themeColor, appIconData, splashImageData } = req.body;
    let normalizedUrl;
    try {
        normalizedUrl = normalizeBuildUrl(url);
    } catch (urlError) {
        return res.status(400).json({ error: urlError.message });
    }
    let iconAsset;
    let splashAsset;
    try {
        iconAsset = parseDataUrlImage(appIconData, 'App icon');
        splashAsset = parseDataUrlImage(splashImageData, 'Splash image');
    } catch (imageError) {
        return res.status(400).json({ error: imageError.message });
    }
    const buildId = Date.now().toString();
    const buildDir = getBuildDir(buildId);
    const appPackage = getPackageId(buildId); // Valid unique package name
    const safeAppName = sanitizeAppName(appName);
    const originalCwd = process.cwd();
    let movedToBuildDir = false;

    console.log(`[Build ${buildId}] Started for: ${normalizedUrl}`);

    try {
        const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
        if (!androidHome) {
            throw new Error('Android SDK not configured. Set ANDROID_HOME or ANDROID_SDK_ROOT, then restart the Node.js server.');
        }
        if (!shell.which('java')) {
            throw new Error('Java/JDK not found in PATH. Install JDK and restart the Node.js server.');
        }
        if (!shell.which('gradle')) {
            throw new Error('Gradle not found in PATH. Install Gradle and restart the Node.js server.');
        }
        ensureAndroidSdkPackages(androidHome);

        // 1. Ensure the parent builds directory exists.
        // Cordova creates the target project directory itself.
        fs.ensureDirSync(path.join(__dirname, 'builds'));

        // 2. Create a basic Cordova project structure
        // Note: In production, you would have a pre-made template to copy for speed.
        // Here we generate it dynamically.
        console.log(`[Build ${buildId}] Creating Cordova Project...`);
        
        // We use shelljs to run cordova commands. 
        // Ensure 'cordova' is installed globally: npm install -g cordova
        // If you don't have cordova installed globally, this step fails.
        
        // FOR TESTING WITHOUT CORDOVA: 
        // Comment out the shell.exec lines and uncomment the "Simulation" section below to test the API flow.
        
        let cmd = `cordova create "${buildDir}" ${appPackage} "${safeAppName}"`;
        runOrThrow(cmd, 'Failed to create Cordova project');

        // 3. Add Android Platform
        process.chdir(buildDir);
        movedToBuildDir = true;
        runOrThrow(`cordova platform add android@${DEFAULT_CORDOVA_ANDROID_VERSION}`, 'Failed to add Android platform');

        // 4. Modify Config.xml for URL and Preferences
        const configPath = path.join(buildDir, 'config.xml');
        let config = fs.readFileSync(configPath, 'utf-8');
        
        // Allow navigation to the target URL and set Android SDK preferences.
        config = config.replace('</widget>', `
            <access origin="*" />
            <allow-navigation href="*" />
            <allow-intent href="http://*/*" />
            <allow-intent href="https://*/*" />
            <preference name="android-compileSdkVersion" value="${DEFAULT_ANDROID_COMPILE_SDK_VERSION}" />
            <preference name="android-targetSdkVersion" value="${DEFAULT_ANDROID_TARGET_SDK_VERSION}" />
            <preference name="android-buildToolsVersion" value="${DEFAULT_ANDROID_BUILD_TOOLS_VERSION}" />
            <preference name="Orientation" value="portrait" />
        </widget>`);
        fs.writeFileSync(configPath, config);

        // 6. Inject WebView Code (www/index.html)
        const indexHtmlPath = path.join(buildDir, 'www', 'index.html');
        const safeUrlForJs = escapeJsString(normalizedUrl);
        const safeThemeColor = /^#[0-9a-f]{3,8}$/i.test(String(themeColor || '').trim()) ? String(themeColor).trim() : '#111111';
        const safeSplashDataForHtml = splashAsset ? splashAsset.dataUrl : '';
        const appHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="Content-Security-Policy" content="default-src * 'self' data: gap: https://ssl.gstatic.com 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src *">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body, html {
                        margin: 0;
                        padding: 0;
                        height: 100%;
                        overflow: hidden;
                        font-family: Arial, sans-serif;
                        background: ${safeThemeColor};
                        color: #fff;
                    }
                    .boot-splash {
                        position: fixed;
                        inset: 0;
                        background: ${safeThemeColor};
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        z-index: 9999;
                    }
                    .boot-splash img {
                        width: 100%;
                        height: 100%;
                        object-fit: cover;
                    }
                    .boot-splash-text {
                        opacity: 0.8;
                        font-size: 14px;
                        letter-spacing: 0.08em;
                    }
                </style>
            </head>
            <body>
                <div id="bootSplash" class="boot-splash">
                    ${splashAsset ? `<img src="${safeSplashDataForHtml}" alt="Splash" />` : '<div class="boot-splash-text">Launching...</div>'}
                </div>
                <script src="cordova.js"></script>
                <script>
                    (function () {
                        var targetUrl = '${safeUrlForJs}';
                        var hasLaunched = false;
                        var splashDelay = ${splashAsset ? 1200 : 150};
                        function openWebApp() {
                            if (hasLaunched) return;
                            hasLaunched = true;
                            window.location.replace(targetUrl);
                        }
                        function scheduleOpen() {
                            setTimeout(openWebApp, splashDelay);
                        }
                        document.addEventListener('deviceready', function () {
                            scheduleOpen();
                        }, false);
                        // Browser fallback if deviceready does not fire.
                        setTimeout(scheduleOpen, 5000);
                    })();
                </script>
            </body>
            </html>
        `;
        fs.writeFileSync(indexHtmlPath, appHtml);

        // 5. Copy icon to Android resources if provided
        if (iconAsset) {
            console.log(`[Build ${buildId}] Copying icon to Android resources...`);
            const androidResDir = path.join(buildDir, 'platforms', 'android', 'app', 'src', 'main', 'res');
            if (fs.existsSync(androidResDir)) {
                // Android mipmap folders for different densities
                const mipmapFolders = ['mipmap-hdpi', 'mipmap-mdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'];
                mipmapFolders.forEach(folder => {
                    const folderPath = path.join(androidResDir, folder);
                    if (fs.existsSync(folderPath)) {
                        fs.writeFileSync(path.join(folderPath, 'ic_launcher.png'), iconAsset.buffer);
                        fs.writeFileSync(path.join(folderPath, 'ic_launcher_foreground.png'), iconAsset.buffer);
                        fs.writeFileSync(path.join(folderPath, 'ic_launcher_round.png'), iconAsset.buffer);
                    }
                });
            }
        }

        // 6. Build APK
        console.log(`[Build ${buildId}] Compiling APK (this may take a minute)...`);
        runOrThrowWithRetry('cordova build android', 'Build failed', {
            retries: 2,
            retryOn: isGradleWrapperNetworkIssue
        });
        process.chdir(originalCwd);
        movedToBuildDir = false;

        // 7. Locate APK
        // Path usually: platforms/android/app/build/outputs/apk/debug/app-debug.apk
        const apkPath = path.join(buildDir, 'platforms', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
        
        if (!fs.existsSync(apkPath)) {
            throw new Error('APK file not found after build');
        }

        // Keep a persistent APK copy for manual retrieval/debugging.
        fs.ensureDirSync(APK_EXPORT_DIR);
        const archivedApkPath = path.join(
            APK_EXPORT_DIR,
            `${buildId}-${safeAppName.replace(/[^\w.-]+/g, '-').toLowerCase()}.apk`
        );
        fs.copyFileSync(apkPath, archivedApkPath);

        // 8. Send File to Client
        console.log(`[Build ${buildId}] Success! Sending file.`);
        res.download(apkPath, `${safeAppName.replace(/\s+/g, '-')}.apk`, (err) => {
            if (err) console.error(err);
            // Clean up build directory after download
            safeRemove(buildDir);
        });

    } catch (error) {
        if (movedToBuildDir) {
            process.chdir(originalCwd);
            movedToBuildDir = false;
        }
        const normalizedError = normalizeBuildErrorMessage(error.message);
        console.error(`[Build ${buildId}] Error:`, normalizedError);
        res.status(500).json({ error: normalizedError });
        safeRemove(buildDir); // Cleanup on error
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

// Catch-all: show friendly error for unknown routes (e.g., /home, /about, etc.)
app.use((req, res) => {
    res.status(404).send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #94a3b8; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .error { text-align: center; padding: 24px; max-width: 300px; }
        .error-icon { font-size: 48px; margin-bottom: 16px; }
        .error-title { color: #ef4444; font-size: 18px; font-weight: 600; margin-bottom: 8px; }
        .error-text { font-size: 14px; line-height: 1.5; }
    </style>
</head>
<body>
    <div class="error">
        <div class="error-icon">❌</div>
        <div class="error-title">Invalid URL</div>
        <div class="error-text">Please enter a complete URL like<br><strong>https://google.com</strong></div>
    </div>
</body>
</html>`);
});
