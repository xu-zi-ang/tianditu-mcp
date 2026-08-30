// 天地图 HTTP 客户端：请求封装 / 缓存 / 限流 / XML 解析
// ★ 坐标系说明：天地图 CGCS2000 ≈ WGS84，与小程序 wx.getLocation 同系，免纠偏
const TIANDITU_BASE = 'https://api.tianditu.gov.cn';

const tk = process.env.TIANDITU_TK || '';
if (!tk) console.warn('[tianditu] 警告：环境变量 TIANDITU_TK 未设置');

// ===== 简易 LRU+TTL 缓存（geocode 结果基本不变，TTL 长）=====
const cache = new Map(); // key -> { value, expireAt }
const CACHE_MAX = 500;
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expireAt) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value; // LRU：淘汰最旧
    cache.delete(firstKey);
  }
  cache.set(key, { value, expireAt: Date.now() + ttlMs });
}

// ===== 单飞合并：同 key 并发请求只打一次天地图 =====
const inflight = new Map(); // key -> Promise

// ===== 限流：令牌桶（默认 8 req/s，留配额余量）=====
let tokens = 8;
let lastRefill = Date.now();
async function rateLimit() {
  const now = Date.now();
  tokens = Math.min(8, tokens + (now - lastRefill) / 1000 * 8);
  lastRefill = now;
  if (tokens < 1) {
    await new Promise(r => setTimeout(r, (1 - tokens) / 8 * 1000));
    tokens = 0;
  } else {
    tokens -= 1;
  }
}

// ===== 核心请求（带重试/超时/缓存/单飞）=====
// paramField：postStr（默认）/ ds（正地理编码 geocoder 专用）
async function tdtRequest(path, postStr, { ttlMs = 10 * 60 * 1000, type = 'query', paramField = 'postStr' } = {}) {
  const cacheKey = path + postStr + type + paramField;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const p = (async () => {
    await rateLimit();
    const url = `${TIANDITU_BASE}${path}?${paramField}=${encodeURIComponent(postStr)}&type=${type}&tk=${tk}`;
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (res.status === 429) { // 限流退避
          await new Promise(r => setTimeout(r, 1000 * (i + 1) * 2));
          continue;
        }
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { data = text; } // drive 返回 XML
        cacheSet(cacheKey, data, ttlMs);
        return data;
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw new Error('天地图请求失败: ' + (lastErr && lastErr.message));
  })();

  inflight.set(cacheKey, p);
  try { return await p; } finally { inflight.delete(cacheKey); }
}

// ===== XML 极简解析（只取 drive 需要的字段）=====
function parseDriveXml(xml) {
  const pick = (tag) => {
    const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
    return m ? m[1] : '';
  };
  const distance = parseFloat(pick('distance')) || 0;   // 公里
  const duration = parseInt(pick('duration'), 10) || 0; // 秒
  // simple 段：每段的文字引导
  const guides = [];
  const simpleBlock = xml.match(/<simple>([\s\S]*?)<\/simple>/);
  if (simpleBlock) {
    const items = simpleBlock[1].match(/<item[\s\S]*?<\/item>/g) || [];
    for (const it of items.slice(0, 8)) {
      const g = (it.match(/<strguide>([\s\S]*?)<\/strguide>/) || [])[1];
      const name = (it.match(/<streetNames>([\s\S]*?)<\/streetNames>/) || [])[1];
      const d = (it.match(/<streetDistance>([\s\S]*?)<\/streetDistance>/) || [])[1];
      if (g) guides.push({ guide: g.replace(/<[^>]+>/g, ''), road: name || '', meters: parseInt(d, 10) || 0 });
    }
  }
  return { distanceKm: Math.round(distance * 10) / 10, durationMin: Math.round(duration / 60), guides };
}

// ===== 工具实现（供 tools 层调用）=====

// 1. 正地理编码：地址 → 坐标
async function geocode(keyWord) {
  const r = await tdtRequest('/geocoder', JSON.stringify({ keyWord }), { ttlMs: 24 * 3600 * 1000, paramField: 'ds' });
  if (r.status !== '0' || !r.location) return { found: false, msg: r.msg || '未解析到坐标' };
  return {
    found: true,
    lon: parseFloat(r.location.lon), lat: parseFloat(r.location.lat),
    level: r.location.level || '', score: r.location.score || 0,
  };
}

