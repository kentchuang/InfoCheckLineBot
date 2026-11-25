const { execSync, execFileSync } = require('child_process');

const DEPLOYMENT_ID = 'AKfycbw6W7bu7kIzakMN8j1cpf-QyXHP_R0HzUjr5x7wD8pUG5N2Iyhv5kZlZXhg6kXPw6SfQA';

let description = process.argv.slice(2).join(' ').trim();
if (!description) {
  try {
    description = execFileSync('git', ['log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim();
  } catch (e) {
    description = '';
  }
}

if (!description) {
  console.error('❌ 部署中止：必須提供版本說明（例如：npm run deploy -- "版本說明"），嚴禁部署未命名版本。');
  process.exit(1);
}

const safeDesc = description.replace(/"/g, "'");
console.log(`🚀 準備部署至 GAS (${DEPLOYMENT_ID})`);
console.log(`📝 版本說明：${safeDesc}`);

execSync('npx @google/clasp push --force', { stdio: 'inherit' });
execSync(`npx @google/clasp deploy -i ${DEPLOYMENT_ID} -d "${safeDesc}"`, { stdio: 'inherit' });
