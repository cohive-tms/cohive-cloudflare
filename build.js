import { existsSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve } from 'path';

const frontendDir = resolve('frontend');
const frontendPackageJson = resolve('frontend/package.json');

// サブモジュールがチェックアウトされているかチェック
if (!existsSync(frontendPackageJson)) {
  console.log('frontend/package.json not found. Trying to initialize git submodules...');

  // 方法 1: git submodule の更新を試みる
  spawnSync('git', ['submodule', 'update', '--init', '--recursive'], {
    stdio: 'inherit',
    shell: true
  });

  // 方法 2 (フォールバック): submoduleが取得できなかった場合、直接 git clone を実行する
  if (!existsSync(frontendPackageJson)) {
    console.log('Submodule update failed or skipped. Falling back to direct git clone...');
    
    // 既存の（空の）frontendディレクトリを削除
    if (existsSync(frontendDir)) {
      try {
        rmSync(frontendDir, { recursive: true, force: true });
      } catch (err) {
        console.warn('Failed to remove existing frontend directory:', err.message);
      }
    }

    // 直接クローンを実行 (高速化のため --depth 1 を指定)
    spawnSync('git', ['clone', '--depth', '1', 'https://github.com/cospace-tms/cospace-frontend.git', 'frontend'], {
      stdio: 'inherit',
      shell: true
    });
  }

  // 最終確認
  if (!existsSync(frontendPackageJson)) {
    console.error('======================================================');
    console.error('Error: frontend/package.json not found after all attempts.');
    console.error('Please ensure that the Git submodules or repository clone are accessible.');
    console.error('======================================================');
    process.exit(1);
  }
}


console.log('Installing frontend dependencies...');
const installResult = spawnSync('npm', ['install'], {
  cwd: resolve('frontend'),
  stdio: 'inherit',
  shell: true
});

if (installResult.status !== 0) {
  process.exit(installResult.status || 1);
}

console.log('Building frontend...');
// 渡された引数をそのまま転送できるように、process.argvを考慮します
// 元のコマンド: npm run build -- --outDir ../dist
const extraArgs = process.argv.slice(2);
const buildArgs = ['run', 'build', '--', '--outDir', '../dist', ...extraArgs];

const buildResult = spawnSync('npm', buildArgs, {
  cwd: resolve('frontend'),
  stdio: 'inherit',
  shell: true
});

process.exit(buildResult.status || 0);
