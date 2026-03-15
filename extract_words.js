import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./words_cet4only.json', 'utf-8'));

const words = data
  .map(entry => entry.word)
  .sort((a, b) => a.localeCompare(b));

fs.writeFileSync('./words_list.txt', words.join('\n'), 'utf-8');
console.log(`共提取 ${words.length} 个单词`);
