import fs from 'fs';

const middle = JSON.parse(fs.readFileSync('./初中词库.json', 'utf-8'));
const high = JSON.parse(fs.readFileSync('./高中词库.json', 'utf-8'));
const cet4Raw = JSON.parse(fs.readFileSync('./CTE4词库.json', 'utf-8'));

// 四级内部先去重
const cet4Map = new Map();
cet4Raw.forEach(entry => cet4Map.set(entry.word, entry));
const cet4 = Array.from(cet4Map.values());

// 初中和高中词库里所有词建成一个集合
const knownWords = new Set([
  ...middle.map(entry => entry.word),
  ...high.map(entry => entry.word)
]);

// 只保留四级里有、初中和高中都没有的词
const cet4Only = cet4.filter(entry => !knownWords.has(entry.word));

fs.writeFileSync('./words_cet4only.json', JSON.stringify(cet4Only, null, 2), 'utf-8');
console.log(`初中词库：${middle.length} 词`);
console.log(`高中词库：${high.length} 词`);
console.log(`四级词库（去重前）：${cet4Raw.length} 词`);
console.log(`四级词库（去重后）：${cet4.length} 词`);
console.log(`四级独有（去除初中+高中后）：${cet4Only.length} 词`);