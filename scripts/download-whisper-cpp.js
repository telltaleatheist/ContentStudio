/**
 * Download whisper.cpp pre-built binaries and models for all platforms
 *
 * whisper.cpp is a standalone C++ implementation of Whisper that:
 * - Has NO dependencies (no Python, no VC++ runtime on Windows)
 * - Is faster than Python Whisper
 * - Works out of the box on all platforms
 *
 * This script downloads PRE-BUILT binaries for ALL target architectures:
 * - macOS: arm64 (Apple Silicon) from Homebrew bottle
 * - macOS: x64 (Intel) from Homebrew bottle
 * - Windows: x64 from GitHub releases
 * - Linux: x64 from GitHub releases (or Homebrew)
 *
 * NO CMAKE OR BUILD TOOLS REQUIRED!
 *
 * Usage:
 *   node scripts/download-whisper-cpp.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { createGunzip } = require('zlib');

const BIN_DIR = path.join(__dirname, '..', 'utilities', 'bin');
const MODELS_DIR = path.join(__dirname, '..', 'utilities', 'models');
const CACHE_DIR = path.join(__dirname, '..', '.build-cache', 'whisper-cpp');

// Windows binaries must be staged into utilities/bin/win32/ so that the
// electron-builder win config (from: utilities/bin/win32 -> to: utilities/bin)
// lands them at resources/utilities/bin/ in the packaged app, which is exactly
// where runtime-paths.ts looks for whisper-cli.exe + DLLs when packaged.
const WIN_STAGE_DIR = path.join(BIN_DIR, 'win32');

// Target platform/arch to stage for. This is the platform being PACKAGED, which
// may differ from the build machine (e.g. `download:all:win` on a Mac).
// download-all.sh passes these via env; when run directly we fall back to host.
function hostPlatformName() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}
const TARGET_PLATFORM = (process.env.TARGET_PLATFORM || hostPlatformName()).toLowerCase();
const TARGET_ARCHS = (process.env.TARGET_ARCHS || '')
  .split(/[\s,]+/)
  .map(s => s.trim())
  .filter(Boolean);

function requestedMacArchs() {
  const archs = TARGET_ARCHS.filter(a => a === 'arm64' || a === 'x64');
  return archs.length ? archs : ['arm64', 'x64'];
}

// Where a given binary is staged (Windows lives under win32/, others in bin/).
function stagedBinaryPath(key) {
  if (key === 'win32-x64') return path.join(WIN_STAGE_DIR, BINARY_NAMES[key]);
  return path.join(BIN_DIR, BINARY_NAMES[key]);
}

// Models to bundle (tiny, base, small)
const MODELS = [
  { name: 'ggml-tiny.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin', size: '~75MB' },
  { name: 'ggml-base.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', size: '~142MB' },
  { name: 'ggml-small.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', size: '~466MB' },
];

// GitHub releases for Windows
const WHISPER_CPP_VERSION = '1.8.2';
const WINDOWS_BINARY_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}/whisper-bin-x64.zip`;

// Target binary names per platform/architecture
const BINARY_NAMES = {
  'darwin-arm64': 'whisper-cli-arm64',
  'darwin-x64': 'whisper-cli-x64',
  'win32-x64': 'whisper-cli.exe',
  'linux-x64': 'whisper-cli',
};

// macOS dylibs
const MACOS_DYLIBS = [
  'libwhisper.1.dylib',
  'libggml.dylib',
  'libggml-base.dylib',
  'libggml-cpu.dylib',
  'libggml-blas.dylib',
  'libggml-metal.dylib',
];

/**
 * Download a file with redirect support.
 *
 * Integrity: the body is streamed to a `.partial` sibling; the file is only
 * renamed into `destPath` after (a) the byte count matches the content-length
 * header (when present) and (b) the sha256 matches `expectedSha256` (when
 * provided). Any failure deletes the partial file, so an interrupted or
 * corrupt download can never masquerade as a valid cached artifact.
 */
