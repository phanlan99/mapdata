// ==========================================
// 1. KHỞI TẠO BẢN ĐỒ VÀ CÁC BIẾN TOÀN CỤC
// ==========================================
const VN_BOUNDS = [[8.0, 102.0], [23.6, 109.8]];

const map = L.map('map').setView([16.047079, 108.206230], 6);

// Thứ tự lớp (z-index): viền nền < viền có dữ liệu < điểm Target
map.createPane('basePane');
map.getPane('basePane').style.zIndex = 340;
map.createPane('polygonPane');
map.getPane('polygonPane').style.zIndex = 350;
map.createPane('targetPane');
map.getPane('targetPane').style.zIndex = 450;

// ---- Nền bản đồ có tự động chuyển nguồn dự phòng ----
const BASE_SOURCES = [
    // Lưu ý: CARTO nay yêu cầu API key (trả về ô ảnh "API KEY REQUIRED"), nên đã bỏ.
    {
        name: 'OpenStreetMap',
        make: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19, referrerPolicy: 'origin',
            attribution: '&copy; OpenStreetMap contributors'
        })
    },
    {
        name: 'Esri',
        make: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19, attribution: 'Tiles &copy; Esri'
        })
    },
    {
        name: 'OpenStreetMap France',
        make: () => L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
            subdomains: 'abc', maxZoom: 19,
            attribution: '&copy; OpenStreetMap France | &copy; OpenStreetMap contributors'
        })
    }
];

let currentBase = null;

function useBase(i) {
    if (currentBase) {
        currentBase.off();
        map.removeLayer(currentBase);
    }
    const src = BASE_SOURCES[i];
    const layer = src.make();
    currentBase = layer;
    let loaded = false;
    let errors = 0;

    layer.on('tileload', () => { loaded = true; });
    layer.on('tileerror', () => {
        errors++;
        if (!loaded && errors >= 4) {
            layer.off();
            console.warn('Nền "' + src.name + '" không tải được, thử nguồn khác...');
            if (i + 1 < BASE_SOURCES.length) {
                useBase(i + 1);
            } else {
                showNotice(
                    '<b>Không tải được ảnh nền bản đồ.</b><br>' +
                    'Kiểm tra kết nối mạng, hoặc mở bằng Live Server / GitHub Pages thay vì file://.'
                );
            }
        }
    });
    layer.addTo(map);
}
useBase(0);

// Tính lại kích thước khung bản đồ sau khi trang dựng xong
window.addEventListener('load', () => map.invalidateSize());
window.addEventListener('resize', () => map.invalidateSize());

// ---- Nút "Zoom về Việt Nam" ----
const ZoomVNControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
        const box = L.DomUtil.create('div', 'leaflet-bar');
        const btn = L.DomUtil.create('a', '', box);
        btn.href = '#';
        btn.title = 'Zoom về Việt Nam';
        btn.innerHTML = '🇻🇳';
        btn.style.cssText = 'font-size:16px; line-height:30px; text-align:center; width:30px; height:30px; display:block; background:#fff; text-decoration:none;';
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.on(btn, 'click', e => {
            L.DomEvent.preventDefault(e);
            map.fitBounds(VN_BOUNDS);
        });
        return box;
    }
});
map.addControl(new ZoomVNControl());

const markersLayer = L.layerGroup().addTo(map);
const labelsLayer = L.layerGroup().addTo(map);
const provincePolygonsLayer = L.layerGroup().addTo(map);
const districtPolygonsLayer = L.layerGroup().addTo(map);

// Lớp viền nền: vẽ TOÀN BỘ ranh giới Việt Nam (không phụ thuộc dữ liệu Excel)
const baseProvinceLayer = L.layerGroup();
const baseDistrictLayer = L.layerGroup();

// Nguồn dữ liệu ranh giới
const PROVINCE_URL = 'https://raw.githubusercontent.com/TungTh/tungth.github.io/master/data/vn-provinces.json';
// Dùng đường dẫn TƯƠNG ĐỐI để chạy được cả trên GitHub Pages dạng user.github.io/ten-repo/
const EXCEL_URL = 'toadoexcel.xlsx';                 // đặt cạnh index.html
const DISTRICT_URL = 'data/vn-districts.geojson';    // GADM 4.1 level 2

const UNKNOWN = 'Chưa xác định';

