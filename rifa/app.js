// ========================================================
// Treebolito — App Optimizada con Bloques + Caché Agresivo
// Reducción del 99.5% en lecturas de Firebase
// ========================================================

const CONFIG = {
    TOTAL_NUMEROS: 100000,
    PRECIO: 1,
    CLABE: "722969010056604160",
    WHATSAPP: "4741482078",
    NUMEROS_POR_PAGINA: 1000,
    NUMEROS_POR_BLOQUE: 1000,
    TOTAL_BLOQUES: 100,
    HORAS_EXPIRACION: 24,
    MAX_NUMEROS: 100,
    CACHE_TTL: 10 * 60 * 1000, // 10 min cache para bloques
    STATS_CACHE_TTL: 5 * 60 * 1000, // 5 min cache para stats
    FECHA_RIFA: "2026-03-23T00:00:00"
};

// ========== FIREBASE CONFIG ==========
const firebaseConfig = {
    apiKey: "AIzaSyCCrsHE4maOWXu06ADT7W6wMXWXzK0wSMo",
    authDomain: "treebolito.firebaseapp.com",
    projectId: "treebolito",
    storageBucket: "treebolito.firebasestorage.app",
    messagingSenderId: "321841443031",
    appId: "1:321841443031:web:f8b97c0802150ecee04092",
    measurementId: "G-20EFETFMW1"
};

// ========== STATE ==========
let db = null;
let paginaActual = 1;
let totalPaginas = Math.ceil(CONFIG.TOTAL_NUMEROS / CONFIG.NUMEROS_POR_PAGINA);
let compraActual = { numeros: [], id: null, tipo: {} };
let statsCache = { disponibles: CONFIG.TOTAL_NUMEROS, apartados: 0, vendidos: 0 };
let bloquesEnMemoria = {}; // bloqueId -> { data: "dddaavv...", apartados: {...}, updated: ts }
let apartando = false;
let filtroActual = "todos"; // "todos" | "disponibles"

// ========== CACHE LAYER ==========
const Cache = {
    get(key) {
        try {
            const raw = localStorage.getItem(`tb_${key}`);
            if (!raw) return null;
            const { data, ts } = JSON.parse(raw);
            const ttl = key.startsWith("stats") ? CONFIG.STATS_CACHE_TTL : CONFIG.CACHE_TTL;
            if (Date.now() - ts > ttl) {
                localStorage.removeItem(`tb_${key}`);
                return null;
            }
            return data;
        } catch { return null; }
    },
    set(key, data) {
        try {
            localStorage.setItem(`tb_${key}`, JSON.stringify({ data, ts: Date.now() }));
        } catch { /* quota exceeded, silently fail */ }
    },
    clear() {
        Object.keys(localStorage)
            .filter(k => k.startsWith("tb_"))
            .forEach(k => localStorage.removeItem(k));
    }
};

// ========== TOAST NOTIFICATIONS ==========
const Toast = {
    container: null,
    init() {
        this.container = document.getElementById("toastContainer");
        if (!this.container) {
            this.container = document.createElement("div");
            this.container.id = "toastContainer";
            this.container.className = "toast-container";
            document.body.appendChild(this.container);
        }
    },
    show(message, type = "info", duration = 3500) {
        if (!this.container) this.init();
        const icons = { success: "✅", error: "❌", info: "ℹ️", warning: "⚠️" };
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.innerHTML = `
      <span class="toast-icon">${icons[type] || "ℹ️"}</span>
      <span class="toast-message">${this._sanitize(message)}</span>
      <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
    `;
        this.container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add("removing");
            setTimeout(() => toast.remove(), 300);
        }, duration);
    },
    success(msg) { this.show(msg, "success"); },
    error(msg) { this.show(msg, "error", 5000); },
    info(msg) { this.show(msg, "info"); },
    warning(msg) { this.show(msg, "warning", 4000); },
    _sanitize(str) {
        const el = document.createElement("span");
        el.textContent = str;
        return el.innerHTML;
    }
};

