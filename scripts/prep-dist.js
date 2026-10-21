// viewer/흥행판_보기.html → dist/index.html (앱 화면으로 사용)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.copyFileSync(path.join(root, 'viewer', '흥행판_보기.html'), path.join(root, 'dist', 'index.html'));
console.log('dist/index.html 준비 완료');