// Tên các cột trong file Excel (so khớp không phân biệt hoa thường)
const KEYS = {
    date: ['report_date', 'report date'],
    manager: ['quản lý', 'quan_ly', 'quan ly'],
    employee: ['employee_name'],
    shopAddress: ['shop_address', 'shop address'],
    sales: ['doanhso', 'doanh so', 'doanh_so'],
    latActual: ['latitude_actual'],
    lngActual: ['longitude_actual'],
    latTarget: ['latitude_target'],
    lngTarget: ['longitude_target']
};

let globalData = [];
let vietnamGeoJSON = null;   // Ranh giới Tỉnh
let districtGeoJSON = null;  // Ranh giới Quận/Huyện

// ==========================================
// 2. CÁC HÀM HỖ TRỢ
// ==========================================
function getColorByName(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 65%, 45%)`;
}

function getVal(row, possibleKeys) {
    const keys = Object.keys(row);
    for (let k of keys) {
        if (possibleKeys.includes(k.toString().trim().toLowerCase())) return row[k];
    }
    return null;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Đọc tọa độ (chấp nhận cả dấu phẩy thập phân kiểu "10,92")
function parseCoord(v) {
    if (v === null || v === undefined || v === '') return NaN;
    let s = String(v).trim();
    if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
    return parseFloat(s);
}

// Đọc doanh số (bỏ dấu phẩy ngăn cách hàng nghìn)
function parseMoney(v) {
    if (v === null || v === undefined || v === '') return 0;
    const n = parseFloat(String(v).replace(/[,\s]/g, ''));
    return isNaN(n) ? 0 : n;
}

// --- Lấy tên từ thuộc tính GeoJSON ---
function getProvinceName(props) {
    return props.Name || props.ten_tinh || 'Khu vực';
}

function getDistrictName(props) {
    return props.NAME_2 || props.TEN_HUYEN || props.Ten_Huyen || props.ADM2_VI || props.district || props.name || 'Khu vực';
}

function getDistrictParent(props) {
    return props.NAME_1 || props.TEN_TINH || props.Ten_Tinh || '';
}

// Nhiều huyện trùng tên ở các tỉnh khác nhau => gắn thêm tên tỉnh
function getDistrictLabel(props) {
    const name = getDistrictName(props);
    const parent = getDistrictParent(props);
    return parent ? `${name} (${parent})` : name;
}

// Tính sẵn bbox cho từng polygon để tìm điểm nhanh hơn
function prepareFeatures(geo) {
    if (!geo || !geo.features) return;
    geo.features.forEach((f, i) => {
        f._idx = i;
        try { f._bbox = turf.bbox(f); } catch (e) { f._bbox = null; }
    });
}

function findFeature(geo, pt) {
    if (!geo) return null;
    const lng = pt.geometry.coordinates[0];
    const lat = pt.geometry.coordinates[1];
    for (const f of geo.features) {
        const b = f._bbox;
        if (b && (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3])) continue;
        try {
            if (turf.booleanPointInPolygon(pt, f)) return f;
        } catch (e) {}
    }
    return null;
}

// Trả về { prov, dist } cho một tọa độ
function locate(lat, lng) {
    if (isNaN(lat) || isNaN(lng)) return { prov: null, dist: null };
    const pt = turf.point([lng, lat]);
    return {
        prov: findFeature(vietnamGeoJSON, pt),
        dist: findFeature(districtGeoJSON, pt)
    };
}

// Chuỗi "Huyện - Tỉnh" cho riêng một điểm
function areaOf(loc) {
    let prov = '';
    if (loc.prov) prov = getProvinceName(loc.prov.properties);
    else if (loc.dist) prov = getDistrictParent(loc.dist.properties);

    const dist = loc.dist ? getDistrictName(loc.dist.properties) : '';
    const parts = [dist, prov].filter(p => p);
    return parts.length ? parts.join(' - ') : UNKNOWN;
}

// ==========================================
// 2b. HIỂN THỊ THÔNG BÁO
// ==========================================
function showNotice(html) {
    const box = document.getElementById('load-notice');
    if (!box) return;
    box.innerHTML = html;
    box.style.display = 'block';
}

function hideNotice() {
    const box = document.getElementById('load-notice');
    if (box) box.style.display = 'none';
}

// ==========================================
// 2c. LỚP VIỀN NỀN TOÀN VIỆT NAM
// ==========================================
function buildBaseLayers() {
    const mk = (geo, weight) => L.geoJSON(geo, {
        pane: 'basePane',
        interactive: false,   // không chặn click/tooltip của lớp phía trên
        style: { color: '#7a7a7a', weight: weight, opacity: 0.8, fill: false }
    });
    baseProvinceLayer.clearLayers();
    baseDistrictLayer.clearLayers();
    if (vietnamGeoJSON) mk(vietnamGeoJSON, 1.2).addTo(baseProvinceLayer);
    if (districtGeoJSON) mk(districtGeoJSON, 0.6).addTo(baseDistrictLayer);
}

// Bật viền Huyện (nếu có) khi công tắc bật, ngược lại hiện viền Tỉnh
function refreshBaseLayers() {
    map.removeLayer(baseProvinceLayer);
    map.removeLayer(baseDistrictLayer);
    const wantDistricts = document.getElementById('toggle-districts').checked;
    if (wantDistricts && districtGeoJSON) map.addLayer(baseDistrictLayer);
    else if (vietnamGeoJSON) map.addLayer(baseProvinceLayer);
}

// ==========================================
// 2d. ĐỌC FILE EXCEL TRỰC TIẾP TRONG TRÌNH DUYỆT (SheetJS)
// ==========================================
const NUMERIC_KEYS = [
    ...KEYS.latActual, ...KEYS.lngActual,
    ...KEYS.latTarget, ...KEYS.lngTarget,
    ...KEYS.sales
];

function parseWorkbook(buffer) {
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];

    // raw:false => ngày tháng hiển thị đúng như trên màn hình Excel
    const shown = XLSX.utils.sheet_to_json(ws, { raw: false });
    // raw:true  => số nguyên bản (tọa độ, doanh số) không bị làm tròn
    const raw = XLSX.utils.sheet_to_json(ws, { raw: true });

    shown.forEach((row, i) => {
        const r = raw[i];
        if (!r) return;
        Object.keys(r).forEach(k => {
            if (typeof r[k] === 'number' && NUMERIC_KEYS.includes(k.trim().toLowerCase())) {
                row[k] = r[k];
            }
        });
    });
    return shown;
}

// Mở bằng file:// thì trình duyệt chặn đọc file khác => cho người dùng tự chọn file
function askUserForExcel() {
    return new Promise(resolve => {
        showNotice(
            '<b>Không tự đọc được file Excel.</b><br>' +
            'Hãy chọn file <code>toadoexcel.xlsx</code> từ máy của bạn:<br>' +
            '<input type="file" id="excel-picker" accept=".xlsx,.xls">'
        );
        document.getElementById('excel-picker').addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                hideNotice();
                resolve(parseWorkbook(ev.target.result));
            };
            reader.readAsArrayBuffer(file);
        });
    });
}

function loadExcelData() {
    return fetch(EXCEL_URL, { cache: 'no-store' })
        .then(res => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.arrayBuffer();
        })
        .then(parseWorkbook)
        .catch(err => {
            console.warn('Không tự tải được ' + EXCEL_URL + ':', err);
            return askUserForExcel();
        });
}

function fetchJson(url, label) {
    return fetch(url)
        .then(res => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .catch(err => {
            console.warn('Không tải được ranh giới ' + label + ' (' + url + '):', err);
            return null;
        });
}

// ==========================================
// 3. TẢI GEOJSON (độc lập) VÀ EXCEL, RỒI GHÉP LẠI
// ==========================================
// Viền Việt Nam hiện ra ngay khi tải xong GeoJSON, không cần chờ Excel
const geoPromise = Promise.all([
    fetchJson(PROVINCE_URL, 'Tỉnh'),
    fetchJson(DISTRICT_URL, 'Quận/Huyện')
]).then(([provData, distData]) => {
    vietnamGeoJSON = provData;
    districtGeoJSON = distData;

    console.log('Tỉnh tải được:', !!vietnamGeoJSON, vietnamGeoJSON ? vietnamGeoJSON.features.length : 0);
    console.log('Huyện tải được:', !!districtGeoJSON, districtGeoJSON ? districtGeoJSON.features.length : 0);
    if (districtGeoJSON && districtGeoJSON.features.length) {
        console.log('Thuộc tính huyện mẫu:', districtGeoJSON.features[0].properties);
    }

    if (!districtGeoJSON && location.protocol === 'file:') {
        showNotice(
            '<b>Chưa hiển thị được ranh giới Quận/Huyện.</b><br>' +
            'Trình duyệt chặn đọc file khi mở trực tiếp (file://). ' +
            'Hãy mở bằng <b>Live Server</b> (VS Code) hoặc <code>python -m http.server</code>, ' +
            'hoặc xem trên GitHub Pages.'
        );
    }

    prepareFeatures(vietnamGeoJSON);
    prepareFeatures(districtGeoJSON);
    buildBaseLayers();
    refreshBaseLayers();
});

const excelPromise = loadExcelData();

Promise.all([excelPromise, geoPromise])
    .then(([data]) => {
        globalData = data;

        // --- QUÉT KHÔNG GIAN: tìm Tỉnh & Huyện cho từng điểm Actual / Target ---
        globalData.forEach(row => {
            const latA = parseCoord(getVal(row, KEYS.latActual));
            const lngA = parseCoord(getVal(row, KEYS.lngActual));
            const latT = parseCoord(getVal(row, KEYS.latTarget));
            const lngT = parseCoord(getVal(row, KEYS.lngTarget));

            row._hasActual = !isNaN(latA) && !isNaN(lngA);
            row._hasTarget = !isNaN(latT) && !isNaN(lngT);
            row._latA = latA; row._lngA = lngA;
            row._latT = latT; row._lngT = lngT;

            const locA = row._hasActual ? locate(latA, lngA) : { prov: null, dist: null };
            const locT = row._hasTarget ? locate(latT, lngT) : { prov: null, dist: null };

            row._provActual = locA.prov ? locA.prov._idx : -1;
            row._distActual = locA.dist ? locA.dist._idx : -1;
            row._provTarget = locT.prov ? locT.prov._idx : -1;
            row._distTarget = locT.dist ? locT.dist._idx : -1;

            row._areaActual = areaOf(locA);
            row._areaTarget = areaOf(locT);

            // Vị trí chính của dòng: ưu tiên Actual, nếu không có thì dùng Target
            const main = row._hasActual ? locA : locT;

            row.calculated_province = UNKNOWN;
            row.calculated_district = UNKNOWN;
            row.district_short = UNKNOWN;

            if (main.prov) {
                row.calculated_province = getProvinceName(main.prov.properties);
            } else if (main.dist) {
                row.calculated_province = getDistrictParent(main.dist.properties) || UNKNOWN;
            }

            if (main.dist) {
                row.calculated_district = getDistrictLabel(main.dist.properties);
                row.district_short = getDistrictName(main.dist.properties);
            }
        });

        const missingDist = globalData.filter(r => r.calculated_district === UNKNOWN).length;
        console.log(`Số dòng chưa xác định được huyện: ${missingDist} / ${globalData.length}`);

        renderSidebar(globalData);
        handleFilterChange();
    })
    .catch(error => {
        console.error('Lỗi khi tải dữ liệu:', error);
        showNotice('<b>Lỗi khi đọc dữ liệu.</b> Mở Console (F12) để xem chi tiết.');
    });

// ==========================================
// 4. KHỞI TẠO CÁC SỰ KIỆN GIAO DIỆN
// ==========================================
document.getElementById('coord-actual').addEventListener('change', handleFilterChange);
document.getElementById('coord-target').addEventListener('change', handleFilterChange);
document.getElementById('ds-zero').addEventListener('change', handleFilterChange);
document.getElementById('ds-more').addEventListener('change', handleFilterChange);

// Công tắc bật/tắt chữ tên Tỉnh/Huyện
document.getElementById('toggle-names').addEventListener('change', function (e) {
    if (e.target.checked) map.addLayer(labelsLayer);
    else map.removeLayer(labelsLayer);
});

// Bật/tắt viền Quận/Huyện => cập nhật lớp nền và vẽ lại bản đồ
document.getElementById('toggle-districts').addEventListener('change', function () {
    refreshBaseLayers();
    handleFilterChange();
});

document.querySelectorAll('.select-all').forEach(btn => {
    btn.addEventListener('click', function () {
        const targetId = this.getAttribute('data-target');
        // Chỉ chọn những mục đang hiển thị (không bị ẩn bởi bộ lọc chéo)
        document.querySelectorAll(`#${targetId} .filter-item:not([style*="display: none"]) input[type="checkbox"]`).forEach(cb => {
            cb.checked = true;
        });
        handleFilterChange();
    });
});