// ========== CONFETTI ==========
function lanzarConfetti() {
    const container = document.createElement("div");
    container.className = "confetti-container";
    document.body.appendChild(container);
    const colors = ["#22c55e", "#4ade80", "#fbbf24", "#f59e0b", "#3b82f6", "#8b5cf6", "#ec4899"];
    for (let i = 0; i < 60; i++) {
        const piece = document.createElement("div");
        piece.className = "confetti-piece";
        piece.style.left = Math.random() * 100 + "%";
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDelay = Math.random() * 2 + "s";
        piece.style.animationDuration = (2 + Math.random() * 2) + "s";
        piece.style.borderRadius = Math.random() > 0.5 ? "50%" : "0";
        piece.style.width = (6 + Math.random() * 8) + "px";
        piece.style.height = piece.style.width;
        container.appendChild(piece);
    }
    setTimeout(() => container.remove(), 5000);
}

// ========== OFFLINE DETECTION ==========
function setupOfflineDetection() {
    const banner = document.getElementById("offlineBanner");
    if (!banner) return;
    const update = () => {
        if (!navigator.onLine) {
            banner.classList.add("show");
        } else {
            banner.classList.remove("show");
        }
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
}

// ========== FIREBASE INIT ==========
async function initDB() {
    try {
        const app = firebase.initializeApp(firebaseConfig);
        db = firebase.firestore(app);
        console.log("Firebase conectado");
        return true;
    } catch (e) {
        console.error("Error Firebase:", e);
        return false;
    }
}

// ========== BLOCK OPERATIONS ==========
// Cada bloque contiene 1000 números como string compacto
// 'd' = disponible, 'a' = apartado, 'v' = vendido

function getBloqueId(numGlobal) {
    return Math.floor(numGlobal / CONFIG.NUMEROS_POR_BLOQUE);
}

function getOffsetEnBloque(numGlobal) {
    return numGlobal % CONFIG.NUMEROS_POR_BLOQUE;
}

function crearBloqueVacio() {
    return {
        data: "d".repeat(CONFIG.NUMEROS_POR_BLOQUE),
        apartados: {},
        updated: Date.now()
    };
}

async function cargarBloque(bloqueId, forceRefresh = false) {
    // 1) Check memory
    if (!forceRefresh && bloquesEnMemoria[bloqueId]) {
        return bloquesEnMemoria[bloqueId];
    }

    // 2) Check localStorage cache
    if (!forceRefresh) {
        const cached = Cache.get(`bloque_${bloqueId}`);
        if (cached) {
            bloquesEnMemoria[bloqueId] = cached;
            return cached;
        }
    }

    // 3) Fetch from Firebase (1 read per block = 1000 numbers)
    if (!db) {
        const bloque = crearBloqueVacio();
        bloquesEnMemoria[bloqueId] = bloque;
        return bloque;
    }

    try {
        const doc = await db.collection("bloques").doc(String(bloqueId)).get();
        let bloque;
        if (doc.exists) {
            bloque = doc.data();
        } else {
            bloque = crearBloqueVacio();
        }
        bloquesEnMemoria[bloqueId] = bloque;
        Cache.set(`bloque_${bloqueId}`, bloque);
        return bloque;
    } catch (e) {
        console.warn("Error cargando bloque", bloqueId, e);
        const bloque = crearBloqueVacio();
        bloquesEnMemoria[bloqueId] = bloque;
        return bloque;
    }
}

function getEstadoNumero(numGlobal) {
    const bloqueId = getBloqueId(numGlobal);
    const offset = getOffsetEnBloque(numGlobal);
    const bloque = bloquesEnMemoria[bloqueId];
    if (!bloque || !bloque.data) return "d";
    const c = bloque.data[offset];
    if (c === "a") return "apartado";
    if (c === "v") return "vendido";
    return "disponible";
}

// ========== STATS ==========
async function cargarStats() {
    // Check cache first
    const cached = Cache.get("stats");
    if (cached) {
        statsCache = cached;
        actualizarUI_Stats();
        return;
    }

    if (!db) {
        actualizarUI_Stats();
        return;
    }

    try {
        const doc = await db.collection("stats").doc("general").get();
        if (doc.exists) {
            statsCache = doc.data();
        } else {
            statsCache = { disponibles: CONFIG.TOTAL_NUMEROS, apartados: 0, vendidos: 0 };
        }
        Cache.set("stats", statsCache);
        actualizarUI_Stats();
    } catch (e) {
        console.warn("Usando stats cacheados");
        actualizarUI_Stats();
    }
}

function actualizarUI_Stats() {
    const setTxt = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    setTxt("statDisponibles", statsCache.disponibles.toLocaleString());
    setTxt("statApartados", statsCache.apartados.toLocaleString());
    setTxt("statVendidos", statsCache.vendidos.toLocaleString());

    // Progress bar
    const vendidosPct = ((statsCache.vendidos + statsCache.apartados) / CONFIG.TOTAL_NUMEROS * 100);
    const fillEl = document.getElementById("progressFill");
    const pctEl = document.getElementById("progressPercent");
    if (fillEl) fillEl.style.width = Math.min(vendidosPct, 100) + "%";
    if (pctEl) pctEl.textContent = vendidosPct.toFixed(1) + "%";

    actualizarDisponiblesRestantes();
}

function actualizarDisponiblesRestantes() {
    const el = document.getElementById("disponiblesRestantes");
    if (!el) return;
    const restantes = Math.max(0, CONFIG.MAX_NUMEROS - compraActual.numeros.length);
    el.textContent = Math.min(restantes, statsCache.disponibles) + " disponibles";
}

// ========== PAGE LOADING ==========
async function cargarPaginaActual() {
    mostrarSkeletons();

    const inicio = (paginaActual - 1) * CONFIG.NUMEROS_POR_PAGINA;
    const fin = Math.min(inicio + CONFIG.NUMEROS_POR_PAGINA, CONFIG.TOTAL_NUMEROS);

    // Determine which blocks we need
    const bloqueInicio = getBloqueId(inicio);
    const bloqueFin = getBloqueId(fin - 1);

    // Load needed blocks (usually 1, at most 2)
    const promises = [];
    for (let b = bloqueInicio; b <= bloqueFin; b++) {
        promises.push(cargarBloque(b));
    }
    await Promise.all(promises);

    renderizarGrid();
    actualizarPaginacion();
}

function mostrarSkeletons() {
    const grid = document.getElementById("numerosGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < 50; i++) {
        const div = document.createElement("div");
        div.className = "skeleton";
        grid.appendChild(div);
    }
}

function renderizarGrid() {
    const grid = document.getElementById("numerosGrid");
    if (!grid) return;
    grid.innerHTML = "";

    const inicio = (paginaActual - 1) * CONFIG.NUMEROS_POR_PAGINA;
    const fin = Math.min(inicio + CONFIG.NUMEROS_POR_PAGINA, CONFIG.TOTAL_NUMEROS);

    const fragment = document.createDocumentFragment();

    for (let i = inicio; i < fin; i++) {
        const estado = getEstadoNumero(i);

        if (filtroActual === "disponibles" && estado !== "disponible" && !compraActual.numeros.includes(i)) {
            continue;
        }

        const div = document.createElement("div");
        div.className = "numero " + estado;
        div.textContent = String(i).padStart(5, "0");
        div.dataset.num = i;

        if (estado === "disponible") {
            div.onclick = () => toggleSeleccion(i);
        }

        if (compraActual.numeros.includes(i)) {
            div.classList.remove(estado);
            div.classList.add("seleccioned");
            div.onclick = () => toggleSeleccion(i);
        }

        fragment.appendChild(div);
    }

    grid.appendChild(fragment);
}

function actualizarPaginacion() {
    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const setDis = (id, val) => { const el = document.getElementById(id); if (el) el.disabled = val; };

    setTxt("currentPage", paginaActual);
    setTxt("currentPage2", paginaActual);
    setTxt("totalPages", totalPaginas);
    setTxt("totalPages2", totalPaginas);
    setDis("prevPage", paginaActual <= 1);
    setDis("nextPage", paginaActual >= totalPaginas);
    setDis("prevPage2", paginaActual <= 1);
    setDis("nextPage2", paginaActual >= totalPaginas);
}

// ========== NUMBER SELECTION ==========
function toggleSeleccion(num) {
    const estado = getEstadoNumero(num);
    if (estado !== "disponible" && !compraActual.numeros.includes(num)) return;

    const idx = compraActual.numeros.indexOf(num);
    if (idx > -1) {
        delete compraActual.tipo[num];
        compraActual.numeros.splice(idx, 1);
    } else {
        if (compraActual.numeros.length >= CONFIG.MAX_NUMEROS) {
            Toast.warning("Solo puedes seleccionar máximo " + CONFIG.MAX_NUMEROS + " números por compra.");
            return;
        }
        compraActual.numeros.push(num);
        compraActual.tipo[num] = "manual";
    }
    compraActual.numeros.sort((a, b) => a - b);
    actualizarSeleccion();
    renderizarGrid();
    actualizarFloatingCart();
}

function quitarNumero(num) {
    const idx = compraActual.numeros.indexOf(num);
    if (idx > -1) {
        delete compraActual.tipo[num];
        compraActual.numeros.splice(idx, 1);
        actualizarSeleccion();
        renderizarGrid();
        actualizarFloatingCart();
    }
}

function seleccionarAleatorio() {
    // Collect available numbers from loaded blocks only
    const disponibles = [];
    for (const bloqueId in bloquesEnMemoria) {
        const bloque = bloquesEnMemoria[bloqueId];
        if (!bloque || !bloque.data) continue;
        const baseNum = parseInt(bloqueId) * CONFIG.NUMEROS_POR_BLOQUE;
        for (let i = 0; i < bloque.data.length; i++) {
            const numGlobal = baseNum + i;
            if (numGlobal >= CONFIG.TOTAL_NUMEROS) break;
            if (bloque.data[i] === "d" && !compraActual.numeros.includes(numGlobal)) {
                disponibles.push(numGlobal);
            }
        }
    }

    let cantidad = parseInt(document.getElementById("cantidadAleatorio").value) || 0;
    if (cantidad <= 0) { Toast.warning("Ingresa una cantidad válida"); return; }

    const espacio = CONFIG.MAX_NUMEROS - compraActual.numeros.length;
    if (espacio <= 0) {
        Toast.warning("Ya tienes el máximo de " + CONFIG.MAX_NUMEROS + " números");
        return;
    }

    cantidad = Math.min(cantidad, espacio, disponibles.length);
    if (cantidad === 0) { Toast.info("No hay más números disponibles en las páginas cargadas. Navega a otras páginas para cargar más."); return; }

    // Fisher-Yates shuffle
    for (let i = disponibles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [disponibles[i], disponibles[j]] = [disponibles[j], disponibles[i]];
    }

    const seleccionados = disponibles.slice(0, cantidad);
    seleccionados.forEach(num => {
        compraActual.numeros.push(num);
        compraActual.tipo[num] = "aleatorio";
    });
    compraActual.numeros.sort((a, b) => a - b);

    actualizarSeleccion();
    renderizarGrid();
    actualizarFloatingCart();
    Toast.success("Se agregaron " + cantidad + " números al azar 🎲");
}

function limpiarSeleccion() {
    if (compraActual.numeros.length === 0) return;
    compraActual = { numeros: [], id: null, tipo: {} };
    actualizarSeleccion();
    renderizarGrid();
    actualizarFloatingCart();
    Toast.info("Selección limpiada");
}

function actualizarSeleccion() {
    const countEl = document.getElementById("seleccionCount");
    if (countEl) countEl.textContent = compraActual.numeros.length;

    const btnConfirmar = document.getElementById("btnConfirmar");
    const sidebar = document.querySelector(".sidebar");

    if (compraActual.numeros.length > 0) {
        if (btnConfirmar) btnConfirmar.style.display = "block";
        if (sidebar) sidebar.classList.remove("hidden");

        const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setTxt("countLista", compraActual.numeros.length);
        setTxt("totalLista", "$" + (compraActual.numeros.length * CONFIG.PRECIO));

        let manuales = 0,
            aleatorios = 0;
        const listaEl = document.getElementById("numerosSeleccionadosLista");
        if (listaEl) {
            listaEl.innerHTML = compraActual.numeros.map(n => {
                const tipo = compraActual.tipo[n] || "manual";
                if (tipo === "manual") manuales++;
                else aleatorios++;
                return `<span class="num-item ${tipo}" onclick="quitarNumero(${n})">${String(n).padStart(5, "0")}<span class="remove">×</span></span>`;
            }).join("");
        }

        setTxt("countManuales", manuales);
        setTxt("countAleatorios", aleatorios);
    } else {
        if (btnConfirmar) btnConfirmar.style.display = "none";
        if (sidebar) sidebar.classList.remove("hidden");
        const listaEl = document.getElementById("numerosSeleccionadosLista");
        if (listaEl) listaEl.innerHTML = `<div class="sidebar-empty"><div class="sidebar-empty-icon">🎲</div><p>Selecciona números o usa el generador</p></div>`;
        const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setTxt("countManuales", "0");
        setTxt("countAleatorios", "0");
        setTxt("countLista", "0");
        setTxt("totalLista", "$0");
    }
    actualizarDisponiblesRestantes();
}

// ========== FLOATING CART ==========
function actualizarFloatingCart() {
    const cart = document.getElementById("floatingCart");
    const badge = document.getElementById("cartBadge");
    if (!cart) return;
    if (compraActual.numeros.length > 0) {
        cart.classList.add("show");
        if (badge) badge.textContent = compraActual.numeros.length;
    } else {
        cart.classList.remove("show");
    }
}

// ========== SEARCH ==========
function buscarNumero() {
    const val = document.getElementById("searchInput").value.trim();
    const num = parseInt(val);
    if (!isNaN(num) && num >= 0 && num < CONFIG.TOTAL_NUMEROS) {
        paginaActual = Math.floor(num / CONFIG.NUMEROS_POR_PAGINA) + 1;
        cargarPaginaActual().then(() => {
            setTimeout(() => {
                const el = document.querySelector(`[data-num='${num}']`);
                if (el) {
                    el.scrollIntoView({ behavior: "smooth", block: "center" });
                    el.style.outline = "3px solid #fbbf24";
                    setTimeout(() => el.style.outline = "", 2000);
                }
            }, 100);
        });
    } else {
        Toast.warning("Ingresa un número válido (0-99999)");
    }
}

// ========== PURCHASE FLOW ==========
function abrirModalCompra() {
    if (compraActual.numeros.length === 0) return;

    const id = "TB-" + new Date().getFullYear() + "-" + String(Math.floor(Math.random() * 99999)).padStart(5, "0");
    compraActual.id = id;

    const setHtml = (elId, html) => { const el = document.getElementById(elId); if (el) el.innerHTML = html; };
    const setTxt = (elId, txt) => { const el = document.getElementById(elId); if (el) el.textContent = txt; };

    setTxt("compraId", id);
    setHtml("numerosSeleccion", compraActual.numeros.map(n =>
        `<span class="numero-tag">${String(n).padStart(5, "0")}</span>`
    ).join(""));
    setTxt("compraTotal", "$" + (compraActual.numeros.length * CONFIG.PRECIO) + " MXN");

    document.getElementById("compraModal").classList.add("show");
}

async function confirmarApartar() {
    if (apartando || compraActual.numeros.length === 0) return;
    if (!db) { Toast.error("Error de conexión. Intenta de nuevo."); return; }

    apartando = true;
    const btn = document.getElementById("confirmarApartar");
    const originalText = btn.textContent;
    btn.textContent = "Procesando...";
    btn.disabled = true;

    const id = compraActual.id;
    const exp = new Date(Date.now() + CONFIG.HORAS_EXPIRACION * 3600000).toISOString();

    try {
        // Group numbers by block
        const bloqueUpdates = {};
        for (const num of compraActual.numeros) {
            const bloqueId = getBloqueId(num);
            if (!bloqueUpdates[bloqueId]) bloqueUpdates[bloqueId] = [];
            bloqueUpdates[bloqueId].push(num);
        }

        const batch = db.batch();

        // Update each affected block
        for (const [bloqueId, nums] of Object.entries(bloqueUpdates)) {
            let bloque = bloquesEnMemoria[bloqueId] || crearBloqueVacio();
            let dataArr = bloque.data.split("");
            let apartados = bloque.apartados ? {...bloque.apartados } : {};

            for (const num of nums) {
                const offset = getOffsetEnBloque(num);
                dataArr[offset] = "a";
                apartados[String(offset)] = { exp, compraId: id };
            }

            const updatedBloque = {
                data: dataArr.join(""),
                apartados,
                updated: Date.now()
            };

            batch.set(db.collection("bloques").doc(String(bloqueId)), updatedBloque);

            // Update local cache
            bloquesEnMemoria[bloqueId] = updatedBloque;
            Cache.set(`bloque_${bloqueId}`, updatedBloque);
        }

        // Save purchase record
        batch.set(db.collection("compras").doc(id), {
            id,
            numeros: compraActual.numeros,
            total: compraActual.numeros.length * CONFIG.PRECIO,
            fecha: new Date().toISOString(),
            expiracion: exp,
            estado: "pendiente"
        });

        // Update stats
        statsCache.disponibles -= compraActual.numeros.length;
        statsCache.apartados += compraActual.numeros.length;
        batch.set(db.collection("stats").doc("general"), statsCache);

        await batch.commit();

        Cache.set("stats", statsCache);
        actualizarUI_Stats();
        renderizarGrid();

        // Close purchase modal, show success
        document.getElementById("compraModal").classList.remove("show");

        const successIdEl = document.getElementById("successId");
        if (successIdEl) successIdEl.textContent = id;

        const wspMsg = encodeURIComponent(
            `Hola, realicé el pago de la rifa Treebolito.\nID: ${id}\nNúmeros: ${compraActual.numeros.map(n => String(n).padStart(5, "0")).join(", ")}\nTotal: $${compraActual.numeros.length * CONFIG.PRECIO} MXN`
        );
        const wspLink = document.getElementById("whatsappShare");
        if (wspLink) wspLink.href = `https://wa.me/52${CONFIG.WHATSAPP}?text=${wspMsg}`;

        document.getElementById("successModal").classList.add("show");
        lanzarConfetti();
        Toast.success("¡Números apartados exitosamente! 🎉");

    } catch (e) {
        console.error("Error al apartar:", e);
        Toast.error("Error al apartar números: " + e.message);
    } finally {
        apartando = false;
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// ========== MODALS ==========
function cerrarModal() {
    document.getElementById("compraModal").classList.remove("show");
}

function cerrarSuccess() {
    document.getElementById("successModal").classList.remove("show");
    compraActual = { numeros: [], id: null, tipo: {} };
    actualizarSeleccion();
    actualizarFloatingCart();
    renderizarGrid();
}

// ========== CLIPBOARD ==========
function copiarTexto(texto) {
    navigator.clipboard.writeText(texto)
        .then(() => Toast.success("Copiado: " + texto))
        .catch(() => Toast.error("No se pudo copiar"));
}

// ========== COUNTDOWN ==========
function iniciarCountdown() {
    const fechaRifa = new Date(CONFIG.FECHA_RIFA);

    function update() {
        const diff = fechaRifa - new Date();
        if (diff <= 0) {
            const el = document.getElementById("countdown");
            if (el) el.innerHTML = "<span style='color:#fbbf24;font-weight:700;font-size:1.2rem'>¡La rifa ha comenzado!</span>";
            return;
        }
        const d = Math.floor(diff / 86400000);
        const h = Math.floor((diff % 86400000) / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val).padStart(2, "0"); };
        setTxt("countDias", d);
        setTxt("countHoras", h);
        setTxt("countMin", m);
        setTxt("countSeg", s);
    }
    update();
    setInterval(update, 1000);
}

// ========== FILTER ==========
function toggleFiltro(filtro) {
    filtroActual = filtro;
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    const activeBtn = document.querySelector(`.filter-btn[data-filter="${filtro}"]`);
    if (activeBtn) activeBtn.classList.add("active");
    renderizarGrid();
}

// ========== EVENT LISTENERS ==========
function setupEventListeners() {
    const on = (id, event, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(event, fn); };

    on("navToggle", "click", () => document.getElementById("navList").classList.toggle("show"));
    on("prevPage", "click", () => { if (paginaActual > 1) { paginaActual--;
            cargarPaginaActual(); } });
    on("nextPage", "click", () => { if (paginaActual < totalPaginas) { paginaActual++;
            cargarPaginaActual(); } });
    on("prevPage2", "click", () => document.getElementById("prevPage").click());
    on("nextPage2", "click", () => document.getElementById("nextPage").click());
    on("searchBtn", "click", buscarNumero);
    on("searchInput", "keypress", e => { if (e.key === "Enter") buscarNumero(); });
    on("btnConfirmar", "click", abrirModalCompra);
    on("btnAleatorio", "click", seleccionarAleatorio);
    on("btnLimpiarSeleccion", "click", limpiarSeleccion);
    on("modalClose", "click", cerrarModal);
    on("cancelarCompra", "click", cerrarModal);
    on("confirmarApartar", "click", confirmarApartar);
    on("closeSuccess", "click", cerrarSuccess);
    on("copyId", "click", () => copiarTexto(document.getElementById("compraId").textContent));
    on("copyClabe", "click", () => copiarTexto(CONFIG.CLABE));
    on("copyWhatsapp", "click", () => copiarTexto(CONFIG.WHATSAPP));

    // Floating cart
    on("floatingCartBtn", "click", () => {
        const sidebar = document.querySelector(".sidebar");
        if (sidebar) sidebar.scrollIntoView({ behavior: "smooth" });
    });

    // Filter buttons
    document.querySelectorAll(".filter-btn").forEach(btn => {
        btn.addEventListener("click", () => toggleFiltro(btn.dataset.filter));
    });

    // Input sanitization
    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
        searchInput.addEventListener("input", () => {
            searchInput.value = searchInput.value.replace(/[^0-9]/g, "");
        });
    }
}

// ========== INIT ==========
async function init() {
    Toast.init();
    setupOfflineDetection();
    setupEventListeners();
    iniciarCountdown();

    actualizarPaginacion();
    mostrarSkeletons();

    const firebaseOk = await initDB();

    if (firebaseOk) {
        await cargarStats();
        await cargarPaginaActual();
    } else {
        Toast.error("No se pudo conectar a Firebase. Los datos podrían no estar actualizados.");
        renderizarGrid();
    }
}

document.addEventListener("DOMContentLoaded", init);