/**
 * Multi-run benchmark browser for results_new.json
 * Extended from index2.js to support multiple benchmark runs with filtering
 */

const DEFAULT_CTX = "default";
const K_SIGMA = 1.0;
const MIN_TOL = 0.25;
const MODEL_COL_WIDTH = 180;
const WINNER_COL_WIDTH = 120;

const state = {
    rawData: null,
    flatBenchmarks: [],
    contexts: [],
    contextMap: new Map(),
    envs: [],
    backendOrder: [],
    columnWidths: {},
    filters: {
        models: new Set(),
        quants: new Set(),
        kernels: new Set(),
        firmwares: new Set(),
        runs: new Set(),
        context: DEFAULT_CTX,
        backends: new Set(),
        sizeLo: null,
        sizeHi: null,
    },
    options: {
        models: [],
        quants: [],
        kernels: [],
        firmwares: [],
        runs: [],
    },
    ui: {},
    sizeStats: { min: Infinity, max: -Infinity },
    draggingEnv: null,
};

document.addEventListener("DOMContentLoaded", () => {
    cacheUI();
    setupModals();
    setupMultiselects();
    // Data is loaded via <script src="results_new.jsonl.js"> which sets global _
    if (typeof _ === "undefined" || !Array.isArray(_)) {
        console.error("Failed to load results_new.jsonl.js - _ is not defined or not an array");
        state.ui.stats.textContent = "Failed to load benchmark data";
        return;
    }
    // Convert array to runs object for compatibility
    const runs = {};
    for (const run of _) {
        if (run.run_id) {
            runs[run.run_id] = run;
        }
    }
    state.rawData = { runs };
    flattenRuns(runs);
    prepareData();
    initializeControls();
    renderTables();
});

function cacheUI() {
    state.ui = {
        runCount: document.getElementById("run-count"),
        modelSelect: document.getElementById("model-select"),
        quantSelect: document.getElementById("quant-select"),
        kernelSelect: document.getElementById("kernel-select"),
        firmwareSelect: document.getElementById("firmware-select"),
        runSelect: document.getElementById("run-select"),
        contextChips: document.getElementById("context-chips"),
        backendList: document.getElementById("backend-list"),
        backendAll: document.getElementById("backend-all"),
        backendNone: document.getElementById("backend-none"),
        sizeLo: document.getElementById("sizeLo"),
        sizeHi: document.getElementById("sizeHi"),
        sizeTrack: document.getElementById("sizeTrack"),
        sizeLoVal: document.getElementById("sizeLoVal"),
        sizeHiVal: document.getElementById("sizeHiVal"),
        stats: document.getElementById("stats-line"),
        resetBtn: document.getElementById("reset-layout"),
        tables: document.getElementById("tables"),
        hipblasModalOpen: document.getElementById("hipblas-modal-open"),
        hipblasModal: document.getElementById("hipblas-modal"),
        hipblasModalClose: document.getElementById("hipblas-modal-close"),
        rpcModalOpen: document.getElementById("rpc-modal-open"),
        rpcModal: document.getElementById("rpc-modal"),
        rpcModalClose: document.getElementById("rpc-modal-close"),
        rocwmmaModalOpen: document.getElementById("rocwmma-modal-open"),
        rocwmmaModal: document.getElementById("rocwmma-modal"),
        rocwmmaModalClose: document.getElementById("rocwmma-modal-close"),
        rocwmmaImprModalOpen: document.getElementById("rocwmma-impr-modal-open"),
        rocwmmaImprModal: document.getElementById("rocwmma-impr-modal"),
        rocwmmaImprModalClose: document.getElementById("rocwmma-impr-modal-close"),
    };
}

function setupModals() {
    const modalConfigs = [
        { open: state.ui.hipblasModalOpen, modal: state.ui.hipblasModal, close: state.ui.hipblasModalClose },
        { open: state.ui.rpcModalOpen, modal: state.ui.rpcModal, close: state.ui.rpcModalClose },
        { open: state.ui.rocwmmaModalOpen, modal: state.ui.rocwmmaModal, close: state.ui.rocwmmaModalClose },
        { open: state.ui.rocwmmaImprModalOpen, modal: state.ui.rocwmmaImprModal, close: state.ui.rocwmmaImprModalClose },
    ];

    modalConfigs.forEach(({ open, modal, close }) => {
        if (!open || !modal) return;
        const openModal = () => modal.classList.remove("hidden");
        const closeModal = () => modal.classList.add("hidden");
        open.addEventListener("click", openModal);
        close?.addEventListener("click", closeModal);
        modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
        });
    });
}

