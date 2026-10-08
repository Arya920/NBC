// =============================================================
// NBC Command Center — frontend logic
// Workspaces: "executive" (portfolio, customer-independent)
//             "consumer"  (everything driven by the selected customer)
// =============================================================

const state = {
    workspace: 'executive',
    customers: [],
    currentId: null,
    currentPayload: null,
    customerRequestSeq: 0,
    portfolio: null,
    productPortfolio: null,
    productDim: 'age',
    productMetric: 'balance',
    journeyMode: 'even',
};

// Categorical palette: distinct hue AND lightness, colour-blind tolerant.
// Red is reserved for negative/declined states and never used as a category.
const CAT = [
    '#1D4ED8', // blue
    '#EA7A00', // orange
    '#0E9F6E', // green
    '#7E3AF2', // violet
    '#BE185D', // magenta
    '#0891B2', // cyan
    '#64748B', // slate
    '#92400E', // brown
];
const UI = { primary: '#1D4ED8' };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

document.addEventListener('DOMContentLoaded', init);

async function init() {
    bindNavigation();
    setWorkspace('executive');

    await loadMeta();
    await loadCustomers();
    await loadPortfolio();
    await loadProductPortfolio('age');

    if (state.customers.length > 0) {
        await selectCustomer(state.customers[0]);
    } else {
        showCustomerEmpty('No customers are available.');
    }
}


// -------------------------------------------------------------
// Navigation
// -------------------------------------------------------------

function bindNavigation() {
    $$('#main-tabs .primary-nav-link').forEach((button) => {
        button.addEventListener('click', () => {
            setWorkspace(button.dataset.workspace);
        });
    });

    $('#product-metric')?.addEventListener('change', (event) => {
        state.productMetric = event.target.value;
        renderProductBreakdown();
    });

    $('#product-dim')?.addEventListener('change', async (event) => {
        await loadProductPortfolio(event.target.value);
    });

    $$('#journey-mode button').forEach((button) => {
        button.addEventListener('click', () => {
            state.journeyMode = button.dataset.mode;
            $$('#journey-mode button').forEach((b) =>
                b.classList.toggle('active', b === button)
            );
            renderJourney(state.currentPayload?.journey);
        });
    });
}

function setWorkspace(target) {
    state.workspace = target;

    $$('#main-tabs .primary-nav-link').forEach((button) => {
        const active = button.dataset.workspace === target;
        button.classList.toggle('active', active);
        button.setAttribute('aria-current', active ? 'page' : 'false');
    });

    $$('[data-workspace-panel]').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.workspacePanel === target);
    });

    // The customer picker only applies to the consumer view.
    $('#customer-navigation-scope')?.classList.toggle('scope-hidden', target !== 'consumer');

    // Plotly needs a laid-out container, so render after the panel is shown.
    requestAnimationFrame(() => {
        if (target === 'executive') {
            renderExecutive();
        } else {
            renderConsumerCharts();
        }
        resizeVisibleCharts();
    });
}

function renderExecutive() {
    renderProductPortfolio();
    if (state.portfolio) renderNbcPortfolio(state.portfolio);
}

function renderConsumerCharts() {
    const payload = state.currentPayload;
    if (!payload) return;

    renderJourney(payload.journey);
    renderCustomerDistribution(payload.history);
    renderBalancePosition(payload.products);
}


// -------------------------------------------------------------
// Metadata / customers
// -------------------------------------------------------------