document.querySelectorAll('.deselect-all').forEach(btn => {
    btn.addEventListener('click', function () {
        const targetId = this.getAttribute('data-target');
        document.querySelectorAll(`#${targetId} input[type="checkbox"]`).forEach(cb => {
            cb.checked = false;
        });
        handleFilterChange();
    });
});

// ==========================================
// 5. TẠO DANH SÁCH BỘ LỌC BÊN TRÁI
// ==========================================
function renderSidebar(data) {
    const createCheckboxes = (containerId, items) => {
        const container = document.getElementById(containerId);
        let html = '';
        items.forEach((itemVal, index) => {
            if (!itemVal) return;
            const safeId = `${containerId}-${index}`;
            const safeVal = escapeHtml(itemVal);
            html += `
                <div class="filter-item">
                    <input type="checkbox" id="${safeId}" value="${safeVal}" checked>
                    <label for="${safeId}">${safeVal}</label>
                </div>
            `;
        });
        container.innerHTML = html;
        container.querySelectorAll('input').forEach(input => input.addEventListener('change', handleFilterChange));
    };

    const uniq = (fn) => [...new Set(data.map(fn).filter(v => v))];
    const sortVi = (arr) => arr.sort((a, b) => a.localeCompare(b, 'vi'));

    const uniqueDates = uniq(item => String(getVal(item, KEYS.date) || '').trim());
    const uniqueProvinces = sortVi(uniq(item => String(item.calculated_province || '').trim()));
    const uniqueDistricts = sortVi(uniq(item => String(item.calculated_district || '').trim()));
    const uniqueManagers = sortVi(uniq(item => String(getVal(item, KEYS.manager) || '').trim()));
    const uniqueEmployees = sortVi(uniq(item => String(getVal(item, KEYS.employee) || '').trim()));

    createCheckboxes('date-list', uniqueDates);
    createCheckboxes('province-list', uniqueProvinces);
    createCheckboxes('district-list', uniqueDistricts);
    createCheckboxes('manager-list', uniqueManagers);
    createCheckboxes('employee-list', uniqueEmployees);
}

