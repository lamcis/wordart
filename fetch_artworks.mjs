/**
 * fetch_artworks.mjs
 *
 * 用法：把这个文件放进 wordart 项目根目录，然后在终端运行：
 *   node fetch_artworks.mjs
 *
 * 会生成 artworks_raw.json。
 *
 * 断点续传规则（以"词 + 来源"为单位）：
 *   - 某来源已找到结果 → 跳过该来源
 *   - 某来源结果为空或上次超时/失败 → 重新搜索该来源
 *   这样 Met 找到了但 Archive 没找到，下次只重搜 Archive，不动 Met 的结果。
 *
 * 数据来源：
 *   1. Met Museum API
 *   2. Wikimedia Commons
 *   3. Internet Archive
 *   4. WikiArt
 */

import fs from "fs/promises";
import { ProxyAgent, fetch as undiciFetch } from "undici";

// ── 代理设置 ──────────────────────────────────────────────
const proxyAgent = new ProxyAgent("http://127.0.0.1:7897");
const fetch = (url, options = {}) =>
  undiciFetch(url, { ...options, dispatcher: proxyAgent });
// ─────────────────────────────────────────────────────────

const WORDS_FILE = "./words_list.txt";
const OUTPUT_FILE = "./artworks_raw.json";

const MAX_PER_SOURCE = 2;
const DELAY_MS = 300;

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJSON(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      headers: { "User-Agent": "WordArtApp/1.0 (educational project)" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return { __error: "http", status: res.status };
    }
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") {
      return { __error: "timeout" };
    }
    return { __error: "network", message: e.message };
  }
}

// 整词匹配（忽略大小写）
function containsWord(text, word) {
  if (!text) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`, "i");
  return regex.test(text);
}

// 找到第一个包含单词的字段，返回字段名和摘录
function findMatchingField(fields, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`, "i");
  for (const { name, text } of fields) {
    if (!text) continue;
    const idx = text.search(regex);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 60);
    const end = Math.min(text.length, idx + word.length + 60);
    const excerpt =
      (start > 0 ? "…" : "") +
      text.slice(start, end) +
      (end < text.length ? "…" : "");
    return { field: name, excerpt };
  }
  return null;
}

// ─────────────────────────────────────────────
// Met Museum API
// ─────────────────────────────────────────────

async function searchMet(word) {
  const searchUrl = `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${encodeURIComponent(word)}`;
  const searchData = await fetchJSON(searchUrl);

  if (searchData?.__error) {
    const reason = searchData.__error === "timeout" ? "超时" : `失败(${searchData.status || searchData.message})`;
    console.log(`  Met:     ✗ ${reason}`);
    return { status: "error", items: [] };
  }
  if (!searchData?.objectIDs || searchData.objectIDs.length === 0) {
    console.log(`  Met:     0 件 (站点总数: 0)`);
    return { status: "done", items: [] };
  }

  const total = searchData.total || searchData.objectIDs.length;
  const results = [];
  const candidates = searchData.objectIDs.slice(0, 10);

  for (const id of candidates) {
    if (results.length >= MAX_PER_SOURCE) break;
    await sleep(100);
    const detail = await fetchJSON(
      `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`
    );
    if (!detail || detail.__error || !detail.primaryImageSmall) continue;

    const tagText = (detail.tags || []).map((t) => t.term).join(", ");
    const fieldsToCheck = [
      { name: "title",          text: detail.title || "" },
      { name: "tags",           text: tagText },
      { name: "objectName",     text: detail.objectName || "" },
      { name: "culture",        text: detail.culture || "" },
      { name: "medium",         text: detail.medium || "" },
      { name: "artist",         text: detail.artistDisplayName || "" },
      { name: "classification", text: detail.classification || "" },
    ];

    const match = findMatchingField(fieldsToCheck, word);

    results.push({
      id: `met_${id}`,
      title: detail.title || "",
      artist: detail.artistDisplayName || "Unknown",
      year: detail.objectDate || "",
      type: detail.objectName || "",
      culture: detail.culture || "",
      medium: detail.medium || "",
      source: "met",
      image_url: detail.primaryImageSmall,
      image_url_large: detail.primaryImage,
      page_url: detail.objectURL || "",
      relevance: "",
      match_context: match
        ? { field: match.field, excerpt: match.excerpt }
        : { field: "search_engine", excerpt: "(模糊搜索命中，字段中未找到精确匹配)" },
      note: match ? `字段匹配(${match.field})` : "仅搜索命中",
    });
  }

  console.log(`  Met:     ${results.length} 件 (站点总数: ${total})`);
  return { status: "done", items: results };
}