/**
 * Flatten all runs into a single benchmark array with system_info attached
 */
function flattenRuns(runs) {
    state.flatBenchmarks = [];
    const modelSet = new Set();
    const quantSet = new Set();
    const kernelSet = new Set();
    const firmwareSet = new Set();
    const runSet = new Set();

    for (const [runId, run] of Object.entries(runs || {})) {
        const sysInfo = run.system_info || {};
        runSet.add(runId);

        if (sysInfo.kernel) kernelSet.add(sysInfo.kernel);
        if (sysInfo.linux_firmware) firmwareSet.add(sysInfo.linux_firmware);

        for (const bench of run.benchmarks || []) {
            const modelName = bench.model_clean || bench.model;
            if (modelName) modelSet.add(modelName);
            if (bench.quant) quantSet.add(bench.quant.toUpperCase());

            state.flatBenchmarks.push({
                ...bench,
                run_id: runId,
                system_info: sysInfo,
            });
        }
    }

    state.options.models = [...modelSet].sort();
    state.options.quants = [...quantSet].sort();
    state.options.kernels = [...kernelSet].sort();
    state.options.firmwares = [...firmwareSet].sort();
    state.options.runs = [...runSet].sort();

    // Initialize all filters to include everything
    state.filters.models = new Set(state.options.models);
    state.filters.quants = new Set(state.options.quants);
    state.filters.kernels = new Set(state.options.kernels);
    state.filters.firmwares = new Set(state.options.firmwares);
    state.filters.runs = new Set(state.options.runs);

    // Update run count
    if (state.ui.runCount) {
        const runCount = Object.keys(runs || {}).length;
        const benchCount = state.flatBenchmarks.length;
        state.ui.runCount.textContent = `${runCount} run(s) · ${benchCount} benchmark entries`;
    }
}

function prepareData() {
    const contextMap = new Map();
    const envSet = new Set();

    for (const bench of state.flatBenchmarks) {
        const test = normalizeTest(bench.test);
        if (!test || !bench.env) continue;

        const contextKey = bench.context || DEFAULT_CTX;
        const env = bench.env;
        envSet.add(env);

        const ctx = ensureContext(contextMap, contextKey, bench.context_tokens);
        const testEntry = ensureTest(ctx, test.original);

        const modelName = bench.model_clean || bench.model;
        const row = ensureModel(testEntry, modelName, bench);

        // Use composite key: env + run_id for uniqueness
        const cellKey = `${env}__${bench.run_id}`;
        row.backends[cellKey] = {
            mean: typeof bench.tps_mean === "number" ? bench.tps_mean : null,
            std: typeof bench.tps_std === "number" ? bench.tps_std : null,
            error: Boolean(bench.error),
            error_type: bench.error_type || null,
            run_id: bench.run_id,
            system_info: bench.system_info,
            env: env,
        };
    }

    state.contextMap = contextMap;
    state.contexts = [...contextMap.values()].sort((a, b) => {
        if (a.key === DEFAULT_CTX) return -1;
        if (b.key === DEFAULT_CTX) return 1;
        if (a.tokens && b.tokens) return a.tokens - b.tokens;
        if (a.tokens) return -1;
        if (b.tokens) return 1;
        return a.key.localeCompare(b.key);
    });
    state.envs = [...envSet].sort();
    state.backendOrder = [...state.envs];
    state.columnWidths = Object.fromEntries(state.envs.map((env) => [env, 120]));
    state.filters.context = state.contexts[0]?.key || DEFAULT_CTX;
    state.filters.backends = new Set(state.envs);
}

function ensureContext(map, key, tokens) {
    if (!map.has(key)) {
        map.set(key, {
            key,
            label: formatContextLabel(key, tokens),
            tokens: tokens ?? null,
            tests: new Map(),
        });
    } else if (tokens && !map.get(key).tokens) {
        const ctx = map.get(key);
        ctx.tokens = tokens;
        ctx.label = formatContextLabel(key, tokens);
    }
    return map.get(key);
}

function ensureTest(ctx, testName) {
    if (!ctx.tests.has(testName)) {
        ctx.tests.set(testName, { name: testName, models: new Map() });
    }
    return ctx.tests.get(testName);
}