// ==========================================
// 6. XỬ LÝ LỌC ĐA CHIỀU (CROSS-FILTERING)
// ==========================================
function handleFilterChange() {
    const checked = (listId) => Array.from(document.querySelectorAll(`#${listId} input[type="checkbox"]:checked`)).map(cb => cb.value);

    const checkedDate = checked('date-list');
    const checkedProv = checked('province-list');
    const checkedDist = checked('district-list');
    const checkedMgr = checked('manager-list');
    const checkedEmp = checked('employee-list');

    const showDsZero = document.getElementById('ds-zero').checked;
    const showDsMore = document.getElementById('ds-more').checked;

    const rowMatches = (row, filters) => {
        const rowDate = String(getVal(row, KEYS.date) || '').trim();
        const rowProv = String(row.calculated_province || '').trim();
        const rowDist = String(row.calculated_district || '').trim();
        const mgrName = String(getVal(row, KEYS.manager) || '').trim();
        const empName = String(getVal(row, KEYS.employee) || '').trim();

        const dsValue = parseMoney(getVal(row, KEYS.sales));

        let dsMatch = false;
        if (showDsZero && dsValue === 0) dsMatch = true;
        if (showDsMore && dsValue > 0) dsMatch = true;
        if (!dsMatch) return false;

        if (filters.date && !filters.date.includes(rowDate)) return false;
        if (filters.prov && !filters.prov.includes(rowProv)) return false;
        if (filters.dist && !filters.dist.includes(rowDist)) return false;
        if (filters.mgr && !filters.mgr.includes(mgrName)) return false;
        if (filters.emp && !filters.emp.includes(empName)) return false;
        return true;
    };

    const availDates = new Set();
    const availProvs = new Set();
    const availDists = new Set();
    const availMgrs = new Set();
    const availEmps = new Set();

    globalData.forEach(row => {
        const d = String(getVal(row, KEYS.date) || '').trim();
        const p = String(row.calculated_province || '').trim();
        const di = String(row.calculated_district || '').trim();
        const m = String(getVal(row, KEYS.manager) || '').trim();
        const e = String(getVal(row, KEYS.employee) || '').trim();

        if (rowMatches(row, { prov: checkedProv, dist: checkedDist, mgr: checkedMgr, emp: checkedEmp })) availDates.add(d);
        if (rowMatches(row, { date: checkedDate, dist: checkedDist, mgr: checkedMgr, emp: checkedEmp })) availProvs.add(p);
        if (rowMatches(row, { date: checkedDate, prov: checkedProv, mgr: checkedMgr, emp: checkedEmp })) availDists.add(di);
        if (rowMatches(row, { date: checkedDate, prov: checkedProv, dist: checkedDist, emp: checkedEmp })) availMgrs.add(m);
        if (rowMatches(row, { date: checkedDate, prov: checkedProv, dist: checkedDist, mgr: checkedMgr })) availEmps.add(e);
    });

    const updateUI = (listId, availableSet) => {
        document.querySelectorAll(`#${listId} .filter-item`).forEach(item => {
            const checkbox = item.querySelector('input[type="checkbox"]');
            item.style.display = availableSet.has(checkbox.value) ? 'block' : 'none';
        });
    };

    updateUI('date-list', availDates);
    updateUI('province-list', availProvs);
    updateUI('district-list', availDists);
    updateUI('manager-list', availMgrs);
    updateUI('employee-list', availEmps);

    const filteredData = globalData.filter(row => rowMatches(row, {
        date: checkedDate, prov: checkedProv, dist: checkedDist, mgr: checkedMgr, emp: checkedEmp
    }));
    renderMap(filteredData);
}