// ─────────────────────────────────────────────
// Wikimedia Commons API
// ─────────────────────────────────────────────

async function searchWikimedia(word) {
  const queries = [word, `${word} painting`, `${word} artwork`];
  const seen = new Set();
  const results = [];
  let totalHits = 0;

  for (const q of queries) {
    if (results.length >= MAX_PER_SOURCE) break;
    await sleep(100);
    const url =
      `https://commons.wikimedia.org/w/api.php?` +
      `action=query&list=search&srsearch=${encodeURIComponent(q)}` +
      `&srnamespace=6&srlimit=6&srprop=snippet|titlesnippet&format=json&origin=*`;

    const data = await fetchJSON(url);
    if (data?.__error) {
      const reason = data.__error === "timeout" ? "超时" : `失败(${data.status || data.message})`;
      console.log(`  Wiki:    ✗ ${reason}`);
      return { status: "error", items: [] };
    }
    if (!data?.query?.search) continue;
    if (totalHits === 0) totalHits = data.query.searchinfo?.totalhits || 0;

    for (const item of data.query.search) {
      if (results.length >= MAX_PER_SOURCE) break;
      if (seen.has(item.title)) continue;

      const rawFileName = item.title.replace("File:", "");
      const fileName = rawFileName.replace(/\.[^.]+$/, "").replace(/_/g, " ");
      const snippet = item.snippet?.replace(/<[^>]+>/g, "") || "";

      const fieldsToCheck = [
        { name: "filename", text: fileName },
        { name: "snippet",  text: snippet },
      ];
      const match = findMatchingField(fieldsToCheck, word);
      if (!match) continue;

      seen.add(item.title);
      results.push({
        id: `wiki_${item.pageid}`,
        title: fileName,
        artist: "",
        year: "",
        type: "artwork",
        culture: "",
        medium: "",
        source: "wikimedia",
        image_url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(rawFileName)}?width=600`,
        image_url_large: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(rawFileName)}`,
        page_url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(item.title)}`,
        relevance: "",
        match_context: { field: match.field, excerpt: match.excerpt },
        note: "",
      });
    }
  }

  console.log(`  Wiki:    ${results.length} 件 (站点总数: ${totalHits})`);
  return { status: "done", items: results };
}

// ─────────────────────────────────────────────
// Internet Archive API
// 直接搜单词，不加额外限定词，避免漏掉结果
// ─────────────────────────────────────────────

async function searchArchive(word) {
  // 三种查询策略：单词本身、限定图像类型、限定艺术相关
  const queries = [
    `${word} AND mediatype:image`,
    `title:(${word}) AND mediatype:image`,
    `description:(${word}) AND mediatype:image`,
  ];

  const seen = new Set();
  const results = [];
  let totalHits = 0;

  for (const q of queries) {
    if (results.length >= MAX_PER_SOURCE) break;
    await sleep(100);

    const url =
      `https://archive.org/advancedsearch.php?` +
      `q=${encodeURIComponent(q)}` +
      `&fl[]=identifier,title,creator,date,description,mediatype` +
      `&rows=8&page=1&output=json`;

    const data = await fetchJSON(url);
    if (data?.__error) {
      const reason = data.__error === "timeout" ? "超时" : `失败(${data.status || data.message})`;
      console.log(`  Archive: ✗ ${reason}`);
      return { status: "error", items: [] };
    }
    if (!data?.response?.docs) continue;
    if (totalHits === 0) totalHits = data.response.numFound || 0;

    for (const item of data.response.docs) {
      if (results.length >= MAX_PER_SOURCE) break;
      if (seen.has(item.identifier)) continue;

      const titleStr = item.title || "";
      const descStr  = (item.description || "").toString();

      const fieldsToCheck = [
        { name: "title",       text: titleStr },
        { name: "description", text: descStr  },
      ];
      const match = findMatchingField(fieldsToCheck, word);
      if (!match) continue;

      seen.add(item.identifier);
      results.push({
        id: `archive_${item.identifier}`,
        title: titleStr,
        artist: item.creator || "",
        year: item.date || "",
        type: "image",
        culture: "",
        medium: "",
        source: "archive",
        image_url: `https://archive.org/services/img/${item.identifier}`,
        image_url_large: `https://archive.org/services/img/${item.identifier}`,
        page_url: `https://archive.org/details/${item.identifier}`,
        relevance: "",
        match_context: { field: match.field, excerpt: match.excerpt },
        note: "",
      });
    }
  }

  console.log(`  Archive: ${results.length} 件 (站点总数: ${totalHits})`);
  return { status: "done", items: results };
}

// ─────────────────────────────────────────────
// WikiArt API
// ─────────────────────────────────────────────

async function searchWikiArt(word) {
  const url = `https://www.wikiart.org/en/search/${encodeURIComponent(word)}/1?json=2`;
  const data = await fetchJSON(url);

  if (data?.__error) {
    const reason = data.__error === "timeout" ? "超时" : `失败(${data.status || data.message})`;
    console.log(`  WikiArt: ✗ ${reason}`);
    return { status: "error", items: [] };
  }

  const items = Array.isArray(data) ? data : (data?.paintings || []);
  if (items.length === 0) {
    console.log(`  WikiArt: 0 件 (站点总数: 0)`);
    return { status: "done", items: [] };
  }

  const results = [];
  for (const item of items) {
    if (results.length >= MAX_PER_SOURCE) break;
    if (!item.image) continue;

    const titleStr = item.title || "";
    const match = findMatchingField([{ name: "title", text: titleStr }], word);
    if (!match) continue;

    results.push({
      id: `wikiart_${item.contentId || item.id || titleStr}`,
      title: titleStr,
      artist: item.artistName || "",
      year: item.completitionYear ? String(item.completitionYear) : "",
      type: "painting",
      culture: "",
      medium: "",
      source: "wikiart",
      image_url: item.image,
      image_url_large: item.image,
      page_url: item.url ? `https://www.wikiart.org${item.url}` : "",
      relevance: "",
      match_context: { field: match.field, excerpt: match.excerpt },
      note: "标题匹配",
    });
  }

  console.log(`  WikiArt: ${results.length} 件 (站点总数: ${items.length})`);
  return { status: "done", items: results };
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────

// 所有来源的名称列表，用于逐来源追踪
const ALL_SOURCES = ["met", "wikimedia", "archive", "wikiart"];

async function main() {
  const raw = await fs.readFile(WORDS_FILE, "utf-8");
  const words = raw.split("\n").map((w) => w.trim()).filter((w) => w.length > 0);

  console.log(`共 ${words.length} 个单词，开始搜索...\n`);

  // results 结构：
  // {
  //   "word": {
  //     word: "...",
  //     artworks: [...],
  //     total_found: N,
  //     source_status: {        ← 新增：每个来源的搜索状态
  //       met:       "done" | "error" | "pending",
  //       wikimedia: "done" | "error" | "pending",
  //       archive:   "done" | "error" | "pending",
  //       wikiart:   "done" | "error" | "pending",
  //     }
  //   }
  // }

  let results = {};
  try {
    const existing = await fs.readFile(OUTPUT_FILE, "utf-8");
    results = JSON.parse(existing);

    // 统计
    let skipCount = 0, retryCount = 0;
    for (const word of words) {
      const r = results[word];
      if (!r) continue;
      const statuses = r.source_status || {};
      const needsRetry = ALL_SOURCES.some(
        (s) => !statuses[s] || statuses[s] === "error"
      );
      if (needsRetry) retryCount++;
      else skipCount++;
    }
    console.log(`发现已有结果文件：`);
    console.log(`  ${skipCount} 个词所有来源已完成 → 跳过`);
    console.log(`  ${retryCount} 个词有来源待搜索或上次出错 → 重新搜索\n`);
  } catch {
    console.log("没有已有文件，从头开始。\n");
  }

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const existing = results[word] || { artworks: [], source_status: {} };
    const statuses = existing.source_status || {};

    // 检查某来源的现有结果是否都含有 match_context
    function sourceLacksContext(sourceName) {
      const sourceArtworks = existing.artworks.filter((a) => a.source === sourceName);
      if (sourceArtworks.length === 0) return false; // 没有结果，不靠这个判断
      return sourceArtworks.some((a) => !a.match_context);
    }

    function sourceIsEmpty(sourceName) {
      return existing.artworks.filter((a) => a.source === sourceName).length === 0;
    }

    const needsMet     = !statuses.met      || statuses.met      === "error" || sourceLacksContext("met")     || sourceIsEmpty("met");
    const needsWiki    = !statuses.wikimedia || statuses.wikimedia === "error" || sourceLacksContext("wikimedia") || sourceIsEmpty("wikimedia");
    const needsArchive = !statuses.archive  || statuses.archive  === "error" || sourceLacksContext("archive") || sourceIsEmpty("archive");
    const needsWikiArt = !statuses.wikiart  || statuses.wikiart  === "error" || sourceLacksContext("wikiart") || sourceIsEmpty("wikiart");

    if (!needsMet && !needsWiki && !needsArchive && !needsWikiArt) {
      continue; // 所有来源都已完成，跳过
    }

    console.log(`[${i + 1}/${words.length}] ${word}`);

    // 保留已有的艺术品（去掉本次会重搜的来源的旧结果）
    const sourcesToRefresh = [];
    if (needsMet)     sourcesToRefresh.push("met");
    if (needsWiki)    sourcesToRefresh.push("wikimedia");
    if (needsArchive) sourcesToRefresh.push("archive");
    if (needsWikiArt) sourcesToRefresh.push("wikiart");

    const keptArtworks = existing.artworks.filter(
      (a) => !sourcesToRefresh.includes(a.source)
    );

    // 搜索各来源
    let metResult     = { status: statuses.met,      items: [] };
    let wikiResult    = { status: statuses.wikimedia, items: [] };
    let archiveResult = { status: statuses.archive,   items: [] };
    let wikiArtResult = { status: statuses.wikiart,   items: [] };

    if (needsMet) {
      metResult = await searchMet(word);
      await sleep(DELAY_MS);
    }
    if (needsWiki) {
      wikiResult = await searchWikimedia(word);
      await sleep(DELAY_MS);
    }
    if (needsArchive) {
      archiveResult = await searchArchive(word);
      await sleep(DELAY_MS);
    }
    if (needsWikiArt) {
      wikiArtResult = await searchWikiArt(word);
      await sleep(DELAY_MS);
    }

    const newArtworks = [
      ...keptArtworks,
      ...metResult.items,
      ...wikiResult.items,
      ...archiveResult.items,
      ...wikiArtResult.items,
    ];

    results[word] = {
      word,
      artworks: newArtworks,
      total_found: newArtworks.length,
      source_status: {
        met:       metResult.status      || statuses.met      || "pending",
        wikimedia: wikiResult.status     || statuses.wikimedia || "pending",
        archive:   archiveResult.status  || statuses.archive  || "pending",
        wikiart:   wikiArtResult.status  || statuses.wikiart  || "pending",
      },
    };

    console.log(`  合计:    ${newArtworks.length} 件\n`);
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf-8");
  }

  // 最终统计
  const total   = Object.keys(results).length;
  const withArt = Object.values(results).filter((r) => r.total_found > 0).length;
  const empty   = total - withArt;

  console.log("✅ 完成！");
  console.log(`总词数：${total}`);
  console.log(`找到艺术品：${withArt} 个词`);
  console.log(`未找到：${empty} 个词`);
  console.log(`结果保存在：${OUTPUT_FILE}`);
}

main().catch(console.error);