function ensureModel(testEntry, modelName, bench) {
    if (!testEntry.models.has(modelName)) {
        testEntry.models.set(modelName, {
            model: modelName,
            quant: (bench.quant || "Unknown").toUpperCase(),
            sizeB: bench.name_params_b ?? bench.params_b ?? null,
            backends: {},
            isRpc: Boolean(bench.rpc),
        });
    }
    const row = testEntry.models.get(modelName);
    const sizeCandidate = bench.name_params_b ?? bench.params_b;
    if (row.sizeB == null && typeof sizeCandidate === "number") {
        row.sizeB = sizeCandidate;
    }
    if (typeof row.sizeB === "number") {
        state.sizeStats.min = Math.min(state.sizeStats.min, row.sizeB);
        state.sizeStats.max = Math.max(state.sizeStats.max, row.sizeB);
    }
    if (bench.rpc) row.isRpc = true;
    return row;
}

function initializeControls() {
    populateMultiselect(state.ui.modelSelect, state.options.models, state.filters.models, "models", "All models");
    populateMultiselect(state.ui.quantSelect, state.options.quants, state.filters.quants, "quants", "All quants");
    populateMultiselect(state.ui.kernelSelect, state.options.kernels, state.filters.kernels, "kernels", "All kernels");
    populateMultiselect(state.ui.firmwareSelect, state.options.firmwares, state.filters.firmwares, "firmwares", "All firmware");
    populateMultiselectRuns(state.ui.runSelect, state.options.runs, state.filters.runs);

    // Context chips
    state.ui.contextChips.innerHTML = "";
    state.contexts.forEach((ctx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chip" + (ctx.key === state.filters.context ? " active" : "");
        btn.dataset.context = ctx.key;
        btn.textContent = ctx.label;
        state.ui.contextChips.appendChild(btn);
    });

    state.ui.contextChips.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-context]");
        if (!btn) return;
        state.filters.context = btn.dataset.context;
        [...state.ui.contextChips.querySelectorAll("button")].forEach((b) => b.classList.toggle("active", b === btn));
        renderTables();
    });

    renderBackendList();
    setupSizeSlider();

    state.ui.backendList.addEventListener("change", (e) => {
        const checkbox = e.target.closest("input[data-env]");
        if (!checkbox) return;
        const env = checkbox.dataset.env;
        if (checkbox.checked) {
            state.filters.backends.add(env);
        } else {
            state.filters.backends.delete(env);
        }
        renderTables();
    });

    state.ui.backendAll.addEventListener("click", () => {
        state.filters.backends = new Set(state.envs);
        renderBackendList();
        renderTables();
    });

    state.ui.backendNone.addEventListener("click", () => {
        state.filters.backends = new Set();
        renderBackendList();
        renderTables();
    });

    state.ui.sizeLo.addEventListener("input", () => updateSizeUI(true));
    state.ui.sizeHi.addEventListener("input", () => updateSizeUI(true));

    state.ui.resetBtn.addEventListener("click", () => {
        state.filters.models = new Set(state.options.models);
        state.filters.quants = new Set(state.options.quants);
        state.filters.kernels = new Set(state.options.kernels);
        state.filters.firmwares = new Set(state.options.firmwares);
        state.filters.runs = new Set(state.options.runs);
        state.filters.context = state.contexts[0]?.key || DEFAULT_CTX;
        state.filters.backends = new Set(state.envs);

        populateMultiselect(state.ui.modelSelect, state.options.models, state.filters.models, "models", "All models");
        populateMultiselect(state.ui.quantSelect, state.options.quants, state.filters.quants, "quants", "All quants");
        populateMultiselect(state.ui.kernelSelect, state.options.kernels, state.filters.kernels, "kernels", "All kernels");
        populateMultiselect(state.ui.firmwareSelect, state.options.firmwares, state.filters.firmwares, "firmwares", "All firmware");
        populateMultiselectRuns(state.ui.runSelect, state.options.runs, state.filters.runs);

        [...state.ui.contextChips.querySelectorAll("button")].forEach((btn) =>
            btn.classList.toggle("active", btn.dataset.context === state.filters.context)
        );
        renderBackendList();
        setupSizeSlider();
        renderTables();
    });
}

function setupMultiselects() {
    document.querySelectorAll(".multiselect").forEach((container) => {
        const btn = container.querySelector(".multiselect-btn");
        const dropdown = container.querySelector(".multiselect-dropdown");

        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            // Close all other dropdowns
            document.querySelectorAll(".multiselect-dropdown").forEach((d) => {
                if (d !== dropdown) d.classList.add("hidden");
            });
            dropdown.classList.toggle("hidden");
            if (!dropdown.classList.contains("hidden")) {
                const search = dropdown.querySelector(".multiselect-search");
                search?.focus();
            }
        });
    });

    // Close dropdowns when clicking outside
    document.addEventListener("click", () => {
        document.querySelectorAll(".multiselect-dropdown").forEach((d) => d.classList.add("hidden"));
    });

    document.querySelectorAll(".multiselect-dropdown").forEach((d) => {
        d.addEventListener("click", (e) => e.stopPropagation());
    });
}