// ==========================================
// 7. VẼ BẢN ĐỒ VÀ THỐNG KÊ CHI TIẾT
// ==========================================
function renderMap(data) {
    markersLayer.clearLayers();
    labelsLayer.clearLayers();
    provincePolygonsLayer.clearLayers();
    districtPolygonsLayer.clearLayers();

    const showActual = document.getElementById('coord-actual').checked;
    const showTarget = document.getElementById('coord-target').checked;
    const wantDistricts = document.getElementById('toggle-districts').checked;
    // Nếu không có dữ liệu huyện thì quay về vẽ viền Tỉnh
    const drawDistricts = wantDistricts && !!districtGeoJSON;

    let countActual = 0;
    let countTarget = 0;

    // Đếm số điểm theo chỉ số polygon: Map<idx, {actual, target}>
    const provCounts = new Map();
    const distCounts = new Map();
    const bump = (store, idx, kind) => {
        if (idx < 0) return;
        if (!store.has(idx)) store.set(idx, { actual: 0, target: 0 });
        store.get(idx)[kind]++;
    };

    data.forEach(row => {
        const employeeName = escapeHtml(getVal(row, KEYS.employee) || 'Chưa rõ');
        const manager = escapeHtml(getVal(row, KEYS.manager) || 'Chưa rõ');
        const dateVal = escapeHtml(getVal(row, KEYS.date) || 'Không rõ');

        // Địa chỉ shop + link mở Google Maps để đối chiếu với vị trí điểm
        const rawAddress = String(getVal(row, KEYS.shopAddress) || '').trim();
        const shopAddress = rawAddress ? escapeHtml(rawAddress) : 'Chưa có';
        const mapsLink = rawAddress
            ? ` <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(rawAddress)}" target="_blank" rel="noopener">[Xem trên Google Maps]</a>`
            : '';

        const dsValue = parseMoney(getVal(row, KEYS.sales));
        const formattedDs = dsValue.toLocaleString('vi-VN');

        const popupContent = (type, color, area, lat, lng) => `
            <div style="font-size: 14px;">
                <b style="color: ${color};">[${type}]</b><br>
                <b>Ngày:</b> ${dateVal}<br>
                <b>Quản lý:</b> ${manager}<br>
                <b>Nhân viên:</b> ${employeeName}<br>
                <b>Khu vực:</b> ${escapeHtml(area)}<br>
                <b>Địa chỉ shop:</b> ${shopAddress}${mapsLink}<br>
                <b>Tọa độ:</b> ${lat.toFixed(5)}, ${lng.toFixed(5)}<br>
                <div style="margin-top: 6px; padding: 4px; background-color: #f8f9fa; border: 1px dashed #28a745; text-align: center;">
                    Doanh số: <b style="color: #28a745; font-size: 16px;">${formattedDs}</b>
                </div>
            </div>
        `;

        if (showActual && row._hasActual) {
            const markerActual = L.marker([row._latA, row._lngA]);
            markerActual.bindPopup(popupContent('ACTUAL - THỰC TẾ', 'blue', row._areaActual, row._latA, row._lngA));
            markersLayer.addLayer(markerActual);
            countActual++;
            bump(provCounts, row._provActual, 'actual');
            bump(distCounts, row._distActual, 'actual');
        }

        if (showTarget && row._hasTarget) {
            const markerTarget = L.circleMarker([row._latT, row._lngT], {
                pane: 'targetPane',
                color: 'red', fillColor: '#f03', fillOpacity: 0.7, radius: 8
            });
            markerTarget.bindPopup(popupContent('TARGET - MỤC TIÊU', 'red', row._areaTarget, row._latT, row._lngT));
            markersLayer.addLayer(markerTarget);
            countTarget++;
            bump(provCounts, row._provTarget, 'target');
            bump(distCounts, row._distTarget, 'target');
        }
    });

    document.getElementById('count-actual').textContent = countActual;
    document.getElementById('count-target').textContent = countTarget;

    // ---- VẼ VIỀN QUẬN / HUYỆN CÓ DỮ LIỆU (tô màu, đè lên viền nền) ----
    if (drawDistricts) {
        distCounts.forEach((c, idx) => {
            const distFeature = districtGeoJSON.features[idx];
            if (!distFeature) return;

            const distName = getDistrictName(distFeature.properties);
            const parent = getDistrictParent(distFeature.properties);
            const distColor = getColorByName(distName + parent + 'dist');
            const percentage = c.target === 0 ? 100 : Math.round((c.actual / c.target) * 100);

            const distPolygon = L.geoJSON(distFeature, {
                pane: 'polygonPane',
                style: { color: distColor, weight: 2, opacity: 0.9, fillColor: distColor, fillOpacity: 0.4, dashArray: '5, 5' }
            });

            distPolygon.bindTooltip(`
                <div style="text-align: center; font-size: 13px;">
                    <b style="font-size: 15px; text-transform: uppercase;">${escapeHtml(distName)}</b><br/>
                    ${parent ? `<span style="color:#666;">${escapeHtml(parent)}</span><br/>` : ''}
                    Mục tiêu: <b>${c.target}</b> | Thực tế: <b>${c.actual}</b><br/>
                    <div style="margin-top: 5px; background: #ffeeba; padding: 3px; border-radius: 4px; font-weight: bold; color: #856404;">Tỷ lệ đạt: ${percentage}%</div>
                </div>
            `, { sticky: true, className: 'province-tooltip' });
            districtPolygonsLayer.addLayer(distPolygon);

            try {
                const center = turf.centerOfMass(distFeature);
                const nameLabel = L.marker([center.geometry.coordinates[1], center.geometry.coordinates[0]], {
                    icon: L.divIcon({
                        className: 'province-label-text',
                        html: `<div style="color:${distColor}; font-size:11px;">${escapeHtml(distName)}</div>`,
                        iconSize: [120, 20],
                        iconAnchor: [60, 10]
                    }),
                    interactive: false
                });
                labelsLayer.addLayer(nameLabel);
            } catch (e) {}
        });
    }

    // ---- VẼ VIỀN TỈNH VÀ THỐNG KÊ SIDEBAR PHẢI ----
    const provinceStatsList = [];

    if (vietnamGeoJSON) {
        provCounts.forEach((c, idx) => {
            const provinceFeature = vietnamGeoJSON.features[idx];
            if (!provinceFeature) return;

            const percentage = c.target === 0 ? 100 : Math.round((c.actual / c.target) * 100);
            const provinceName = getProvinceName(provinceFeature.properties);
            const provinceColor = getColorByName(provinceName);

            provinceStatsList.push({
                name: provinceName,
                color: provinceColor,
                actual: c.actual,
                target: c.target,
                percent: percentage
            });

            // Chỉ tô màu viền Tỉnh khi không vẽ viền Huyện (tránh rối mắt)
            if (!drawDistricts) {
                const provincePolygon = L.geoJSON(provinceFeature, {
                    pane: 'polygonPane',
                    style: { color: provinceColor, weight: 2, opacity: 0.9, fillColor: provinceColor, fillOpacity: 0.3 }
                });

                provincePolygon.bindTooltip(`
                    <div style="text-align: center; font-size: 13px;">
                        <b style="font-size: 15px; text-transform: uppercase;">${escapeHtml(provinceName)}</b><br/>
                        Mục tiêu (Target): <b>${c.target}</b><br/>
                        Thực tế (Actual): <b>${c.actual}</b><br/>
                        <div style="margin-top: 5px; background: #ffeeba; padding: 3px; border-radius: 4px; font-weight: bold; color: #856404;">Tỷ lệ đạt: ${percentage}%</div>
                    </div>
                `, { sticky: true, className: 'province-tooltip' });
                provincePolygonsLayer.addLayer(provincePolygon);

                try {
                    const center = turf.centerOfMass(provinceFeature);
                    const nameLabel = L.marker([center.geometry.coordinates[1], center.geometry.coordinates[0]], {
                        icon: L.divIcon({
                            className: 'province-label-text',
                            html: `<div>${escapeHtml(provinceName)}</div>`,
                            iconSize: [120, 20],
                            iconAnchor: [60, 10]
                        }),
                        interactive: false
                    });
                    labelsLayer.addLayer(nameLabel);
                } catch (e) {}
            }
        });
    }

    renderProvinceStats(provinceStatsList);
    renderSalesStats(data);
}

