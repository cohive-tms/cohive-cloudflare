import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve } from 'path';

const frontendPackageJson = resolve('frontend/package.json');

// サブモジュールがチェックアウトされているかチェック
if (!existsSync(frontendPackageJson)) {
  console.log('frontend/package.json not found. Trying to initialize git submodules...');
  const submoduleResult = spawnSync('git', ['submodule', 'update', '--init', '--recursive'], {
    stdio: 'inherit',
    shell: true
  });

  if (!existsSync(frontendPackageJson)) {
    console.error('======================================================');
    console.error('Error: frontend/package.json not found after trying to initialize submodules.');
    console.error('Please ensure that the Git submodules are initialized.');
    console.error('Run: git submodule update --init --recursive');
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
