// MCP 工具定义：7 个工具，覆盖天地图 6 类 API（含公交规划）
// 每个：name / description（给模型看，决定调用准确率）/ inputSchema / handler
const tdt = require('./tianditu');

const TOOLS = [
  {
    name: 'geocode',
    description: '地理编码：把地址/地名解析为经纬度坐标。适用于"XX在哪里/帮我定位XX/查XX坐标"。返回 lon(经度)、lat(纬度)、level(精度级别)。地址越完整精度越高。',
    inputSchema: {
      type: 'object',
      properties: {
        keyWord: { type: 'string', description: '地址或地名，如"杭州西湖风景名胜区"' },
      },
      required: ['keyWord'],
    },
    async handler({ keyWord }) { return tdt.geocode(keyWord); },
  },
  {
    name: 'reverse_geocode',
    description: '逆地理编码：把经纬度解析为结构化地址。适用于"我现在在哪/这个坐标是什么地方"。返回格式化地址、城市、道路、附近POI。',
    inputSchema: {
      type: 'object',
      properties: {
        lon: { type: 'number', description: '经度（WGS84/CGCS2000）' },
        lat: { type: 'number', description: '纬度（WGS84/CGCS2000）' },
      },
      required: ['lon', 'lat'],
    },
    async handler({ lon, lat }) { return tdt.reverseGeocode(lon, lat); },
  },
  {
    name: 'search_poi',
    description: 'POI搜索：按关键词搜地点。queryType=nearby 周边搜（给 lon/lat/radius，返回带距离，适合"附近有什么吃的"）；normal 普通搜（给 mapBound，适合"西湖在哪"）；admin 行政区搜（给 adminCode）。返回名称/地址/坐标/距离/分类。',
    inputSchema: {
      type: 'object',
      properties: {
        keyWord: { type: 'string', description: '搜索关键词，如"美食"/"咖啡"/"停车场"' },
        queryType: { type: 'string', enum: ['nearby', 'normal', 'admin', 'view'], description: '搜索类型，默认 nearby' },
        lon: { type: 'number', description: '中心点经度（nearby 必填）' },
        lat: { type: 'number', description: '中心点纬度（nearby 必填）' },
        radius: { type: 'number', description: '搜索半径米数，默认3000，最大10000（nearby 用）' },
        adminCode: { type: 'string', description: '9位行政区国标码（admin 用，可先调 admin_district 获取）' },
        mapBound: { type: 'string', description: '视野范围 "minx,miny,maxx,maxy"（normal/view 用）' },
        count: { type: 'number', description: '返回条数，默认8，最大20' },
        dataTypes: { type: 'string', description: '分类过滤，如"餐饮,公园"' },
      },
      required: ['keyWord'],
    },
    async handler(p) {
      const r = await tdt.searchPoi({ ...p, count: Math.min(p.count || 8, 20) });
      if (!r.found) return r;
      // 模型友好： nearby 结果按距离排序提示
      return r;
    },
  },
  {
    name: 'drive_route',
    description: '路线规划：起点到终点的驾车/步行路线。返回总距离(公里)、总时长(分钟)、分段引导。style: 0最快 1最短 2避开高速 3步行。适合"从A到B多远/怎么走/步行多久"。',
    inputSchema: {
      type: 'object',
      properties: {
        origLon: { type: 'number', description: '起点经度' },
        origLat: { type: 'number', description: '起点纬度' },
        destLon: { type: 'number', description: '终点经度' },
        destLat: { type: 'number', description: '终点纬度' },
        style: { type: 'number', enum: [0, 1, 2, 3], description: '路线类型，默认0最快，3为步行' },
        waypoints: { type: 'array', items: { type: 'string' }, description: '途经点 ["lon,lat", ...]，最多3个' },
      },
      required: ['origLon', 'origLat', 'destLon', 'destLat'],
    },
    async handler(p) { return tdt.driveRoute(p); },
  },
  {
    name: 'transit_route',
    description: '公交/地铁路线规划：起点到终点的公共交通方案（公交+地铁）。返回最优方案总时长(分钟)、距离(公里)、乘车线路名（如"地铁2号线→4号线"）、换乘次数、步行时长、备选线路。适合"坐地铁怎么去/公交多久/不打车怎么走"。',
    inputSchema: {
      type: 'object',
      properties: {
        origLon: { type: 'number', description: '起点经度' },
        origLat: { type: 'number', description: '起点纬度' },
        destLon: { type: 'number', description: '终点经度' },
        destLat: { type: 'number', description: '终点纬度' },
        linetype: { type: 'string', description: '规划类型位掩码：1较快捷(默认) 2少换乘 4少步行 8不坐地铁，可组合如"3"' },
      },
      required: ['origLon', 'origLat', 'destLon', 'destLat'],
    },
    async handler(p) { return tdt.transitRoute(p); },
  },
  {
    name: 'admin_district',
    description: '行政区划查询：行政区名称/编码 → 中心点坐标、行政区编码(adminCode)、下级行政区。用于：拿某城市的 adminCode（供 search_poi admin 模式）、城市级问答（"杭州有哪些区"）。childLevel 1返回下一级。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '行政区名称或编码，如"杭州"' },
        childLevel: { type: 'number', enum: [0, 1, 2, 3], description: '返回下级层数，默认0' },
      },
      required: ['keyword'],
    },
    async handler(p) { return tdt.adminDistrict(p); },
  },
  {
    name: 'travel_quick_check',
    description: '旅行快查（复合工具，推荐伴游场景优先使用）：给一个位置坐标，一次返回周边的三类去处（默认：美食/咖啡/景点各3个）+ 各自距离。适合"逛累了吃点啥/附近有啥可逛的/帮我看看周边"。',
    inputSchema: {
      type: 'object',
      properties: {
        lon: { type: 'number', description: '当前经度' },
        lat: { type: 'number', description: '当前纬度' },
        categories: { type: 'array', items: { type: 'string' }, description: '要查的类别，默认 ["美食","咖啡","景点"]' },
        radius: { type: 'number', description: '半径米数，默认2000' },
      },
      required: ['lon', 'lat'],
    },
    async handler({ lon, lat, categories, radius }) {
      const cats = (categories && categories.length) ? categories.slice(0, 3) : ['美食', '咖啡', '景点'];
      const rad = Math.min(radius || 2000, 10000);
      const results = await Promise.all(cats.map(async c => {
        try {
          const r = await tdt.searchPoi({ keyWord: c, queryType: 'nearby', lon, lat, radius: rad, count: 3 });
          return { category: c, found: r.found, items: r.found ? r.pois.map(p => ({ name: p.name, distance: p.distance, address: p.address })) : [] };
        } catch (e) {
          return { category: c, found: false, items: [] };
        }
      }));
      return { lon, lat, radiusM: rad, results };
    },
  },
];

module.exports = { TOOLS };