function populateMultiselect(container, options, selected, filterKey, allLabel) {
    const dropdown = container.querySelector(".multiselect-dropdown");
    const optionsDiv = dropdown.querySelector(".multiselect-options");
    const searchInput = dropdown.querySelector(".multiselect-search");
    const labelSpan = container.querySelector(".multiselect-label");
    const selectAllBtn = dropdown.querySelector(".multiselect-all");
    const selectNoneBtn = dropdown.querySelector(".multiselect-none");

    optionsDiv.innerHTML = "";
    options.forEach((opt) => {
        const div = document.createElement("div");
        div.className = "multiselect-option";
        div.innerHTML = `
            <input type="checkbox" ${selected.has(opt) ? "checked" : ""}>
            <span class="multiselect-option-label">${opt}</span>
        `;
        div.querySelector("input").addEventListener("change", (e) => {
            if (e.target.checked) {
                selected.add(opt);
            } else {
                selected.delete(opt);
            }
            updateMultiselectLabel(container, options, selected, allLabel);
            renderTables();
        });
        optionsDiv.appendChild(div);
    });

    searchInput.value = "";
    searchInput.addEventListener("input", () => {
        const query = searchInput.value.toLowerCase();
        optionsDiv.querySelectorAll(".multiselect-option").forEach((opt) => {
            const label = opt.querySelector(".multiselect-option-label").textContent.toLowerCase();
            opt.classList.toggle("hidden", !label.includes(query));
        });
    });

    selectAllBtn.addEventListener("click", () => {
        options.forEach((opt) => selected.add(opt));
        optionsDiv.querySelectorAll("input").forEach((cb) => cb.checked = true);
        updateMultiselectLabel(container, options, selected, allLabel);
        renderTables();
    });

    selectNoneBtn.addEventListener("click", () => {
        selected.clear();
        optionsDiv.querySelectorAll("input").forEach((cb) => cb.checked = false);
        updateMultiselectLabel(container, options, selected, allLabel);
        renderTables();
    });

    updateMultiselectLabel(container, options, selected, allLabel);
}

function populateMultiselectRuns(container, runIds, selected) {
    const dropdown = container.querySelector(".multiselect-dropdown");
    const optionsDiv = dropdown.querySelector(".multiselect-options");
    const searchInput = dropdown.querySelector(".multiselect-search");
    const labelSpan = container.querySelector(".multiselect-label");
    const selectAllBtn = dropdown.querySelector(".multiselect-all");
    const selectNoneBtn = dropdown.querySelector(".multiselect-none");

    optionsDiv.innerHTML = "";
    runIds.forEach((runId) => {
        const run = state.rawData?.runs?.[runId];
        const sysInfo = run?.system_info || {};
        const hostname = sysInfo.hostname || "unknown";
        const timestamp = sysInfo.timestamp || runId;

        const div = document.createElement("div");
        div.className = "multiselect-option";
        div.innerHTML = `
            <input type="checkbox" ${selected.has(runId) ? "checked" : ""}>
            <span class="multiselect-option-label">${hostname}</span>
            <span class="multiselect-option-meta">${timestamp}</span>
        `;
        div.querySelector("input").addEventListener("change", (e) => {
            if (e.target.checked) {
                selected.add(runId);
            } else {
                selected.delete(runId);
            }
            updateMultiselectLabel(container, runIds, selected, "All runs");
            renderTables();
        });
        optionsDiv.appendChild(div);
    });

    searchInput.value = "";
    searchInput.addEventListener("input", () => {
        const query = searchInput.value.toLowerCase();
        optionsDiv.querySelectorAll(".multiselect-option").forEach((opt) => {
            const label = opt.querySelector(".multiselect-option-label").textContent.toLowerCase();
            const meta = opt.querySelector(".multiselect-option-meta")?.textContent.toLowerCase() || "";
            opt.classList.toggle("hidden", !label.includes(query) && !meta.includes(query));
        });
    });

    selectAllBtn.addEventListener("click", () => {
        runIds.forEach((id) => selected.add(id));
        optionsDiv.querySelectorAll("input").forEach((cb) => cb.checked = true);
        updateMultiselectLabel(container, runIds, selected, "All runs");
        renderTables();
    });

    selectNoneBtn.addEventListener("click", () => {
        selected.clear();
        optionsDiv.querySelectorAll("input").forEach((cb) => cb.checked = false);
        updateMultiselectLabel(container, runIds, selected, "All runs");
        renderTables();
    });

    updateMultiselectLabel(container, runIds, selected, "All runs");
}