async function loadMeta() {
    try {
        const response = await fetch('/api/meta', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Meta request failed: ${response.status}`);

        const data = await response.json();

        const el = $('#dataset-status');
        if (!el) return;

        el.innerHTML = `
            <div class="dataset-row"><span>Data as of</span><strong>${escapeHtml(data.snapshot_date)}</strong></div>
            <div class="dataset-row"><span>Customers</span><strong>${Number(data.customer_count || 0).toLocaleString()}</strong></div>
        `;
    } catch (error) {
        console.error('Meta load failed:', error);
        setStatusMessage('Dataset information unavailable');
    }
}

async function loadCustomers() {
    try {
        const response = await fetch('/api/customers', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Customer request failed: ${response.status}`);

        const data = await response.json();
        state.customers = Array.isArray(data.ids)
            ? data.ids.map(String)
            : [];

        const input = $('#customer-search');
        const list = $('#customer-list');
        if (!input || !list) return;

        const renderList = (filter = '') => {
            const query = filter.trim().toLowerCase();

            const items = query
                ? state.customers.filter((id) => id.toLowerCase().includes(query))
                : state.customers;

            const visibleItems = items.slice(0, 200);

            list.innerHTML = visibleItems.length
                ? visibleItems
                    .map(
                        (id) =>
                            `<li data-id="${escapeHtml(id)}">${escapeHtml(id)}</li>`
                    )
                    .join('')
                : '<li class="no-match">No customer found</li>';
        };

        input.addEventListener('focus', () => {
            renderList(input.value);
            list.classList.remove('hidden');
        });

        input.addEventListener('input', () => {
            renderList(input.value);
            list.classList.remove('hidden');
        });

        input.addEventListener('keydown', async (event) => {
            if (event.key === 'Enter') {
                const first = list.querySelector('li[data-id]');
                if (!first) return;

                list.classList.add('hidden');
                input.blur();
                await selectCustomer(first.dataset.id);
            }

            if (event.key === 'Escape') {
                list.classList.add('hidden');
                input.blur();
            }
        });

        list.addEventListener('click', async (event) => {
            const item = event.target.closest('li[data-id]');
            if (!item) return;

            list.classList.add('hidden');
            input.blur();
            await selectCustomer(item.dataset.id);
        });

        document.addEventListener('click', (event) => {
            if (!event.target.closest('#customer-combobox')) {
                list.classList.add('hidden');
            }
        });

        input.value = state.customers[0] || '';
    } catch (error) {
        console.error('Customer list load failed:', error);
        showCustomerEmpty('Customer list could not be loaded.');
    }
}

async function selectCustomer(id) {
    const customerId = String(id || '').trim();
    if (!customerId) return;

    state.currentId = customerId;

    const input = $('#customer-search');
    if (input) input.value = customerId;

    // Clear previous charts before loading the new customer's data.
    clearCustomerHistoryChart();
    purgeChart('chart-journey');
    purgeChart('chart-product-balance');
    setHistoryLoading();

    const requestSeq = ++state.customerRequestSeq;

    try {
        const response = await fetch(
            `/api/customer/${encodeURIComponent(customerId)}`,
            { cache: 'no-store' }
        );

        if (!response.ok) {
            throw new Error(`Customer request failed: ${response.status}`);
        }

        const data = await response.json();

        // Ignore a slower response from an older selection.
        if (requestSeq !== state.customerRequestSeq) return;
        if (state.currentId !== customerId) return;

        state.currentPayload = data;
        renderCustomer(data);
    } catch (error) {
        if (requestSeq !== state.customerRequestSeq) return;

        console.error('Customer load failed:', error);
        showCustomerEmpty('Customer data could not be loaded.');
    }
}


// -------------------------------------------------------------
// Customer rendering
// -------------------------------------------------------------

function renderCustomer(data) {
    renderHero(data.hero);
    renderNbc(data.nbc);
    renderActivity(data.activity, data.interaction);

    renderProfileSummary(
        '#term-profile-summary',
        data.term_profile,
        6,
        'Term deposit profile unavailable'
    );
    renderFullProfile('#term-profile-full', data.term_profile);

    renderProfileSummary(
        '#insurance-profile-summary',
        data.insurance_profile,
        6,
        'Insurance profile unavailable'
    );
    renderFullProfile('#insurance-profile-full', data.insurance_profile);

    renderHistory(data.history);
    renderJourney(data.journey);
    renderProducts(data.products);
}

function renderHero(hero) {
    setText('#hero-id', hero?.id);
    setText('#hero-score-date', hero?.score_date);
    setText('#hero-channel', hero?.channel);
    setText('#hero-last-action-date', hero?.last_action_date);
}

function renderNbc(nbc) {
    setText('#nbc1-value', nbc?.nbc1);
    setText('#nbc2-value', nbc?.nbc2);
    setText('#nbc3-value', nbc?.nbc3);
}

function renderActivity(activity, interaction) {
    setText('#ctx-last-action', activity?.last_action);

    if (!interaction) {
        setText('#interaction-date', 'No interaction date');
        setText('#interaction-text', 'No interaction record was found for this customer.');
        return;
    }

    setText('#interaction-date', interaction.date);
    setText('#interaction-text', interaction.text);
}

function renderProfileSummary(selector, rows, limit, emptyText) {
    const container = $(selector);
    if (!container) return;

    if (!Array.isArray(rows) || rows.length === 0) {
        container.innerHTML = `<div class="kv-empty">${escapeHtml(emptyText)}</div>`;
        return;
    }

    container.innerHTML = rows
        .slice(0, limit)
        .map(
            (row) => `
                <div class="kv">
                    <span>${escapeHtml(row.field)}</span>
                    <strong>${escapeHtml(row.value)}</strong>
                </div>
            `
        )
        .join('');
}