// ==========================================
// 8. RENDER BẢNG THỐNG KÊ SIDEBAR PHẢI
// ==========================================
function renderProvinceStats(stats) {
    const listContainer = document.getElementById('province-stats-list');
    if (stats.length === 0) {
        listContainer.innerHTML = '<div style="color: #888; font-style: italic; text-align: center; margin-top: 20px;">Không có dữ liệu tỉnh nào.</div>';
        return;
    }
    stats.sort((a, b) => (b.actual + b.target) - (a.actual + a.target));

    let html = '';
    stats.forEach(stat => {
        html += `
            <div class="prov-stat-item" style="border-left: 4px solid ${stat.color};">
                <div class="prov-stat-name">${escapeHtml(stat.name)}</div>
                <div class="prov-stat-details">
                    <span style="color: blue;">Act: <b>${stat.actual}</b></span>
                    <span style="color: red;">Tar: <b>${stat.target}</b></span>
                    <span style="color: #856404; font-weight: bold;">${stat.percent}%</span>
                </div>
            </div>
        `;
    });
    listContainer.innerHTML = html;
}

function renderSalesStats(data) {
    const listContainer = document.getElementById('sales-stats-list');

    if (data.length === 0) {
        listContainer.innerHTML = '<div style="color: #888; font-style: italic; text-align: center; margin-top: 20px;">Không có dữ liệu kinh doanh.</div>';
        return;
    }

    const salesData = {};
    data.forEach(row => {
        const mgrName = String(getVal(row, KEYS.manager) || 'Chưa rõ').trim();
        const empName = String(getVal(row, KEYS.employee) || 'Chưa rõ').trim();
        const dsValue = parseMoney(getVal(row, KEYS.sales));

        if (!salesData[mgrName]) {
            salesData[mgrName] = { total: 0, employees: {} };
        }
        salesData[mgrName].total += dsValue;
        if (!salesData[mgrName].employees[empName]) {
            salesData[mgrName].employees[empName] = 0;
        }
        salesData[mgrName].employees[empName] += dsValue;
    });

    const sortedManagers = Object.keys(salesData).sort((a, b) => salesData[b].total - salesData[a].total);

    let html = '';
    sortedManagers.forEach(mgr => {
        const mgrTotal = salesData[mgr].total;
        const formattedMgrTotal = mgrTotal.toLocaleString('vi-VN');
        const safeMgr = escapeHtml(mgr);

        html += `
            <div class="mgr-stat-group">
                <div class="mgr-stat-header">
                    <span>👤 ${safeMgr}</span>
                    <span>${formattedMgrTotal}</span>
                </div>
        `;

        const employees = salesData[mgr].employees;
        const sortedEmployees = Object.keys(employees).sort((a, b) => employees[b] - employees[a]);

        sortedEmployees.forEach(emp => {
            const empTotal = employees[emp];
            const formattedEmpTotal = empTotal.toLocaleString('vi-VN');
            const percent = mgrTotal === 0 ? 0 : ((empTotal / mgrTotal) * 100).toFixed(1);

            html += `
                <div class="emp-stat-item">
                    <div class="emp-stat-name">
                        ↳ ${escapeHtml(emp)}
                        <span class="emp-stat-percent" title="Đóng góp ${percent}% vào tổng DS của ${safeMgr}">${percent}%</span>
                    </div>
                    <div class="emp-stat-sales">${formattedEmpTotal}</div>
                </div>
            `;
        });

        html += `</div>`;
    });
    listContainer.innerHTML = html;
}