function updateMultiselectLabel(container, options, selected, allLabel) {
    const labelSpan = container.querySelector(".multiselect-label");
    if (selected.size === 0) {
        labelSpan.textContent = "None selected";
    } else if (selected.size === options.length) {
        labelSpan.textContent = allLabel;
    } else if (selected.size <= 2) {
        labelSpan.textContent = [...selected].join(", ");
    } else {
        labelSpan.textContent = `${selected.size} selected`;
    }
}

function renderBackendList() {
    const container = state.ui.backendList;
    container.innerHTML = "";
    state.backendOrder.forEach((env) => {
        const label = document.createElement("label");
        label.className = "backend-item";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.env = env;
        checkbox.checked = state.filters.backends.has(env);
        label.appendChild(checkbox);

        const baseSpan = document.createElement("span");
        const { base, tags } = splitEnvName(env);
        baseSpan.textContent = base;
        label.appendChild(baseSpan);
        tags.forEach((tag) => {
            const pill = document.createElement("span");
            pill.className = "tag";
            pill.textContent = tag;
            const safeTag = tag.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
            pill.classList.add(`tag-${safeTag}`);
            label.appendChild(pill);
        });

        container.appendChild(label);
    });
}

function setupSizeSlider() {
    const { sizeLo, sizeHi } = state.ui;
    const minRaw = state.sizeStats.min === Infinity ? 0 : Math.floor(state.sizeStats.min || 0);
    const maxRaw = state.sizeStats.max === -Infinity ? 0 : Math.ceil(state.sizeStats.max || 0);
    const minB = Math.max(0, minRaw);
    const maxB = Math.max(minB, maxRaw);

    [sizeLo, sizeHi].forEach((inp) => {
        inp.min = minB;
        inp.max = maxB;
        inp.step = 1;
    });

    sizeLo.value = minB;
    sizeHi.value = maxB;
    sizeLo.style.zIndex = 2;
    sizeHi.style.zIndex = 1;
    updateSizeUI(false);
}

function updateSizeUI(triggerRender) {
    const { sizeLo, sizeHi, sizeLoVal, sizeHiVal, sizeTrack } = state.ui;
    if (+sizeLo.value > +sizeHi.value) {
        if (document.activeElement === sizeLo) {
            sizeHi.value = sizeLo.value;
        } else {
            sizeLo.value = sizeHi.value;
        }
    }
    sizeLo.style.zIndex = +sizeLo.value >= +sizeHi.max - 1 ? 4 : 2;
    sizeHi.style.zIndex = +sizeHi.value <= +sizeLo.min + 1 ? 3 : 1;
    state.filters.sizeLo = +sizeLo.value;
    state.filters.sizeHi = +sizeHi.value;
    sizeLoVal.textContent = formatSizeLabel(state.filters.sizeLo);
    sizeHiVal.textContent = formatSizeLabel(state.filters.sizeHi);
    const range = (sizeHi.max - sizeLo.min) || 1;
    const minB = +sizeLo.min;
    const start = ((state.filters.sizeLo - minB) / range) * 100;
    const end = ((state.filters.sizeHi - minB) / range) * 100;
    sizeTrack.style.background = `linear-gradient(to right, #e3e7f1 ${start}%, var(--accent) ${start}%, var(--accent) ${end}%, #e3e7f1 ${end}%)`;
    if (triggerRender) renderTables();
}

function renderTables() {
    const ctx = state.contextMap.get(state.filters.context);
    if (!ctx) {
        state.ui.tables.innerHTML = "<p>No data for this context.</p>";
        state.ui.stats.textContent = "0 rows";
        return;
    }

    const backendList = state.backendOrder.filter((env) => state.filters.backends.has(env));
    const tests = [...ctx.tests.values()].sort((a, b) => a.name.localeCompare(b.name));
    const frag = document.createDocumentFragment();
    let totalRows = 0;

    for (const test of tests) {
        const models = filterModels(test.models);
        if (!models.length) continue;
        totalRows += models.length;
        const block = document.createElement("div");
        block.className = "test-block";
        const heading = document.createElement("h2");
        heading.textContent = `${test.name.toUpperCase()} — tokens/second`;
        block.appendChild(heading);

        const tableWrap = document.createElement("div");
        tableWrap.className = "table-wrap";
        const scroller = document.createElement("div");
        scroller.className = "table-scroll";

        const modelsWithWinners = models.map((model) => {
            const winners = computeWinners(model, backendList);
            return { ...model, _cachedWinners: winners };
        });

        const table = buildSingleTable(modelsWithWinners, backendList);
        scroller.appendChild(table);
        tableWrap.appendChild(scroller);
        block.appendChild(tableWrap);
        setupResizeOverlay(scroller, backendList, table);
        frag.appendChild(block);
    }

    state.ui.tables.innerHTML = "";
    if (frag.childNodes.length) {
        state.ui.tables.appendChild(frag);
    } else {
        state.ui.tables.innerHTML = "<p>No models match the current filters.</p>";
    }
    state.ui.stats.textContent = `Showing ${totalRows.toLocaleString()} model rows across ${backendList.length} backends`;
}