// 2. 逆地理编码：坐标 → 地址
async function reverseGeocode(lon, lat) {
  const r = await tdtRequest('/geocoder', JSON.stringify({ lon, lat, ver: 1 }), { ttlMs: 5 * 60 * 1000, type: 'geocode' });
  if (r.status !== '0' || !r.result) return { found: false, msg: r.msg || '未解析到地址' };
  const c = r.result.addressComponent || {};
  return {
    found: true,
    formatted: r.result.formatted_address,
    city: c.city || '', road: c.road || '', poi: c.poi || '',
  };
}

// 3. POI 搜索（四合一：普通1/视野2/周边3/行政区12）
// queryTypes: 'nearby'|'normal'|'view'|'admin'
async function searchPoi({ keyWord, queryType = 'nearby', lon, lat, radius = 3000, adminCode, mapBound, level = 12, count = 8, start = 0, dataTypes }) {
  let qType, post;
  if (queryType === 'nearby') {
    if (lon === undefined || lat === undefined) throw new Error('周边搜索需要 lon/lat');
    qType = 3;
    post = { keyWord, queryType: qType, queryRadius: Math.min(radius, 10000), pointLonlat: lon + ',' + lat, start, count };
  } else if (queryType === 'admin') {
    if (!adminCode) throw new Error('行政区搜索需要 adminCode');
    qType = 12;
    post = { keyWord, queryType: qType, specify: adminCode, start, count };
  } else if (queryType === 'view') {
    if (!mapBound) throw new Error('视野搜索需要 mapBound');
    qType = 2;
    post = { keyWord, queryType: qType, mapBound, level, start, count };
  } else { // normal
    if (!mapBound) throw new Error('普通搜索需要 mapBound（可用 adminDistrict 拿 bound）');
    qType = 1;
    post = { keyWord, queryType: qType, mapBound, level, start, count };
  }
  if (dataTypes) post.dataTypes = dataTypes;
  const r = await tdtRequest('/v2/search', JSON.stringify(post), { ttlMs: 10 * 60 * 1000 });
  if (r.resultType !== 1 || !r.pois || !r.pois.length) {
    return { found: false, count: 0, msg: (r.status && r.status[0] && r.status[0].cndesc) || '无结果' };
  }
  return {
    found: true, count: r.count || r.pois.length,
    pois: r.pois.slice(0, count).map(p => ({
      name: p.name, lonlat: p.lonlat, address: p.address || '', phone: p.phone || '',
      typeName: p.typeName || '', distance: p.distance || '', // nearby 时带距离
      province: p.province || '', city: p.city || '', county: p.county || '',
    })),
  };
}

// 4. 驾车/步行路线规划（style: 0最快 1最短 2避开高速 3步行）
async function driveRoute({ origLon, origLat, destLon, destLat, style = 0, waypoints }) {
  const post = {
    orig: origLon + ',' + origLat,
    dest: destLon + ',' + destLat,
    style: String(Math.min(3, Math.max(0, style))),
  };
  if (waypoints && waypoints.length) post.mid = waypoints.join(';');
  const r = await tdtRequest('/drive', JSON.stringify(post), { ttlMs: 2 * 60 * 1000, type: 'search' });
  if (typeof r !== 'string' || r.indexOf('<distance>') < 0) {
    return { found: false, msg: '路线规划无结果' };
  }
  const parsed = parseDriveXml(r);
  return { found: true, ...parsed };
}

// 5. 行政区划：名称/编码 → 中心点+轮廓+下级
async function adminDistrict({ keyword, childLevel = 0, extensions = false }) {
  const url = `${TIANDITU_BASE}/v2/administrative?keyword=${encodeURIComponent(keyword)}&childLevel=${childLevel}&extensions=${extensions}&tk=${tk}`;
  await rateLimit();
  const cacheKey = 'admin:' + keyword + childLevel + extensions;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;
  const res = await fetch(url);
  const r = await res.json();
  if (r.status !== 200 || !r.data || !r.data.district || !r.data.district.length) {
    return { found: false, suggestion: (r.data && r.data.suggestion) || [] };
  }
  const out = {
    found: true,
    districts: r.data.district.map(d => ({
      name: d.name, gb: d.gb, level: d.level,
      center: d.center ? { lon: d.center.lng, lat: d.center.lat } : null,
      boundary: extensions ? (d.boundary || '').slice(0, 500) : undefined, // 轮廓极长，截断示例
    })),
  };
  cacheSet(cacheKey, out, 24 * 3600 * 1000);
  return out;
}

module.exports = { geocode, reverseGeocode, searchPoi, driveRoute, adminDistrict };
