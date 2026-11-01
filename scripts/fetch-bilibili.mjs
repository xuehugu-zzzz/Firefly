#!/usr/bin/env node
/**
 * 抓取 B 站用户公开数据（视频列表 + 播放量 + 粉丝数 + 公开收藏夹），写入 src/data/bilibili.json
 *
 * 用法:
 *   node scripts/fetch-bilibili.mjs
 *   BILI_UID=123456 BILI_FAV_IDS=none node scripts/fetch-bilibili.mjs          # 不抓收藏夹
 *   BILI_FAV_IDS=111,222 BILI_FAV_MAX_PAGES=3 node scripts/fetch-bilibili.mjs  # 只抓指定收藏夹
 *
 * 说明:
 * - B 站 space 接口有风控，必须带 WBI 签名 + buvid cookie + 模拟浏览器的请求头
 * - 遇到 -412 / -352 会刷新 cookie 并退避重试；仍失败则不修改已有 JSON，退出码仍为 0
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, "..", "src", "data", "bilibili.json");

const UID = Number(process.env.BILI_UID || 1826932251);
// all = 所有公开收藏夹（默认）；none = 不抓；否则逗号分隔的收藏夹 id
const FAV_MODE = (process.env.BILI_FAV_IDS || "all").trim();
const MAX_FAV_PAGES = Number(process.env.BILI_FAV_MAX_PAGES || 1);
const RETRY_DELAY_MS = Number(process.env.BILI_RETRY_DELAY_MS || 8000);
const TIMEOUT_MS = 20000;

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// WBI mixinKey 置换表
const MIXIN_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
	33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
	61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
	36, 20, 34, 44, 52,
];

const RISK_CODES = new Set([-412, -352, -799, -101]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const timedFetch = (url, opts = {}) =>
	fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });

let cookie = "";

function headers(referer) {
	return {
		"User-Agent": UA,
		Accept: "application/json, text/plain, */*",
		"Accept-Language": "zh-CN,zh;q=0.9",
		Referer: referer || "https://www.bilibili.com/",
		Origin: "https://space.bilibili.com",
		"sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": '"Windows"',
		...(cookie ? { Cookie: cookie } : {}),
	};
}

async function getJson(url, referer) {
	const res = await timedFetch(url, { headers: headers(referer) });
	const text = await res.text();
	if (text.trimStart().startsWith("<")) {
		const err = new Error(`风控拦截 (HTTP ${res.status}): 返回 HTML 而非 JSON`);
		err.code = -412;
		throw err;
	}
	const json = JSON.parse(text);
	if (json.code !== 0) {
		const err = new Error(`接口返回 code=${json.code} ${json.message || ""}`.trim());
		err.code = json.code;
		throw err;
	}
	return json.data;
}

/** 带退避重试的请求：遇到风控码就换 cookie 再来 */
async function getJsonRetry(url, referer, label, attempts = 3) {
	let lastErr;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await getJson(url, referer);
		} catch (err) {
			lastErr = err;
			if (!RISK_CODES.has(err.code)) throw err;
			console.warn(
				`[bilibili] ${label} 第 ${attempt} 次失败 (code=${err.code})，${(RETRY_DELAY_MS * attempt) / 1000}s 后重试…`,
			);
			await sleep(RETRY_DELAY_MS * attempt);
			if (attempt < attempts) {
				try {
					await initCookie();
				} catch {
					/* 换 cookie 失败不影响重试 */
				}
			}
		}
	}
	throw lastErr;
}

/** 1. 拿 buvid3 / buvid4 cookie */
async function initCookie() {
	const data = await getJson("https://api.bilibili.com/x/frontend/finger/spi");
	cookie = `buvid3=${data.b_3}; buvid4=${data.b_4}`;
}