function buildSingleTable(models, backendList) {
    const table = document.createElement("table");
    const colgroup = document.createElement("colgroup");
    const colModel = document.createElement("col");
    colModel.style.width = `${MODEL_COL_WIDTH}px`;
    colgroup.appendChild(colModel);
    const colWinner = document.createElement("col");
    colWinner.style.width = `${WINNER_COL_WIDTH}px`;
    colgroup.appendChild(colWinner);
    backendList.forEach((env) => {
        const col = document.createElement("col");
        col.style.width = `${state.columnWidths[env] || 120}px`;
        col.dataset.env = env;
        colgroup.appendChild(col);
    });
    table.appendChild(colgroup);

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.appendChild(makeHeaderCell("Model", "model"));
    headRow.appendChild(makeHeaderCell("Winner", "winner"));
    backendList.forEach((env) => {
        const th = makeHeaderCell(env, "backend-header");
        attachHeaderInteractions(th, env);
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    models.forEach((model) => {
        const tr = document.createElement("tr");
        const tdModel = document.createElement("td");
        tdModel.className = "model";
        const head = document.createElement("div");
        head.className = "model-head";
        const nameSpan = document.createElement("span");
        nameSpan.className = "model-name";
        nameSpan.textContent = model.model;
        head.appendChild(nameSpan);
        if (model.isRpc) {
            const pill = document.createElement("span");
            pill.className = "model-pill model-pill-rpc";
            pill.title = "Run executed via llama.cpp RPC across two servers";
            pill.textContent = "RPC · dual server";
            head.appendChild(pill);
        }
        tdModel.appendChild(head);
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = `${model.quant} · ${formatSize(model.sizeB)}`;
        tdModel.appendChild(meta);

        const actionWrap = document.createElement("div");
        actionWrap.className = "row-actions";
        const btnDesc = document.createElement("button");
        btnDesc.type = "button";
        btnDesc.className = "row-action-btn";
        btnDesc.textContent = "Sort ↓";
        btnDesc.addEventListener("click", (e) => {
            e.preventDefault();
            sortBackendsByModel(model, "desc");
        });
        const btnAsc = document.createElement("button");
        btnAsc.type = "button";
        btnAsc.className = "row-action-btn";
        btnAsc.textContent = "Sort ↑";
        btnAsc.addEventListener("click", (e) => {
            e.preventDefault();
            sortBackendsByModel(model, "asc");
        });
        actionWrap.appendChild(btnDesc);
        actionWrap.appendChild(btnAsc);
        tdModel.appendChild(actionWrap);
        tr.appendChild(tdModel);

        const tdWinner = document.createElement("td");
        tdWinner.className = "winner";
        if (model._cachedWinners.length) {
            const wrap = document.createElement("div");
            wrap.className = "winner-list";
            wrap.innerHTML = model._cachedWinners.map((w) => `<span class="winner-pill">${w}</span>`).join("");
            tdWinner.appendChild(wrap);
        } else {
            tdWinner.innerHTML = `<span class="cell-empty">—</span>`;
        }
        tr.appendChild(tdWinner);

        backendList.forEach((env) => {
            const td = document.createElement("td");
            td.className = "data-cell";
            td.dataset.env = env;

            // Find best cell for this env from selected runs
            const cell = getBestCellForEnv(model, env);

            if (!cell) {
                td.innerHTML = `<span class="cell-empty">—</span>`;
            } else if (cell.error || cell.mean == null) {
                td.innerHTML = `<span class="cell-error">⚠ ${cell.error_type || "error"}</span>`;
            } else {
                const isBest = model._cachedWinners.includes(env);
                if (isBest) td.classList.add("best");
                td.innerHTML = `
                    <div class="measure">${cell.mean.toFixed(2)}</div>
                    <div class="std">± ${cell.std?.toFixed(2) ?? "—"}</div>
                    ${cell.run_id ? `<span class="run-indicator" title="${formatRunInfo(cell)}">${getRunHostname(cell.run_id)}</span>` : ""}
                `;
            }
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
}

function getBestCellForEnv(model, env) {
    // Find all cells for this env from selected runs
    const cells = [];
    for (const [cellKey, cell] of Object.entries(model.backends)) {
        if (cell.env === env && state.filters.runs.has(cell.run_id)) {
            // Also check kernel and firmware filters
            const sysInfo = cell.system_info || {};
            if (state.filters.kernels.size > 0 && sysInfo.kernel && !state.filters.kernels.has(sysInfo.kernel)) continue;
            if (state.filters.firmwares.size > 0 && sysInfo.linux_firmware && !state.filters.firmwares.has(sysInfo.linux_firmware)) continue;
            cells.push(cell);
        }
    }
    if (cells.length === 0) return null;
    // Return the one with highest mean (best performance)
    return cells.reduce((best, c) => {
        if (!best || (c.mean != null && (best.mean == null || c.mean > best.mean))) return c;
        return best;
    }, null);
}

function getRunHostname(runId) {
    const run = state.rawData?.runs?.[runId];
    return run?.system_info?.hostname || runId.slice(0, 8);
}

function formatRunInfo(cell) {
    const sysInfo = cell.system_info || {};
    const parts = [];
    if (sysInfo.hostname) parts.push(`Host: ${sysInfo.hostname}`);
    if (sysInfo.kernel) parts.push(`Kernel: ${sysInfo.kernel}`);
    if (sysInfo.linux_firmware) parts.push(`Firmware: ${sysInfo.linux_firmware}`);
    if (sysInfo.timestamp) parts.push(`Date: ${sysInfo.timestamp}`);
    return parts.join("\n");
}

function makeHeaderCell(label, extra = "") {
    const th = document.createElement("th");
    th.textContent = label;
    if (extra) th.className = extra;
    return th;
}

function attachHeaderInteractions(th, env) {
    const width = state.columnWidths[env] || 120;
    th.style.width = `${width}px`;
    th.style.minWidth = `${width}px`;
    th.draggable = true;
    th.addEventListener("dragstart", (e) => {
        state.draggingEnv = env;
        th.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
    });
    th.addEventListener("dragend", () => {
        state.draggingEnv = null;
        th.classList.remove("dragging");
        document.querySelectorAll("th.backend-header.drop-target").forEach((el) => el.classList.remove("drop-target"));
    });
    th.addEventListener("dragover", (e) => {
        if (!state.draggingEnv || state.draggingEnv === env) return;
        e.preventDefault();
        th.classList.add("drop-target");
    });
    th.addEventListener("dragleave", () => th.classList.remove("drop-target"));
    th.addEventListener("drop", (e) => {
        if (!state.draggingEnv || state.draggingEnv === env) return;
        e.preventDefault();
        moveBackend(state.draggingEnv, env);
        th.classList.remove("drop-target");
    });

    const handle = document.createElement("span");
    handle.className = "resize-handle";
    handle.addEventListener("mousedown", (e) => startResize(e, env));
    th.appendChild(handle);
}

function moveBackend(from, to) {
    const order = state.backendOrder;
    const fromIdx = order.indexOf(from);
    const toIdx = order.indexOf(to);
    if (fromIdx === -1 || toIdx === -1) return;
    const [col] = order.splice(fromIdx, 1);
    order.splice(toIdx, 0, col);
    renderBackendList();
    renderTables();
}

function filterModels(modelsMap) {
    const models = [];
    for (const model of modelsMap.values()) {
        // Filter by model name
        if (state.filters.models.size > 0 && !state.filters.models.has(model.model)) continue;
        // Filter by quant
        if (state.filters.quants.size > 0 && !state.filters.quants.has(model.quant)) continue;
        // Filter by size
        if (model.sizeB != null) {
            if (state.filters.sizeLo != null && model.sizeB < state.filters.sizeLo - 1e-6) continue;
            if (state.filters.sizeHi != null && model.sizeB > state.filters.sizeHi + 1e-6) continue;
        }
        models.push(model);
    }
    models.sort((a, b) => a.model.localeCompare(b.model));
    return models;
}

function computeWinners(model, backends) {
    const values = [];
    backends.forEach((env) => {
        const cell = getBestCellForEnv(model, env);
        if (cell && !cell.error && typeof cell.mean === "number") {
            values.push({
                env,
                mean: cell.mean,
                std: typeof cell.std === "number" ? cell.std : 0,
            });
        }
    });
    if (!values.length) return [];
    let best = values[0];
    for (const v of values) if (v.mean > best.mean) best = v;
    const winners = [];
    for (const v of values) {
        const pooled = Math.sqrt((best.std || 0) ** 2 + (v.std || 0) ** 2);
        const tol = Math.max(MIN_TOL, K_SIGMA * pooled);
        if ((best.mean - v.mean) <= tol) winners.push(v.env);
    }
    return winners;
}

function normalizeTest(name) {
    if (!name) return null;
    return { key: name.toLowerCase(), original: name };
}

function formatContextLabel(key, tokens) {
    if (key === DEFAULT_CTX) return "Default window";
    if (tokens) return `ctx ${tokens.toLocaleString()}`;
    return key;
}

function formatSize(size) {
    if (size == null) return "—";
    return `${Number(size).toFixed(1)}B`;
}

function formatSizeLabel(size) {
    if (size >= 1000) return `${(size / 1000).toFixed(1)}kB`;
    return `${Math.round(size)}B`;
}

function sortBackendsByModel(model, direction) {
    const dir = direction === "asc" ? 1 : -1;
    const order = [...state.backendOrder].sort((a, b) => {
        const cellA = getBestCellForEnv(model, a);
        const cellB = getBestCellForEnv(model, b);
        const va = backendValue(cellA, direction);
        const vb = backendValue(cellB, direction);
        if (va === vb) return a.localeCompare(b);
        return (va - vb) * dir;
    });
    state.backendOrder = order;
    renderBackendList();
    renderTables();
}

function backendValue(cell, direction) {
    if (!cell || cell.error || typeof cell.mean !== "number") {
        return direction === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    }
    return cell.mean;
}

function splitEnvName(env) {
    const canonical = env.replace(/_/g, ".");
    const tagRegex = /-(rocwmma-improved|rocwmma|improved|hblt0)/gi;
    const tags = [];
    let match;
    while ((match = tagRegex.exec(canonical)) !== null) {
        tags.push(match[1].toLowerCase());
    }
    const base = canonical.replace(tagRegex, "");
    return { base, tags };
}

function startResize(event, env) {
    event.preventDefault();
    event.stopPropagation();
    const column = state.columnWidths[env] || 120;
    const startX = event.clientX;
    const shellRect = state.ui.tables.getBoundingClientRect();
    const guide = document.createElement("div");
    guide.className = "resize-line";
    guide.style.position = "fixed";
    guide.style.top = `${shellRect.top}px`;
    guide.style.bottom = `${window.innerHeight - shellRect.bottom}px`;
    guide.style.left = `${startX}px`;
    guide.style.width = "2px";
    guide.style.background = "var(--accent)";
    guide.style.zIndex = "10";
    document.body.appendChild(guide);
    let nextWidth = column;

    const onMove = (e) => {
        const delta = e.clientX - startX;
        nextWidth = Math.max(80, column + delta);
        guide.style.left = `${e.clientX}px`;
    };

    const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        guide.remove();
        state.columnWidths[env] = nextWidth;
        renderTables();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}

function setupResizeOverlay(tableWrap, backendList, table) {
    let overlay = tableWrap.querySelector(".resize-overlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "resize-overlay";
        tableWrap.appendChild(overlay);
    } else {
        overlay.innerHTML = "";
    }

    overlay.style.width = `${tableWrap.clientWidth}px`;
    overlay.style.height = `${table.offsetHeight}px`;

    const bars = [];
    let offset = MODEL_COL_WIDTH + WINNER_COL_WIDTH;
    backendList.forEach((env) => {
        const width = state.columnWidths[env] || 120;
        const bar = document.createElement("div");
        bar.className = "resize-bar";
        bar.dataset.env = env;
        bar.addEventListener("mousedown", (e) => startResize(e, env));
        overlay.appendChild(bar);
        bars.push({ bar, offset, width, env });
        offset += width;
    });

    const positionBars = () => {
        bars.forEach(({ bar, offset, width }) => {
            const left = offset + width - 3 - tableWrap.scrollLeft;
            bar.style.left = `${left}px`;
        });
    };
    positionBars();

    if (tableWrap._overlayScroll) {
        tableWrap.removeEventListener("scroll", tableWrap._overlayScroll);
    }
    const onScroll = () => positionBars();
    tableWrap.addEventListener("scroll", onScroll);
    tableWrap._overlayScroll = onScroll;

    if (tableWrap._overlayResize) {
        tableWrap._overlayResize.disconnect();
    }
    const resizeObserver = new ResizeObserver(() => {
        overlay.style.width = `${tableWrap.clientWidth}px`;
        overlay.style.height = `${table.offsetHeight}px`;
        positionBars();
    });
    resizeObserver.observe(tableWrap);
    tableWrap._overlayResize = resizeObserver;
}
