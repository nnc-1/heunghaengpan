// 개발용: 옆 폴더(흥행판)의 최신 뷰어를 viewer/ 로 가져온다.
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', '..', '흥행판', '흥행판_보기.html');
if (!fs.existsSync(src)) { console.error('원본을 찾을 수 없어요:', src); process.exit(1); }
fs.copyFileSync(src, path.join(__dirname, '..', 'viewer', '흥행판_보기.html'));
console.log('뷰어 동기화 완료');