/** 2. 拿 WBI 密钥并生成签名（nav 未登录返回 -101，但 wbi_img 依然有效） */
async function getSigner() {
	const res = await timedFetch("https://api.bilibili.com/x/web-interface/nav", {
		headers: headers("https://www.bilibili.com/"),
	});
	const json = await res.json();
	const wbiImg = json?.data?.wbi_img;
	if (!wbiImg?.img_url || !wbiImg?.sub_url) {
		throw new Error(`无法获取 WBI 密钥: code=${json?.code} ${json?.message || ""}`.trim());
	}
	const raw =
		wbiImg.img_url.split("/").pop().split(".")[0] +
		wbiImg.sub_url.split("/").pop().split(".")[0];
	const mixinKey = MIXIN_TAB.map((i) => raw[i]).join("").slice(0, 32);

	return (params) => {
		const p = { ...params, wts: Math.floor(Date.now() / 1000) };
		const query = Object.keys(p)
			.sort()
			.map(
				(k) =>
					`${encodeURIComponent(k)}=${encodeURIComponent(
						String(p[k]).replace(/[!'()*]/g, ""),
					)}`,
			)
			.join("&");
		return `${query}&w_rid=${md5(query + mixinKey)}`;
	};
}

// space 接口必需的浏览器指纹参数
const DM_PARAMS = {
	dm_img_list: "[]",
	dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
	dm_cover_img_str: "QU5HTEUgKE5WSURJQSwgTlZJRElB",
	dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
};