function downloadFile(url, destPath, headers = {}, expectedSha256 = null) {
  return new Promise((resolve, reject) => {
    const tmpPath = `${destPath}.partial`;
    const file = fs.createWriteStream(tmpPath);
    const hash = expectedSha256 ? crypto.createHash('sha256') : null;
    let redirectCount = 0;
    const maxRedirects = 10;
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      try { file.destroy(); } catch (_) {}
      fs.unlink(tmpPath, () => reject(err));
    }

    function doRequest(currentUrl) {
      const protocol = currentUrl.startsWith('https') ? https : http;

      const options = {
        headers: {
          'User-Agent': 'ContentStudio/1.0',
          ...headers
        }
      };

      protocol.get(currentUrl, options, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            fail(new Error('Too many redirects'));
            return;
          }

          let redirectUrl = response.headers.location;
          if (redirectUrl.startsWith('/')) {
            const urlObj = new URL(currentUrl);
            redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
          }

          response.resume(); // drain the redirect body
          doRequest(redirectUrl);
          return;
        }

        if (response.statusCode !== 200) {
          fail(new Error(`HTTP ${response.statusCode}: ${response.statusMessage} for ${currentUrl}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'], 10);
        let downloadedBytes = 0;
        let lastPercent = 0;

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (hash) hash.update(chunk);
          if (totalBytes) {
            const percent = Math.floor((downloadedBytes / totalBytes) * 100);
            if (percent >= lastPercent + 10) {
              process.stdout.write(`\r   Progress: ${percent}%`);
              lastPercent = percent;
            }
          }
        });

        response.on('error', (err) => fail(err));

        response.pipe(file);

        file.on('finish', () => {
          file.close(() => {
            if (settled) return;
            console.log('\r   Progress: 100%');

            // Verify completeness against content-length (when the server sent one).
            if (!Number.isNaN(totalBytes) && totalBytes > 0 && downloadedBytes !== totalBytes) {
              fail(new Error(
                `Incomplete download: expected ${totalBytes} bytes but received ${downloadedBytes} for ${currentUrl}`
              ));
              return;
            }

            // Verify sha256 when a checksum is available for this artifact.
            if (hash) {
              const digest = hash.digest('hex').toLowerCase();
              if (digest !== String(expectedSha256).toLowerCase()) {
                fail(new Error(
                  `SHA256 mismatch for ${currentUrl}: expected ${expectedSha256}, got ${digest}`
                ));
                return;
              }
            }

            // Only now, atomically move the verified file into place.
            fs.rename(tmpPath, destPath, (err) => {
              if (err) { fail(err); return; }
              settled = true;
              resolve();
            });
          });
        });

        file.on('error', (err) => fail(err));
      }).on('error', (err) => fail(err));
    }

    doRequest(url);
  });
}

/**
 * Extract a zip file
 */
async function extractZip(zipPath, destDir) {
  const extractZipModule = require('extract-zip');
  await extractZipModule(zipPath, { dir: destDir });
}

/**
 * Find a file in directory recursively
 */
function findFile(dir, filename) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const found = findFile(fullPath, filename);
      if (found) return found;
    } else if (file === filename || file.toLowerCase() === filename.toLowerCase()) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Check if a binary is valid (exists and is large enough)
 */
function isValidBinary(filePath, minSize = 100 * 1024) {
  if (!fs.existsSync(filePath)) return false;
  const stats = fs.statSync(filePath);
  return stats.size >= minSize;
}

/**
 * Get Homebrew bottle URL for whisper-cpp
 */
async function getHomebrewBottleUrl(osVersion, isArm64) {
  // Get the brew info JSON
  const result = execSync('brew info whisper-cpp --json', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const info = JSON.parse(result)[0];
  const bottle = info.bottle?.stable;

  if (!bottle) {
    throw new Error('No Homebrew bottle available for whisper-cpp');
  }

  // Determine which bottle to use
  // arm64_sonoma/arm64_sequoia for Apple Silicon, sonoma for Intel
  const files = bottle.files;
  let bottleKey;

  if (isArm64) {
    // Prefer newer macOS versions for arm64
    bottleKey = files.arm64_tahoe ? 'arm64_tahoe' :
                files.arm64_sequoia ? 'arm64_sequoia' :
                files.arm64_sonoma ? 'arm64_sonoma' : null;
  } else {
    // Intel - use non-arm64 macOS bottle
    bottleKey = files.sonoma ? 'sonoma' :
                files.ventura ? 'ventura' : null;
  }

  if (!bottleKey || !files[bottleKey]) {
    throw new Error(`No Homebrew bottle for ${isArm64 ? 'arm64' : 'x64'} macOS`);
  }

  return {
    url: files[bottleKey].url,
    sha256: files[bottleKey].sha256,
    version: info.versions.stable
  };
}

/**
 * Download and extract Homebrew bottle for macOS
 */
async function downloadHomebrewBottle(arch) {
  const binaryName = BINARY_NAMES[`darwin-${arch}`];
  const destPath = path.join(BIN_DIR, binaryName);
  const isArm64 = arch === 'arm64';

  // Check if already exists
  if (isValidBinary(destPath)) {
    console.log(`✅ ${binaryName} already exists`);
    return destPath;
  }

  console.log(`📥 Getting Homebrew bottle info for macOS ${arch}...`);

  let bottleInfo;
  try {
    bottleInfo = await getHomebrewBottleUrl('sonoma', isArm64);
  } catch (err) {
    console.error(`Failed to get Homebrew bottle: ${err.message}`);
    throw err;
  }

  const cacheBottlePath = path.join(CACHE_DIR, `whisper-cpp-${bottleInfo.version}-${arch}.tar.gz`);
  const cacheExtractDir = path.join(CACHE_DIR, `whisper-cpp-${arch}`);

  // Download bottle if not cached
  if (!fs.existsSync(cacheBottlePath) || fs.statSync(cacheBottlePath).size < 100 * 1024) {
    console.log(`📥 Downloading Homebrew bottle for ${arch}...`);
    console.log(`   URL: ${bottleInfo.url}`);

    // Homebrew bottles need authentication header for GHCR
    await downloadFile(bottleInfo.url, cacheBottlePath, {
      'Authorization': 'Bearer QQ==',
      'Accept': 'application/vnd.oci.image.layer.v1.tar+gzip'
    }, bottleInfo.sha256);
  } else {
    console.log(`   Using cached bottle`);
  }

  // Extract bottle
  console.log('📦 Extracting bottle...');
  if (fs.existsSync(cacheExtractDir)) {
    fs.rmSync(cacheExtractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(cacheExtractDir, { recursive: true });

  execSync(`tar -xzf "${cacheBottlePath}" -C "${cacheExtractDir}"`, { stdio: 'pipe' });

  // Find the whisper-cli binary in the extracted bottle
  const whisperCliPath = findFile(cacheExtractDir, 'whisper-cli');
  if (!whisperCliPath) {
    throw new Error('whisper-cli not found in extracted bottle');
  }

  // Copy binary
  console.log(`📋 Installing ${binaryName}...`);
  fs.copyFileSync(whisperCliPath, destPath);
  fs.chmodSync(destPath, 0o755);

  // Find and copy dylibs
  const libDir = path.dirname(whisperCliPath).replace('/bin', '/lib');
  const libInternalDir = path.dirname(whisperCliPath).replace('/bin', '/libinternal');

  for (const dylib of MACOS_DYLIBS) {
    const archDylibName = `${path.basename(dylib, '.dylib')}-${arch}.dylib`;
    const destDylib = path.join(BIN_DIR, archDylibName);

    // Check various locations
    for (const searchDir of [libDir, libInternalDir, path.dirname(whisperCliPath)]) {
      const srcDylib = path.join(searchDir, dylib);
      if (fs.existsSync(srcDylib)) {
        fs.copyFileSync(srcDylib, destDylib);
        fs.chmodSync(destDylib, 0o755);
        console.log(`   ✓ ${dylib} -> ${archDylibName}`);
        break;
      }
    }
  }

  // Fix rpaths and codesign
  console.log('🔧 Fixing library paths...');
  for (const dylib of MACOS_DYLIBS) {
    const archDylibName = `${path.basename(dylib, '.dylib')}-${arch}.dylib`;
    try {
      execSync(
        `install_name_tool -change @rpath/${dylib} @loader_path/${archDylibName} "${destPath}"`,
        { stdio: 'pipe' }
      );
    } catch (err) {
      // Some dylibs may not be referenced
    }
  }

  try {
    execSync(`codesign --force --sign - "${destPath}"`, { stdio: 'pipe' });
    for (const dylib of MACOS_DYLIBS) {
      const archDylibName = `${path.basename(dylib, '.dylib')}-${arch}.dylib`;
      const dylibPath = path.join(BIN_DIR, archDylibName);
      if (fs.existsSync(dylibPath)) {
        execSync(`codesign --force --sign - "${dylibPath}"`, { stdio: 'pipe' });
      }
    }
  } catch (err) {
    console.warn(`   ⚠ Codesign warning: ${err.message}`);
  }

  console.log(`✅ Installed ${binaryName}`);
  return destPath;
}

/**
 * Setup whisper.cpp for the requested macOS architectures
 */
async function setupMacOS(archs = ['arm64', 'x64']) {
  const targets = archs.filter(a => a === 'arm64' || a === 'x64');
  if (targets.length === 0) {
    throw new Error(`No valid macOS architectures requested (got: ${archs.join(', ') || 'none'})`);
  }

  const needed = targets.filter(a => !isValidBinary(path.join(BIN_DIR, BINARY_NAMES[`darwin-${a}`])));

  // Check if all requested archs already exist
  if (needed.length === 0) {
    console.log(`✅ whisper.cpp: requested macOS binaries already exist (${targets.join(', ')})`);
    return;
  }

  // Check if Homebrew is available
  try {
    execSync('which brew', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Homebrew not found. Please install Homebrew:\n\n' +
      '   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n\n' +
      'Then run this script again.'
    );
  }

  // Make sure whisper-cpp formula is available
  try {
    execSync('brew info whisper-cpp', { stdio: 'pipe' });
  } catch {
    console.log('📦 Updating Homebrew and fetching whisper-cpp info...');
    execSync('brew update', { stdio: 'pipe' });
  }

  // Download each requested architecture
  for (const arch of targets) {
    if (isValidBinary(path.join(BIN_DIR, BINARY_NAMES[`darwin-${arch}`]))) {
      console.log(`✅ whisper.cpp ${arch} already exists`);
    } else {
      await downloadHomebrewBottle(arch);
    }
  }
}

/**
 * Download and setup whisper.cpp binary for Windows
 */
async function downloadWindowsBinary() {
  const binaryName = BINARY_NAMES['win32-x64'];
  // Stage into utilities/bin/win32/ so packaging copies it to
  // resources/utilities/bin/ (see WIN_STAGE_DIR comment + runtime-paths.ts).
  if (!fs.existsSync(WIN_STAGE_DIR)) {
    fs.mkdirSync(WIN_STAGE_DIR, { recursive: true });
  }
  const destPath = path.join(WIN_STAGE_DIR, binaryName);
  const cacheZipPath = path.join(CACHE_DIR, `whisper-cpp-win32-v${WHISPER_CPP_VERSION}.zip`);
  const cacheExtractDir = path.join(CACHE_DIR, `whisper-cpp-win32`);

  // Check if already exists
  if (isValidBinary(destPath)) {
    console.log(`✅ Windows binary already exists`);
    return destPath;
  }

  console.log(`📥 Downloading whisper.cpp v${WHISPER_CPP_VERSION} for Windows...`);

  if (!fs.existsSync(cacheZipPath) || fs.statSync(cacheZipPath).size < 100 * 1024) {
    await downloadFile(WINDOWS_BINARY_URL, cacheZipPath);
  } else {
    console.log('   ZIP already downloaded');
  }

  console.log('📦 Extracting...');
  if (fs.existsSync(cacheExtractDir)) {
    fs.rmSync(cacheExtractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(cacheExtractDir, { recursive: true });
  await extractZip(cacheZipPath, cacheExtractDir);

  // Find whisper-cli.exe
  const possibleNames = ['whisper-cli.exe', 'whisper.exe', 'main.exe'];
  let foundBinary = null;

  for (const name of possibleNames) {
    foundBinary = findFile(cacheExtractDir, name);
    if (foundBinary) {
      console.log(`   Found binary: ${name}`);
      break;
    }
  }

  if (!foundBinary) {
    throw new Error(`Could not find whisper binary in extracted archive`);
  }

  fs.copyFileSync(foundBinary, destPath);
  console.log(`✅ Windows binary installed: ${binaryName}`);

  // Copy required DLLs next to the binary (utilities/bin/win32/) so they end up
  // alongside whisper-cli.exe in the packaged resources/utilities/bin/.
  const requiredDlls = ['ggml.dll', 'ggml-base.dll', 'ggml-cpu.dll', 'whisper.dll'];
  const binaryDir = path.dirname(foundBinary);

  const missingDlls = [];
  for (const dll of requiredDlls) {
    const dllPath = path.join(binaryDir, dll);
    if (fs.existsSync(dllPath)) {
      const destDllPath = path.join(WIN_STAGE_DIR, dll);
      fs.copyFileSync(dllPath, destDllPath);
      console.log(`   ✓ ${dll}`);
    } else {
      missingDlls.push(dll);
    }
  }

  if (missingDlls.length === requiredDlls.length) {
    // None of the expected runtime DLLs were found — whisper-cli.exe cannot run.
    throw new Error(
      `None of the required Windows DLLs (${requiredDlls.join(', ')}) were found in the ` +
      `whisper.cpp archive; the staged whisper-cli.exe would fail to launch.`
    );
  }
  if (missingDlls.length > 0) {
    console.warn(`   ⚠ Missing DLLs (not found in archive): ${missingDlls.join(', ')}`);
  }

  return destPath;
}

/**
 * Download all Whisper models
 */
async function downloadModels() {
  const downloadedModels = [];

  for (const model of MODELS) {
    const cacheModelPath = path.join(CACHE_DIR, model.name);
    const destModelPath = path.join(MODELS_DIR, model.name);

    if (fs.existsSync(destModelPath)) {
      const stats = fs.statSync(destModelPath);
      if (stats.size > 1000000) {
        console.log(`✅ ${model.name} already exists (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
        downloadedModels.push(destModelPath);
        continue;
      }
    }

    if (fs.existsSync(cacheModelPath)) {
      const stats = fs.statSync(cacheModelPath);
      if (stats.size > 1000000) {
        console.log(`✅ ${model.name} found in cache`);
        fs.copyFileSync(cacheModelPath, destModelPath);
        downloadedModels.push(destModelPath);
        continue;
      }
    }

    console.log(`📥 Downloading ${model.name} (${model.size})...`);
    await downloadFile(model.url, cacheModelPath);
    fs.copyFileSync(cacheModelPath, destModelPath);

    console.log(`✅ Model installed: ${model.name}`);
    downloadedModels.push(destModelPath);
  }

  return downloadedModels;
}

/**
 * Check if all required binaries and models are cached FOR THE REQUESTED TARGET.
 * Note: this keys off TARGET_PLATFORM/TARGET_ARCHS (the platform being packaged),
 * not the build machine, so `download:all:win` on a Mac does not falsely short-
 * circuit because Mac binaries happen to exist.
 */
function isEverythingCached() {
  // Models are always required
  const hasAllModels = MODELS.every(model => {
    const modelPath = path.join(MODELS_DIR, model.name);
    return fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1024 * 1024;
  });

  if (!hasAllModels) return false;

  // Check binaries based on the requested TARGET platform
  if (TARGET_PLATFORM === 'mac') {
    return requestedMacArchs().every(a => isValidBinary(path.join(BIN_DIR, BINARY_NAMES[`darwin-${a}`])));
  } else if (TARGET_PLATFORM === 'win') {
    return isValidBinary(stagedBinaryPath('win32-x64'));
  }
  // Linux is unsupported: never report "cached" so main() runs and errors out.
  return false;
}

/**
 * Main function
 */
async function main() {
  try {
    const platform = process.platform;

    // Linux is not supported: fail loudly BEFORE any "success" so that
    // clean:package:linux stops instead of producing a binary-less AppImage.
    if (TARGET_PLATFORM === 'linux') {
      throw new Error(
        'Linux target is not supported — no binaries staged. ' +
        'Aborting so packaging fails loudly rather than shipping an empty AppImage.'
      );
    }

    // Quick check if everything is cached (for the requested target)
    if (isEverythingCached()) {
      console.log('✅ whisper.cpp: All binaries and models already cached');
      return;
    }

    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         whisper.cpp Pre-Built Binary Setup               ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    console.log(`Build platform: ${platform} (${process.arch})`);
    console.log(`Target platform: ${TARGET_PLATFORM}${TARGET_PLATFORM === 'mac' ? ` (${requestedMacArchs().join(', ')})` : ''}\n`);

    // Create directories
    for (const dir of [BIN_DIR, MODELS_DIR, CACHE_DIR]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Download binaries based on the requested TARGET platform
    console.log('📋 Step 1: Download whisper.cpp binaries\n');

    if (TARGET_PLATFORM === 'mac') {
      await setupMacOS(requestedMacArchs());
    } else if (TARGET_PLATFORM === 'win') {
      await downloadWindowsBinary();
    } else {
      throw new Error(`Unsupported target platform: ${TARGET_PLATFORM}`);
    }

    // Download models
    console.log('\n📋 Step 2: Download Whisper models\n');
    const modelPaths = await downloadModels();

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║         whisper.cpp Setup Complete! ✅                    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    // List what was installed
    console.log('📁 Binaries:');
    for (const [key, name] of Object.entries(BINARY_NAMES)) {
      const binPath = stagedBinaryPath(key);
      if (fs.existsSync(binPath)) {
        const stats = fs.statSync(binPath);
        console.log(`   ✓ ${name} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
      }
    }

    console.log(`\n📁 Models: ${modelPaths.length} installed`);
    for (const mp of modelPaths) {
      console.log(`   ✓ ${path.basename(mp)}`);
    }

    console.log('\n💾 Files cached in .build-cache/whisper-cpp/ for reuse\n');

  } catch (error) {
    console.error('\n╔═══════════════════════════════════════════════════════════╗');
    console.error('║              Setup Failed ❌                              ║');
    console.error('╚═══════════════════════════════════════════════════════════╝\n');
    console.error(`Error: ${error.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { downloadWhisperCpp: main };