function renderFullProfile(selector, rows) {
    const container = $(selector);
    if (!container) return;

    if (!Array.isArray(rows) || rows.length === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Field</th>
                    <th>Value</th>
                </tr>
            </thead>
            <tbody>
                ${rows
                    .map(
                        (row) => `
                            <tr>
                                <td>${escapeHtml(row.field)}</td>
                                <td>${escapeHtml(row.value)}</td>
                            </tr>
                        `
                    )
                    .join('')}
            </tbody>
        </table>
    `;
}


// -------------------------------------------------------------
// Customer NBC1 history
// -------------------------------------------------------------

function setHistoryLoading() {
    setText('#history-subtitle', '', '');
    setText('#hs-points', 'Loading…');
    setText('#hs-dominant', 'Loading…');
    setText('#hs-latest', 'Loading…');
    setText('#hist-readout', 'Loading customer history…');
    setText('#current-vs-history', 'Loading…');

    const table = $('#history-table');
    if (table) table.innerHTML = '';

    $('#customer-chart-empty')?.classList.add('hidden');
}

function renderHistory(history) {
    const chartEmpty = $('#customer-chart-empty');

    if (!history) {
        setText('#history-subtitle', '', '');
        setText('#hs-points', '0');
        setText('#hs-dominant', '—');
        setText('#hs-latest', '—');
        setText('#hist-readout', 'No historical NBC1 records are available.');
        setText('#current-vs-history', 'No comparison is available.');
        const table = $('#history-table');
        if (table) table.innerHTML = '';
        showChartEmpty(chartEmpty, true);
        clearCustomerHistoryChart();
        return;
    }

    setText('#history-subtitle', `${history.total} historical points`);
    setText('#hs-points', history.total);
    setText('#hs-dominant', history.dominant);
    setText('#hs-latest', history.latest);

    setText(
        '#hist-readout',
        `${history.dominant} appeared in ${history.dominant_count} of ${history.total} historical points.`
    );

    setText(
        '#current-vs-history',
        history.matches_current
            ? 'Current NBC1 matches the latest historical NBC1.'
            : 'Current NBC1 differs from the latest historical NBC1.'
    );

    renderHistoryTable(history.points);
    showChartEmpty(chartEmpty, false);

    requestAnimationFrame(() => {
        renderCustomerDistribution(history);
    });
}

function renderHistoryTable(points) {
    const container = $('#history-table');
    if (!container) return;

    container.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Point</th>
                    <th>NBC date</th>
                    <th>NBC1</th>
                </tr>
            </thead>
            <tbody>
                ${(points || [])
                    .map(
                        (point) => `
                            <tr>
                                <td>${escapeHtml(point.point)}</td>
                                <td>${escapeHtml(point.date)}</td>
                                <td>${escapeHtml(point.state)}</td>
                            </tr>
                        `
                    )
                    .join('')}
            </tbody>
        </table>
    `;
}

function renderCustomerDistribution(history) {
    if (
        state.workspace !== 'consumer' ||
        !history ||
        !Array.isArray(history.counts)
    ) {
        return;
    }

    const container = $('#chart-customer-distribution');
    if (!container || typeof Plotly === 'undefined') return;
    if (!isElementVisible(container)) return;

    const labels = history.counts.map((item) => item.state);
    const values = history.counts.map((item) => Number(item.value || 0));

    if (!labels.length) {
        clearCustomerHistoryChart();
        return;
    }

    const traces = [
        {
            type: 'bar',
            orientation: 'h',
            x: values,
            y: labels,
            marker: { color: UI.primary },
            hovertemplate: '<b>%{y}</b><br>%{x} of historical points<extra></extra>',
        },
    ];

    const maxValue = Math.max(...values, 1);

    const layout = chartBaseLayout({
        height: Math.max(320, Math.min(420, labels.length * 64 + 120)),
        margin: { l: 210, r: 30, t: 16, b: 50 },
        xaxis: {
            title: null,
            range: [0, maxValue + 1],
            dtick: 1,
            showgrid: true,
            gridcolor: 'rgba(100,116,139,0.18)',
            zeroline: false,
            tickfont: { size: 10, color: '#475569' },
        },
        yaxis: {
            title: null,
            showgrid: false,
            zeroline: false,
            automargin: true,
            autorange: 'reversed',
            tickfont: { size: 11, color: '#1E293B' },
        },
        showlegend: false,
    });

    try {
        Plotly.react(container, traces, layout, {
            displayModeBar: false,
            responsive: true,
        });
    } catch (error) {
        console.error('Customer history chart failed:', error);
    }
}

function clearCustomerHistoryChart() {
    purgeChart('chart-customer-distribution');
}


// -------------------------------------------------------------
// Portfolio: NBC1 composition (executive)
// -------------------------------------------------------------

async function loadPortfolio() {
    try {
        const response = await fetch('/api/portfolio', { cache: 'no-store' });

        if (!response.ok) {
            throw new Error(`Portfolio request failed: ${response.status}`);
        }

        state.portfolio = await response.json();

        if (state.workspace === 'executive') {
            requestAnimationFrame(() => renderNbcPortfolio(state.portfolio));
        }
    } catch (error) {
        console.error('Portfolio load failed:', error);
        showPortfolioError();
    }
}

function renderNbcPortfolio(data) {
    if (state.workspace !== 'executive') return;

    const container = $('#chart-portfolio');
    if (!container || typeof Plotly === 'undefined') return;
    if (!isElementVisible(container)) return;

    if (
        !data ||
        !Array.isArray(data.points) ||
        !Array.isArray(data.series) ||
        !data.points.length
    ) {
        showPortfolioError();
        return;
    }

    const xLabels = data.points.map((point) => `P${point}`);
    const dates = Array.isArray(data.point_dates) ? data.point_dates : [];

    const traces = data.series.map((series, index) => ({
        type: 'bar',
        name: series.state,
        x: xLabels,
        y: series.values,
        marker: {
            color: CAT[index % CAT.length],
            line: { color: '#FFFFFF', width: 1.5 },
        },
        customdata: series.values.map((value, pointIndex) => [
            xLabels[pointIndex],
            dates[pointIndex] || '—',
            value,
        ]),
        hovertemplate:
            '<b>%{fullData.name}</b><br>' +
            '%{customdata[0]} · %{customdata[1]}<br>' +
            '%{customdata[2]:,} customers<extra></extra>',
    }));

    const layout = chartBaseLayout({
        height: 520,
        barmode: 'stack',
        bargap: 0.26,
        margin: { l: 70, r: 30, t: 70, b: 70 },
        legend: {
            orientation: 'h',
            yanchor: 'bottom',
            y: 1.02,
            xanchor: 'left',
            x: 0,
            font: { size: 10, color: '#334155' },
        },
        xaxis: {
            title: {
                text: 'Historical point',
                font: { size: 11, color: '#475569' },
            },
            type: 'category',
            showgrid: false,
            zeroline: false,
            tickfont: { size: 10, color: '#475569' },
            tickmode: 'array',
            tickvals: xLabels,
            ticktext: xLabels,
        },
        yaxis: {
            title: {
                text: 'Number of customers',
                standoff: 12,
                font: { size: 11, color: '#475569' },
            },
            rangemode: 'tozero',
            showgrid: true,
            gridcolor: 'rgba(100,116,139,0.18)',
            zeroline: false,
            tickfont: { size: 10, color: '#475569' },
        },
        hovermode: 'closest',
    });

    try {
        Plotly.react(container, traces, layout, {
            displayModeBar: false,
            responsive: true,
        });

        showChartEmpty($('#portfolio-chart-empty'), false);
    } catch (error) {
        console.error('Portfolio chart failed:', error);
        showPortfolioError();
    }
}

function showPortfolioError() {
    showChartEmpty($('#portfolio-chart-empty'), true);
    purgeChart('chart-portfolio');
}


// -------------------------------------------------------------
// Chart helpers
// -------------------------------------------------------------

function chartBaseLayout(overrides = {}) {
    return Object.assign(
        {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: {
                family: 'Inter, system-ui, sans-serif',
                color: '#334155',
            },
            hoverlabel: {
                bgcolor: '#FFFFFF',
                bordercolor: '#CBD5E1',
                font: { size: 11, color: '#0F172A' },
            },
        },
        overrides
    );
}

function resizeVisibleCharts() {
    if (typeof Plotly === 'undefined') return;

    [
        'chart-customer-distribution',
        'chart-portfolio',
        'chart-journey',
        'chart-product-balance',
        'chart-product-penetration',
        'chart-product-breakdown',
    ].forEach((id) => {
        const element = document.getElementById(id);

        if (!element || !element.data) return;
        if (!isElementVisible(element)) return;

        try {
            Plotly.Plots.resize(element);
        } catch (error) {
            console.warn(`Could not resize ${id}:`, error);
        }
    });
}

window.addEventListener('resize', () => {
    requestAnimationFrame(resizeVisibleCharts);
});

function purgeChart(id) {
    const el = document.getElementById(id);
    if (!el || typeof Plotly === 'undefined') return;
    try { Plotly.purge(el); } catch (e) { /* nothing to purge */ }
}

function isElementVisible(el) {
    return !!el && el.offsetWidth > 0 && el.offsetHeight > 0;
}


// -------------------------------------------------------------
// UI helpers
// -------------------------------------------------------------

function showCustomerEmpty(message) {
    setText('#hero-id', '—');
    setText('#hero-score-date', '—');
    setText('#hero-channel', '—');
    setText('#hero-last-action-date', '—');
    setText('#nbc1-value', '—');
    setText('#nbc2-value', '—');
    setText('#nbc3-value', '—');
    setText('#ctx-last-action', message);
    setText('#interaction-date', '—');
    setText('#interaction-text', '—');

    clearCustomerHistoryChart();
}

function setStatusMessage(message) {
    const el = $('#dataset-status');
    if (el) {
        el.innerHTML = `<div class="dataset-row"><span>${escapeHtml(message)}</span></div>`;
    }
}

function setText(selector, value, fallback = '—') {
    const element = $(selector);
    if (!element) return;

    element.textContent =
        value === null || value === undefined || value === ''
            ? fallback
            : String(value);
}

function showChartEmpty(element, show) {
    if (!element) return;
    element.classList.toggle('hidden', !show);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatNumber(value) {
    return value === null || value === undefined
        ? '—'
        : Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function ordinal(n) {
    const v = n % 100;
    const suffix = ['th', 'st', 'nd', 'rd'];
    return n + (suffix[(v - 20) % 10] || suffix[v] || suffix[0]);
}


// =============================================================
// Customer journey
// =============================================================

const STAGE_COLORS = {
    'Acquisition': '#1D4ED8',
    'Onboarding': '#0891B2',
    'Cross-Sell / Marketing': '#EA7A00',
    'Product Holding': '#0E9F6E',
    'Service / Retention': '#7E3AF2',
    'Current State': '#0F172A',
};

function wrapLabel(text, width = 20) {
    const words = String(text ?? '').split(/\s+/);
    const lines = [];
    let line = '';
    words.forEach((word) => {
        if ((line + ' ' + word).trim().length > width && line) {
            lines.push(line);
            line = word;
        } else {
            line = (line + ' ' + word).trim();
        }
    });
    if (line) lines.push(line);
    return lines.join('<br>');
}

function shortEventTitle(title) {
    return String(title ?? '')
        .replace('Next Best Comm: ', 'Recommended: ')
        .replace('Bank Action: ', 'Action: ');
}

function renderJourney(events) {
    const container = $('#chart-journey');
    const empty = $('#journey-chart-empty');
    if (!container || typeof Plotly === 'undefined') return;

    renderJourneyTable(events);

    if (!Array.isArray(events) || events.length === 0) {
        showChartEmpty(empty, true);
        purgeChart('chart-journey');
        setText('#journey-subtitle', 'No journey events available');
        return;
    }
    showChartEmpty(empty, false);

    setText(
        '#journey-subtitle',
        `${events.length} checkpoints · ${events[0].date} → ${events[events.length - 1].date}`
    );

    // Plotly needs a laid-out container; re-rendered when the workspace is shown.
    if (state.workspace !== 'consumer') return;
    if (!isElementVisible(container)) return;

    const timeScale = state.journeyMode === 'time';
    const DAY = 86400000;

    // Same-day events are nudged apart on the time scale so they stay clickable.
    const seen = {};
    const xs = events.map((event, index) => {
        if (!timeScale) return index + 1;
        const t = Date.parse(event.iso);
        const k = seen[event.iso] || 0;
        seen[event.iso] = k + 1;
        return new Date(t + k * 2 * DAY).toISOString().slice(0, 10);
    });

    // Alternate above/below, two heights per side, so labels do not collide.
    const levels = events.map((_, i) => {
        const up = i % 2 === 0;
        const tier = (Math.floor(i / 2) % 2) + 1;
        return up ? tier : -tier;
    });

    const shapes = events.map((_, i) => ({
        type: 'line',
        x0: xs[i], x1: xs[i], y0: 0, y1: levels[i],
        line: { color: 'rgba(100,116,139,0.40)', width: 1 },
        layer: 'below',
    }));

    let xRange;
    if (timeScale) {
        const times = events.map((e) => Date.parse(e.iso));
        const lo = Math.min(...times);
        const hi = Math.max(...times) + 4 * DAY;
        const pad = Math.max((hi - lo) * 0.06, 20 * DAY);
        xRange = [new Date(lo - pad).toISOString(), new Date(hi + pad).toISOString()];
    } else {
        xRange = [0.2, events.length + 0.8];
    }

    shapes.push({
        type: 'line',
        xref: 'paper', x0: 0, x1: 1, y0: 0, y1: 0,
        line: { color: '#94A3B8', width: 2 },
        layer: 'below',
    });

    const stages = Object.keys(STAGE_COLORS).filter((stage) =>
        events.some((e) => e.stage === stage)
    );
    const extraStages = [...new Set(events.map((e) => e.stage))].filter(
        (stage) => !(stage in STAGE_COLORS)
    );

    const markerTraces = [...stages, ...extraStages].map((stage) => {
        const idx = events.map((e, i) => (e.stage === stage ? i : -1)).filter((i) => i >= 0);
        const isCurrent = stage === 'Current State';
        return {
            type: 'scatter',
            mode: 'markers',
            name: stage,
            x: idx.map((i) => xs[i]),
            y: idx.map(() => 0),
            marker: {
                size: isCurrent ? 19 : 14,
                symbol: isCurrent ? 'diamond' : 'circle',
                color: STAGE_COLORS[stage] || '#475569',
                line: {
                    width: 2.5,
                    color: idx.map((i) =>
                        events[i].status === 'Declined' ? '#DC2626' : '#FFFFFF'
                    ),
                },
            },
            customdata: idx.map((i) => {
                const e = events[i];
                return [e.seq, e.date, e.title, e.channel, e.status, e.product, wrapLabel(e.description, 60)];
            }),
            hovertemplate:
                '<b>#%{customdata[0]} · %{customdata[2]}</b><br>' +
                '%{customdata[1]} · %{customdata[5]}<br>' +
                'Channel: %{customdata[3]} · Status: %{customdata[4]}<br>' +
                '%{customdata[6]}<extra></extra>',
        };
    });

    const labelTrace = {
        type: 'scatter',
        mode: 'text',
        x: xs,
        y: levels,
        text: events.map((e) => `<b>${wrapLabel(shortEventTitle(e.title), 20)}</b><br>${e.date}`),
        textposition: levels.map((l) => (l > 0 ? 'top center' : 'bottom center')),
        textfont: { size: 10, color: '#1E293B' },
        hoverinfo: 'skip',
        showlegend: false,
        cliponaxis: false,
    };

    const layout = chartBaseLayout({
        height: 440,
        margin: { l: 24, r: 24, t: 10, b: 52 },
        shapes,
        showlegend: true,
        legend: {
            orientation: 'h', yanchor: 'top', y: -0.02, xanchor: 'center', x: 0.5,
            font: { size: 10, color: '#334155' },
        },
        xaxis: Object.assign(
            {
                range: xRange,
                showgrid: false,
                zeroline: false,
                fixedrange: true,
            },
            timeScale
                ? { type: 'date', tickformat: '%b %Y', tickfont: { size: 10, color: '#475569' }, side: 'bottom' }
                : { showticklabels: false }
        ),
        yaxis: { range: [-3.1, 3.1], visible: false, fixedrange: true },
        hovermode: 'closest',
    });

    try {
        Plotly.react(container, [labelTrace, ...markerTraces], layout, {
            displayModeBar: false,
            responsive: true,
        });
    } catch (error) {
        console.error('Journey chart failed:', error);
    }
}

function renderJourneyTable(events) {
    const container = $('#journey-table');
    if (!container) return;
    if (!Array.isArray(events) || !events.length) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = `
        <table>
            <thead><tr>
                <th>#</th><th>Date</th><th>Stage</th><th>Event</th>
                <th>Product</th><th>Channel</th><th>Status</th>
            </tr></thead>
            <tbody>
                ${events.map((e) => `
                    <tr title="${escapeHtml(e.description)}">
                        <td>${escapeHtml(e.seq)}</td>
                        <td>${escapeHtml(e.date)}</td>
                        <td>${escapeHtml(e.stage)}</td>
                        <td>${escapeHtml(e.title)}</td>
                        <td>${escapeHtml(e.product)}</td>
                        <td>${escapeHtml(e.channel)}</td>
                        <td>${escapeHtml(e.status)}</td>
                    </tr>`).join('')}
            </tbody>
        </table>
    `;
}


// =============================================================
// Products — customer holdings (consumer)
// =============================================================

function renderProducts(products) {
    const list = $('#product-list');
    if (!list) return;

    if (!products) {
        list.innerHTML = '<li class="profile-empty-inline">Product data unavailable for this customer.</li>';
        setText('#pk-count', '—');
        setText('#pk-count-sub', '', '');
        setText('#pk-balance', '—');
        setText('#pk-balance-sub', '', '');
        setText('#pk-premium', '—');
        setText('#pk-premium-sub', '', '');
        purgeChart('chart-product-balance');
        return;
    }

    list.innerHTML = products.held.map((item) => {
        const hasDate = item.held && item.date && item.date !== '—';
        return `
            <li class="holding ${item.held ? 'held' : ''}">
                <span class="holding-name">${escapeHtml(item.label)}</span>
                <span class="holding-meta">${hasDate ? `Since ${escapeHtml(item.date)}` : ''}</span>
                <span class="holding-status">${item.held ? 'Held' : 'Not held'}</span>
            </li>`;
    }).join('');

    setText('#pk-count', `${products.count} of ${products.max}`);
    setText('#pk-count-sub', 'Excludes the base current account', '');

    setText('#pk-balance', formatNumber(products.balance));
    setText(
        '#pk-balance-sub',
        products.balance_percentile === null
            ? ''
            : `${ordinal(products.balance_percentile)} percentile · median ${formatNumber(products.ref.median)}`,
        ''
    );

    if (products.premium !== null) {
        setText('#pk-premium', formatNumber(products.premium));
        setText('#pk-premium-sub', `Policyholder median ${formatNumber(products.ref.premium_median)}`, '');
    } else {
        setText('#pk-premium', '—');
        setText('#pk-premium-sub', 'No active motor policy', '');
    }

    if (state.workspace === 'consumer') {
        requestAnimationFrame(() => renderBalancePosition(products));
    }
}

function renderBalancePosition(products) {
    const container = $('#chart-product-balance');
    if (!container || typeof Plotly === 'undefined' || !products) return;
    if (!isElementVisible(container) || products.balance === null) return;

    const r = products.ref;
    const b = products.balance;
    const lo = Math.min(r.p5, b);
    const hi = Math.max(r.p95, b);
    const pad = (hi - lo) * 0.08 || 50;

    const layout = chartBaseLayout({
        height: 190,
        margin: { l: 24, r: 24, t: 24, b: 40 },
        shapes: [
            { type: 'line', x0: r.p5, x1: r.p95, y0: 0.5, y1: 0.5, line: { color: '#94A3B8', width: 2 } },
            { type: 'rect', x0: r.p25, x1: r.p75, y0: 0.32, y1: 0.68, fillcolor: 'rgba(29,78,216,0.14)', line: { width: 0 } },
            { type: 'line', x0: r.median, x1: r.median, y0: 0.24, y1: 0.76, line: { color: '#1D4ED8', width: 2 } },
        ],
        annotations: [
            { x: r.median, y: 0.8, text: `median ${formatNumber(r.median)}`, showarrow: false, font: { size: 10, color: '#475569' } },
        ],
        xaxis: {
            range: [lo - pad, hi + pad],
            showgrid: true, gridcolor: 'rgba(100,116,139,0.18)', zeroline: false,
            tickfont: { size: 10, color: '#475569' },
            title: { text: 'Balance (P5–P95 whisker)', font: { size: 10, color: '#64748B' } },
        },
        yaxis: { range: [0, 1], visible: false, fixedrange: true },
        showlegend: false,
    });

    Plotly.react(container, [{
        type: 'scatter', mode: 'markers', x: [b], y: [0.5],
        marker: { symbol: 'diamond', size: 16, color: '#EA7A00', line: { width: 2, color: '#FFFFFF' } },
        hovertemplate: `Customer balance: ${formatNumber(b)}<extra></extra>`,
    }], layout, { displayModeBar: false, responsive: true });
}


// =============================================================
// Products — portfolio (executive)
// =============================================================

async function loadProductPortfolio(dim) {
    try {
        const response = await fetch(
            `/api/product-portfolio?dim=${encodeURIComponent(dim)}`,
            { cache: 'no-store' }
        );
        if (!response.ok) throw new Error(`Product portfolio request failed: ${response.status}`);
        state.productPortfolio = await response.json();
        state.productDim = state.productPortfolio.dimension;
        const select = $('#product-dim');
        if (select) select.value = state.productDim;
        if (state.workspace === 'executive') {
            requestAnimationFrame(renderProductPortfolio);
        }
    } catch (error) {
        console.error('Product portfolio load failed:', error);
    }
}

function renderPortfolioKpis(data) {
    const container = $('#exec-kpis');
    if (!container) return;

    const k = data.kpis;
    const tracked = Array.isArray(data.penetration) ? data.penetration.length : 0;

    const items = [
        ['Customers', formatNumber(k.customers), `${formatNumber(k.motor_holders)} hold motor insurance`],
        ['Products per customer', k.products_mean ?? '—', `Across ${tracked} tracked products`],
        ['No product held', k.no_product_pct === null ? '—' : `${k.no_product_pct}%`, 'Cross-sell headroom'],
        ['Median balance', formatNumber(k.balance_median), `Mean ${formatNumber(k.balance_mean)} · ${formatNumber(k.negative_balance)} negative`],
    ];

    container.innerHTML = items.map(([label, value, sub]) => `
        <div class="kpi">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <small>${escapeHtml(sub)}</small>
        </div>`).join('');
}

function renderProductPortfolio() {
    const data = state.productPortfolio;
    if (!data || state.workspace !== 'executive') return;

    renderPortfolioKpis(data);

    const pen = $('#chart-product-penetration');
    if (pen && typeof Plotly !== 'undefined' && isElementVisible(pen)) {
        const items = data.penetration;
        Plotly.react(pen, [{
            type: 'bar', orientation: 'h',
            x: items.map((i) => i.pct),
            y: items.map((i) => i.label),
            text: items.map((i) => `${i.pct}% · ${formatNumber(i.customers)}`),
            textposition: 'outside', cliponaxis: false,
            marker: { color: UI.primary },
            hovertemplate: '<b>%{y}</b><br>%{text}<extra></extra>',
        }], chartBaseLayout({
            height: 260,
            margin: { l: 110, r: 70, t: 10, b: 40 },
            xaxis: { range: [0, 100], ticksuffix: '%', showgrid: true, gridcolor: 'rgba(100,116,139,0.18)', zeroline: false, tickfont: { size: 10, color: '#475569' } },
            yaxis: { autorange: 'reversed', automargin: true, tickfont: { size: 11, color: '#1E293B' } },
            showlegend: false,
        }), { displayModeBar: false, responsive: true });
    }

    renderProductBreakdown();
}

function renderProductBreakdown() {
    const data = state.productPortfolio;
    const el = $('#chart-product-breakdown');
    if (!data || !el || typeof Plotly === 'undefined' || state.workspace !== 'executive') return;
    if (!isElementVisible(el)) return;

    const metric = state.productMetric;
    const rows = data.rows;
    const FADE = 0.3;

    let bar, median = null, yTitle, note, lowFlags, counts;
    if (metric === 'products') {
        bar = rows.map((r) => r.products_mean);
        yTitle = 'Products held per customer';
        lowFlags = rows.map((r) => r.low_n);
        counts = rows.map((r) => r.n);
        note = `Mean number of tracked products per customer. Faded bars have fewer than ${data.min_group_n} customers.`;
    } else if (metric === 'premium') {
        bar = rows.map((r) => r.premium_mean);
        median = rows.map((r) => r.premium_median);
        yTitle = 'Annual premium';
        lowFlags = rows.map((r) => r.premium_low_n);
        counts = rows.map((r) => r.premium_n);
        note = 'Policyholders only (n shown under each label). Faded bars have fewer than 10 policyholders. Bars = mean, ◆ = median.';
    } else {
        bar = rows.map((r) => r.balance_mean);
        median = rows.map((r) => r.balance_median);
        yTitle = 'Balance';
        lowFlags = rows.map((r) => r.low_n);
        counts = rows.map((r) => r.n);
        note = `Bars = mean, ◆ = median. A mean far above its median means a few large balances are driving it. Faded bars have fewer than ${data.min_group_n} customers.`;
    }

    const labels = rows.map((r, i) => `${r.group}<br>n=${counts[i]}`);
    const traces = [{
        type: 'bar', name: 'Mean', x: labels, y: bar,
        marker: { color: '#1D4ED8', opacity: lowFlags.map((low) => (low ? FADE : 0.9)) },
        hovertemplate: '<b>%{x}</b><br>Mean: %{y:,.2f}<extra></extra>',
    }];
    if (median) {
        traces.push({
            type: 'scatter', mode: 'markers', name: 'Median', x: labels, y: median,
            marker: { symbol: 'diamond', size: 11, color: '#EA7A00', line: { width: 1.5, color: '#FFFFFF' } },
            hovertemplate: '<b>%{x}</b><br>Median: %{y:,.0f}<extra></extra>',
        });
    }

    Plotly.react(el, traces, chartBaseLayout({
        height: 360,
        margin: { l: 64, r: 20, t: 20, b: 80 },
        showlegend: !!median,
        legend: { orientation: 'h', x: 0, y: 1.1, font: { size: 10, color: '#334155' } },
        xaxis: { type: 'category', tickfont: { size: 10, color: '#475569' }, automargin: true },
        yaxis: {
            title: { text: yTitle, standoff: 8, font: { size: 11, color: '#475569' } },
            rangemode: 'tozero', showgrid: true, gridcolor: 'rgba(100,116,139,0.18)', zeroline: false,
            tickfont: { size: 10, color: '#475569' },
        },
        bargap: 0.3,
    }), { displayModeBar: false, responsive: true });

    setText('#product-breakdown-note', note);
}