const httpsUrl = (u) => (u ? u.replace(/^http:\/\//, "https://") : u);
const withThumb = (u, size = "@480w_270h_1c.webp") =>
	u ? (u.includes("@") ? u : `${httpsUrl(u)}${size}`) : u;

const REF_VIDEO = `https://space.bilibili.com/${UID}/video`;
const REF_SPACE = `https://space.bilibili.com/${UID}`;
const REF_FAV = `https://space.bilibili.com/${UID}/favlist`;

/** 主接口：space/wbi/arc/search（含播放/弹幕/评论数） */
async function fetchVideosByArcSearch(sign) {
	const videos = [];
	let page = 1;
	let total = 0;

	while (page <= 20) {
		const data = await getJsonRetry(
			`https://api.bilibili.com/x/space/wbi/arc/search?${sign({
				mid: UID,
				ps: 30,
				pn: page,
				order: "pubdate",
				web_location: 1550101,
				...DM_PARAMS,
			})}`,
			REF_VIDEO,
			"arc/search",
		);

		total = data.page?.count ?? 0;
		const list = data.list?.vlist ?? [];
		for (const v of list) {
			videos.push({
				bvid: v.bvid,
				title: v.title,
				cover: withThumb(v.pic),
				play: v.play ?? 0,
				danmaku: v.video_review ?? 0,
				comment: v.comment ?? v.review ?? 0,
				duration: v.length || "",
				created: v.created ? new Date(v.created * 1000).toISOString() : null,
				url: `https://www.bilibili.com/video/${v.bvid}`,
			});
		}

		if (videos.length >= total || list.length === 0) break;
		page += 1;
		await sleep(300);
	}

	return { videos, total };
}

/** 备用接口：series/recArchivesByKeywords（只有播放量，风控更宽松） */
async function fetchVideosBySeries() {
	const data = await getJsonRetry(
		`https://api.bilibili.com/x/series/recArchivesByKeywords?mid=${UID}&keywords=&ps=30&pn=1&orderby=pubdate`,
		REF_VIDEO,
		"series",
	);
	const archives = data.archives || [];
	return {
		total: archives.length,
		videos: archives.map((v) => ({
			bvid: v.bvid,
			title: v.title,
			cover: withThumb(v.pic),
			play: v.stat?.view ?? 0,
			danmaku: 0,
			comment: 0,
			duration: String(v.duration || ""),
			created: v.pubdate ? new Date(v.pubdate * 1000).toISOString() : null,
			url: `https://www.bilibili.com/video/${v.bvid}`,
		})),
	};
}

async function fetchVideos(sign) {
	try {
		return await fetchVideosByArcSearch(sign);
	} catch (err) {
		console.warn(`[bilibili] 主接口失败 (${err.message})，尝试备用接口…`);
		return await fetchVideosBySeries();
	}
}

async function fetchUser() {
	const data = await getJsonRetry(
		`https://api.bilibili.com/x/web-interface/card?mid=${UID}`,
		REF_SPACE,
		"card",
	);
	const card = data.card;
	return {
		uid: UID,
		name: card.name,
		face: httpsUrl(card.face),
		sign: card.sign || "",
		fans: card.fans ?? 0,
		following: card.friend ?? 0,
		url: REF_SPACE,
	};
}

/** 列出该用户的公开收藏夹 */
async function fetchFavFolders() {
	const data = await getJsonRetry(
		`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${UID}`,
		REF_FAV,
		"fav-folders",
	);
	return (data.list || []).map((f) => ({
		id: f.id,
		title: f.title,
		mediaCount: f.media_count ?? 0,
	}));
}

async function fetchFavorite(folder) {
	const medias = [];
	let info = null;
	let hasMore = false;

	for (let page = 1; page <= MAX_FAV_PAGES; page += 1) {
		const data = await getJsonRetry(
			`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${folder.id}&ps=20&pn=${page}&platform=web&order=mtime&type=0`,
			`${REF_FAV}?fid=${folder.id}`,
			`fav:${folder.id}`,
			2,
		);
		info = info || data.info;
		for (const m of data.medias || []) {
			if (m.title === "已失效视频") continue;
			medias.push({
				bvid: m.bvid,
				title: m.title,
				cover: withThumb(m.cover),
				upper: m.upper?.name || "",
				play: m.cnt_info?.play ?? 0,
				duration: m.duration || "",
				url: `https://www.bilibili.com/video/${m.bvid}`,
			});
		}
		hasMore = Boolean(data.has_more);
		if (!hasMore) break;
		await sleep(300);
	}

	return {
		id: folder.id,
		title: info?.title || folder.title,
		mediaCount: info?.media_count ?? folder.mediaCount,
		url: `${REF_FAV}?fid=${folder.id}`,
		medias,
		hasMore,
	};
}

async function main() {
	console.log(`[bilibili] 开始抓取 UID=${UID} 的公开数据…`);
	await initCookie();
	const sign = await getSigner();

	const user = await fetchUser();
	console.log(`[bilibili] 用户: ${user.name}  粉丝 ${user.fans}`);

	const { videos, total } = await fetchVideos(sign);
	const totalPlay = videos.reduce((sum, v) => sum + v.play, 0);
	console.log(`[bilibili] 视频 ${videos.length}/${total} 个，总播放 ${totalPlay}`);

	// 收藏夹
	let targets = [];
	if (FAV_MODE.toLowerCase() !== "none") {
		const folders = await fetchFavFolders();
		console.log(`[bilibili] 公开收藏夹 ${folders.length} 个`);
		if (FAV_MODE.toLowerCase() === "all") {
			targets = folders;
		} else {
			const ids = new Set(
				FAV_MODE.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			);
			targets = folders.filter((f) => ids.has(String(f.id)));
		}
	}

	const favorites = [];
	for (const folder of targets) {
		try {
			const fav = await fetchFavorite(folder);
			favorites.push(fav);
			console.log(
				`[bilibili] 收藏夹「${fav.title}」抓到 ${fav.medias.length}/${fav.mediaCount} 条`,
			);
		} catch (err) {
			console.warn(`[bilibili] 收藏夹「${folder.title}」抓取失败: ${err.message}`);
		}
		await sleep(400);
	}

	const payload = {
		uid: UID,
		fetchedAt: new Date().toISOString(),
		user,
		stats: {
			videoCount: total,
			totalPlay,
			totalDanmaku: videos.reduce((s, v) => s + v.danmaku, 0),
			totalComment: videos.reduce((s, v) => s + v.comment, 0),
			favFolderCount: favorites.length,
		},
		videos,
		favorites,
	};

	fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
	fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	console.log(`[bilibili] 已写入 ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch((err) => {
	// 抓取失败不中断构建：保留上一次的 JSON
	console.warn(`[bilibili] 抓取失败，保留旧数据: ${err.message}`);
	process.exit(0);
});
