// 发布前自动递增版本号：expo.version（patch）+ android.versionCode + ios.buildNumber
// 用法：npm run version:bump   （或 npm run release 一步完成 bump + commit + push）
const fs = require('fs');
const path = require('path');

const appJsonPath = path.join(__dirname, '..', 'app.json');
const raw = fs.readFileSync(appJsonPath, 'utf8');
const app = JSON.parse(raw);
const expo = app.expo || {};

const oldVersion = String(expo.version || '1.0.0');
const parts = oldVersion.split('.').map((n) => Number(n) || 0);
while (parts.length < 3) parts.push(0);
parts[2] += 1;
const newVersion = parts.join('.');

const oldCode = Number(expo.android?.versionCode || 0);
expo.version = newVersion;
expo.android = { ...(expo.android || {}), versionCode: oldCode + 1 };
expo.ios = { ...(expo.ios || {}), buildNumber: String(Number(expo.ios?.buildNumber || 0) + 1) };
app.expo = expo;

fs.writeFileSync(appJsonPath, JSON.stringify(app, null, 2) + '\n', 'utf8');
console.log(`版本已更新：${oldVersion} -> ${newVersion}（Android versionCode ${oldCode} -> ${oldCode + 1}）`);
